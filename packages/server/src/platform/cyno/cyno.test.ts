import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_COOKIE, parseCynoEvent, type AgentLogEntry,
  type Card, type CynoServerEvent, type CynoSnapshot, type CynoState } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import type { TerminalsConfig } from "../../engines/terminals/manager";
import { writeAuthFile } from "../auth/store";

const FAKE_CLI = fileURLToPath(new URL("../../engines/terminals/fake-cli.mjs", import.meta.url));
const FAKE_AGY = fileURLToPath(new URL("../../engines/terminals/fake-agy.mjs", import.meta.url));

// Cada teste sobe e fala com uma CLI falsa de verdade (processo + MCP por HTTP).
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

type Setup = TestApp & { spawnLog: string; messageLog: string; fakeState: string; port: number };

/** App com a CLI falsa e o server ouvindo de verdade (a CLI falsa chama o MCP por HTTP). */
async function setup(options: { cynoIdleMs?: number; dataDir?: string; fakeState?: string; password?: string } = {}): Promise<Setup> {
  const dir = await tempDir();
  const port = await freePort();
  const spawnLog = path.join(dir, "spawns.jsonl");
  const messageLog = path.join(dir, "messages.jsonl");
  // As sessões que a CLI falsa conhece: num "reinício" a mesma pasta, senão o `--resume` não acharia a conversa.
  const fakeState = options.fakeState ?? path.join(dir, "fake-state");
  const terminals: Partial<TerminalsConfig> = {
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    idleMs: 0,
    maxRetries: 1,
    backoffMs: () => 10,
    stopGraceMs: 2000,
    claude: { command: process.execPath, prefixArgs: [FAKE_CLI] },
    gemini: { command: process.execPath, prefixArgs: [FAKE_AGY] },
    env: { ...process.env, FAKE_CLI_STATE: fakeState, FAKE_CLI_LOG: spawnLog, FAKE_CLI_MESSAGES: messageLog, ANTHROPIC_API_KEY: "sk-ant-NAO-PODE", GEMINI_API_KEY: "gemini-NAO-PODE" },
  };
  const testApp = await setupApp({ terminals, ...(options.dataDir ? { dataDir: options.dataDir } : {}), ...(options.cynoIdleMs ? { cynoIdleMs: options.cynoIdleMs } : {}) });
  if (options.password) await writeAuthFile(testApp.dataDir, options.password);
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, spawnLog, messageLog, fakeState, port };
}

async function jsonLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as T);
}

type Spawn = { argv: string[]; cwd: string; env: Record<string, string> };

const snapshot = async (test: TestApp): Promise<CynoSnapshot> => (await test.app.inject({ method: "GET", url: "/api/cyno" })).json() as CynoSnapshot;
const say = (test: TestApp, text: string) => test.app.inject({ method: "POST", url: "/api/cyno/messages", payload: { text } });

/** Espera a entrada do log que satisfaz o teste (as falas e respostas chegam pelo websocket/snapshot). */
async function waitEntry(test: TestApp, predicate: (entry: AgentLogEntry) => boolean, timeoutMs = 8000): Promise<AgentLogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await snapshot(test)).entries.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("a entrada esperada não chegou a tempo");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const replyTo = (test: TestApp, text: string) => waitEntry(test, (entry) => entry.kind === "chat" && entry.from === "agent" && entry.text.includes(text));

async function waitStatus(test: TestApp, status: CynoState["status"], timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await snapshot(test)).state.status !== status) {
    if (Date.now() > deadline) throw new Error(`o Cyno não chegou a ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("CynoService: sob demanda", () => {
  it("nunca sobe no boot: dorme, sem processo nem arquivos, e a conversa está vazia", async () => {
    const test = await setup();
    const { state, entries } = await snapshot(test);
    expect(state).toMatchObject({ status: "sleeping", everStarted: false, newConversation: false, choice: { engine: "claude", model: "sonnet", effort: "medium" } });
    expect(entries).toEqual([]);
    expect(await jsonLines(test.spawnLog)).toEqual([]);
    await expect(access(path.join(test.dataDir, "platform", "cyno", "session.json"))).rejects.toThrow();
  });

  it("a primeira mensagem acorda o Cyno: a fala e a resposta entram no chat, na pasta e com a config isolada dele", async () => {
    const test = await setup();
    const response = await say(test, "Oi, Cyno");
    expect(response.statusCode).toBe(202);
    const reply = await replyTo(test, "Oi, Cyno");
    expect(reply.agentId).toBe("cyno");
    expect(reply.taskId).toMatch(/^conversa-cyno-\d{8}$/);

    const [spawn] = await jsonLines<Spawn>(test.spawnLog);
    expect(spawn!.cwd).toBe(path.join(test.dataDir, "platform", "cyno"));
    // Sem Bash e sem subagentes embutidos; só os arquivos e a internet; as chaves de API nunca vão.
    expect(spawn!.argv.join(" ")).not.toMatch(/\bAgent\b/);
    const tools = spawn!.argv[spawn!.argv.indexOf("--tools") + 1] ?? "";
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Agent");
    expect(spawn!.argv).toContain("--mcp-config");
    expect(spawn!.env.ANTHROPIC_API_KEY).toBeUndefined();
    // As instruções do Cyno estão na pasta dele (CLAUDE.md) e o token MCP só na pasta dele, com modo 0600.
    const claudeMd = await readFile(path.join(spawn!.cwd, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Você é o Cyno");
    expect(claudeMd).toContain("NUNCA invente");
    const state = (await snapshot(test)).state;
    expect(state.everStarted).toBe(true);
  });

  it("as ferramentas do Cyno (list_workspaces, get_usage) respondem com o que o servidor sabe", async () => {
    const test = await setup();
    await say(test, "[workspaces] como estão os workspaces?");
    const reply = await replyTo(test, "workspace");
    expect(reply.kind === "chat" && reply.text).toMatch(/principal — "/);
    await say(test, "[uso] e a cota?");
    const usage = await replyTo(test, "Claude Code");
    expect(usage.kind === "chat" && usage.text).toContain("Agents since");
    // O que ele fez aparece no log como ferramentas (o trabalho ao vivo do chat).
    const tools = (await snapshot(test)).entries.filter((entry) => entry.kind === "tool");
    expect(tools.map((entry) => (entry.kind === "tool" ? entry.name : ""))).toEqual(["mcp__office__list_workspaces", "mcp__office__get_usage"]);
  });

  it("dorme depois de ocioso e a próxima mensagem retoma a MESMA conversa", async () => {
    const test = await setup({ cynoIdleMs: 200 });
    await say(test, "primeira");
    await replyTo(test, "primeira");
    await waitStatus(test, "sleeping");
    expect((await snapshot(test)).state.everStarted).toBe(true);
    await say(test, "segunda");
    await replyTo(test, "segunda");
    const spawns = await jsonLines<Spawn>(test.spawnLog);
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    const resumed = spawns.at(-1)!;
    const firstSession = spawns[0]!.argv[spawns[0]!.argv.indexOf("--session-id") + 1];
    expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(firstSession);
    const messages = await jsonLines<{ sessionId: string; text: string }>(test.messageLog);
    expect(new Set(messages.map((message) => message.sessionId)).size).toBe(1);
  });

  it("a conversa continua depois de reiniciar o servidor (mesma sessão, o chat volta do disco)", async () => {
    const first = await setup();
    await say(first, "antes do reinício");
    await replyTo(first, "antes do reinício");
    const sessionBefore = JSON.parse(await readFile(path.join(first.dataDir, "platform", "cyno", "session.json"), "utf8")) as { sessionId: string };
    await first.app.close();

    const second = await setup({ dataDir: first.dataDir, fakeState: first.fakeState });
    const { state, entries } = await snapshot(second);
    expect(state.status).toBe("sleeping");
    expect(entries.some((entry) => entry.kind === "chat" && entry.from === "user" && entry.text === "antes do reinício")).toBe(true);
    await say(second, "depois do reinício");
    await replyTo(second, "depois do reinício");
    const spawns = await jsonLines<Spawn>(second.spawnLog);
    expect(spawns.at(-1)!.argv[spawns.at(-1)!.argv.indexOf("--resume") + 1]).toBe(sessionBefore.sessionId);
  });

  it("\"Nova conversa\" é manual: abre sessão nova só na próxima mensagem, sem resumo, e sobrevive a um reinício até lá", async () => {
    const test = await setup();
    await say(test, "conversa velha");
    await replyTo(test, "conversa velha");
    const oldSession = (JSON.parse(await readFile(path.join(test.dataDir, "platform", "cyno", "session.json"), "utf8")) as { sessionId: string }).sessionId;

    const fresh = await test.app.inject({ method: "POST", url: "/api/cyno/new-conversation" });
    expect(fresh.json<CynoState>().newConversation).toBe(true);
    await expect(readFile(path.join(test.dataDir, "platform", "cyno", "nova-conversa.json"), "utf8")).resolves.toContain("pending");

    await say(test, "conversa do zero");
    await replyTo(test, "conversa do zero");
    const messages = await jsonLines<{ sessionId: string; text: string }>(test.messageLog);
    const last = messages.at(-1)!;
    // A conversa nova abre só com o digest das fichas (nada da conversa antiga), por código.
    expect(last.text).toContain("[Platform context, built by code");
    expect(last.text.endsWith("conversa do zero")).toBe(true);
    expect(last.text).not.toContain("conversa velha");
    expect(last.sessionId).not.toBe(oldSession);
    expect((await snapshot(test)).state.newConversation).toBe(false);
    await expect(access(path.join(test.dataDir, "platform", "cyno", "nova-conversa.json"))).rejects.toThrow();
    // O histórico do chat na tela continua (e ganhou o aviso).
    const { entries } = await snapshot(test);
    expect(entries.some((entry) => entry.kind === "status" && entry.message.startsWith("Nova conversa"))).toBe(true);
    expect(entries.some((entry) => entry.kind === "chat" && entry.text === "conversa velha")).toBe(true);
  });

  it("nunca renova a conversa sozinho: muitas mensagens seguidas ficam na mesma sessão", async () => {
    const test = await setup();
    for (const n of [1, 2, 3, 4]) {
      await say(test, `mensagem ${n}`);
      await replyTo(test, `eco: mensagem ${n}`);
    }
    const messages = await jsonLines<{ sessionId: string }>(test.messageLog);
    expect(messages).toHaveLength(4);
    expect(new Set(messages.map((message) => message.sessionId)).size).toBe(1);
  });

  it("mensagem vazia: 400; motor simulado: 409 com a explicação", async () => {
    const test = await setup();
    expect((await say(test, "   ")).statusCode).toBe(400);
    await test.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine: "mock" } } });
    const blocked = await say(test, "oi");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: string }>().error).toContain("Cyno");
  });
});

describe("Cyno: motor e modelo", () => {
  it("trocar o modelo vale nos modelos padrão globais e no estado; mexer nos modelos gerais não apaga o do Cyno", async () => {
    const test = await setup();
    const changed = await test.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine: "claude", model: "opus", effort: "high" } } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<CynoState>().choice).toEqual({ engine: "claude", model: "opus", effort: "high" });
    const models = (await test.app.inject({ method: "GET", url: "/api/settings/models" })).json<{ defaults: { cyno?: unknown; maestro: unknown; agentes: unknown; subagentes: unknown } }>();
    expect(models.defaults.cyno).toEqual({ engine: "claude", model: "opus", effort: "high" });
    // A tela de modelos padrão manda o objeto sem `cyno`: o escolhido continua.
    const withoutCyno = Object.fromEntries(Object.entries(models.defaults).filter(([key]) => key !== "cyno"));
    const saved = await test.app.inject({ method: "PUT", url: "/api/settings/models", payload: { defaults: withoutCyno } });
    expect(saved.json<{ defaults: { cyno?: unknown } }>().defaults.cyno).toEqual({ engine: "claude", model: "opus", effort: "high" });
    // A próxima subida usa o modelo escolhido.
    await say(test, "oi");
    await replyTo(test, "oi");
    const [spawn] = await jsonLines<Spawn>(test.spawnLog);
    expect(spawn!.argv[spawn!.argv.indexOf("--model") + 1]).toBe("opus");
  });

  it("trocar de motor funciona (Gemini) e avisa no chat que a conversa recomeça; o modelo inválido é recusado", async () => {
    const test = await setup();
    const bad = await test.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine: "claude", model: "--perigoso" } } });
    expect(bad.statusCode).toBe(400);
    await test.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine: "gemini", model: "gemini-3.8-flash-medium" } } });
    const { entries, state } = await snapshot(test);
    expect(state.choice.engine).toBe("gemini");
    expect(entries.some((entry) => entry.kind === "status" && entry.message.includes("Motor trocado"))).toBe(true);
    await say(test, "oi gemini");
    await waitEntry(test, (entry) => entry.kind === "chat" && entry.from === "agent");
    const [spawn] = await jsonLines<Spawn>(test.spawnLog);
    expect(spawn!.cwd).toBe(path.join(test.dataDir, "platform", "cyno"));
    // O Antigravity lê o GEMINI.md e o `.agents/mcp_config.json` da pasta do Cyno (nunca o ~/.gemini do dono).
    await expect(readFile(path.join(spawn!.cwd, "GEMINI.md"), "utf8")).resolves.toContain("Você é o Cyno");
    expect((await snapshot(test)).state.error).toBeUndefined();
  });
});

describe("Cyno: gastos", () => {
  it("o turno do Cyno entra no histórico de gastos como \"Cyno · plataforma\"", async () => {
    const test = await setup();
    await say(test, "gasta um turno");
    await replyTo(test, "gasta um turno");
    // O turno é gravado ao terminar; espera a fila de escrita.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const history = (await test.app.inject({ method: "GET", url: "/api/w/principal/usage/history?groupBy=agent" })).json<{ groups: { key: string; label: string }[] }>();
    expect(history.groups.some((group) => group.key === "cyno" && group.label === "Cyno · plataforma")).toBe(true);
  });
});

describe("Cyno: fichas dos workspaces", () => {
  it("GET /api/cyno/cards: a ficha de cada workspace; PUT escreve a frase (400 acima de 280, 404 sem workspace)", async () => {
    const test = await setup();
    const { cards } = (await test.app.inject({ method: "GET", url: "/api/cyno/cards" })).json<{ cards: Card[] }>();
    const principal = cards.find((card) => card.workspace === "principal")!;
    expect(principal).toBeDefined();
    expect(principal.summary.summary).toBe("");
    expect(principal.team.maestro.engine).toBeDefined();

    const put = await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "Faz posts e comentários." } });
    expect(put.statusCode).toBe(200);
    expect(put.json<Card>().summary).toMatchObject({ summary: "Faz posts e comentários.", by: "dono" });
    // Gravou no card.json do workspace.
    expect(JSON.parse(await readFile(path.join(test.dataDir, "workspaces", "principal", "card.json"), "utf8"))).toMatchObject({ summary: "Faz posts e comentários.", by: "dono" });
    expect((await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "x".repeat(281) } })).statusCode).toBe(400);
    expect((await test.app.inject({ method: "PUT", url: "/api/cyno/cards/nada", payload: { summary: "oi" } })).statusCode).toBe(404);
    expect((await test.app.inject({ method: "GET", url: "/api/cyno/waiting" })).json()).toEqual({ items: expect.any(Array) });
  });

  it("a sugestão de uma IA sobre a frase do dono vira proposta; o dono ignora", async () => {
    const test = await setup();
    await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "Frase do dono." } });
    await test.app.workspaces.get("principal").cardSummary.write("Sugestão do Maestro.", "maestro");
    const card = (await test.app.inject({ method: "GET", url: "/api/cyno/cards" })).json<{ cards: Card[] }>().cards.find((entry) => entry.workspace === "principal")!;
    expect(card.summary).toMatchObject({ summary: "Frase do dono.", proposal: { summary: "Sugestão do Maestro.", by: "maestro" } });
    const dismissed = await test.app.inject({ method: "DELETE", url: "/api/cyno/cards/principal/proposal" });
    expect(dismissed.json<Card>().summary.proposal).toBeUndefined();
  });

  it("o digest das fichas abre a conversa; as mensagens seguintes só levam o que mudou (por código), e nada mudou = nada vai", async () => {
    const test = await setup();
    await say(test, "primeira");
    await replyTo(test, "primeira");
    const messages = () => jsonLines<{ sessionId: string; text: string }>(test.messageLog);
    const first = (await messages())[0]!;
    expect(first.text).toContain("[Platform context, built by code with no AI.");
    expect(first.text).toContain("## principal ·");
    expect(first.text.endsWith("\n\nprimeira")).toBe(true);

    // Nada mudou: a segunda vai pura.
    await say(test, "segunda");
    await replyTo(test, "segunda");
    expect((await messages())[1]!.text).toBe("segunda");

    // O dono escreve a frase: a próxima mensagem leva a linha do que mudou, uma vez só.
    await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "Posts do perfil." } });
    await say(test, "terceira");
    await replyTo(test, "terceira");
    expect((await messages())[2]!.text).toBe("terceira\n\n(Workspace changes since your last message, by code: principal: the 'what it does' sentence changed)");
    await say(test, "quarta");
    await replyTo(test, "quarta");
    expect((await messages())[3]!.text).toBe("quarta");
  });

  it("\"Nova conversa\" recomeça com o digest das fichas (e só ele)", async () => {
    const test = await setup();
    await say(test, "conversa velha");
    await replyTo(test, "conversa velha");
    await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "Faço posts do perfil." } });
    await test.app.inject({ method: "POST", url: "/api/cyno/new-conversation" });
    await say(test, "conversa nova");
    await replyTo(test, "conversa nova");
    const last = (await jsonLines<{ text: string }>(test.messageLog)).at(-1)!;
    expect(last.text).toContain("Faz: Faço posts do perfil.");
    expect(last.text).not.toContain("Workspace changes since");
    expect(last.text).not.toContain("conversa velha");
  });

  it("list_workspaces, get_workspace_card e set_workspace_summary do Cyno leem as fichas e escrevem a frase", async () => {
    const test = await setup();
    const tools = test.app.cyno.tools();
    const run = (name: string, input: object) => tools.find((tool) => tool.name === name)!.call(input as never);
    expect((await run("list_workspaces", {})).text).toContain("principal");
    expect((await run("set_workspace_summary", { workspace: "principal", text: "Escrita pelo Cyno." })).text).toMatch(/^Saved/);
    expect((await run("get_workspace_card", { workspace: "principal" })).text).toContain("Faz: Escrita pelo Cyno.");
    expect(test.app.workspaces.get("principal").cardSummary.get()).toMatchObject({ summary: "Escrita pelo Cyno.", by: "cyno" });
  });

  it("o websocket avisa (`cyno:cards`) quando a ficha de um workspace muda", async () => {
    const test = await setup();
    const { port } = test.app.server.address() as AddressInfo;
    const events: CynoServerEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cyno/ws`);
    socket.on("message", (data) => {
      const event = parseCynoEvent(JSON.parse(String(data)));
      if (event) events.push(event);
    });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    await test.app.inject({ method: "GET", url: "/api/cyno/cards" });
    await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "Muda a ficha." } });
    const deadline = Date.now() + 8000;
    while (!events.some((event) => event.type === "cyno:cards" && event.workspaces.includes("principal"))) {
      if (Date.now() > deadline) throw new Error("cyno:cards não chegou");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    socket.close();
  });
});

describe("Cyno: depois de um reinício e as configurações", () => {
  it("o que mudou durante a queda chega como novidade na primeira mensagem depois de voltar (cursor do delta em disco)", async () => {
    const first = await setup();
    await say(first, "antes da queda");
    await replyTo(first, "antes da queda");
    await first.app.close();
    const seenFile = path.join(first.dataDir, "platform", "cyno", "cards-seen.json");
    const seen = JSON.parse(await readFile(seenFile, "utf8")) as Record<string, { waiting: number }>;
    const id = Object.keys(seen)[0]!;
    // Durante a queda "aconteceu" algo: a ficha de antes tinha 5 itens esperando, agora tem 0.
    seen[id]!.waiting = 5;
    await (await import("node:fs/promises")).writeFile(seenFile, JSON.stringify(seen));

    const second = await setup({ dataDir: first.dataDir, fakeState: first.fakeState });
    await say(second, "depois da queda");
    await replyTo(second, "depois da queda");
    const messages = await jsonLines<{ text: string }>(second.messageLog);
    expect(messages.some((message) => message.text.includes(`${id}: -5 waiting for you (now 0)`))).toBe(true);
  });

  it("configurações: lê, grava só o que veio, e o teto de turnos do dia bate com mensagem clara (429)", async () => {
    const test = await setup();
    const initial = (await test.app.inject({ method: "GET", url: "/api/cyno/settings" })).json() as { settings: { idleMinutes: number; dailyTurnCap: number; digest: { enabled: boolean } }; turnsToday: number };
    expect(initial.settings).toMatchObject({ idleMinutes: 10, dailyTurnCap: 40, digest: { enabled: false } });
    expect(initial.turnsToday).toBe(0);
    const saved = await test.app.inject({ method: "PATCH", url: "/api/cyno/settings", payload: { dailyTurnCap: 2, digest: { enabled: true } } });
    expect(saved.json()).toMatchObject({ settings: { idleMinutes: 10, dailyTurnCap: 2, digest: { enabled: true, time: "08:00" } } });
    expect((await test.app.inject({ method: "PATCH", url: "/api/cyno/settings", payload: { dailyTurnCap: 0 } })).statusCode).toBe(400);
    await say(test, "um");
    await replyTo(test, "um");
    expect((await say(test, "dois")).statusCode).toBe(202);
    const capped = await say(test, "três");
    expect(capped.statusCode).toBe(429);
    expect(capped.json<{ error: string }>().error).toMatch(/teto de 2 turnos de hoje/);
    expect(((await test.app.inject({ method: "GET", url: "/api/cyno/settings" })).json() as { turnsToday: number }).turnsToday).toBe(2);
    // Subir o teto libera na hora.
    await test.app.inject({ method: "PATCH", url: "/api/cyno/settings", payload: { dailyTurnCap: 5 } });
    expect((await say(test, "quatro")).statusCode).toBe(202);
  });
});

describe("Cyno: atrás da senha do app", () => {
  it("sem sessão, as rotas e o websocket recusam; com sessão, funcionam", async () => {
    const test = await setup({ password: "senha-de-teste-1" });
    expect((await test.app.inject({ method: "GET", url: "/api/cyno" })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "POST", url: "/api/cyno/messages", payload: { text: "oi" } })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "POST", url: "/api/cyno/new-conversation" })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "PUT", url: "/api/cyno/model", payload: { choice: { engine: "claude" } } })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/api/cyno/cards" })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/api/cyno/waiting" })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "PUT", url: "/api/cyno/cards/principal", payload: { summary: "x" } })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "DELETE", url: "/api/cyno/cards/principal/proposal" })).statusCode).toBe(401);

    // O websocket sem cookie nem abre.
    const host = `127.0.0.1:${test.port}`;
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}/api/cyno/ws`);
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("open", () => reject(new Error("abriu sem senha")));
      socket.once("error", () => undefined);
    });
    expect(status).toBe(401);

    const login = await test.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste-1" } });
    const cookie = String(([] as unknown[]).concat(login.headers["set-cookie"])[0]).split(";")[0]!;
    expect(cookie.startsWith(`${AUTH_COOKIE}=`)).toBe(true);
    expect((await test.app.inject({ method: "GET", url: "/api/cyno", headers: { cookie } })).statusCode).toBe(200);
  });
});

describe("Cyno: websocket", () => {
  it("manda o snapshot ao conectar e depois a fala, o trabalho e a resposta ao vivo", async () => {
    const test = await setup();
    const { port } = test.app.server.address() as AddressInfo;
    const events: CynoServerEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cyno/ws`);
    socket.on("message", (data) => {
      const event = parseCynoEvent(JSON.parse(String(data)));
      if (event) events.push(event);
    });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const waitFor = async (predicate: (event: CynoServerEvent) => boolean) => {
      const deadline = Date.now() + 8000;
      while (!events.some(predicate)) {
        if (Date.now() > deadline) throw new Error("evento do websocket não chegou");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitFor((event) => event.type === "cyno:snapshot");
    expect(events[0]).toMatchObject({ type: "cyno:snapshot", state: { status: "sleeping" }, entries: [] });
    await say(test, "[workspaces] ao vivo");
    await waitFor((event) => event.type === "cyno:log" && event.entry.kind === "chat" && event.entry.from === "user");
    await waitFor((event) => event.type === "cyno:log" && event.entry.kind === "tool" && event.entry.name.endsWith("list_workspaces"));
    await waitFor((event) => event.type === "cyno:log" && event.entry.kind === "chat" && event.entry.from === "agent");
    const statuses = events.flatMap((event) => (event.type === "cyno:status" ? [event.state.status] : []));
    expect(statuses).toContain("waking");
    expect(statuses).toContain("working");
    socket.close();
  });
});
