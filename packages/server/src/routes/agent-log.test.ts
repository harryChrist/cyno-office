import type { AgentLogEntry, AgentLogResponse, ServerEvent, Task, TaskLogResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, soloTeam, wsApi } from "../dev/test-api";
import { gatedSleep, testRunner, useTestApp, type EventLog } from "../dev/test-app";

const setupApp = useTestApp();

/** Entradas agent:log publicadas para a tarefa (a última versão de cada id, na ordem de criação). */
function logOf(log: EventLog, taskId: string): AgentLogEntry[] {
  const byId = new Map<string, AgentLogEntry>();
  for (const event of log.events) if (event.type === "agent:log" && event.entry.taskId === taskId) byId.set(event.entry.id, event.entry);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

const describeEntry = (entry: AgentLogEntry) => {
  switch (entry.kind) {
    case "status":
      return `status:${entry.status}`;
    case "approval":
      return entry.phase === "asked" ? "approval:asked" : `approval:${entry.approved ? "approved" : "rejected"}`;
    case "subagent":
      return `subagent:${entry.phase}`;
    default:
      return entry.kind;
  }
};

const isLogFor = (taskId: string, predicate: (entry: AgentLogEntry) => boolean) => (event: ServerEvent) =>
  event.type === "agent:log" && event.entry.taskId === taskId && predicate(event.entry);

describe("Log de trabalho: orquestrador", () => {
  it("fluxo feliz: started, narração e ferramentas do runner, progresso, resultado e done (pelo GET também)", async () => {
    const { app, log } = await setupApp();
    const task = await createTask(app, "projetox", "projetox-frontend", "Criar a tela de pedidos");
    await log.waitForTask(task.id, "done");
    const entries = logOf(log, task.id);
    const kinds = entries.map(describeEntry);
    expect(kinds[0]).toBe("status:started");
    expect(kinds.slice(-2)).toEqual(["result", "status:done"]);
    expect(kinds).toContain("text");
    expect(kinds).toContain("tool");
    expect(kinds.filter((kind) => kind === "progress").length).toBeGreaterThanOrEqual(4);
    expect(entries.filter((entry) => entry.kind === "tool").every((entry) => entry.kind === "tool" && entry.status === "ok")).toBe(true);
    // Só o que veio do runner leva o provedor.
    expect(entries.find((entry) => entry.kind === "text")!.provider).toBe("mock");
    expect(entries[0]!.provider).toBeUndefined();

    const body = await call<TaskLogResponse>(app, "GET", `${wsApi()}/tasks/${task.id}/log`);
    expect(body).toEqual({ taskId: task.id, entries, threads: [] });

    const agentLog = await call<AgentLogResponse>(app, "GET", `${wsApi()}/agents/${task.agentId}/log?limit=3`);
    expect(agentLog.entries).toEqual(entries.slice(-3));
    expect(agentLog.summary).toEqual({ activeSubagents: 0 });
  });

  it("aprovação: asked (com o item do Para você) e waiting; aprovar -> decided e resumed", async () => {
    const { app, log } = await setupApp();
    const task = await createTask(app, "projetox", "projetox-backend", "Migrar o banco [aprovar]");
    await log.waitForTask(task.id, "waiting_approval");
    await log.waitFor(isLogFor(task.id, (entry) => entry.kind === "status" && entry.status === "waiting"));
    const asked = logOf(log, task.id).find((entry) => entry.kind === "approval");
    expect(asked).toMatchObject({ kind: "approval", phase: "asked", forYouId: "A-0001", question: expect.stringContaining("aprovação") });

    await call<Task>(app, "POST", `${wsApi()}/tasks/${task.id}/approval`, { approved: true }, 200);
    await log.waitForTask(task.id, "done");
    const kinds = logOf(log, task.id).map(describeEntry);
    const at = kinds.indexOf("approval:asked");
    expect(kinds.slice(at, at + 4)).toEqual(["approval:asked", "status:waiting", "approval:approved", "status:resumed"]);
    expect(kinds.at(-1)).toBe("status:done");
  });

  it("aprovação recusada com nota: decided rejeitada e failed com o motivo", async () => {
    const { app, log } = await setupApp();
    const task = await createTask(app, "projetox", "projetox-backend", "Apagar tudo [aprovar]");
    await log.waitForTask(task.id, "waiting_approval");
    const items = await call<{ id: string; taskId: string }[]>(app, "GET", `${wsApi()}/for-you`);
    const item = items.find((candidate) => candidate.taskId === task.id)!;
    await call(app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "rejeitado", response: "arriscado demais" }, 200);
    const entries = logOf(log, task.id);
    expect(entries.slice(-2)).toEqual([
      expect.objectContaining({ kind: "approval", phase: "decided", approved: false, note: "arriscado demais" }),
      expect.objectContaining({ kind: "status", status: "failed", message: "Recusado pelo usuário: arriscado demais" }),
    ]);
  });

  it("agente removido no meio: a ferramenta aberta fecha com erro e a tarefa fica canceled", async () => {
    // A primeira espera (antes da ferramenta) passa; a seguinte segura com a ferramenta aberta.
    const gate = gatedSleep();
    let calls = 0;
    const sleep: typeof gate.sleep = (ms, signal) => (++calls <= 1 ? Promise.resolve() : gate.sleep(ms, signal));
    const { app, log } = await setupApp({ runner: testRunner({ sleep }) });
    const { room, team, agent } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Algo demorado");
    await log.waitFor(isLogFor(task.id, (entry) => entry.kind === "tool"));
    await call(app, "DELETE", `${wsApi()}/agents/${agent.id}`);
    const entries = logOf(log, task.id);
    expect(entries.find((entry) => entry.kind === "tool")).toMatchObject({ status: "error", output: "Interrompida: tarefa cancelada" });
    expect(entries.at(-1)).toMatchObject({ kind: "status", status: "canceled", message: "Cancelada: o agente foi removido" });
    gate.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nada do runner chega depois do cancelamento.
    expect(logOf(log, task.id)).toHaveLength(entries.length);
  });

  it("subagentes do MockRunner: threads no GET, filtro ?thread= e resumo com subagentes ativos", async () => {
    const { app, log } = await setupApp({ runner: testRunner({ subagentRate: 1, random: () => 0.99 }) });
    const { room, team, agent } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Pesquisar concorrentes");
    await log.waitForTask(task.id, "done");

    const body = await call<TaskLogResponse>(app, "GET", `${wsApi()}/tasks/${task.id}/log`);
    expect(body.threads).toHaveLength(3);
    expect(body.threads.every((thread) => thread.status === "ok" && thread.label.startsWith(`${agent.name} · `))).toBe(true);
    const tagged = body.entries.filter((entry) => entry.thread !== undefined);
    expect(new Set(tagged.map((entry) => entry.thread))).toEqual(new Set(body.threads.map((thread) => thread.id)));

    const first = body.threads[0]!;
    const one = await call<TaskLogResponse>(app, "GET", `${wsApi()}/tasks/${task.id}/log?thread=${first.id}`);
    expect(one.entries.length).toBeGreaterThan(0);
    expect(one.entries.every((entry) => entry.thread === first.id)).toBe(true);
    expect(one.entries.map((entry) => entry.kind)).toEqual(["text", "progress", "tool", "progress", "result"]);
    const main = await call<TaskLogResponse>(app, "GET", `${wsApi()}/tasks/${task.id}/log?thread=main`);
    expect(main.entries.filter((entry) => entry.kind === "subagent")).toHaveLength(6);
  });

  it("resumo do agente conta os subagentes rodando agora", async () => {
    // O primeiro passo (brain.search: 2 esperas) passa direto; depois tudo para no portão.
    const gate = gatedSleep();
    let calls = 0;
    const sleep: typeof gate.sleep = (ms, signal) => (++calls <= 2 ? Promise.resolve() : gate.sleep(ms, signal));
    const { app, log } = await setupApp({ runner: testRunner({ subagentRate: 1, random: () => 0.3, sleep }) });
    const { room, team, agent } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Pesquisar concorrentes");
    await log.waitFor(isLogFor(task.id, (entry) => entry.kind === "subagent" && entry.phase === "started"));
    const during = await call<AgentLogResponse>(app, "GET", `${wsApi()}/agents/${agent.id}/log`);
    expect(during.summary).toEqual({ activeTaskId: task.id, activeSubagents: 2 });
    gate.open();
    await log.waitForTask(task.id, "done");
    const after = await call<AgentLogResponse>(app, "GET", `${wsApi()}/agents/${agent.id}/log`);
    expect(after.summary).toEqual({ activeSubagents: 0 });
    expect(after.entries.filter((entry) => entry.kind === "subagent" && entry.phase === "finished")).toHaveLength(2);
  });
});

describe("Log de trabalho: Maestro", () => {
  it("triagem com pontuação e motivo, delegação, espera, revisão e resultado", async () => {
    const { app, log } = await setupApp();
    const task = await call<Task>(app, "POST", `${wsApi()}/tasks`, { prompt: "Pesquisar referências sobre agentes" });
    await log.waitForTask(task.id, "done");
    const entries = logOf(log, task.id);
    expect(entries.map(describeEntry)).toEqual([
      "status:started",
      "text",
      "text",
      "delegation",
      "status:waiting",
      "text",
      "result",
      "status:done",
    ]);
    expect(entries[1]).toMatchObject({ kind: "text", text: "Lendo o pedido…" });
    expect(entries[2]).toMatchObject({ kind: "text", text: expect.stringContaining("Pontuação dos times:") });
    expect(entries[2]!.kind === "text" && entries[2]!.text).toContain("**Pesquisa**");
    expect(entries[3]).toMatchObject({ kind: "delegation", teamId: "projetoy-pesquisa", reason: expect.stringContaining("'pesquisar'") });
    expect(entries.every((entry) => entry.agentId === "maestro")).toBe(true);

    const maestro = await call<AgentLogResponse>(app, "GET", `${wsApi()}/agents/maestro/log`);
    expect(maestro.entries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });
});

describe("Log de trabalho: rotas", () => {
  it("valida params e query; 404 para tarefa sem log; agente desconhecido = lista vazia", async () => {
    const { app } = await setupApp();
    await call(app, "GET", `${wsApi()}/tasks/..%2Fetc/log`, undefined, 400);
    await call(app, "GET", `${wsApi()}/tasks/nao-existe/log?thread=a%20b`, undefined, 400);
    await call(app, "GET", `${wsApi()}/agents/Ana/log`, undefined, 400);
    await call(app, "GET", `${wsApi()}/agents/ana/log?limit=0`, undefined, 400);
    await call(app, "GET", `${wsApi()}/agents/ana/log?limit=9999`, undefined, 400);
    await call(app, "GET", `${wsApi()}/tasks/nao-existe/log`, undefined, 404);
    const empty = await call<AgentLogResponse>(app, "GET", `${wsApi()}/agents/ninguem/log`);
    expect(empty).toEqual({ agentId: "ninguem", entries: [], summary: { activeSubagents: 0 } });
    await call(app, "GET", `/api/w/nao-existe/agents/ana/log`, undefined, 404);
  });
});
