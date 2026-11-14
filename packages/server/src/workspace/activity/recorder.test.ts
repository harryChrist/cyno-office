import type { Agent, ActivityEntry, ForYouItem, MediaItem, Plan, Routine, RoutineEntry, Task } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../../platform/events/hub";
import { ActivityLog, setActivityLog } from "./log";
import { observeWorkspaceActivity, type ActivitySnapshot } from "./recorder";

const agent = (partial: Partial<Agent> = {}): Agent => ({ id: "eco", teamId: "t", name: "ECO", role: "Redator", instructions: "", avatar: { skin: "a", hair: "b", hairColor: "c", shirt: "d", pants: "e" }, status: "idle", ...partial });
const task = (partial: Partial<Task> = {}): Task => ({ id: "t1", roomId: "r", teamId: "t", agentId: "eco", prompt: "Escrever o post de segunda\ncom detalhes", status: "queued", createdAt: "2026-11-10T12:00:00.000Z", updatedAt: "2026-11-10T12:00:00.000Z", ...partial });
const item = (partial: Partial<ForYouItem> = {}): ForYouItem =>
  ({ id: "A-0001", agentId: "eco", roomId: "r", type: "linkedin-post", status: "pendente", where: "Post de segunda", meta: {}, text: "novo", originalText: "novo", editedByUser: false, createdAt: "2026-11-10T12:00:00.000Z", ...partial }) as ForYouItem;

let log: ActivityLog;
let entries: ActivityEntry[];
let hub: EventHub;
let snapshot: ActivitySnapshot;

beforeEach(() => {
  log = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
  entries = [];
  log.onAppend((entry) => entries.push(entry));
  setActivityLog(log);
  hub = new EventHub();
  snapshot = { tasks: [], forYou: [], agents: [agent()], media: [], plans: [], routines: [], entries: [] };
});
afterEach(() => setActivityLog(undefined));

const observe = (cost?: Parameters<typeof observeWorkspaceActivity>[0]["cost"]) =>
  observeWorkspaceActivity({ workspaceId: "principal", hub, snapshot: () => snapshot, ...(cost ? { cost } : {}) });

describe("observeWorkspaceActivity", () => {
  it("conta a vida de uma tarefa: criada, iniciada, concluída (com duração e custo)", async () => {
    const observer = observe(async () => ({ costUsd: 0.1234567, tokens: 5000 }));
    hub.publish({ type: "task:upserted", task: task() });
    hub.publish({ type: "task:upserted", task: task({ status: "in_progress", ranWith: { engine: "claude", model: "sonnet" } }) });
    hub.publish({ type: "task:upserted", task: task({ status: "in_progress", prompt: "outro" }) }); // mesmo status: nada
    hub.publish({ type: "task:upserted", task: task({ status: "done" }) });
    await observer.drain();
    expect(entries.map((entry) => [entry.category, entry.action, entry.actor])).toEqual([
      ["tarefa", "criada", "usuario"],
      ["tarefa", "iniciada", "eco"],
      ["tarefa", "concluida", "eco"],
    ]);
    expect(entries[0]).toMatchObject({ workspaceId: "principal", summary: "Você pediu “Escrever o post de segunda”", refs: { taskId: "t1" } });
    expect(entries[1]!.data).toMatchObject({ engine: "claude", model: "sonnet" });
    expect(entries[2]!.data).toMatchObject({ costUsd: 0.1235, tokens: 5000 });
    expect(entries[2]!.summary).toMatch(/^ECO concluiu “Escrever o post de segunda” em /);
  });

  it("a manchete e o resumo da entrega gravados na Atividade saem sem segredo", async () => {
    const observer = observe();
    const result = "Configurei o acesso com Authorization: Bearer abcdef1234567890zzz e subi.\n\nO resumo diz: password: hunter2hunter2 ficou no arquivo, mais texto para virar resumo da entrega.";
    hub.publish({ type: "task:upserted", task: task({ id: "seg", status: "queued" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "seg", status: "done", result }) });
    await observer.drain();
    const data = entries.find((entry) => entry.action === "concluida")!.data as { headline?: string; summary?: string };
    expect(JSON.stringify(data)).not.toMatch(/abcdef1234567890zzz|hunter2hunter2/);
    expect(data.headline).toBeTruthy();
  });

  it("tarefa com outcome 'cancelled' vira 'cancelada' (não 'falhou'), mesmo sem o texto 'Cancelada'", async () => {
    const observer = observe();
    hub.publish({ type: "task:upserted", task: task({ id: "x", status: "queued" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "x", status: "failed", outcome: "cancelled", result: "Parado por você" }) });
    await observer.drain();
    expect(entries.map((entry) => entry.action)).toEqual(["criada", "cancelada"]);
  });

  it("falha, cancelamento, retomada depois da aprovação e subtarefa do Maestro", async () => {
    const observer = observe();
    hub.publish({ type: "task:upserted", task: task({ id: "pai", agentId: "maestro", status: "in_progress" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "filha", projectId: "pai", status: "queued" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "filha", projectId: "pai", status: "in_progress" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "filha", projectId: "pai", status: "waiting_approval" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "filha", projectId: "pai", status: "in_progress" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "filha", projectId: "pai", status: "failed", result: "A CLI caiu" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "outra", status: "queued" }) });
    hub.publish({ type: "task:upserted", task: task({ id: "outra", status: "failed", result: "Cancelada pelo usuário" }) });
    await observer.drain();
    const actions = entries.map((entry) => `${entry.refs?.taskId}:${entry.action}`);
    expect(actions).toEqual(["pai:criada", "pai:iniciada", "filha:criada", "filha:iniciada", "filha:retomada", "filha:falhou", "outra:criada", "outra:cancelada"]);
    expect(entries.find((entry) => entry.refs?.taskId === "filha" && entry.action === "criada")).toMatchObject({ actor: "maestro", refs: { rootTaskId: "pai" } });
    expect(entries.find((entry) => entry.action === "falhou")!.data).toMatchObject({ error: "A CLI caiu" });
  });

  it("aprovações: pedida, decidida (com edição do usuário) e cancelada", () => {
    observe();
    hub.publish({ type: "foryou:upserted", item: item() });
    hub.publish({ type: "foryou:upserted", item: item({ status: "aprovado", editedByUser: true, text: "editado", decidedAt: "2026-11-10T12:05:00.000Z" }) });
    hub.publish({ type: "foryou:upserted", item: item({ id: "A-0002" }) });
    hub.publish({ type: "foryou:upserted", item: item({ id: "A-0002", status: "cancelado", cancelledBy: "maestro", cancelReason: "mudou o plano" }) });
    expect(entries.map((entry) => [entry.action, entry.actor])).toEqual([
      ["pedida", "eco"],
      ["aprovada", "usuario"],
      ["pedida", "eco"],
      ["cancelada", "maestro"],
    ]);
    expect(entries[1]).toMatchObject({ summary: "Você aprovou: Post de segunda (com a sua edição)", data: { edited: true } });
  });

  it("recusa com motivo e retrabalho: o motivo vai no resumo e o retrabalho vira uma entrada", () => {
    const task0 = { ref: "T1", title: "Comentário 1", ownerId: "eco", steps: [{ agentId: "eco", taskId: "t1" }], current: 0, rework: { count: 0 } };
    snapshot = { ...snapshot, plans: [{ id: "p1", title: "Campanha", status: "ativo", tasks: [task0] } as unknown as Plan] };
    observe();
    hub.publish({ type: "foryou:upserted", item: item({ status: "pendente" }) });
    hub.publish({ type: "foryou:upserted", item: item({ status: "rejeitado", rejection: { reason: "tom muito formal" }, groupId: "G-1" }) });
    hub.publish({ type: "project:upserted", project: { id: "p1", title: "Campanha", status: "ativo", tasks: [{ ...task0, rework: { count: 1, last: { reason: "tom muito formal", at: "2026-11-11T12:00:00.000Z", itemId: "A-0001" } } }] } as unknown as Plan });
    expect(entries.map((entry) => `${entry.category}.${entry.action}`)).toEqual(["aprovacao.pedida", "aprovacao.rejeitada", "aprovacao.retrabalho"]);
    expect(entries[1]!.summary).toContain("motivo: “tom muito formal”");
    expect(entries[1]!.data).toMatchObject({ reason: "tom muito formal", groupId: "G-1" });
    expect(entries[2]!.summary).toBe("“Comentário 1” voltou para ECO refazer (retrabalho 1 de 2) — motivo: “tom muito formal”");
    expect(entries[2]!.data).toMatchObject({ count: 1, ref: "T1", agentId: "eco" });
  });

  it("repasse entre agentes: uma entrada por tarefa de repasse nova (e a resposta de um ask)", () => {
    const task0 = { ref: "T1", title: "Post", ownerId: "eco", steps: [{ agentId: "eco" }], current: 0, rework: { count: 0 } };
    snapshot = { ...snapshot, plans: [{ id: "p1", title: "Campanha", status: "ativo", tasks: [task0] } as unknown as Plan] };
    observe();
    const handoff = { ref: "H1", title: "Vez passada", ownerId: "ana", steps: [{ agentId: "ana" }], current: 0, rework: { count: 0 }, origin: { fromAddress: "principal/eco", fromRef: "T1", intent: "pass_on", hops: 1, at: "2026-11-11T12:00:00.000Z" } };
    const reply = { ...handoff, ref: "H2", ownerId: "eco", origin: { fromAddress: "principal/ana", fromRef: "H1", intent: "fyi", hops: 2, reply: true } };
    hub.publish({ type: "project:upserted", project: { id: "p1", title: "Campanha", status: "ativo", tasks: [task0, handoff] } as unknown as Plan });
    hub.publish({ type: "project:upserted", project: { id: "p1", title: "Campanha", status: "ativo", tasks: [task0, handoff, reply] } as unknown as Plan });
    expect(entries.map((entry) => `${entry.category}.${entry.action}`)).toEqual(["plano.repasse", "plano.repasse"]);
    expect(entries[0]!.summary).toContain("passou para");
    expect(entries[0]!.data).toMatchObject({ ref: "H1", fromRef: "T1", intent: "pass_on", hops: 1, from: "eco", to: "ana" });
    expect(entries[1]!.summary).toContain("respondeu a");
  });

  it("prioridade, prazo, começo, ritmo e pausa de um projeto viram uma entrada cada", () => {
    const project = { id: "t1", title: "Campanha", status: "ativo", priority: "normal", tasks: [] } as unknown as Plan;
    snapshot.plans = [project];
    observe();
    hub.publish({ type: "project:upserted", project: { ...project, worked: { "2026-11-11": 5 } } as Plan }); // só horas: nada
    hub.publish({ type: "project:upserted", project: { ...project, priority: "alta", dueAt: "2026-11-20T15:00:00.000Z" } });
    hub.publish({ type: "project:upserted", project: { ...project, priority: "alta", dueAt: "2026-11-20T15:00:00.000Z", startAt: "2026-11-12T12:00:00.000Z", pace: { hoursPerDay: 1 }, status: "pausado" } });
    hub.publish({ type: "project:upserted", project: { ...project, priority: "alta", status: "ativo" } });
    expect(entries.map((entry) => `${entry.category}.${entry.action}`)).toEqual(["plano.prioridade", "plano.prazo", "plano.comeco", "plano.ritmo", "plano.pausado", "plano.prazo", "plano.comeco", "plano.ritmo", "plano.retomado"]);
    expect(entries[0]!.summary).toBe("Você mudou a prioridade de “Campanha” para alta");
    expect(entries[1]!.summary).toBe("Você definiu o prazo de “Campanha” para 20/11, 12:00");
    expect(entries[5]!.summary).toBe("Você tirou o prazo de “Campanha”");
  });

  it("execuções dos horários de uma rotina: só os fins (rodou, falhou, pulada) viram entrada", () => {
    const routine = { id: "R-2", title: "Inscrições", unit: "item", site: "", target: 1, status: "ativa", createdBy: "usuario", type: "acompanhamento", schedules: [{ id: "S1", label: "E-mail" }], lastRuns: [] } as unknown as Routine;
    snapshot.routines = [routine];
    observe();
    const run = { id: "x1", scheduleId: "S1", slotKey: "2026-11-11T09:00", startedAt: "2026-11-11T12:00:00.000Z", changes: [] };
    hub.publish({ type: "routine:upserted", routine: { ...routine, lastRuns: [{ ...run, outcome: "rodando" }] } as Routine }); // rodando: nada
    hub.publish({ type: "routine:upserted", routine: { ...routine, lastRuns: [{ ...run, outcome: "ok", summary: "2 novos" }] } as Routine });
    hub.publish({ type: "routine:upserted", routine: { ...routine, lastRuns: [{ ...run, outcome: "ok", summary: "2 novos" }, { ...run, id: "x2", slotKey: "2026-11-11T13:00", outcome: "pulada", skipReason: "a execução anterior ainda está aberta" }] } as Routine });
    expect(entries.map((entry) => `${entry.category}.${entry.action}`)).toEqual(["rotina.executada", "rotina.pulada"]);
    expect(entries[0]!.summary).toBe("O horário E-mail 09:00 de “Inscrições” rodou: 2 novos");
    expect(entries[1]!.summary).toBe("O horário E-mail 13:00 de “Inscrições” foi pulado: a execução anterior ainda está aberta");
  });

  it("execução com mudanças: uma linha 'mudou' (não 'executada') e um destaque por status de alerta; itens expirados avisam uma vez", () => {
    const routine = { id: "R-2", title: "Inscrições", unit: "item", site: "", target: 1, status: "ativa", createdBy: "usuario", type: "acompanhamento", schedules: [{ id: "S1", label: "E-mail" }], lastRuns: [] } as unknown as Routine;
    snapshot.routines = [routine];
    observe();
    const run = { id: "x1", scheduleId: "S1", slotKey: "2026-11-11T09:00", startedAt: "2026-11-11T12:00:00.000Z", outcome: "ok", changes: [{ itemId: "I-0001", text: "Novo: Acme (Inscrito)", kind: "novo" }, { itemId: "I-0002", text: "Novo: Beta (Inscrito)", kind: "novo" }, { itemId: "I-0003", text: "Gama → Entrevista", kind: "status", alert: true }] };
    hub.publish({ type: "routine:upserted", routine: { ...routine, lastRuns: [run] } as unknown as Routine });
    hub.publish({ type: "routine:items", routineId: "R-2", expired: [{ itemId: "I-0004", text: "Delta → Sem resposta (fim da vida)", kind: "encerrado" }] });
    hub.publish({ type: "routine:items", routineId: "R-2" }); // sem expirados: nada
    expect(entries.map((entry) => `${entry.category}.${entry.action}`)).toEqual(["rotina.mudou", "rotina.alerta", "rotina.expirou"]);
    expect(entries[0]!.summary).toBe("Inscrições: 2 novos; Gama → Entrevista");
    expect(entries[1]!.summary).toBe("Atenção em Inscrições: Gama → Entrevista");
    expect(entries[2]!.summary).toBe("Inscrições: Delta → Sem resposta (fim da vida)");
  });

  it("rotinas, mídia, plano e agentes", () => {
    const routine = { id: "R-1", title: "Convites", unit: "convite", site: "linkedin.com", target: 10, status: "ativa", createdBy: "usuario", type: "meta", schedules: [], lastRuns: [] } as unknown as Routine;
    snapshot.routines = [routine];
    observe();
    hub.publish({ type: "routine:upserted", routine });
    hub.publish({ type: "routine:upserted", routine: { ...routine, lastDispatchAt: "2026-11-10T12:00:00Z", lastTaskId: "t9" } });
    hub.publish({ type: "routine:upserted", routine: { ...routine, status: "pausada" } });
    hub.publish({ type: "routine:entry", entry: { id: "E1", routineId: "R-1", periodKey: "2026-W46", url: "https://x.com/a", taskId: "t9", agentId: "eco", stage: "registrado", at: "2026-11-10T12:00:00Z" } as RoutineEntry });
    hub.publish({ type: "routine:closed", periodKey: "2026-W46", routineIds: ["R-1"] });
    const media = { id: "M-0001", kind: "image", origin: "html", title: "Capa", createdBy: "eco", status: "rascunho", size: 10 } as MediaItem;
    hub.publish({ type: "media:upserted", media });
    hub.publish({ type: "media:upserted", media: { ...media, status: "publicado", publishedUrl: "https://x.com/p", where: "LinkedIn" } });
    hub.publish({ type: "media:deleted", id: "M-0001" });
    const plan = { id: "t1", forYouId: "A-1", title: "Campanha", status: "proposto", tasks: [{}, {}] } as unknown as Plan;
    hub.publish({ type: "project:upserted", project: plan });
    hub.publish({ type: "project:upserted", project: { ...plan, status: "ativo" } });
    hub.publish({ type: "project:upserted", project: { ...plan, status: "concluido" } });
    hub.publish({ type: "agent:upserted", agent: agent({ status: "working" }) }); // só status: nada
    hub.publish({ type: "agent:upserted", agent: agent({ model: "opus" }) });
    hub.publish({ type: "agent:upserted", agent: agent({ id: "novo", name: "NOVO" }) });
    hub.publish({ type: "agent:deleted", id: "novo" });
    expect(entries.map((entry) => `${entry.category}.${entry.action}`)).toEqual([
      "rotina.disparou",
      "rotina.pausada",
      "rotina.registrado",
      "rotina.semana_fechada",
      "midia.criada",
      "midia.publicada",
      "midia.apagada",
      "plano.criado",
      "plano.aprovado",
      "plano.concluido",
      "agente.alterado",
      "agente.criado",
      "agente.removido",
    ]);
    expect(entries.find((entry) => entry.action === "publicada")).toMatchObject({ refs: { mediaId: "M-0001", url: "https://x.com/p" } });
    expect(entries.find((entry) => entry.action === "registrado")).toMatchObject({ refs: { url: "https://x.com/a" } });
  });

  it("não registra nada sem Atividade ligada", () => {
    setActivityLog(undefined);
    observe();
    hub.publish({ type: "task:upserted", task: task() });
    expect(entries).toHaveLength(0);
  });
});
