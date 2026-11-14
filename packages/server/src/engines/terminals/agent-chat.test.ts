import { readFile } from "node:fs/promises";
import { conversationLogId, type Agent, type AgentLogEntry, type OfficeState, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { AgentLogService } from "../../workspace/agent-log/service";
import { HttpError } from "../../platform/http/errors";
import { dataPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { AGENT_CHAT_SESSION_KEY, AgentChat, chatMessage, chatRecap, workRecap } from "./agent-chat";
import type { SendOptions, TerminalAgent, TerminalEvent, TerminalListener } from "./types";

const tempDir = useTempDirs();
const NOW = new Date("2026-11-08T12:00:00.000Z");
const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function agent(id: string, engine: Agent["engine"], teamId = "t1"): Agent {
  return { id, name: id === "maestro" ? "Maestro" : `Agente ${id}`, role: "Redator", teamId, status: "idle", engine } as Agent;
}

function office(tasks: Task[] = []): OfficeState {
  return {
    rooms: [
      { id: "r1", name: "Projeto" },
      { id: "maestro-room", name: "Sala do Maestro", kind: "maestro" },
    ],
    teams: [
      { id: "t1", name: "Conteúdo", roomId: "r1", focus: "posts" },
      { id: "tm", name: "Maestro", roomId: "maestro-room", focus: "coordenar" },
    ],
    agents: [agent("cli", "claude"), agent("sim", "mock"), agent("maestro", "claude", "tm")],
    tasks,
  } as unknown as OfficeState;
}

/** Terminal falso: guarda o que foi mandado e deixa o teste emitir eventos. */
class FakeTerminal implements TerminalAgent {
  readonly agentId = "cli";
  readonly provider = "claude" as const;
  readonly sent: { text: string; tag?: string; options?: SendOptions }[] = [];
  sessionKey: string | undefined;
  private readonly listeners = new Set<TerminalListener>();
  status() {
    return "idle" as const;
  }
  sessionId() {
    return undefined;
  }
  lastError() {
    return undefined;
  }
  currentSessionKey() {
    return this.sessionKey;
  }
  ensureRunning() {
    return Promise.resolve();
  }
  send(text: string, tag?: string, options?: SendOptions) {
    this.sent.push({ text, tag, options });
  }
  cancel() {
    return [];
  }
  interrupt() {}
  stop() {
    return Promise.resolve();
  }
  onEvent(listener: TerminalListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: TerminalEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

async function setup(options: { tasks?: Task[]; note?: { taskId: string; live: boolean } } = {}) {
  const dir = await tempDir();
  const paths = dataPaths(dir);
  const queue = new WriteQueue();
  const events: ServerEvent[] = [];
  const state = office(options.tasks);
  const agentLog = new AgentLogService({ paths, queue, publish: (event) => events.push(event), tasks: () => state.tasks, log: { error: () => undefined }, now: () => NOW });
  const terminal = new FakeTerminal();
  const chatting: [string, boolean][] = [];
  const notes: [string, string][] = [];
  const chat = new AgentChat({
    state: { read: () => state },
    terminals: {
      get: (agentId) => {
        if (agentId !== "cli") throw new HttpError(409, "simulado");
        return terminal;
      },
      setChatting: (agentId, value) => void chatting.push([agentId, value]),
    },
    runner: {
      note: (agentId, text) => {
        notes.push([agentId, text]);
        return options.note;
      },
    },
    agentLog,
    log: { warn: () => undefined },
    now: () => NOW,
    mockReplyMs: 0,
    simulated: true,
    publish: (event) => void events.push(event),
  });
  const statuses = (messageId?: string) => events.flatMap((event) => (event.type === "agent:chat-status" && (!messageId || event.chat.messageId === messageId) ? [event.chat.status] : []));
  const failure = () => events.flatMap((event) => (event.type === "agent:chat-status" && event.chat.status === "failed" ? [event.chat.error] : [])).at(-1);
  const erro = () => events.flatMap((event) => (event.type === "agent:chat-status" && event.chat.error ? [event.chat.error] : [])).at(-1);
  const logged = () => events.flatMap((event) => (event.type === "agent:log" ? [event.entry] : []));
  return { dir, paths, queue, agentLog, terminal, chat, chatting, notes, logged, statuses, failure, erro };
}

const working = (agentId: string): Task => ({ id: TASK_ID, roomId: "r1", teamId: "t1", agentId, prompt: "Escreva um post", status: "in_progress", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }) as Task;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("AgentChat: roteamento da conversa direta", () => {
  it("agente de CLI livre: conversa numa sessão própria (chave conversa), com a fala no log do dia", async () => {
    const { chat, terminal, logged } = await setup();
    const response = await chat.send("cli", "  oi, tudo bem?  ");
    const logId = conversationLogId("cli", NOW);
    expect(response).toEqual({ mode: "conversa", logId, messageId: expect.any(String) });
    expect(terminal.sent).toHaveLength(1);
    expect(terminal.sent[0]!.tag).toBe(`conversa:${(response as { messageId: string }).messageId}`);
    expect(terminal.sent[0]!.options).toEqual({ freshSession: true, sessionKey: AGENT_CHAT_SESSION_KEY });
    expect(terminal.sent[0]!.text).toContain("NÃO é uma tarefa");
    expect(terminal.sent[0]!.text).toContain("oi, tudo bem?");
    expect(logged()).toEqual([expect.objectContaining({ taskId: logId, agentId: "cli", kind: "chat", from: "user", text: "oi, tudo bem?", via: "painel" })]);
  });

  it("agente de CLI numa tarefa: vira nota da tarefa (não conversa), no log da tarefa", async () => {
    const { chat, terminal, notes, logged } = await setup({ tasks: [working("cli")], note: { taskId: TASK_ID, live: true } });
    const response = await chat.send("cli", "foca no público jovem");
    expect(response).toEqual({ mode: "nota", taskId: TASK_ID, live: true, messageId: expect.any(String) });
    expect(notes).toEqual([["cli", "foca no público jovem"]]);
    expect(terminal.sent).toHaveLength(0);
    expect(logged()).toEqual([expect.objectContaining({ taskId: TASK_ID, kind: "chat", from: "user", text: "foca no público jovem" })]);
  });

  it("nota que chegou depois da entrega vira conversa (mesmo com outra tarefa já rodando), sem passar pela nota", async () => {
    const { chat, terminal, notes, logged } = await setup({ tasks: [working("cli")], note: { taskId: "outra", live: false } });
    await chat.lateNotes("cli", TASK_ID, ["troque o título"]);
    expect(notes).toEqual([]); // não entra na tarefa seguinte
    expect(terminal.sent).toHaveLength(1);
    expect(terminal.sent[0]!.options).toEqual({ freshSession: true, sessionKey: AGENT_CHAT_SESSION_KEY });
    expect(terminal.sent[0]!.text).toContain(`Esta nota era para a tarefa “Escreva um post” (${TASK_ID}), que você acabou de entregar`);
    expect(terminal.sent[0]!.text).toContain("troque o título");
    expect(logged()).toEqual([expect.objectContaining({ taskId: conversationLogId("cli", NOW), kind: "chat", from: "user", text: "Nota que chegou depois da entrega: troque o título" })]);
  });

  it("nota que não entrou ao vivo: o log da tarefa avisa que espera o fim do turno", async () => {
    const { chat, logged } = await setup({ tasks: [working("cli")], note: { taskId: TASK_ID, live: false } });
    expect(await chat.send("cli", "mais curto")).toEqual({ mode: "nota", taskId: TASK_ID, live: false, messageId: expect.any(String) });
    expect(logged().map((entry) => entry.kind)).toEqual(["chat", "status"]);
  });

  it("agente simulado: conversa (livre) e nota (numa tarefa) com resposta pronta", async () => {
    const free = await setup();
    expect(await free.chat.send("sim", "oi")).toEqual({ mode: "conversa", logId: conversationLogId("sim", NOW), messageId: expect.any(String) });
    await settle();
    expect(free.logged().map((entry) => [entry.kind, entry.kind === "chat" ? entry.from : ""])).toEqual([
      ["chat", "user"],
      ["chat", "agent"],
    ]);
    expect((free.logged()[1] as Extract<AgentLogEntry, { kind: "chat" }>).text).toMatch(/^\(Simulado\)/);

    const busy = await setup({ tasks: [working("sim")] });
    expect(await busy.chat.send("sim", "foca no público jovem")).toEqual({ mode: "nota", taskId: TASK_ID, live: true, messageId: expect.any(String) });
    await settle();
    expect(busy.logged().every((entry) => entry.taskId === TASK_ID)).toBe(true);
    expect(busy.logged()).toHaveLength(2);
  });

  it("o Maestro tem a caixa dele (409); agente inexistente 404; mensagem vazia 400", async () => {
    const { chat } = await setup();
    await expect(chat.send("maestro", "oi")).rejects.toMatchObject({ statusCode: 409 });
    await expect(chat.send("ninguem", "oi")).rejects.toMatchObject({ statusCode: 404 });
    await expect(chat.send("cli", "   ")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("AgentChat: turno da conversa e persistência", () => {
  it("o turno da conversa vai para o log do dia (ferramentas e resposta), liga e desliga o balão e grava em logs/conversa-<agente>-AAAAMMDD.jsonl", async () => {
    const { chat, terminal, chatting, queue, paths, logged, agentLog } = await setup();
    await chat.send("cli", "qual o tom da marca?");
    const tag = terminal.sent[0]!.tag!;
    terminal.emit({ type: "turn_start", tag });
    terminal.emit({ type: "tool_use", id: "tu-1", name: "mcp__office__search_notes", input: { query: "tom" } });
    terminal.emit({ type: "tool_result", id: "tu-1", ok: true, output: "1 nota" });
    terminal.emit({ type: "turn_end", tag, ok: true, result: "Leve e direto." });
    expect(chatting).toEqual([
      ["cli", true],
      ["cli", false],
    ]);
    const logId = conversationLogId("cli", NOW);
    expect(logged().map((entry) => [entry.taskId, entry.kind])).toEqual([
      [logId, "chat"],
      [logId, "tool"],
      [logId, "tool"],
      [logId, "chat"],
    ]);
    await queue.idle();
    const lines = (await readFile(paths.taskLogFile(logId), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AgentLogEntry);
    expect(lines.filter((entry) => entry.kind === "chat").map((entry) => (entry.kind === "chat" ? `${entry.from}:${entry.text}` : ""))).toEqual(["user:qual o tom da marca?", "agent:Leve e direto."]);
    // Um server novo lê de volta pelo histórico do agente.
    const again = new AgentLogService({ paths, queue: new WriteQueue(), publish: () => undefined, tasks: () => [], log: { error: () => undefined }, now: () => NOW });
    expect((await again.recentForAgent("cli", 50)).filter((entry) => entry.kind === "chat")).toHaveLength(2);
    expect(agentLog).toBeDefined();
  });

  it("turno de outra coisa (tarefa) não entra na conversa; mensagem descartada vira status de falha", async () => {
    const { chat, terminal, logged } = await setup();
    await chat.send("cli", "oi");
    terminal.emit({ type: "turn_start", tag: TASK_ID });
    terminal.emit({ type: "text", text: "trabalhando na tarefa" });
    terminal.emit({ type: "turn_end", tag: TASK_ID, ok: true, result: "ok" });
    expect(logged()).toHaveLength(1);
    terminal.emit({ type: "dropped", tag: terminal.sent[0]!.tag, reason: "Terminal parado" });
    expect(logged().at(-1)).toMatchObject({ kind: "status", status: "failed", message: "A mensagem não chegou: Terminal parado" });
  });

  it("sessão nova da CLI (a última era de uma tarefa): a mensagem leva o resumo da conversa recente; a mesma sessão, não", async () => {
    const { chat, terminal } = await setup();
    await chat.send("cli", "primeira fala");
    const tag = terminal.sent[0]!.tag!;
    terminal.emit({ type: "turn_start", tag });
    terminal.emit({ type: "turn_end", tag, ok: true, result: "primeira resposta" });
    terminal.sessionKey = TASK_ID;
    await chat.send("cli", "segunda fala");
    expect(terminal.sent[1]!.text).toContain("Conversa recente");
    expect(terminal.sent[1]!.text).toContain("- Você: primeira resposta");
    terminal.sessionKey = AGENT_CHAT_SESSION_KEY;
    await chat.send("cli", "terceira");
    expect(terminal.sent[2]!.text).not.toContain("Conversa recente");
  });

  it("chatRecap / chatMessage: só falas da conversa, cortadas, as últimas", () => {
    const base = { agentId: "cli", at: NOW.toISOString() };
    const entries = [
      { ...base, id: "1", taskId: TASK_ID, kind: "chat", from: "user", text: "nota de tarefa" },
      { ...base, id: "2", taskId: conversationLogId("cli", NOW), kind: "chat", from: "user", text: "oi\n  tudo" },
      { ...base, id: "3", taskId: conversationLogId("cli", NOW), kind: "text", text: "pensando" },
      { ...base, id: "4", taskId: conversationLogId("cli", NOW), kind: "chat", from: "agent", text: "x".repeat(400) },
    ] as AgentLogEntry[];
    const recap = chatRecap(entries);
    expect(recap.split("\n")).toHaveLength(2);
    expect(recap).toContain("- Usuário: oi tudo");
    expect(recap.split("\n")[1]!.length).toBeLessThan(320);
    expect(chatMessage("e aí?")).not.toContain("Conversa recente");
  });

  it("workRecap: as últimas entregas do agente (com o título da tarefa) vão no contexto da conversa nova", () => {
    const base = { agentId: "cli", at: NOW.toISOString() };
    const entries = [
      { ...base, id: "1", taskId: TASK_ID, kind: "result", text: "Legenda: bora cozinhar! 🍳" },
      { ...base, id: "2", taskId: TASK_ID, kind: "result", text: "resultado do subagente", thread: "s1" },
    ] as AgentLogEntry[];
    const work = workRecap(entries, () => "Legenda do app de receitas");
    expect(work).toBe("- Tarefa “Legenda do app de receitas”: Legenda: bora cozinhar! 🍳");
    expect(chatMessage("e no TikTok?", { chat: "", work })).toContain("O que você entregou nas últimas tarefas");
  });
});

describe("AgentChat: estado de entrega da mensagem (agent:chat-status)", () => {
  it("conversa com o agente livre: na fila, entregue (o turno abriu) e respondeu", async () => {
    const { chat, terminal, statuses } = await setup();
    const { messageId } = await chat.send("cli", "oi");
    expect(statuses(messageId)).toEqual(["queued"]);
    const tag = terminal.sent[0]!.tag!;
    terminal.emit({ type: "turn_start", tag });
    expect(statuses(messageId)).toEqual(["queued", "delivered"]);
    terminal.emit({ type: "turn_end", tag, ok: true, result: "Oi!" });
    expect(statuses(messageId)).toEqual(["queued", "delivered", "answered"]);
  });

  it("o turno de outra mensagem ou de uma tarefa não entrega esta", async () => {
    const { chat, terminal, statuses } = await setup();
    const { messageId } = await chat.send("cli", "oi");
    terminal.emit({ type: "turn_start", tag: TASK_ID });
    terminal.emit({ type: "turn_end", tag: TASK_ID, ok: true, result: "ok" });
    terminal.emit({ type: "turn_start", tag: "conversa:outra" });
    expect(statuses(messageId)).toEqual(["queued"]);
  });

  it("descartada (terminal parado): falhou, com o motivo; a confirmação atrasada corrige para entregue, e entregue nunca volta a falhou", async () => {
    const { chat, terminal, statuses, failure } = await setup();
    const { messageId } = await chat.send("cli", "oi");
    const tag = terminal.sent[0]!.tag!;
    terminal.emit({ type: "dropped", tag, reason: "Terminal parado" });
    expect(statuses(messageId)).toEqual(["queued", "failed"]);
    expect(failure()).toBe("A mensagem não chegou: Terminal parado");
    terminal.emit({ type: "turn_start", tag }); // confirmação atrasada
    expect(statuses(messageId)).toEqual(["queued", "failed", "delivered"]);
    terminal.emit({ type: "dropped", tag, reason: "de novo" }); // falha tardia não desfaz a entrega
    expect(statuses(messageId)).toEqual(["queued", "failed", "delivered"]);
  });

  it("o turno deu erro depois da entrega: continua entregue (nunca volta a falhou), com o motivo no mesmo estado", async () => {
    const { chat, terminal, statuses, erro } = await setup();
    const { messageId } = await chat.send("cli", "oi");
    const tag = terminal.sent[0]!.tag!;
    terminal.emit({ type: "turn_start", tag });
    terminal.emit({ type: "turn_end", tag, ok: false, result: "cota estourou" });
    expect(statuses(messageId)).toEqual(["queued", "delivered", "delivered"]);
    expect(erro()).toContain("cota estourou");
  });

  it("terminal que cai com a mensagem na fila: falhou", async () => {
    const { chat, terminal, statuses, logged } = await setup();
    const { messageId } = await chat.send("cli", "oi");
    terminal.emit({ type: "status", status: "error" });
    expect(statuses(messageId)).toEqual(["queued", "failed"]);
    expect(logged().at(-1)).toMatchObject({ kind: "status", status: "failed", message: expect.stringContaining("A mensagem não chegou") });
  });

  it("nota ao vivo: entregue na hora; ao fim do turno, respondeu", async () => {
    const { chat, terminal, statuses } = await setup({ tasks: [working("cli")], note: { taskId: TASK_ID, live: true } });
    const { messageId } = await chat.send("cli", "foca no público jovem");
    expect(statuses(messageId)).toEqual(["queued", "delivered"]);
    terminal.emit({ type: "turn_end", tag: TASK_ID, ok: true, result: "ok" });
    expect(statuses(messageId)).toEqual(["queued", "delivered", "answered"]);
  });

  it("nota na fila (o agente está ocupado): entregue quando o turno seguinte abre", async () => {
    const { chat, terminal, statuses } = await setup({ tasks: [working("cli")], note: { taskId: TASK_ID, live: false } });
    const { messageId } = await chat.send("cli", "mais curto");
    expect(statuses(messageId)).toEqual(["queued"]);
    terminal.emit({ type: "turn_start", tag: TASK_ID });
    expect(statuses(messageId)).toEqual(["queued", "delivered"]);
    terminal.emit({ type: "turn_end", tag: TASK_ID, ok: true, result: "ok" });
    expect(statuses(messageId)).toEqual(["queued", "delivered", "answered"]);
  });

  it("nota que ficou na fila quando a tarefa acabou vira conversa e é entregue com ela", async () => {
    const { chat, terminal, statuses } = await setup({ tasks: [working("cli")], note: { taskId: TASK_ID, live: false } });
    const { messageId } = await chat.send("cli", "troque o título");
    await chat.lateNotes("cli", TASK_ID, ["troque o título"]);
    const tag = terminal.sent[0]!.tag!;
    expect(tag).toMatch(/^conversa:/);
    terminal.emit({ type: "turn_start", tag });
    expect(statuses(messageId)).toEqual(["queued", "delivered"]);
  });

  it("agente simulado: entregue na hora, respondeu quando a resposta pronta chega", async () => {
    const { chat, statuses } = await setup();
    const { messageId } = await chat.send("sim", "oi");
    expect(statuses(messageId)).toEqual(["queued", "delivered"]);
    await settle();
    expect(statuses(messageId)).toEqual(["queued", "delivered", "answered"]);
  });
});
