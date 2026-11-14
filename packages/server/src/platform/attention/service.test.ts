import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATTENTION_COALESCE_MS, ATTENTION_DEDUPE_MS, ENGINE_DOWN_SETTLE_MS, HELP_ESCALATE_MS, type AgentTerminalInfo, type AttentionServerEvent, type ForYouItem, type Project, type ServerEvent, type SubscriptionUsage, type Task } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionService, type AttentionSource } from "./service";

const T0 = new Date("2026-11-12T12:00:00.000Z");

const item = (id: string, change: Partial<ForYouItem> = {}): ForYouItem =>
  ({ id, agentId: "eco", roomId: "r", type: "post", status: "pendente", meta: {}, text: "Legenda do bolo", originalText: "Legenda do bolo", editedByUser: false, createdAt: new Date().toISOString(), title: `Post ${id}`, ...change }) as ForYouItem;

const task = (id: string, change: Partial<Task> = {}): Task => ({ id, roomId: "r", teamId: "t", agentId: "eco", prompt: `Fazer ${id}`, status: "in_progress", createdAt: T0.toISOString(), updatedAt: T0.toISOString(), ...change }) as Task;

const project = (id: string, change: Partial<Project> = {}): Project => ({ id, title: "Site novo", tasks: [], ...change }) as unknown as Project;

/** Um workspace falso: o estado é mexido pelo teste e os eventos são disparados à mão. */
function fakeSource(id: string, name = id) {
  const state = { forYou: [] as ForYouItem[], tasks: [] as Task[], projects: [] as Project[], terminals: [] as AgentTerminalInfo[] };
  const listeners = new Set<(event: ServerEvent) => void>();
  const source: AttentionSource = {
    id,
    name,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: () => ({ ...state, agents: [{ id: "eco", name: "Eco", engine: "gemini" as const }, { id: "crivo", name: "Crivo" }] }),
  };
  const emit = (event: ServerEvent) => listeners.forEach((listener) => listener(event));
  return { source, state, emit, listenerCount: () => listeners.size };
}

describe("AttentionService", () => {
  let dir: string;
  const opened: AttentionService[] = [];
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = await mkdtemp(path.join(tmpdir(), "cyno-attention-"));
  });
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((service) => service.close()));
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });

  async function setup(sources: ReturnType<typeof fakeSource>[] = [fakeSource("ws")], options: { usage?: SubscriptionUsage[]; start?: boolean } = {}) {
    const usageListeners = new Set<(event: ServerEvent) => void>();
    let usageNow = options.usage ?? [];
    let listChanged: (() => void) | undefined;
    let current = sources;
    const file = path.join(dir, "attention.json");
    const build = async () => {
      const opened_ = await AttentionService.open({
        file,
        now: () => new Date(),
        log: { error: () => undefined },
        sources: () => current.map((entry) => entry.source),
        subscribeList: (listener) => {
          listChanged = listener;
          return () => undefined;
        },
        usage: {
          subscribe: (listener) => {
            usageListeners.add(listener);
            return () => usageListeners.delete(listener);
          },
          snapshot: () => usageNow,
        },
        tickMs: 1_000,
      });
      opened.push(opened_);
      return opened_;
    };
    const service = await build();
    const events: AttentionServerEvent[] = [];
    service.subscribe((event) => events.push(event));
    if (options.start !== false) service.start();
    const raised = () => events.filter((event) => event.type === "attention:raised").map((event) => (event as { alert: import("@cyno/shared").AttentionAlert }).alert);
    return {
      service,
      events,
      raised,
      file,
      build,
      setUsage: (usage: SubscriptionUsage) => {
        usageNow = [usage];
        usageListeners.forEach((listener) => listener({ type: "usage:updated", usage }));
      },
      setSources: (next: ReturnType<typeof fakeSource>[]) => {
        current = next;
        listChanged?.();
      },
    };
  }

  const kinds = (events: AttentionServerEvent[]) => events.map((event) => event.type);

  describe("aprovações, perguntas, planos, rotinas e sprints", () => {
    it("um item pendente novo gera um alerta, uma vez, com o agente e o texto", async () => {
      const ws = fakeSource("ws", "Meu Workspace");
      const { service, events, raised } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-0001") });
      ws.emit({ type: "foryou:upserted", item: item("A-0001") });
      expect(kinds(events)).toEqual(["attention:raised"]);
      const [alert] = raised();
      expect(alert).toMatchObject({ kind: "approval", level: "alert", needsOwner: true, workspaceId: "ws", workspaceName: "Meu Workspace", agentName: "Eco", forYouId: "A-0001", count: 1 });
      expect(alert!.text).toContain("Eco pede a sua aprovação");
      expect(alert!.target).toEqual({ page: "para-voce", workspaceId: "ws", ref: "A-0001" });
      expect(alert!.replay).toBeUndefined();
      expect(service.list()).toHaveLength(1);
    });

    it("cada tipo de item vira o tipo certo de alerta", async () => {
      const ws = fakeSource("ws");
      const { raised } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1", { type: "pergunta", title: "Qual cor?" }) });
      ws.emit({ type: "foryou:upserted", item: item("A-2", { kind: "plano", agentId: "crivo" }) });
      ws.emit({ type: "foryou:upserted", item: item("A-3", { kind: "sprint", agentId: "maestro-x" }) });
      ws.emit({ type: "foryou:upserted", item: item("A-4", { kind: "rotina", agentId: "outro" }) });
      expect(raised().map((alert) => alert.kind)).toEqual(["question", "plan", "sprint", "routine"]);
      expect(raised()[0]!.text).toBe("Eco tem uma pergunta: Qual cor?");
    });

    it("item que o Modo Automático já aprovou não avisa", async () => {
      const ws = fakeSource("ws");
      const { events } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1", { status: "aprovado", decidedBy: "automatico" }) });
      expect(events).toEqual([]);
    });

    it("sumir: o item decidido (ou apagado) limpa o alerta", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      ws.emit({ type: "foryou:upserted", item: item("A-1", { status: "aprovado" }) });
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", key: "approval:ws:A-1", reason: "decided" });
      expect(service.list()).toEqual([]);
      ws.emit({ type: "foryou:upserted", item: item("A-2") });
      ws.emit({ type: "foryou:deleted", id: "A-2" });
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", reason: "resolved" });
      // decidir algo que nunca avisou não gera evento.
      const before = events.length;
      ws.emit({ type: "foryou:upserted", item: item("A-9", { status: "rejeitado" }) });
      expect(events).toHaveLength(before);
    });

    it("rajada: vários do mesmo agente em 3 s viram um alerta com a contagem", async () => {
      const ws = fakeSource("ws");
      const { service, events, raised } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      vi.advanceTimersByTime(1000);
      ws.emit({ type: "foryou:upserted", item: item("A-2") });
      vi.advanceTimersByTime(1000);
      ws.emit({ type: "foryou:upserted", item: item("A-3") });
      expect(raised()).toHaveLength(1);
      expect(kinds(events)).toEqual(["attention:raised", "attention:updated", "attention:updated"]);
      expect(service.list()[0]).toMatchObject({ count: 3, text: "Eco pediu 3 aprovações" });
      // Passou dos 3 s do primeiro: o seguinte é outro alerta.
      vi.advanceTimersByTime(ATTENTION_COALESCE_MS + 1);
      ws.emit({ type: "foryou:upserted", item: item("A-4") });
      expect(raised()).toHaveLength(2);
    });

    it("um lote (mesmo groupId) é um alerta só, mesmo com itens chegando com folga; decidir um a um baixa a contagem", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws]);
      for (const id of ["A-1", "A-2", "A-3"]) {
        ws.emit({ type: "foryou:upserted", item: item(id, { groupId: "G-1" }) });
        vi.advanceTimersByTime(10_000);
      }
      expect(service.list()).toHaveLength(1);
      expect(service.list()[0]!.count).toBe(3);
      ws.emit({ type: "foryou:upserted", item: item("A-1", { groupId: "G-1", status: "aprovado" }) });
      expect(service.list()[0]!.count).toBe(2);
      ws.emit({ type: "foryou:upserted", item: item("A-2", { groupId: "G-1", status: "aprovado" }) });
      ws.emit({ type: "foryou:upserted", item: item("A-3", { groupId: "G-1", status: "rejeitado" }) });
      expect(service.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", reason: "decided" });
    });

    it("itens de agentes diferentes não se juntam", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      ws.emit({ type: "foryou:upserted", item: item("A-2", { agentId: "crivo" }) });
      expect(service.list()).toHaveLength(2);
    });

    it("chave de repetição: reabrir o item dentro de 10 min volta quieto; depois de 10 min avisa de novo", async () => {
      const ws = fakeSource("ws");
      const { raised } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      ws.emit({ type: "foryou:upserted", item: item("A-1", { status: "aprovado" }) });
      vi.advanceTimersByTime(60_000);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      expect(raised().map((alert) => Boolean(alert.replay))).toEqual([false, true]);
      ws.emit({ type: "foryou:upserted", item: item("A-1", { status: "aprovado" }) });
      vi.advanceTimersByTime(ATTENTION_DEDUPE_MS + 5_000);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      expect(raised().map((alert) => Boolean(alert.replay))).toEqual([false, true, false]);
    });

    it("editar o texto de um item já aberto atualiza o alerta (não cria outro)", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1", { title: "Antes" }) });
      ws.emit({ type: "foryou:upserted", item: item("A-1", { title: "Depois" }) });
      expect(kinds(events)).toEqual(["attention:raised", "attention:updated"]);
      expect(service.list()[0]!.text).toContain("Depois");
    });

    it("o texto passa pela máscara de segredos e cabe em 140 caracteres", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1", { title: `chave sk-ant-api03-${"a".repeat(40)} ${"x".repeat(300)}` }) });
      const text = service.list()[0]!.text;
      expect(text.length).toBeLessThanOrEqual(140);
      expect(text).not.toContain("sk-ant-api03");
    });
  });

  describe("carga inicial, reinício e reconexão", () => {
    it("o que já esperava quando o servidor liga entra como replay (conta, mas não avisa), com a hora do item", async () => {
      const ws = fakeSource("ws");
      ws.state.forYou = [item("A-1", { createdAt: "2026-11-12T03:00:00.000Z" }), item("A-2", { status: "aprovado" })];
      const { service } = await setup([ws]);
      const open = service.list();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ key: "approval:ws:A-1", replay: true, at: "2026-11-12T03:00:00.000Z" });
    });

    it("um evento do mesmo item depois do boot não vira aviso novo", async () => {
      const ws = fakeSource("ws");
      ws.state.forYou = [item("A-1")];
      const { events } = await setup([ws]);
      const before = events.length;
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      expect(events.length).toBe(before);
    });

    it("antes de start() nada é lido nem assinado", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws], { start: false });
      expect(ws.listenerCount()).toBe(0);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      expect(events).toEqual([]);
      expect(service.list()).toEqual([]);
    });

    it("tarefa que já tinha falhado antes do boot não gera alerta", async () => {
      const ws = fakeSource("ws");
      ws.state.tasks = [task("T-1", { status: "failed" })];
      const { service } = await setup([ws]);
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed" }) });
      expect(service.list()).toEqual([]);
    });

    it("workspace novo entra na escuta; o excluído leva os alertas dele", async () => {
      const a = fakeSource("a");
      const b = fakeSource("b");
      const { service, setSources } = await setup([a]);
      a.emit({ type: "foryou:upserted", item: item("A-1") });
      setSources([a, b]);
      b.emit({ type: "foryou:upserted", item: item("B-1") });
      expect(service.list().map((alert) => alert.workspaceId)).toEqual(["a", "b"]);
      setSources([b]);
      expect(service.list().map((alert) => alert.workspaceId)).toEqual(["b"]);
      expect(a.listenerCount()).toBe(0);
    });
  });

  describe("entrega", () => {
    it("pedido do dono concluído gera um aviso discreto (info, não conta no número) com a manchete; não repete nem nasce na carga", async () => {
      const ws = fakeSource("ws");
      ws.state.tasks.push(task("R-0", { role: "request", status: "done", result: "Antigo. Já estava pronto." }));
      const { service, events } = await setup([ws]);
      expect(service.list()).toEqual([]);
      ws.emit({ type: "task:upserted", task: task("R-1", { role: "request", status: "in_progress" }) });
      ws.emit({ type: "task:upserted", task: task("R-1", { role: "request", status: "done", result: "O post do bolo ficou pronto. Segue o texto completo abaixo.\n\nMais um parágrafo com detalhes do que foi feito durante a entrega." }) });
      ws.emit({ type: "task:upserted", task: task("R-1", { role: "request", status: "done", result: "O post do bolo ficou pronto." }) });
      const [alert] = service.list();
      expect(alert).toMatchObject({ kind: "delivery", level: "info", needsOwner: false, taskId: "R-1", agentName: "Eco", target: { page: "trabalho", workspaceId: "ws", ref: "R-1" } });
      expect(alert!.text).toContain("O post do bolo ficou pronto.");
      expect(events.filter((event) => event.type === "attention:raised")).toHaveLength(1);
      // Sem "Visto", some sozinho em 24 h.
      vi.advanceTimersByTime(24 * 3_600_000 + 2_000);
      expect(service.list()).toEqual([]);
    });

    it("pedido cancelado ou sem resultado não é entrega; projeto que vira concluído é", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "task:upserted", task: task("R-1", { role: "request", status: "in_progress" }) });
      ws.emit({ type: "task:upserted", task: task("R-1", { role: "request", status: "done", outcome: "cancelled", result: "Cancelado." }) });
      ws.emit({ type: "task:upserted", task: task("R-2", { role: "request", status: "in_progress" }) });
      ws.emit({ type: "task:upserted", task: task("R-2", { role: "request", status: "done" }) });
      expect(service.list()).toEqual([]);
      ws.emit({ type: "project:upserted", project: project("P-1", { status: "ativo" }) });
      ws.emit({ type: "project:upserted", project: project("P-1", { status: "concluido" }) });
      expect(service.list()).toMatchObject([{ kind: "delivery", level: "info", needsOwner: false, projectId: "P-1", text: "Projeto Site novo concluído" }]);
    });
  });

  describe("tarefa que falhou", () => {
    it("falhar gera um aviso (warn, não conta no número); voltar a andar limpa", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws]);
      ws.emit({ type: "task:upserted", task: task("T-1") });
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed" }) });
      expect(service.list()[0]).toMatchObject({ kind: "failed", level: "warn", needsOwner: false, taskId: "T-1", agentName: "Eco", target: { page: "trabalho", workspaceId: "ws", ref: "T-1" } });
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed" }) });
      expect(events.filter((event) => event.type === "attention:raised")).toHaveLength(1);
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "in_progress" }) });
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", key: "failed:ws:T-1", reason: "resolved" });
    });

    it("cancelada, o pedido do Maestro e tarefa que nunca falhou não avisam", async () => {
      const ws = fakeSource("ws");
      const { events } = await setup([ws]);
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed", outcome: "cancelled" }) });
      ws.emit({ type: "task:upserted", task: task("R-1", { status: "failed", role: "request" }) });
      ws.emit({ type: "task:upserted", task: task("T-2", { status: "done" }) });
      expect(events).toEqual([]);
    });

    it("falhar de novo (a mesma tarefa, depois de tentar outra vez) sobe o alerta para alert", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed" }) });
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "in_progress" }) });
      vi.advanceTimersByTime(1000);
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed" }) });
      expect(service.list()[0]!.level).toBe("alert");
    });

    it("3 falhas do mesmo projeto em 60 s viram um alerta", async () => {
      const ws = fakeSource("ws");
      ws.state.projects = [project("P-1")];
      const { service } = await setup([ws]);
      for (const id of ["T-1", "T-2", "T-3"]) {
        ws.emit({ type: "task:upserted", task: task(id, { status: "failed", projectId: "P-1" }) });
        vi.advanceTimersByTime(10_000);
      }
      expect(service.list()).toHaveLength(1);
      expect(service.list()[0]).toMatchObject({ count: 3, text: "3 tarefas falharam em Site novo" });
    });

    it("\"Visto\" tira o alerta, não deixa voltar depois do reinício e sobrevive no arquivo", async () => {
      const ws = fakeSource("ws");
      const { service, file, build, events } = await setup([ws]);
      ws.emit({ type: "task:upserted", task: task("T-1", { status: "failed" }) });
      await service.idle();
      const stored = JSON.parse(await readFile(file, "utf8")) as { open: { key: string }[] };
      expect(stored.open.map((alert) => alert.key)).toEqual(["failed:ws:T-1"]);
      // Reinício com a tarefa ainda falhada: o alerta volta (quieto)...
      ws.state.tasks = [task("T-1", { status: "failed" })];
      const second = await build();
      second.start();
      expect(second.list()[0]).toMatchObject({ key: "failed:ws:T-1", replay: true });
      // ... até o dono marcar como visto.
      expect(second.markSeen("failed:ws:T-1")).toBe("ok");
      await second.idle();
      const third = await build();
      third.start();
      expect(third.list()).toEqual([]);
      expect(events).toBeDefined();
      expect(service.markSeen("nao-existe")).toBe("not-found");
    });

    it("o que espera o dono não aceita \"Visto\"", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      expect(service.markSeen("approval:ws:A-1")).toBe("not-allowed");
      expect(service.list()).toHaveLength(1);
    });
  });

  describe("pedido de ajuda", () => {
    const withHelp = (what: string, kind?: "access" | "skill", at = new Date().toISOString()): Project =>
      project("P-1", { tasks: [{ ref: "T1", title: "Feed", help: [{ agentId: "eco", what, ...(kind ? { kind } : {}), at }], blocked: { type: kind === "access" ? "acesso" : "agente", note: "Esperando o Maestro", since: at }, note: "Esperando o Maestro" }] as never });
    // O pedido foi respondido (ou soltou): o bloqueio sai, mas o histórico do pedido continua em `help`.
    const released = (what: string, kind?: "access" | "skill"): Project => ({ ...withHelp(what, kind), tasks: [{ ...(withHelp(what, kind).tasks[0] as object), blocked: undefined, note: undefined }] as never });

    it("pedido de acesso chama o dono na hora", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "project:upserted", project: withHelp("Preciso do login do Instagram", "access") });
      expect(service.list()[0]).toMatchObject({ kind: "help", level: "alert", needsOwner: true, agentName: "Eco" });
      expect(service.list()[0]!.text).toContain("precisa de um acesso");
    });

    it("o histórico de pedidos antigos (tarefa que já andou) não vira alerta, nem no boot", async () => {
      const ws = fakeSource("ws");
      ws.state.projects = [released("Acesso antigo", "access")];
      const { service } = await setup([ws]);
      expect(service.list()).toEqual([]);
    });

    it("pedido de skill só chama se o Maestro não resolver em 5 minutos", async () => {
      const ws = fakeSource("ws");
      const { service } = await setup([ws]);
      ws.emit({ type: "project:upserted", project: withHelp("Preciso de uma skill de vídeo", "skill") });
      expect(service.list()).toEqual([]);
      vi.advanceTimersByTime(HELP_ESCALATE_MS - 5_000);
      expect(service.list()).toEqual([]);
      vi.advanceTimersByTime(10_000);
      expect(service.list()[0]).toMatchObject({ kind: "help", needsOwner: true });
    });

    it("o Maestro responder (o pedido sai) antes dos 5 min: nunca avisa; depois dos 5 min: limpa", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws]);
      ws.emit({ type: "project:upserted", project: withHelp("Ajuda", "skill") });
      vi.advanceTimersByTime(60_000);
      ws.emit({ type: "project:upserted", project: released("Ajuda", "skill") });
      vi.advanceTimersByTime(HELP_ESCALATE_MS);
      expect(events).toEqual([]);
      ws.emit({ type: "project:upserted", project: withHelp("Acesso", "access") });
      expect(service.list()).toHaveLength(1);
      ws.emit({ type: "project:upserted", project: released("Acesso", "access") });
      expect(service.list()).toEqual([]);
    });
  });

  describe("terminal que caiu", () => {
    const terminal = (status: AgentTerminalInfo["status"]): AgentTerminalInfo => ({ agentId: "eco", engine: "gemini", status, updatedAt: new Date().toISOString() });

    it("só avisa se o erro fica; voltar limpa", async () => {
      const ws = fakeSource("ws");
      const { service, events } = await setup([ws]);
      ws.state.terminals = [terminal("error")];
      ws.emit({ type: "agent:terminal", terminal: terminal("error") });
      vi.advanceTimersByTime(ENGINE_DOWN_SETTLE_MS - 1000);
      expect(service.list()).toEqual([]);
      vi.advanceTimersByTime(2000);
      expect(service.list()[0]).toMatchObject({ kind: "engine_down", needsOwner: true, text: "Antigravity de Eco caiu e não voltou", target: { page: "agente", ref: "eco" } });
      ws.state.terminals = [terminal("idle")];
      ws.emit({ type: "agent:terminal", terminal: terminal("idle") });
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", reason: "resolved" });
    });

    it("workspace apagado durante a espera de 45 s não deixa alerta órfão", async () => {
      const ws = fakeSource("ws");
      const { service, setSources, events } = await setup([ws]);
      ws.state.terminals = [terminal("error")];
      ws.emit({ type: "agent:terminal", terminal: terminal("error") });
      vi.advanceTimersByTime(ENGINE_DOWN_SETTLE_MS - 1000);
      setSources([]);
      vi.advanceTimersByTime(ENGINE_DOWN_SETTLE_MS * 2);
      expect(service.list()).toEqual([]);
      expect(events.filter((event) => event.type === "attention:raised")).toEqual([]);
    });

    it("renomear o workspace vale para os alertas novos", async () => {
      const ws = fakeSource("ws", "Antigo");
      const { service, setSources } = await setup([ws]);
      // O serviço segue ouvindo a fonte original; só a lista de workspaces mudou (renomear).
      setSources([{ ...ws, source: { ...ws.source, name: "Novo nome" } }]);
      ws.state.terminals = [terminal("error")];
      ws.emit({ type: "agent:terminal", terminal: terminal("error") });
      vi.advanceTimersByTime(ENGINE_DOWN_SETTLE_MS + 1000);
      expect(service.list()[0]).toMatchObject({ kind: "engine_down", workspaceName: "Novo nome" });
    });

    it("queda que se recupera (erro, depois subindo) não avisa", async () => {
      const ws = fakeSource("ws");
      const { events } = await setup([ws]);
      ws.state.terminals = [terminal("error")];
      ws.emit({ type: "agent:terminal", terminal: terminal("error") });
      vi.advanceTimersByTime(5_000);
      ws.state.terminals = [terminal("starting")];
      ws.emit({ type: "agent:terminal", terminal: terminal("starting") });
      vi.advanceTimersByTime(ENGINE_DOWN_SETTLE_MS * 2);
      expect(events).toEqual([]);
    });
  });

  describe("limite de uso", () => {
    const usage = (utilization: number, status?: string): SubscriptionUsage => ({
      provider: "claude",
      windows: [{ id: "five_hour", utilization, resetsAt: new Date(T0.getTime() + 3 * 3_600_000).toISOString(), ...(status ? { status } : {}) }],
      updatedAt: new Date().toISOString(),
    });

    it("80% avisa (warn), 95% e esgotado chamam (alert); nunca conta no número", async () => {
      const { service, setUsage, raised } = await setup([fakeSource("ws")]);
      setUsage(usage(0.5));
      expect(service.list()).toEqual([]);
      setUsage(usage(0.82));
      expect(service.list()[0]).toMatchObject({ kind: "usage", level: "warn", needsOwner: false, target: { page: "gestao", ref: "gastos" } });
      expect(service.list()[0]!.text).toBe("Claude Code: 5 h em 82%, volta às 12h");
      setUsage(usage(0.84));
      setUsage(usage(0.96));
      expect(service.list()).toHaveLength(1);
      expect(service.list()[0]).toMatchObject({ level: "alert", needsOwner: false });
      setUsage(usage(1));
      expect(service.list()[0]!.text).toBe("Claude Code: 5 h esgotada, volta às 12h");
      expect(raised().map((alert) => alert.level)).toEqual(["warn", "alert", "alert"]);
    });

    it("histerese: só rearma quando cai 5 pontos; renovar a janela limpa", async () => {
      const { service, setUsage, raised, events } = await setup([fakeSource("ws")]);
      setUsage(usage(0.85));
      setUsage(usage(0.78));
      expect(service.list()).toHaveLength(1);
      setUsage(usage(0.84));
      expect(raised()).toHaveLength(1);
      setUsage(usage(0.2));
      expect(service.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", reason: "resolved" });
      setUsage(usage(0.9));
      expect(raised()).toHaveLength(2);
    });

    it("o alerta de limite sai sozinho (não aceita \"Visto\")", async () => {
      const { service, setUsage } = await setup([fakeSource("ws")]);
      setUsage(usage(0.9));
      const key = service.list()[0]!.key;
      expect(service.markSeen(key)).toBe("not-allowed");
      expect(service.list()).toHaveLength(1);
    });

    it("janela rejected conta como esgotada; já acima de 80% no boot entra quieto", async () => {
      const { service, setUsage } = await setup([fakeSource("ws")], { usage: [usage(0.9)] });
      expect(service.list()[0]).toMatchObject({ kind: "usage", replay: true });
      setUsage(usage(0.5, "rejected"));
      expect(service.list()[0]!.text).toContain("esgotada");
    });

    it("alerta de limite expira quando a janela passa", async () => {
      const { service, setUsage, events } = await setup([fakeSource("ws")]);
      setUsage(usage(0.97));
      vi.advanceTimersByTime(3 * 3_600_000 + 2_000);
      expect(service.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "attention:cleared", reason: "expired" });
    });
  });

  describe("preferências e arquivo", () => {
    it("as preferências da conta valem depois de reabrir; silenciar não apaga o alerta", async () => {
      const ws = fakeSource("ws");
      const { service, build } = await setup([ws]);
      service.updatePrefs({ mutedWorkspaces: { ws: {} }, kinds: { delivery: false }, dndUntil: "2026-11-12T20:00:00.000Z" });
      ws.emit({ type: "foryou:upserted", item: item("A-1") });
      expect(service.list()).toHaveLength(1);
      await service.idle();
      const again = await build();
      expect(again.prefs()).toEqual({ mutedWorkspaces: { ws: {} }, kinds: { delivery: false }, dndUntil: "2026-11-12T20:00:00.000Z" });
      again.updatePrefs({ dndUntil: null });
      expect(again.prefs().dndUntil).toBeUndefined();
    });

    it("arquivo quebrado: começa com os padrões", async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(dir, "attention.json"), "{ isso não é json");
      const { service } = await setup([fakeSource("ws")]);
      expect(service.prefs()).toEqual({ mutedWorkspaces: {}, kinds: {} });
    });
  });

  describe("orçamento (J2-09)", () => {
    it("80% é aviso e 100% é alerta, nenhum entra no número da aba; cada degrau nasce uma vez por período", async () => {
      const { service, raised } = await setup([fakeSource("ws")]);
      service.raiseBudget({ ref: "dia-2026-11-12-80", level: "warn", text: "Orçamento hoje em 82%: US$ 4,10 de US$ 5,00 equiv.", expiresAt: T0.getTime() + 3_600_000 });
      service.raiseBudget({ ref: "dia-2026-11-12-100", level: "alert", text: "Orçamento hoje estourado: US$ 5,00 de US$ 5,00 equiv.", expiresAt: T0.getTime() + 3_600_000 });
      expect(raised().map((alert) => [alert.kind, alert.level, alert.needsOwner])).toEqual([
        ["budget", "warn", false],
        ["budget", "alert", false],
      ]);
      expect(raised()[0]!.target).toEqual({ page: "gestao", ref: "gastos" });
      // Repetir o mesmo degrau do mesmo período não cria outro alerta.
      service.raiseBudget({ ref: "dia-2026-11-12-80", level: "warn", text: "Orçamento hoje em 83%: US$ 4,15 de US$ 5,00 equiv.", expiresAt: T0.getTime() + 3_600_000 });
      expect(service.list().filter((alert) => alert.kind === "budget")).toHaveLength(2);
      // O alerta é de orçamento, sem o dono precisar decidir: some sozinho no fim do período.
      await vi.advanceTimersByTimeAsync(3_700_000);
      expect(service.list().filter((alert) => alert.kind === "budget")).toEqual([]);
    });

    it("o alerta de orçamento aceita \"Visto\": some do sino e não volta no mesmo degrau e período", async () => {
      const { service } = await setup([fakeSource("ws")]);
      const input = { ref: "mes-2026-11-100", level: "alert" as const, text: "Orçamento do mês estourado", expiresAt: T0.getTime() + 20 * 86_400_000 };
      service.raiseBudget(input);
      const key = service.list()[0]!.key;
      expect(service.markSeen(key)).toBe("ok");
      expect(service.list()).toEqual([]);
      // O vigia repete o aviso; passados mais de 24 h, ainda no mesmo período, continua quieto.
      service.raiseBudget(input);
      expect(service.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(3 * 86_400_000);
      service.raiseBudget(input);
      expect(service.list()).toEqual([]);
      // Outro degrau do mesmo período nasce normalmente.
      service.raiseBudget({ ...input, ref: "mes-2026-11-80", level: "warn" });
      expect(service.list()).toHaveLength(1);
    });

    it("clearBudget tira só os alertas que não passam no filtro", async () => {
      const { service } = await setup([fakeSource("ws")]);
      service.raiseBudget({ ref: "dia-2026-11-12-80", level: "warn", text: "a" });
      service.raiseBudget({ ref: "dia-2026-11-12-100", level: "alert", text: "b" });
      service.clearBudget((ref) => ref === "dia-2026-11-12-80");
      expect(service.list().map((alert) => alert.key)).toEqual(["budget:plataforma:dia-2026-11-12-80"]);
      service.clearBudget();
      expect(service.list()).toEqual([]);
    });
  });
});

