import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { AgentLogEntry, AgentTerminalInfo, MaestroTerminalServerMessage, Task, TaskLogResponse, Workspace } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import type { TerminalsConfig } from "./manager";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "./pty-terminal";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const FAKE_TUI = fileURLToPath(new URL("./fake-tui.mjs", import.meta.url));

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

type Env = { root: string; projects: string; tuiLog: string; cliLog: string };

/**
 * App com o Maestro no terminal interativo (CLI interativa falsa) e os outros agentes headless (CLI
 * falsa de sempre), ouvindo de verdade (as CLIs falsas chamam o MCP por HTTP).
 */
async function setup(env?: Env, extra: Partial<TerminalsConfig> = {}, dataDir?: string): Promise<TestApp & Env> {
  const root = env?.root ?? (await tempDir());
  const projects = path.join(root, "projects");
  const tuiLog = path.join(root, "tui-spawns.jsonl");
  const cliLog = path.join(root, "cli-spawns.jsonl");
  const port = await freePort();
  const testApp = await setupApp({
    ...(dataDir ? { dataDir } : {}),
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 2,
      backoffMs: () => 20,
      stopGraceMs: 1000,
      claude: { command: process.execPath, prefixArgs: [FAKE_CLI] },
      maestroPty: {
        enabled: true,
        projectsDir: projects,
        pollMs: 20,
        readyTimeoutMs: 3000,
        submitDelayMs: 30,
      },
      env: { ...process.env, FAKE_TUI_PROJECTS: projects, FAKE_TUI_LOG: tuiLog, FAKE_TUI_STATE: path.join(root, "tui-state"), FAKE_CLI_LOG: cliLog, FAKE_CLI_STATE: path.join(root, "cli-state") },
      ...extra,
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, root, projects, tuiLog, cliLog };
}

async function patchAgent(testApp: TestApp, id: string, body: Record<string, unknown>) {
  const response = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: body });
  expect(response.statusCode).toBe(200);
}

async function waitTask(testApp: TestApp, id: string, status: Task["status"], timeoutMs = 10_000): Promise<Task> {
  const current = testApp.store.snapshot().tasks.find((task) => task.id === id);
  if (current?.status !== status) await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === status, timeoutMs);
  return testApp.store.snapshot().tasks.find((task) => task.id === id)!;
}

async function waitTerminal(testApp: TestApp, check: (info: AgentTerminalInfo) => boolean, timeoutMs = 8000): Promise<AgentTerminalInfo> {
  const event = await testApp.log.waitFor((candidate) => candidate.type === "agent:terminal" && candidate.terminal.agentId === "maestro" && check(candidate.terminal), timeoutMs);
  return (event as { terminal: AgentTerminalInfo }).terminal;
}

async function taskLog(testApp: TestApp, taskId: string): Promise<AgentLogEntry[]> {
  const response = await testApp.app.inject({ method: "GET", url: `${API}/tasks/${taskId}/log` });
  return (response.json() as TaskLogResponse).entries;
}

const lines = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as T);

/** O Maestro passa a usar a CLI interativa falsa: o adaptador do Claude roda o node com o script dela. */
function useFakeTui(): Partial<TerminalsConfig> {
  return { claude: { command: process.execPath, prefixArgs: [FAKE_TUI] } };
}

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8000, label = "condição"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Tempo esgotado esperando ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function connectTerminal(testApp: TestApp) {
  const received: MaestroTerminalServerMessage[] = [];
  let closeCode: number | undefined;
  const socket = await testApp.app.injectWS(`${API}/maestro/terminal`, {}, {
    onInit: (ws) => {
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as MaestroTerminalServerMessage));
      ws.on("close", (code) => {
        closeCode = code;
      });
    },
  });
  const screen = () =>
    stripAnsi(
      received
        .filter((message) => message.t === "out" || message.t === "replay")
        .map((message) => (message as { d: string }).d)
        .join(""),
    );
  return { socket, received, screen, closeCode: () => closeCode };
}

describe("Maestro no terminal interativo (pty) de ponta a ponta", () => {
  it("pedido pela API vira mensagem colada no terminal com o id; complete_request fecha o pedido; o log vem da conversa em disco", async () => {
    const testApp = await setup(undefined, useFakeTui());
    await patchAgent(testApp, "maestro", { engine: "claude", model: "haiku" });
    // Manter sempre rodando (padrão): o terminal sobe sozinho quando o Maestro vira Claude Code.
    const ready = await waitTerminal(testApp, (info) => info.status === "idle");
    expect(ready.mode).toBe("pty");
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "diga oi" } });
    expect(response.statusCode).toBe(201);
    const request = response.json() as Task;
    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toBe("Resposta do Maestro (terminal): diga oi");
    const entries = await taskLog(testApp, request.id);
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "mcp__office__complete_request" && entry.provider === "claude" && entry.status === "ok")).toBe(true);
    expect(entries.some((entry) => entry.kind === "text" && entry.provider === "claude")).toBe(true);
    expect(entries.some((entry) => entry.kind === "result")).toBe(true);
    const [spawn] = await lines<{ argv: string[] }>(testApp.tuiLog);
    expect(spawn!.argv[spawn!.argv.indexOf("--remote-control") + 1]).toBe("Maestro · Principal");
    expect(spawn!.argv[spawn!.argv.indexOf("--model") + 1]).toBe("haiku");
    const remote = await waitTerminal(testApp, (info) => info.remote?.active === true);
    expect(remote.remote).toEqual({ active: true, name: "Maestro · Principal", url: "https://claude.ai/code/session_FAKE123" });
  }, 20_000);

  it("WebSocket do terminal: hello + replay, teclas (comando /help), resize; e o que se digita nele é conversa (não vira pedido)", async () => {
    const testApp = await setup(undefined, useFakeTui());
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await waitTerminal(testApp, (info) => info.status === "idle");
    const viewer = await connectTerminal(testApp);
    const other = await connectTerminal(testApp);
    await until(() => viewer.received.length >= 2, 4000, "hello");
    expect(viewer.received[0]).toMatchObject({ t: "hello", status: "idle", cols: 120, rows: 36 });
    expect(viewer.received[1]).toMatchObject({ t: "replay" });
    expect(viewer.screen()).toContain("Fake Claude Code");

    viewer.socket.send(JSON.stringify({ t: "in", d: "/help\r" }));
    await until(() => viewer.screen().includes("Comandos: /help"), 4000, "saída do /help");
    // Quem só assiste também vê.
    await until(() => other.screen().includes("Comandos: /help"), 4000, "saída do /help no outro");
    viewer.socket.send(JSON.stringify({ t: "resize", cols: 100, rows: 30 }));
    await until(() => testApp.workspaces.get("principal").terminals.maestroPty()?.dimensions().cols === 100, 4000, "resize");
    // Mensagem inválida é ignorada (não derruba nada).
    viewer.socket.send("{não é json");
    viewer.socket.send(JSON.stringify({ t: "resize", cols: 1, rows: 1 }));

    const before = testApp.store.snapshot().tasks.length;
    viewer.socket.send(JSON.stringify({ t: "in", d: "oi direto no terminal\r" }));
    const reply = await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent", 6000);
    expect(reply).toMatchObject({ entry: { text: "ok: oi direto no terminal" } });
    expect(testApp.store.snapshot().tasks).toHaveLength(before);
    const entries = await taskLog(testApp, (reply as { entry: AgentLogEntry }).entry.taskId);
    expect(entries[0]).toMatchObject({ kind: "chat", from: "user", text: "oi direto no terminal", via: "terminal" });
    expect(entries.some((entry) => entry.kind === "text" && entry.text === "ok: oi direto no terminal" && entry.provider === "claude")).toBe(true);
    viewer.socket.terminate();
    other.socket.terminate();
  }, 20_000);

  it("Maestro simulado: o WebSocket do terminal fecha com 4409", async () => {
    const testApp = await setup(undefined, useFakeTui());
    const viewer = await connectTerminal(testApp);
    await until(() => viewer.closeCode(), 4000, "fechar");
    expect(viewer.closeCode()).toBe(4409);
  });

  it("trocar o modelo do Maestro (sempre rodando): o terminal reinicia sozinho com o modelo novo, na mesma conversa", async () => {
    const testApp = await setup(undefined, useFakeTui());
    await patchAgent(testApp, "maestro", { engine: "claude", model: "haiku" });
    await waitTerminal(testApp, (info) => info.status === "idle");
    // Uma conversa antes da troca, para haver o que retomar.
    const message = await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "oi" } });
    expect(message.statusCode).toBe(202);
    await waitTerminal(testApp, (info) => info.status === "busy");
    await waitTerminal(testApp, (info) => info.status === "idle");
    await patchAgent(testApp, "maestro", { model: "sonnet", effort: "medium" });
    const spawns = await until(async () => {
      const all = await lines<{ argv: string[] }>(testApp.tuiLog);
      return all.length >= 2 ? all : undefined;
    }, 10_000, "a segunda subida do terminal");
    const second = spawns[1]!.argv;
    expect(second[second.indexOf("--model") + 1]).toBe("sonnet");
    expect(second[second.indexOf("--effort") + 1]).toBe("medium");
    // Mesma conversa: a nova subida retoma a sessão da primeira.
    const first = spawns[0]!.argv;
    expect(second[second.indexOf("--resume") + 1]).toBe(first[first.indexOf("--session-id") + 1]);
    await waitTerminal(testApp, (info) => info.status === "idle");
  }, 20_000);

  it("acesso dos agentes: ligar o terminal no workspace e desligar a internet do Maestro reiniciam o terminal com as ferramentas novas", async () => {
    const testApp = await setup(undefined, useFakeTui());
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await waitTerminal(testApp, (info) => info.status === "idle");
    const tools = (argv: string[]) => argv[argv.indexOf("--tools") + 1];
    const spawnsAtLeast = (count: number) =>
      until(async () => {
        const all = await lines<{ argv: string[] }>(testApp.tuiLog);
        return all.length >= count ? all : undefined;
      }, 10_000, `subida ${count} do terminal`);
    expect(tools((await spawnsAtLeast(1))[0]!.argv)).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
    const put = await testApp.app.inject({ method: "PUT", url: "/api/workspaces/principal/access", payload: { terminal: true, blockedDomains: ["https://www.Ruim.com/x"] } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as Workspace).access).toMatchObject({ internet: true, terminal: true, blockedDomains: ["www.ruim.com"] });
    const second = (await spawnsAtLeast(2))[1]!.argv;
    expect(tools(second)).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash");
    expect(second[second.indexOf("--disallowedTools") + 1]).toBe("WebFetch(domain:www.ruim.com),WebFetch(domain:*.www.ruim.com)");
    await waitTerminal(testApp, (info) => info.status === "idle");
    await patchAgent(testApp, "maestro", { internet: false });
    const third = (await spawnsAtLeast(3))[2]!.argv;
    expect(tools(third)).toBe("Read,Write,Edit,Glob,Grep,Bash");
    await waitTerminal(testApp, (info) => info.status === "idle");
  }, 30_000);

  it("PUT /access valida: domínio inválido e corpo vazio = 400; workspace inexistente = 404", async () => {
    const testApp = await setup(undefined, useFakeTui());
    const bad = await testApp.app.inject({ method: "PUT", url: "/api/workspaces/principal/access", payload: { allowedDomains: ["não é domínio"] } });
    expect(bad.statusCode).toBe(400);
    const empty = await testApp.app.inject({ method: "PUT", url: "/api/workspaces/principal/access", payload: {} });
    expect(empty.statusCode).toBe(400);
    const extra = await testApp.app.inject({ method: "PUT", url: "/api/workspaces/principal/access", payload: { shell: true } });
    expect(extra.statusCode).toBe(400);
    const missing = await testApp.app.inject({ method: "PUT", url: "/api/workspaces/nao-existe/access", payload: { internet: false } });
    expect(missing.statusCode).toBe(404);
  });

  it("'Manter o Maestro sempre rodando' desligado: para quando ocioso; ligado de novo: sobe na hora", async () => {
    const testApp = await setup(undefined, { ...useFakeTui(), idleMs: 200 });
    const off = await testApp.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { maestro: { keepAlive: false } } });
    expect(off.statusCode).toBe(200);
    expect((off.json() as Workspace).maestro).toEqual({ keepAlive: false });
    await patchAgent(testApp, "maestro", { engine: "claude" });
    // Desligado: não sobe sozinho; um pedido sobe, e depois de ocioso para.
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "rapidinho" } });
    await waitTask(testApp, (response.json() as Task).id, "done");
    await waitTerminal(testApp, (info) => info.status === "stopped");
    const on = await testApp.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { maestro: { keepAlive: true } } });
    expect(on.statusCode).toBe(200);
    await waitTerminal(testApp, (info) => info.status === "idle");
    const list = await testApp.app.inject({ method: "GET", url: "/api/workspaces" });
    expect((list.json() as Workspace[]).find((ws) => ws.id === "principal")?.maestro).toEqual({ keepAlive: true });
  }, 20_000);

  it("nome da sessão do Remote Control pela API: /rename no terminal vivo (sem reiniciar); vazio volta ao padrão; nome inválido é recusado", async () => {
    const testApp = await setup(undefined, useFakeTui());
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await waitTerminal(testApp, (info) => info.remote?.active === true);
    const renamed = await testApp.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { maestro: { sessionName: "  Maestro do Harry  " } } });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as Workspace).maestro).toEqual({ sessionName: "Maestro do Harry" });
    const live = await waitTerminal(testApp, (info) => info.remote?.name === "Maestro do Harry" && info.remote.pendingName === undefined);
    expect(live.remote?.active).toBe(true);
    expect(live.status).toBe("idle");
    const replay = await testApp.app.inject({ method: "GET", url: "/api/workspaces" });
    expect((replay.json() as Workspace[]).find((ws) => ws.id === "principal")?.maestro).toEqual({ sessionName: "Maestro do Harry" });
    expect((await readFile(testApp.tuiLog, "utf8")).trim().split("\n")).toHaveLength(1);

    // Vazio = o padrão de novo ("Maestro · <workspace>"); renomear o workspace acompanha.
    const reset = await testApp.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { maestro: { sessionName: "" } } });
    expect((reset.json() as Workspace).maestro).toEqual({});
    await waitTerminal(testApp, (info) => info.remote?.name === "Maestro · Principal");
    await testApp.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { name: "Casa" } });
    await waitTerminal(testApp, (info) => info.remote?.name === "Maestro · Casa");

    const bad = await testApp.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { maestro: { sessionName: "linha\n/exit" } } });
    expect(bad.statusCode).toBe(400);
  }, 20_000);

  it("reiniciar o server: o Maestro sobe sozinho na MESMA conversa (--resume) com o Remote Control; o pedido aberto e a conversa continuam", async () => {
    const first = await setup(undefined, useFakeTui());
    await patchAgent(first, "maestro", { engine: "claude" });
    await waitTerminal(first, (info) => info.status === "idle");
    // Conversa pela caixa do painel: colada no terminal, sem pedido.
    const talk = await first.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "oi, Maestro" } });
    expect(talk.json()).toMatchObject({ mode: "conversa" });
    await first.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent" && event.entry.text === "ok: oi, Maestro", 6000);
    const response = await first.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "primeiro" } });
    await waitTask(first, (response.json() as Task).id, "done");
    const sessionId = first.workspaces.get("principal").terminals.maestroPty()!.sessionId();
    expect(sessionId).toBeTruthy();
    // Um pedido que ficou aberto quando o server caiu.
    const state = first.store.snapshot();
    const openTask: Task = { id: "4f0a2b8e-1111-4c4c-9a9a-123456789abc", roomId: "sala-do-maestro", teamId: state.agents.find((agent) => agent.id === "maestro")!.teamId, agentId: "maestro", prompt: "pedido aberto", status: "in_progress", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await first.store.commitTasks([...state.tasks, openTask]);
    await first.app.close();

    const second = await setup({ root: first.root, projects: first.projects, tuiLog: first.tuiLog, cliLog: first.cliLog }, useFakeTui(), first.dataDir);
    // Sem nenhum pedido novo: sobe no boot, retomando a conversa salva.
    await until(async () => (await lines<{ argv: string[] }>(first.tuiLog)).length >= 2, 8000, "subida no boot");
    const argv = (await lines<{ argv: string[] }>(first.tuiLog)).at(-1)!.argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe(sessionId);
    expect(argv).toContain("--remote-control");
    // O pedido aberto continua: o Maestro recebe o aviso do reinício (colado no terminal) e responde.
    const done = await waitTask(second, openTask.id, "done", 12_000);
    expect(done.result).toContain(`O servidor reiniciou. O pedido ${openTask.id} ainda está aberto`);
    expect(second.workspaces.get("principal").terminals.maestroPty()!.sessionId()).toBe(sessionId);
    // A conversa sobrevive ao reinício (o log da conversa não é sobra de tarefa) e volta no GET do agente.
    const agentLog = (await second.app.inject({ method: "GET", url: `${API}/agents/maestro/log` })).json() as { entries: AgentLogEntry[] };
    // O pedido fechado fora de uma conversa (o Maestro foi acordado pelo servidor) também avisa na conversa.
    expect(agentLog.entries.filter((entry) => entry.kind === "chat").map((entry) => (entry as { text: string }).text)).toEqual([
      "oi, Maestro",
      "ok: oi, Maestro",
      "**Pedido concluído: primeiro**\n\nResposta do Maestro (terminal): primeiro",
    ]);
  }, 30_000);

  it("agentes de time (headless) retomam a sessão da tarefa em andamento na próxima ação depois de reiniciar (e não sobem no boot)", async () => {
    const first = await setup();
    await patchAgent(first, "beto", { engine: "claude" });
    const response = await first.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "[aprovar] Post do dia" } });
    const task = response.json() as Task;
    await waitTask(first, task.id, "waiting_approval");
    const sessionFile = path.join(first.dir, "agents", "beto", "session.json");
    const session = await until(async () => {
      const saved = JSON.parse(await readFile(sessionFile, "utf8")) as { sessionId: string; key: string; started: boolean };
      return saved.started && saved;
    }, 4000, "sessão salva");
    expect(session.key).toBe(task.id);
    await first.app.close();
    const before = (await lines(first.cliLog)).length;

    const second = await setup({ root: first.root, projects: first.projects, tuiLog: first.tuiLog, cliLog: first.cliLog }, {}, first.dataDir);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await lines(first.cliLog)).length).toBe(before);
    const item = second.store.forYouSnapshot().find((candidate) => candidate.taskId === task.id)!;
    const decided = await second.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/decision`, payload: { status: "aprovado", text: "Texto aprovado" } });
    expect(decided.statusCode).toBe(200);
    await waitTask(second, task.id, "done");
    const argv = (await lines<{ argv: string[] }>(first.cliLog)).at(-1)!.argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe(session.sessionId);
  }, 20_000);
});
