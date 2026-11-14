import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { ASK_LIMITS, parseAskMarker, parseRequestMarker, type AgentLogEntry, type AskRecord, type Project, type SentRequestView } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { FAKE_CLI } from "../../engines/terminals/process-terminal.test";
import { AskLedger, AskRefused } from "./asks";
import { JsonRecords } from "./records";
import { WriteQueue } from "../../store/write-queue";
import { briefingMessage } from "./cyno-requests";

vi.setConfig({ testTimeout: 30_000 });

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

/** App com a CLI falsa: o Cyno e o Maestro/agentes do "principal" no motor claude (o MCP chamado por HTTP de verdade). */
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
    expect((await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: { engine: "claude" } })).statusCode).toBe(200);
  }
  return { ...testApp, messageLog };
}

const messages = async (ctx: Ctx): Promise<string[]> =>
  (await readFile(ctx.messageLog, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((raw) => (JSON.parse(raw) as { text: string }).text);

/** Mensagens que são do Maestro (o briefing do Cyno, a resposta a um ask_cyno, um recado do Cyno ou a fala do dono a ele). */
const isForMaestro = (text: string) => ["Briefing completo do Cyno", "[Resposta do Cyno", "[Sem resposta do Cyno", "[Mensagem do Cyno", "[ask-cyno]"].some((mark) => text.includes(mark));
const toMaestro = async (ctx: Ctx) => (await messages(ctx)).filter(isForMaestro);
const toCyno = async (ctx: Ctx) => (await messages(ctx)).filter((text) => !isForMaestro(text) && !text.includes("Pode olhar o rascunho"));

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error("a condição não chegou a tempo");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sayCyno = (ctx: Ctx, text: string) => ctx.app.inject({ method: "POST", url: "/api/cyno/messages", payload: { text } });
const sayMaestro = (ctx: Ctx, text: string) => ctx.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text } });
const cynoEntries = async (ctx: Ctx) => (await ctx.app.inject({ method: "GET", url: "/api/cyno" })).json<{ entries: AgentLogEntry[] }>().entries;
const requests = async (ctx: Ctx) => (await ctx.app.inject({ method: "GET", url: "/api/cyno/requests" })).json<{ requests: SentRequestView[] }>().requests;
const project = (ctx: Ctx, id: string): Project | undefined => ctx.app.workspaces.get("principal").plans.list().find((item) => item.id === id);

/** Manda o pedido pelo Cyno falso e espera o id aparecer na lista. */
async function sendOne(ctx: Ctx): Promise<string> {
  expect((await sayCyno(ctx, "[pedir:principal] manda o post do café")).statusCode).toBe(202);
  return (await until(async () => (await requests(ctx))[0]?.projectId))!;
}

describe("Cyno: send_request", () => {
  it("cria o pedido no workspace com origin cyno e o brief gravado no Projeto, e acorda o Maestro UMA vez com o briefing completo", async () => {
    const ctx = await setup();
    const id = await sendOne(ctx);
    const created = project(ctx, id)!;
    expect(created).toMatchObject({ origin: "cyno", kind: "tarefa", title: "Post sobre café", priority: "normal" });
    expect(created.brief).toContain("post curto sobre café");
    expect(created.doneWhen?.map((item) => item.text)).toEqual(["até 600 caracteres"]);
    // O pedido do Maestro e o projeto têm o mesmo id; a origem aparece no log do pedido.
    const request = ctx.store.snapshot().tasks.find((task) => task.id === id)!;
    expect(request).toMatchObject({ role: "request", agentId: "maestro" });

    const received = await until(async () => (await toMaestro(ctx))[0]);
    expect(received).toContain("[Briefing completo do Cyno, em nome do dono]");
    expect(received).toContain("NÃO refaça ao dono");
    expect(received).toContain("Agentes sugeridos pelo Cyno");
    expect(received).toContain(id);
    // Uma mensagem só ao Maestro (o servidor acorda uma vez), mesmo depois de ele fechar o pedido.
    await until(async () => (await requests(ctx))[0]?.state === "concluido");
    expect(await toMaestro(ctx)).toHaveLength(1);
    // O arquivo dos pedidos enviados (sobrevive ao reinício).
    const saved = JSON.parse(await readFile(path.join(ctx.dataDir, "platform", "sent-requests.json"), "utf8")) as { items: { projectId: string; workspace: string }[] };
    expect(saved.items).toMatchObject([{ projectId: id, workspace: "principal" }]);
  });

  it("o chat do Cyno ganha o cartão do pedido (marca) e, quando o Maestro conclui, um aviso passivo SEM acordar o Cyno", async () => {
    const ctx = await setup();
    const id = await sendOne(ctx);
    const marker = (await until(async () => (await cynoEntries(ctx)).find((entry) => entry.kind === "status" && parseRequestMarker(entry.message) !== undefined)))!;
    expect(marker.kind === "status" && parseRequestMarker(marker.message)).toMatchObject({ workspace: "principal", projectId: id, title: "Post sobre café" });
    const notice = await until(async () => (await cynoEntries(ctx)).find((entry) => entry.kind === "status" && entry.message.includes("concluído")));
    expect(notice).toBeTruthy();
    // Só a mensagem do dono chegou ao Cyno; o aviso não o acordou.
    expect(await toCyno(ctx)).toHaveLength(1);
    // Na próxima vez que acordar, a mudança vem junto, uma vez.
    await sayCyno(ctx, "e agora?");
    const next = await until(async () => (await toCyno(ctx))[1]);
    expect(next).toContain(`request ${id} "Post sobre café" (principal) is now DONE`);
    await sayCyno(ctx, "mais uma");
    expect((await until(async () => (await toCyno(ctx))[2]))!).not.toContain("is now DONE");
  });

  it("get_request_status lê o estado por código: não acorda o Maestro nem outro agente", async () => {
    const ctx = await setup();
    const id = await sendOne(ctx);
    await until(async () => (await requests(ctx))[0]?.state === "concluido");
    const before = (await messages(ctx)).length;
    await sayCyno(ctx, `[estado:${id}] como está?`);
    await until(async () => (await messages(ctx)).length === before + 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await messages(ctx);
    // Só a pergunta do dono ao Cyno; nenhuma mensagem nova a Maestro ou agentes.
    expect(after).toHaveLength(before + 1);
    expect(await toMaestro(ctx)).toHaveLength(1);
    const reply = (await cynoEntries(ctx)).filter((entry) => entry.kind === "chat" && entry.from === "agent").at(-1)!;
    expect(reply.kind === "chat" && reply.text).toContain(`Request ${id} "Post sobre café" → workspace principal`);
    expect(reply.kind === "chat" && reply.text).toContain("concluído");
  });

  it("o mesmo pedido repetido não é enviado de novo (um turno só do Maestro)", async () => {
    const ctx = await setup();
    // Um Maestro que não fecha o pedido deixa-o aberto: a duplicata é barrada pelo título.
    const send = ctx.app.cyno.tools().find((tool) => tool.name === "send_request")!;
    const input = { workspace: "principal", title: "Post duplicado", brief: "Escrever um post curto sobre café para o LinkedIn com tom leve e revisão." };
    const first = await send.call(input);
    expect(first.isError).toBeUndefined();
    const second = await send.call(input);
    expect(second.text).toContain("already exists");
    expect(await requests(ctx)).toHaveLength(1);
  });

  it("recusa workspace inexistente, briefing curto e Maestro que não roda em CLI, com o motivo", async () => {
    const ctx = await setup();
    const send = ctx.app.cyno.tools().find((tool) => tool.name === "send_request")!;
    expect((await send.call({ workspace: "nada", title: "Post", brief: "x".repeat(60) })).text).toContain('No workspace "nada"');
    expect(send.input.safeParse({ workspace: "principal", title: "Post", brief: "curto" }).success).toBe(false);
    await ctx.app.inject({ method: "PATCH", url: `${API}/agents/maestro`, payload: { engine: "mock" } });
    const refused = await send.call({ workspace: "principal", title: "Post", brief: "x".repeat(60) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("does not run on a CLI engine");
  });

  it("update_request pausa e muda a prioridade; cancel_request fecha o pedido do Cyno (sem aviso passivo)", async () => {
    const ctx = await setup();
    const tools = ctx.app.cyno.tools();
    const send = tools.find((tool) => tool.name === "send_request")!;
    // O Maestro falso conclui o pedido sozinho; para testar o que está aberto, pausamos antes de ele fechar: usa um pedido novo.
    const sent = await send.call({ workspace: "principal", title: "Para mexer", brief: "Escrever um post curto sobre café para o LinkedIn com tom leve e revisão.", priority: "high", due_at: "2030-01-10" });
    const id = /Request id: ([0-9a-f-]{36})/.exec(sent.text)![1]!;
    expect(project(ctx, id)).toMatchObject({ priority: "alta", dueAt: "2030-01-10T00:00:00.000Z" });
    const update = tools.find((tool) => tool.name === "update_request")!;
    const changed = await update.call({ request_id: id, priority: "low", paused: true });
    expect(changed.isError).toBeUndefined();
    expect(project(ctx, id)).toMatchObject({ priority: "baixa" });
    expect((await update.call({ request_id: "nada", paused: true })).isError).toBe(true);
    await until(async () => ctx.store.snapshot().tasks.find((task) => task.id === id)?.status !== "in_progress" && (await requests(ctx))[0]?.state === "concluido");
    const cancel = tools.find((tool) => tool.name === "cancel_request")!;
    expect((await cancel.call({ request_id: id, reason: "teste" })).text).toContain("already");
  });
});

describe("Cyno: message_agent", () => {
  it("fala com o Maestro (conversa, não pedido) e com um agente de time; deixa claro que veio do Cyno; não cria tarefa", async () => {
    const ctx = await setup();
    const tools = ctx.app.cyno.tools();
    const talk = tools.find((tool) => tool.name === "message_agent")!;
    const tasksBefore = ctx.store.snapshot().tasks.length;
    expect((await talk.call({ workspace: "principal", agent: "maestro", message: "Qual o status da semana?" })).text).toContain("Delivered to");
    const heard = await until(async () => (await messages(ctx)).find((text) => text.includes("[Mensagem do Cyno, o agente da plataforma, em nome do dono] Qual o status")));
    expect(heard).toBeTruthy();
    expect((await talk.call({ workspace: "principal", agent: "Clara", message: "Pode olhar o rascunho?" })).text).toContain("Delivered to Clara");
    expect(await until(async () => (await messages(ctx)).find((text) => text.includes("Pode olhar o rascunho?")))).toContain("[Mensagem do Cyno");
    expect(ctx.store.snapshot().tasks).toHaveLength(tasksBefore);
    const missing = await talk.call({ workspace: "principal", agent: "Fulano", message: "oi" });
    expect(missing.isError).toBe(true);
  });
});

describe("Cyno: ask_cyno", () => {
  it("o Maestro pergunta, o Cyno é acordado com a pergunta, a resposta volta como mensagem na conversa do Maestro e o chat do dono mostra as linhas discretas", async () => {
    const ctx = await setup();
    expect((await sayMaestro(ctx, "[ask-cyno] [responder:A-0001] preciso da imagem que o Design fez")).statusCode).toBe(202);
    const asked = await until(async () => (await toCyno(ctx)).find((text) => text.includes("[Help request from the Maestro of workspace")));
    expect(asked).toContain("question A-0001");
    expect(asked).toContain("answer_maestro");
    const answer = await until(async () => (await toMaestro(ctx)).find((text) => text.includes("[Resposta do Cyno à sua pergunta A-0001]")));
    expect(answer).toContain("Use a imagem M-0001 do workspace Design.");
    expect(answer).toContain("abrir outra");
    // A gravação vai pela fila: espera o arquivo refletir a resposta.
    const savedAsks = async () => JSON.parse(await readFile(path.join(ctx.dataDir, "platform", "asks.json"), "utf8").catch(() => '{"items":[]}')) as { items: AskRecord[] };
    const saved = { items: (await until(async () => ((await savedAsks()).items[0]?.status === "respondido" ? (await savedAsks()).items : undefined)))! };
    expect(saved.items[0]).toMatchObject({ id: "A-0001", workspace: "principal", status: "respondido", answer: "Use a imagem M-0001 do workspace Design." });
    const lines = (await until(async () => {
      const entries = (await cynoEntries(ctx)).flatMap((entry) => (entry.kind === "status" ? (parseAskMarker(entry.message) ?? []) : []));
      return entries.length >= 2 ? entries : undefined;
    }))!;
    expect(lines[0]).toContain("Maestro de ");
    expect(lines[0]).toContain("perguntou");
    expect(lines[1]).toContain("Cyno respondeu ao Maestro");
    // O turno da pergunta não vira balão de conversa com o dono.
    expect((await cynoEntries(ctx)).filter((entry) => entry.kind === "chat" && entry.from === "agent")).toHaveLength(0);
    // Uma resposta só por pergunta.
    const answerTool = ctx.app.cyno.tools().find((tool) => tool.name === "answer_maestro")!;
    expect((await answerTool.call({ ask_id: "A-0001", message: "de novo" })).text).toContain("already closed");
  });

  it("sem resposta do Cyno no texto final do turno, o texto final é a resposta", async () => {
    const ctx = await setup();
    await sayMaestro(ctx, "[ask-cyno] quem cuida de design?");
    const answer = await until(async () => (await toMaestro(ctx)).find((text) => text.includes("[Resposta do Cyno à sua pergunta A-0001]")));
    expect(answer).toContain("eco:");
  });

  it("os limites do servidor chegam ao Maestro como erro com o motivo (e a pergunta barrada não acorda o Cyno)", async () => {
    const ctx = await setup();
    const runtime = ctx.app.workspaces.get("principal");
    const maestroTools = runtime.officeTools("maestro");
    const ask = maestroTools.find((tool) => tool.name === "ask_cyno")!;
    // O Cyno falso responde cada pergunta pelo texto do turno; fecha-se uma de cada vez, e o teto por hora conta todas.
    for (let index = 0; index < ASK_LIMITS.perWorkspaceHour; index += 1) {
      const sent = await ask.call({ question: `pergunta ${index}` });
      expect(sent.isError).toBeUndefined();
      await until(async () => ctx.app.cyno.askList().find((item) => item.message === `pergunta ${index}`)?.status === "respondido");
    }
    // O erro vira resultado com isError no protocolo MCP; aqui a chamada direta lança com o mesmo texto.
    const refused = await Promise.resolve()
      .then(() => ask.call({ question: "mais uma" }))
      .catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("Limit reached");
    expect((refused as Error).message).toContain("ask_user");
    expect(ctx.app.cyno.askList()).toHaveLength(ASK_LIMITS.perWorkspaceHour);
  });
});

describe("Cyno: escopos das ferramentas", () => {
  it("o agente de workspace não tem as ferramentas do Cyno; o Cyno não tem as do Maestro; ask_cyno é só do Maestro", async () => {
    const ctx = await setup();
    const runtime = ctx.app.workspaces.get("principal");
    const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
    const worker = names(runtime.officeTools("clara"));
    const maestro = names(runtime.officeTools("maestro"));
    const cyno = names(ctx.app.cyno.tools());
    for (const name of ["send_request", "get_request_status", "list_sent_requests", "message_agent", "cancel_request", "update_request", "answer_maestro"]) {
      expect(cyno).toContain(name);
      expect(worker).not.toContain(name);
    }
    // O Maestro tem as dele (message_agent e cancel_request de dentro do workspace), mas não as de mandar pedidos nem de responder.
    for (const name of ["send_request", "get_request_status", "list_sent_requests", "answer_maestro"]) expect(maestro).not.toContain(name);
    expect(maestro).toContain("ask_cyno");
    expect(worker).not.toContain("ask_cyno");
    expect(cyno).not.toContain("ask_cyno");
    for (const name of ["delegate_task", "open_request", "create_project", "complete_request"]) expect(cyno).not.toContain(name);
  });
});

describe("AskLedger", () => {
  async function ledger(start = Date.parse("2026-11-11T10:00:00Z")) {
    const dir = await tempDir();
    let now = start;
    const queue = new WriteQueue();
    const records = await JsonRecords.open<AskRecord>(path.join(dir, "asks.json"), queue, AskLedger.parse);
    // O arquivo é gravado na fila: `idle` espera antes de a pasta temporária ser apagada.
    return { ledger: new AskLedger(records, () => new Date(now)), advance: (ms: number) => (now += ms), idle: () => queue.idle() };
  }

  it("no máximo N abertas por workspace; responder libera; só uma resposta por pergunta", async () => {
    const { ledger: asks, idle } = await ledger();
    const first = asks.open({ workspace: "a", question: "q1" });
    asks.open({ workspace: "a", question: "q2" });
    expect(() => asks.open({ workspace: "a", question: "q3" })).toThrow(AskRefused);
    expect(() => asks.open({ workspace: "a", question: "q3" })).toThrow(/2 open questions/);
    // Outro workspace não é afetado.
    expect(asks.open({ workspace: "b", question: "q" }).id).toBe("A-0003");
    expect(asks.answer(first.id, "ok")).toMatchObject({ status: "respondido", answer: "ok" });
    expect(asks.answer(first.id, "de novo")).toBeUndefined();
    expect(asks.open({ workspace: "a", question: "q3" }).id).toBe("A-0004");
    await idle();
  });

  it("teto por hora por workspace (continuar a conversa abrindo outra conta) e na plataforma; a hora seguinte libera", async () => {
    const { ledger: asks, advance, idle } = await ledger();
    for (let index = 0; index < ASK_LIMITS.perWorkspaceHour; index += 1) asks.answer(asks.open({ workspace: "a", question: `q${index}` }).id, "r");
    expect(() => asks.open({ workspace: "a", question: "x" })).toThrow(/per hour for this workspace/);
    // A plataforma toda tem um teto também.
    let workspace = 0;
    while (asks.list().filter((ask) => ask.status !== "aberto").length < ASK_LIMITS.perHour) {
      const id = `w${workspace++}`;
      asks.answer(asks.open({ workspace: id, question: "q" }).id, "r");
    }
    expect(() => asks.open({ workspace: "novo", question: "x" })).toThrow(/platform reached its limit/);
    advance(61 * 60_000);
    expect(asks.open({ workspace: "a", question: "depois de uma hora" }).status).toBe("aberto");
    await idle();
  });

  it("pergunta aberta sem resposta por 1 h vira sem_resposta", async () => {
    const { ledger: asks, advance, idle } = await ledger();
    const ask = asks.open({ workspace: "a", question: "q" });
    advance(ASK_LIMITS.expireMs - 1000);
    expect(asks.expire()).toEqual([]);
    advance(2000);
    expect(asks.expire().map((item) => item.id)).toEqual([ask.id]);
    expect(asks.get(ask.id)?.status).toBe("sem_resposta");
    expect(asks.answer(ask.id, "tarde")).toBeUndefined();
    await idle();
  });
});

describe("briefingMessage", () => {
  it("deixa claro que é o briefing completo do Cyno e que o Maestro só distribui, com prazo e agentes sugeridos", () => {
    const text = briefingMessage("abc", { title: "Post", brief: "Fazer o post.", kind: "project", priority: "high", dueAt: "2026-11-20T00:00:00.000Z", doneWhen: ["curto"], suggestedAgents: ["Clara", "Beto"] });
    expect(text).toContain("[Briefing completo do Cyno, em nome do dono]");
    expect(text).toContain("PROJETO");
    expect(text).toContain("## Pronto quando\n- curto");
    expect(text).toContain("- Clara\n- Beto");
    expect(text).toContain("prioridade high · prazo 2026-11-20");
    expect(text).toContain("Só DISTRIBUA");
  });
});
