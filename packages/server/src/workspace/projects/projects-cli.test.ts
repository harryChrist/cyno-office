import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { AgentLogEntry, ForYouItem, Plan, ServerEvent, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { FAKE_CLI } from "../../engines/terminals/process-terminal.test";

const setupApp = useTestApp();
const tempDir = useTempDirs();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

type Ctx = TestApp & { messageLog: string };

/** App com a CLI falsa (Maestro e agentes de time no motor claude; o MCP chamado por HTTP de verdade). */
async function setup(): Promise<Ctx> {
  const dir = await tempDir();
  const port = await freePort();
  const messageLog = path.join(dir, "messages.jsonl");
  const testApp = await setupApp({
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 1,
      backoffMs: () => 10,
      stopGraceMs: 2000,
      claude: { command: process.execPath, prefixArgs: [FAKE_CLI] },
      gemini: { command: "/nao-existe/agy" },
      env: { ...process.env, FAKE_CLI_STATE: path.join(dir, "fake-state"), FAKE_CLI_MESSAGES: messageLog, ANTHROPIC_API_KEY: "sk-ant-NAO-PODE" },
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  for (const id of ["maestro", "clara", "beto"]) {
    const response = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: { engine: "claude" } });
    expect(response.statusCode).toBe(200);
  }
  return { ...testApp, messageLog };
}

/** Mensagens que a CLI falsa recebeu (todas as sessões). */
async function messages(ctx: Ctx): Promise<string[]> {
  return (await readFile(ctx.messageLog, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((raw) => (JSON.parse(raw) as { text: string }).text);
}

const say = (ctx: TestApp, text: string) => ctx.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text } });

async function openedRequest(ctx: TestApp, title: string): Promise<Task> {
  const event = await ctx.log.waitFor((candidate) => candidate.type === "task:upserted" && candidate.task.agentId === "maestro" && candidate.task.prompt.startsWith(title), 8000);
  return (event as Extract<ServerEvent, { type: "task:upserted" }>).task;
}

async function waitTask(ctx: TestApp, id: string, status: Task["status"], timeoutMs = 10_000): Promise<Task> {
  await ctx.log.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === status, timeoutMs);
  return ctx.store.snapshot().tasks.find((task) => task.id === id)!;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("condição não chegou a tempo");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const forYou = async (ctx: TestApp) => (await ctx.app.inject({ method: "GET", url: `${API}/for-you` })).json() as ForYouItem[];

describe("planos com a CLI falsa (Maestro e agentes de CLI)", () => {
  it("planejar → aprovar → etapas passam adiante sozinhas → o Maestro recebe UMA mensagem no fim e conclui na conversa", async () => {
    const ctx = await setup();
    await say(ctx, "[abrir] [planejar:clara,beto] Campanha do produto");
    const request = await openedRequest(ctx, "Campanha do produto");
    const proposed = (await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === request.id, 8000)) as Extract<ServerEvent, { type: "project:upserted" }>;
    const plan: Plan = proposed.project;
    expect(plan.tasks.map((task) => task.steps.map((step) => step.agentId))).toEqual([["clara"], ["clara", "beto"]]);
    await waitTask(ctx, request.id, "waiting_approval");
    // O turno da conversa acabou e o pedido NÃO fechou (está esperando a aprovação).
    await until(async () => (await messages(ctx)).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ctx.store.snapshot().tasks.find((task) => task.id === request.id)!.status).toBe("waiting_approval");
    expect(ctx.store.snapshot().agents.find((agent) => agent.id === "maestro")!.status).toBe("waiting_approval");

    expect((await ctx.app.inject({ method: "POST", url: `${API}/plans/${plan.id}/approve` })).statusCode).toBe(200);
    const done = await waitTask(ctx, request.id, "done", 20_000);
    expect(done.result).toBe("Resposta final do Maestro. Pedido " + request.id + ": o projeto terminou — 2 de 2 concluídas.");

    const all = await messages(ctx);
    const toMaestro = all.filter((text) => text.includes(`Pedido ${request.id}`));
    // Uma mensagem só para o Maestro durante a execução: o fim do plano (nenhum "Resultado da tarefa").
    expect(toMaestro.filter((text) => text.includes("o projeto terminou"))).toHaveLength(1);
    expect(all.some((text) => text.startsWith("Resultado da tarefa"))).toBe(false);
    // A passagem: Beto recebe o que Clara entregou na etapa 1 de T2.
    const steps = ctx.store.snapshot().tasks.filter((task) => task.projectId === request.id && task.work);
    const claraStep = steps.find((task) => task.work!.ref === "T2" && task.work!.step === 0)!;
    const betoStep = steps.find((task) => task.work!.ref === "T2" && task.work!.step === 1)!;
    expect(betoStep.agentId).toBe("beto");
    expect(betoStep.prompt).toContain(`- Etapa 1 (Clara): Feito pelo fake: Tarefa ${claraStep.id}:`);
    // A resposta final também aparece na conversa.
    const agentLog = (await ctx.app.inject({ method: "GET", url: `${API}/agents/maestro/log` })).json() as { entries: AgentLogEntry[] };
    expect(agentLog.entries.some((entry) => entry.kind === "chat" && entry.from === "agent" && entry.text.startsWith("**Pedido concluído: Campanha do produto**"))).toBe(true);
  }, 40_000);

  it("questionário do Maestro: o rascunho das respostas não acorda ninguém; enviar acorda o Maestro uma vez com todas", async () => {
    const ctx = await setup();
    await say(ctx, "[abrir] [perguntas] Algo vago");
    const request = await openedRequest(ctx, "Algo vago");
    await waitTask(ctx, request.id, "waiting_approval");
    await until(async () => (await forYou(ctx)).some((item) => item.kind === "questionario"));
    const item = (await forYou(ctx)).find((candidate) => candidate.kind === "questionario")!;
    expect(item).toMatchObject({ taskId: request.id, projectId: request.id, status: "pendente", questions: [{ id: "q1", text: "Qual o público?", options: ["devs", "gestores"], default: "devs" }, { id: "q2", text: "Qual o tom?" }] });
    await until(async () => (await messages(ctx)).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = (await messages(ctx)).length;

    const draft = await ctx.app.inject({ method: "PATCH", url: `${API}/for-you/${item.id}/answers`, payload: { answers: { q1: { text: "gestores" } } } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ status: "pendente", answers: { q1: { text: "gestores" } } });
    await ctx.app.inject({ method: "PATCH", url: `${API}/for-you/${item.id}/answers`, payload: { answers: { q2: { skipped: true } } } });
    expect((await ctx.app.inject({ method: "PATCH", url: `${API}/for-you/${item.id}/answers`, payload: { answers: { q9: { text: "x" } } } })).statusCode).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await messages(ctx)).toHaveLength(before);

    const sent = await ctx.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/submit` });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: "respondido" });
    const done = await waitTask(ctx, request.id, "done");
    expect(done.result).toContain("Respostas do usuário ao seu questionário");
    const after = (await messages(ctx)).slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("1. Qual o público?\n   → gestores\n2. Qual o tom?\n   → decida você");
    expect((await ctx.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/submit` })).statusCode).toBe(409);
  }, 30_000);

  it("pedido que termina com uma pergunta ao usuário fica esperando (não fecha com a pergunta como resultado)", async () => {
    const ctx = await setup();
    const created = await ctx.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[perguntar] Escreva um post" } });
    const request = created.json() as Task;
    const waiting = await waitTask(ctx, request.id, "waiting_approval");
    expect(waiting.waiting).toBe("O Maestro fez uma pergunta na conversa");
    expect(waiting.result).toBeUndefined();
    // A pergunta aparece na conversa.
    const agentLog = (await ctx.app.inject({ method: "GET", url: `${API}/agents/maestro/log` })).json() as { entries: AgentLogEntry[] };
    expect(agentLog.entries.some((entry) => entry.kind === "chat" && entry.text === "Antes de seguir: qual tom você prefere?")).toBe(true);

    // Aberto numa conversa e terminando com pergunta: também espera.
    await say(ctx, "[abrir] [perguntar] Roteiro do vídeo");
    const opened = await openedRequest(ctx, "Roteiro do vídeo");
    expect((await waitTask(ctx, opened.id, "waiting_approval")).waiting).toBe("O Maestro fez uma pergunta na conversa");
  }, 30_000);

  it("agente pede informação numa etapa: só a tarefa dele espera e só ele é acordado; request_help acorda o Maestro uma vez", async () => {
    const ctx = await setup();
    await say(ctx, "[abrir] [planejar:clara,beto] [etapa:info] Pesquisa com dúvidas");
    const request = await openedRequest(ctx, "Pesquisa com dúvidas");
    const proposed = (await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === request.id, 8000)) as Extract<ServerEvent, { type: "project:upserted" }>;
    await ctx.app.inject({ method: "POST", url: `${API}/plans/${proposed.project.id}/approve` });
    await until(async () => (await forYou(ctx)).some((item) => item.kind === "questionario" && item.agentId === "clara"), 10_000);
    const item = (await forYou(ctx)).find((candidate) => candidate.kind === "questionario" && candidate.agentId === "clara")!;
    expect(item).toMatchObject({ projectId: request.id, taskRef: "T1" });
    await until(() => ctx.workspaces.get("principal").plans.get(proposed.project.id).tasks[0]!.status === "esperando_voce");
    // Questionário (ask_user) espera respostas, não aprovação: o texto diz isso (na tarefa e no log).
    const step = ctx.store.snapshot().tasks.find((task) => task.projectId === request.id && task.agentId === "clara" && task.status === "waiting_approval")!;
    expect(step.waiting).toBe("Esperando suas respostas");
    const stepLog = (await ctx.app.inject({ method: "GET", url: `${API}/tasks/${step.id}/log` })).json() as { entries: { kind: string; message?: string; questions?: number }[] };
    expect(stepLog.entries).toContainEqual(expect.objectContaining({ kind: "approval", questions: 1 }));
    expect(stepLog.entries).toContainEqual(expect.objectContaining({ kind: "status", message: "Esperando suas respostas" }));
    const before = await messages(ctx);
    await ctx.app.inject({ method: "PATCH", url: `${API}/for-you/${item.id}/answers`, payload: { answers: { q1: { text: "artigos" } } } });
    await ctx.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/submit` });
    await waitTask(ctx, request.id, "done", 20_000);
    const after = (await messages(ctx)).slice(before.length);
    // Depois de enviar: a resposta foi para Clara (não para o Maestro); o Maestro só recebeu o fim do plano.
    expect(after.filter((text) => text.startsWith("Respostas do usuário (“Dúvidas da pesquisa”"))).toHaveLength(1);
    expect(after.filter((text) => text.startsWith("Respostas do usuário (") && text.includes("Qual a fonte preferida?\n   → artigos"))).toHaveLength(1);
    expect(after.filter((text) => text.includes(`Pedido ${request.id}`))).toHaveLength(1);

    // request_help: uma mensagem para o Maestro, a tarefa segue.
    await say(ctx, "[abrir] [planejar:clara,beto] [etapa:ajuda] Post com design");
    const second = await openedRequest(ctx, "Post com design");
    const plan2 = (await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === second.id, 8000)) as Extract<ServerEvent, { type: "project:upserted" }>;
    await ctx.app.inject({ method: "POST", url: `${API}/plans/${plan2.project.id}/approve` });
    await waitTask(ctx, second.id, "done", 20_000);
    const toMaestro = (await messages(ctx)).filter((text) => text.includes(`Pedido ${second.id}`));
    expect(toMaestro.filter((text) => text.includes("pediu ajuda"))).toHaveLength(1);
    expect(toMaestro.filter((text) => text.includes("o projeto terminou"))).toHaveLength(1);
    expect(ctx.workspaces.get("principal").plans.get(plan2.project.id).tasks[0]!.help).toMatchObject([{ agentId: "clara", what: "Falta alguém de design", suggestedAgentId: "lia" }]);
  }, 60_000);
});
