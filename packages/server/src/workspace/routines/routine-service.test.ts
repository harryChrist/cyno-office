import { readFile } from "node:fs/promises";
import path from "node:path";
import { emptyRoutinesData, type ForYouItem, type RoutineProposalPayload, type ServerEvent, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { RoutineService, RoutineToolError } from "./routine-service";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
// As gravações do routines.json terminam antes de a pasta temporária sair.
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

/** Segunda 2026-11-09 11:00 em São Paulo (W46). */
const NOW = new Date("2026-11-09T14:00:00Z");

async function setup() {
  const dir = await tempDir();
  const file = path.join(dir, "routines.json");
  const events: ServerEvent[] = [];
  const cards: RoutineProposalPayload[] = [];
  let clock = NOW;
  const queue = new WriteQueue();
  queues.push(queue);
  const service = new RoutineService(emptyRoutinesData(), {
    file,
    queue,
    publish: (event) => events.push(event),
    owners: {
      agent: (id) => (id === "clara" ? { id, name: "Clara", teamId: "time" } : undefined),
      team: (id) => (id === "time" ? { id, name: "Time" } : undefined),
    },
    openCard: (payload) => {
      cards.push(payload);
      return { id: "A-0001" } as ForYouItem;
    },
    log: { warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  const task = (patch: Partial<Task> = {}): Task => ({ id: "t1", roomId: "r", teamId: "time", agentId: "clara", prompt: "Rotina: x", status: "in_progress", routineId: "R-0001", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...patch });
  const proposeInput = { title: "Convites", unit: "convite", kind: "invite" as const, site: "linkedin.com", target: 100, agentId: "clara", instruction: "Convide devs" };
  const activate = (overrides?: { needsApproval?: boolean; target?: number; dailyCap?: number }) => {
    const { routine } = service.propose(proposeInput);
    service.decide({ routine: cards.at(-1), id: "A-0001" } as ForYouItem, { status: "aprovado", ...(overrides ? { routine: overrides } : {}) });
    return routine.id;
  };
  return { service, file, events, cards, queue, task, activate, proposeInput, setClock: (date: Date) => (clock = date) };
}

describe("RoutineService: proposta e ativação", () => {
  it("o Maestro propõe: nasce proposta, limita a meta ao teto do site e abre o cartão", async () => {
    const { service, cards, proposeInput } = await setup();
    const { routine, targetClamped } = service.propose({ ...proposeInput, suggestedNeedsApproval: false });
    expect(routine).toMatchObject({ id: "R-0001", status: "proposta", target: 60, needsApproval: true, createdBy: "maestro" });
    expect(targetClamped).toBe(true);
    expect(cards[0]).toMatchObject({ routineId: "R-0001", mode: "criar", owner: "Clara", target: 60, needsApproval: true, suggestedNeedsApproval: false, limits: { daily: 15, weekly: 60 } });
  });

  it("aprovar ativa; sem ajuste continua pedindo OK (a sugestão do Maestro não vale)", async () => {
    const { service, activate } = await setup();
    const id = activate();
    expect(service.get(id)).toMatchObject({ status: "ativa", needsApproval: true });
  });

  it("aprovar com ajustes do usuário: sem OK, meta e teto", async () => {
    const { service, activate } = await setup();
    const id = activate({ needsApproval: false, target: 20, dailyCap: 5 });
    expect(service.get(id)).toMatchObject({ status: "ativa", needsApproval: false, target: 20, dailyCap: 5 });
  });

  it("rejeitar ou descartar arquiva a proposta; decidir de novo dá 409", async () => {
    const { service, cards, proposeInput } = await setup();
    service.propose(proposeInput);
    const item = { id: "A-0001", routine: cards[0] } as ForYouItem;
    service.decide(item, { status: "rejeitado" });
    expect(service.get("R-0001").status).toBe("encerrada");
    expect(() => service.decide(item, { status: "aprovado" })).toThrow(/já foi decidida/);
    service.propose(proposeInput);
    service.itemCancelled({ id: "A-0002", routine: cards[1] } as ForYouItem);
    expect(service.get("R-0002").status).toBe("encerrada");
  });

  it("dono inexistente ou os dois donos: erro", async () => {
    const { service, proposeInput } = await setup();
    expect(() => service.propose({ ...proposeInput, agentId: "nao-existe" })).toThrow(/não existe/);
    expect(() => service.propose({ ...proposeInput, teamId: "time" })).toThrow(/OU/);
  });

  it("o usuário cria direto (ativa) e edita; proposta não edita", async () => {
    const { service, proposeInput } = await setup();
    const created = service.create({ title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 20, period: "week", teamId: "time", needsApproval: true, instruction: "" });
    expect(created).toMatchObject({ status: "ativa", target: 7 });
    expect(service.update(created.id, { target: 3, needsApproval: false, skipThisPeriod: true })).toMatchObject({ target: 3, needsApproval: false, skipPeriods: ["2026-W46"] });
    service.propose(proposeInput);
    expect(() => service.update("R-0002", { target: 1 })).toThrow(/espera a sua decisão/);
  });

  it("o Maestro só pausa rotina ativa", async () => {
    const { service, activate } = await setup();
    const id = activate();
    expect(service.pauseByMaestro(id).status).toBe("pausada");
    expect(() => service.pauseByMaestro(id)).toThrow(RoutineToolError);
  });

  it("grava routines.json e publica os eventos", async () => {
    const { file, events, queue, activate } = await setup();
    const id = activate();
    await queue.idle();
    const disk = JSON.parse(await readFile(file, "utf8")) as { routines: { id: string; status: string }[] };
    expect(disk.routines).toMatchObject([{ id, status: "ativa" }]);
    expect(events.filter((event) => event.type === "routine:upserted")).toHaveLength(2);
  });
});

describe("RoutineService: registro, entrega e descarte", () => {
  it("registra, deduplica o link, e só entrega quando a tarefa termina done", async () => {
    const { service, task, activate } = await setup();
    const id = activate();
    const running = task();
    const first = service.record({ task: running, agentId: "clara", routineId: id, url: "https://www.linkedin.com/in/ana/" });
    expect(first).toMatchObject({ todayCount: 1, cap: 15 });
    expect(() => service.record({ task: running, agentId: "clara", routineId: id, url: "https://linkedin.com/in/ana" })).toThrow(/already recorded/);
    service.record({ task: running, agentId: "clara", routineId: id, url: "https://linkedin.com/in/bia", note: "Bia" });
    expect(service.entries.map((entry) => entry.stage)).toEqual(["registrado", "registrado"]);
    // Tarefa ainda não terminou: nada conta.
    service.onTaskUpdate(task({ status: "waiting_approval" }));
    expect(service.entries.every((entry) => entry.stage === "registrado")).toBe(true);
    service.onTaskUpdate(task({ status: "done" }));
    expect(service.entries.map((entry) => entry.stage)).toEqual(["entregue", "entregue"]);
    expect(service.entries[0]!.settledAt).toBeDefined();
  });

  it("meta batida: um evento só, quando a entrega chega ao alvo (nem antes, nem repetido no mesmo período)", async () => {
    const { service, task, activate, events } = await setup();
    const id = activate({ target: 2 });
    const hits = () => events.filter((event) => event.type === "routine:goal-hit");
    service.record({ task: task({ id: "t1" }), agentId: "clara", routineId: id, url: "https://linkedin.com/in/ana" });
    service.onTaskUpdate(task({ id: "t1", status: "done" }));
    expect(hits()).toHaveLength(0);
    service.record({ task: task({ id: "t2" }), agentId: "clara", routineId: id, url: "https://linkedin.com/in/bia" });
    service.onTaskUpdate(task({ id: "t2", status: "done" }));
    expect(hits()).toMatchObject([{ type: "routine:goal-hit", routineId: id, delivered: 2, target: 2, agentId: "clara", title: "Convites" }]);
    // Uma entrega a mais, no mesmo período, não comemora de novo.
    service.record({ task: task({ id: "t3" }), agentId: "clara", routineId: id, url: "https://linkedin.com/in/caio" });
    service.onTaskUpdate(task({ id: "t3", status: "done" }));
    expect(hits()).toHaveLength(1);
  });

  it("tarefa que falhou descarta os itens, e o link pode ser registrado de novo", async () => {
    const { service, task, activate } = await setup();
    const id = activate();
    service.record({ task: task(), agentId: "clara", routineId: id, url: "https://linkedin.com/in/ana" });
    service.onTaskUpdate(task({ status: "failed" }));
    expect(service.entries[0]!.stage).toBe("descartado");
    service.record({ task: task({ id: "t2" }), agentId: "clara", routineId: id, url: "https://linkedin.com/in/ana" });
    expect(service.entries.map((entry) => entry.stage)).toEqual(["descartado", "registrado"]);
  });

  it("valida o agente, a tarefa da rotina, o site, o link e o status", async () => {
    const { service, task, activate } = await setup();
    const id = activate();
    const call = (patch: { task?: Task | undefined; agentId?: string; routineId?: string; url?: string }) =>
      service.record({ task: task(), agentId: "clara", routineId: id, url: "https://linkedin.com/in/x", ...patch });
    expect(() => call({ task: undefined })).toThrow(/no task in progress/);
    expect(() => call({ agentId: "outra" })).toThrow(/no task in progress/);
    expect(() => call({ task: task({ routineId: "R-0009" }) })).toThrow(/does not belong/);
    expect(() => call({ task: task({ routineId: undefined }) })).toThrow(/does not belong/);
    expect(() => call({ routineId: "R-0009" })).toThrow(/does not exist/);
    expect(() => call({ url: "https://evil.com/in/x" })).toThrow(/must be on linkedin.com/);
    expect(() => call({ url: "javascript:alert(1)" })).toThrow(/full http/);
    service.pauseByMaestro(id);
    expect(() => call({})).toThrow(/pausada/);
  });

  it("recusa registro acima do teto diário", async () => {
    const { service, task, activate } = await setup();
    const id = activate({ dailyCap: 2 });
    for (const name of ["a", "b"]) service.record({ task: task(), agentId: "clara", routineId: id, url: `https://linkedin.com/in/${name}` });
    expect(() => service.record({ task: task(), agentId: "clara", routineId: id, url: "https://linkedin.com/in/c" })).toThrow(/Daily cap reached \(2\/2/);
  });

  it("o teto diário vira no dia seguinte (fuso de São Paulo)", async () => {
    const { service, task, activate, setClock } = await setup();
    const id = activate({ dailyCap: 1 });
    service.record({ task: task(), agentId: "clara", routineId: id, url: "https://linkedin.com/in/a" });
    expect(service.todayCount(id)).toBe(1);
    setClock(new Date("2026-11-10T14:00:00Z"));
    expect(service.todayCount(id)).toBe(0);
    expect(() => service.record({ task: task(), agentId: "clara", routineId: id, url: "https://linkedin.com/in/b" })).not.toThrow();
  });
});

describe("RoutineService: fechamento e meta", () => {
  it("fecha o período com bateu / não bateu / pulada e conta a sequência ruim", async () => {
    const { service, task, activate, setClock } = await setup();
    const hit = activate({ target: 1 });
    const miss = activate({ target: 5 });
    const skipped = activate({ target: 5 });
    service.update(skipped, { skipThisPeriod: true });
    service.record({ task: task(), agentId: "clara", routineId: hit, url: "https://linkedin.com/in/a" });
    service.onTaskUpdate(task({ status: "done" }));
    setClock(new Date("2026-11-16T14:00:00Z"));
    const results = service.closePeriod("2026-W46");
    expect(Object.fromEntries(results.map((result) => [result.routineId, result.outcome]))).toEqual({ [hit]: "bateu", [miss]: "nao_bateu", [skipped]: "pulada" });
    expect(service.closedPeriod()).toBe("2026-W46");
    expect(service.badStreak(miss)).toBe(1);
    service.closePeriod("2026-W47");
    expect(service.badStreak(miss)).toBe(2);
    expect(service.history(service.get(miss), setClock(new Date("2026-11-23T14:00:00Z"))).map((point) => point.outcome)).toContain("nao_bateu");
  });
});

describe("RoutineService: permissão sem OK (grant) e prova de execução", () => {
  it("libera só com rotina sem OK, clique, rótulo do tipo e host do site", async () => {
    const { service, activate } = await setup();
    const comment = service.create({ title: "Comentários", unit: "comentário", kind: "comment", site: "linkedin.com", target: 10, period: "week", agentId: "clara", needsApproval: false, instruction: "" });
    const ask = service.create({ title: "Comentários com OK", unit: "comentário", kind: "comment", site: "linkedin.com", target: 10, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    expect(service.grant(comment.id, "www.linkedin.com", "Comentar", "click")).toEqual({ allowed: true, routineId: comment.id });
    expect(service.grant(comment.id, "linkedin.com", "Post", "click")).toMatchObject({ allowed: true });
    // rótulo proibido, host de outro site, ação que não é clique, rotina que pede OK, tarefa sem rotina
    expect(service.grant(comment.id, "linkedin.com", "Conectar", "click")).toBeNull();
    expect(service.grant(comment.id, "linkedin.com", "Enviar mensagem", "click")).toBeNull();
    expect(service.grant(comment.id, "facebook.com", "Comentar", "click")).toBeNull();
    expect(service.grant(comment.id, "linkedin.com", "Comentar", "submit")).toBeNull();
    expect(service.grant(ask.id, "linkedin.com", "Comentar", "click")).toBeNull();
    expect(service.grant(undefined, "linkedin.com", "Comentar", "click")).toBeNull();
    expect(service.grant("R-0099", "linkedin.com", "Comentar", "click")).toBeNull();
    void activate;
  });

  it("para no teto diário contando as execuções do dia e não libera pausada", async () => {
    const { service } = await setup();
    const routine = service.create({ title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 5, period: "week", agentId: "clara", needsApproval: false, instruction: "" });
    expect(service.grant(routine.id, "linkedin.com", "Publicar", "click")).not.toBeNull();
    service.noteExecution({ routineId: routine.id, host: "linkedin.com", label: "Publicar", actionKind: "click", agentId: "clara", via: "rotina" });
    expect(service.executionsToday(routine.id)).toBe(1);
    // post: 1 por dia
    expect(service.grant(routine.id, "linkedin.com", "Publicar", "click")).toBeNull();
    const other = service.create({ title: "Posts 2", unit: "post", kind: "post", site: "linkedin.com", target: 5, period: "week", agentId: "clara", needsApproval: false, instruction: "" });
    service.update(other.id, { status: "pausada" });
    expect(service.grant(other.id, "linkedin.com", "Publicar", "click")).toBeNull();
  });
});

describe("RoutineService: remapRunProject (tarefa avulsa virou projeto)", () => {
  it("as execuções que apontam para as Tasks movidas passam a apontar para o projeto novo; as outras ficam", async () => {
    const { service, activate, events } = await setup();
    const id = activate();
    service.addRun(id, { projectId: "avulsas", taskId: "t1", startedAt: NOW.toISOString(), outcome: "rodando" });
    service.addRun(id, { projectId: "avulsas", taskId: "t2", startedAt: NOW.toISOString(), outcome: "ok" });
    events.length = 0;
    expect(service.remapRunProject(new Set(["t1"]), "proj-novo")).toBe(1);
    const runs = service.get(id).lastRuns;
    expect(runs.map((run) => [run.taskId, run.projectId])).toEqual([
      ["t1", "proj-novo"],
      ["t2", "avulsas"],
    ]);
    expect(events.some((event) => event.type === "routine:upserted")).toBe(true);
    // Nada a mudar: não publica de novo.
    events.length = 0;
    expect(service.remapRunProject(new Set(["t1"]), "proj-novo")).toBe(0);
    expect(events).toHaveLength(0);
  });
});
