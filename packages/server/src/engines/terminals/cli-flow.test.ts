import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentLogEntry, AgentUsageResponse, Task, TaskLogResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { MAESTRO_PRIMER_HEADER, MAESTRO_SEED_SEPARATOR } from "../../workspace/maestro/cli-maestro";
import { soloTeam } from "../../dev/test-api";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import type { TerminalsConfig } from "./manager";
import { FAKE_CLI } from "./process-terminal.test";

/** Gestão do Maestro além de criar (manage-tools, agent-tools e calendar-tools), na ordem do tools/list. */
const MANAGE_TOOLS = [
  ...["update_room", "update_team", "update_agent", "set_room_brain_sharing", "delete_room", "delete_team", "delete_agent", "set_agent_access", "set_agent_connectors", "set_agent_skills", "delete_approval_type"],
  ...["start_agent", "stop_agent", "message_agent", "get_agent_activity", "list_requests", "list_projects", "get_usage"],
  ...["list_events", "create_event", "update_event", "delete_event"],
  "set_workspace_summary",
  "ask_cyno",
];
const BROWSER_TOOLS = ["browser_open", "browser_tabs", "browser_snapshot", "browser_current_url", "browser_get_link", "browser_find", "browser_inspect", "browser_click", "browser_type", "browser_upload", "browser_press", "browser_scroll", "browser_back", "browser_screenshot", "browser_close_tab"];
// "Sua agenda" (Maestro e agentes de time), logo depois das ferramentas do papel e antes do Cérebro.
const AGENDA_TOOLS = ["agenda_book", "agenda_free_slots", "agenda_list", "agenda_move", "agenda_cancel"];
const MEDIA_TOOLS = ["media_render_html", "media_save_file", "media_view", "media_list", "media_list_folders", "media_get_file", "media_update"];
const BOARD_TOOLS = ["board_guide", "board_list", "board_save", "board_set_data", "board_patch_data", "board_read_data"];
const MURAL_TOOLS = ["mural_share", "mural_list", "mural_use", "mural_unshare"];

/** Antigravity CLI falso (imita o `agy` stream-json; veja fixtures/agy-stream-json.jsonl). */
const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));

const setupApp = useTestApp();
const tempDir = useTempDirs();

/** Porta livre para o server (a URL do MCP vai na configuração antes do listen). */
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

/** App com terminais da CLI falsa e o server ouvindo de verdade (a CLI falsa chama o MCP por HTTP). */
async function setup(extra: Partial<TerminalsConfig> = {}): Promise<TestApp & { spawnLog: string; messageLog: string; port: number }> {
  const dir = await tempDir();
  const port = await freePort();
  const spawnLog = path.join(dir, "spawns.jsonl");
  const messageLog = path.join(dir, "messages.jsonl");
  const testApp = await setupApp({
    terminals: {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      idleMs: 0,
      maxRetries: 1,
      backoffMs: () => 10,
      stopGraceMs: 2000,
      claude: { command: process.execPath, prefixArgs: [FAKE_CLI] },
      gemini: { command: process.execPath, prefixArgs: [FAKE_AGY] },
      env: {
        ...process.env,
        FAKE_CLI_STATE: path.join(dir, "fake-state"),
        FAKE_CLI_LOG: spawnLog,
        FAKE_CLI_MESSAGES: messageLog,
        ANTHROPIC_API_KEY: "sk-ant-NAO-PODE",
        GEMINI_API_KEY: "gemini-NAO-PODE",
      },
      ...extra,
    },
  });
  await testApp.app.listen({ port, host: "127.0.0.1" });
  return { ...testApp, spawnLog, messageLog, port };
}

/** Subidas da CLI falsa do Claude (argv) e mensagens que ela recebeu. */
async function jsonLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as T);
}

async function patchAgent(testApp: TestApp, id: string, body: Record<string, unknown>) {
  const response = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/${id}`, payload: body });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function taskLog(testApp: TestApp, taskId: string): Promise<AgentLogEntry[]> {
  const response = await testApp.app.inject({ method: "GET", url: `${API}/tasks/${taskId}/log` });
  return (response.json() as TaskLogResponse).entries;
}

async function waitTask(testApp: TestApp, id: string, status: Task["status"], timeoutMs = 8000): Promise<Task> {
  await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === status, timeoutMs);
  return testApp.store.snapshot().tasks.find((task) => task.id === id)!;
}

async function mcp(testApp: TestApp, token: string | undefined, body: unknown) {
  return testApp.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: body as Record<string, unknown>,
  });
}

/** Token MCP do agente (lido do mcp.json que o terminal grava na pasta dele). */
async function tokenOf(testApp: TestApp, agentId: string): Promise<string> {
  const file = path.join(testApp.dir, "agents", agentId, "mcp.json");
  const json = JSON.parse(await readFile(file, "utf8")) as { mcpServers: { office: { headers: { Authorization: string } } } };
  return json.mcpServers.office.headers.Authorization.replace("Bearer ", "");
}

describe("agentes de CLI de ponta a ponta (CLI falsa + MCP por HTTP)", () => {
  it("agente de time com motor claude: a tarefa vai para a sessão viva e `entregar` fecha a tarefa", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "beto", { engine: "claude", model: "sonnet" });
    const response = await testApp.app.inject({
      method: "POST",
      url: `${API}/tasks`,
      payload: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "[entregar] [subagente] [subagente-opus] Escreva um haicai" },
    });
    const task = response.json() as Task;
    expect(task.agentId).toBe("beto");
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Feito pelo fake");
    // A tarefa guarda com que motor/modelo rodou.
    expect(done.ranWith).toEqual({ engine: "claude", model: "sonnet" });

    const entries = await taskLog(testApp, task.id);
    const fromCli = entries.filter((entry) => entry.provider === "claude");
    expect(fromCli.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "mcp__office__submit_result" && entry.status === "ok")).toBe(true);
    expect(entries.some((entry) => entry.kind === "progress" && entry.message === "Metade feita")).toBe(true);
    // Subagente do Claude Code (Agent): thread = id da chamada, com as mensagens de dentro dele e o modelo.
    // Sem `model` na chamada: o padrão de subagentes do workspace (sonnet); com `model`: o que o agente pediu.
    expect(entries.find((entry) => entry.kind === "subagent" && entry.phase === "started" && entry.subagentId === "toolu_sub1")).toMatchObject({ model: "sonnet", label: "Pesquisa rápida" });
    expect(entries.find((entry) => entry.kind === "subagent" && entry.phase === "started" && entry.subagentId === "toolu_sub2")).toMatchObject({ model: "opus" });
    expect(entries.some((entry) => entry.kind === "subagent" && entry.phase === "finished" && entry.subagentId === "toolu_sub2" && entry.status === "ok")).toBe(true);
    expect(entries.some((entry) => entry.thread === "toolu_sub1" && entry.kind === "tool" && entry.name === "Read")).toBe(true);
    expect(entries.some((entry) => entry.kind === "raw" && entry.text.includes("task_started"))).toBe(false);
    expect(entries.some((entry) => entry.kind === "raw" && entry.text === "linha que não é JSON")).toBe(true);
    expect(entries.at(-1)).toMatchObject({ kind: "status", status: "done" });

    // Pasta do agente: CLAUDE.md com as instruções e session.json com a sessão.
    const claudeMd = await readFile(path.join(testApp.dir, "agents", "beto", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Você é Beto");
    expect(claudeMd).toContain("Colegas de time: Clara");
    expect(claudeMd).toContain("submit_result");
    expect(claudeMd).toContain("## Subagentes");
    expect(claudeMd).toContain("padrão do workspace (sonnet, esforço médio)");
    const spawn = JSON.parse((await readFile(testApp.spawnLog, "utf8")).split("\n")[0]!) as { argv: string[]; env: Record<string, string> };
    expect(spawn.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawn.argv[spawn.argv.indexOf("--model") + 1]).toBe("sonnet");
    // Subagentes internos: a ferramenta Agent liberada, o padrão do workspace por env e em primeiro plano.
    // Workspace sem política gravada = os padrões: internet ligada (busca e páginas), terminal desligado.
    expect(spawn.argv[spawn.argv.indexOf("--tools") + 1]).toBe("Read,Write,Edit,Glob,Grep,Agent,WebSearch,WebFetch");
    expect(spawn.argv[spawn.argv.indexOf("--allowedTools") + 1]).toBe("Read,Write,Edit,Glob,Grep,Agent,WebSearch,WebFetch,mcp__office");
    expect(spawn.argv[spawn.argv.indexOf("--disallowedTools") + 1]).toBe("Bash");
    expect(spawn.argv).toContain("--forward-subagent-text");
    expect(spawn.env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_EFFORT: "medium", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
    expect(testApp.log.events.some((event) => event.type === "agent:terminal" && event.terminal.agentId === "beto" && event.terminal.status === "busy")).toBe(true);
  });

  it("Maestro com motor claude: delegar cria a subtarefa, o resultado volta para a sessão dele e complete_request fecha o pedido", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "claude" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[delegar:clara] Escreva um slogan" } });
    expect(response.statusCode).toBe(201);
    const request = response.json() as Task;
    expect(request.agentId).toBe("maestro");

    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toContain("Resposta final do Maestro");
    const subtask = testApp.store.snapshot().tasks.find((task) => task.projectId === request.id)!;
    expect(subtask).toMatchObject({ agentId: "clara", status: "done", prompt: "[entregar] Escreva um slogan" });
    expect(subtask.result).toContain("Feito pelo fake");

    const entries = await taskLog(testApp, request.id);
    expect(entries.some((entry) => entry.kind === "delegation" && entry.subtaskId === subtask.id && entry.toAgentId === "clara" && entry.reason === "Delegado pelo Maestro para Clara")).toBe(true);
    expect(subtask.routeReason).toBe("Delegado pelo Maestro para Clara");
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "mcp__office__delegate_task" && entry.provider === "claude")).toBe(true);
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "mcp__office__complete_request")).toBe(true);
    expect(entries.some((entry) => entry.kind === "result")).toBe(true);
    // A triagem por palavras não rodou.
    expect(entries.some((entry) => entry.kind === "text" && entry.text.includes("Pontuação dos times"))).toBe(false);
    const claudeMd = await readFile(path.join(testApp.dir, "agents", "maestro", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("complete_request");
    expect(claudeMd).toContain("set_agent_model");
    expect(claudeMd).not.toContain("## Subagentes");
    // O Maestro não tem a ferramenta de subagente (ele delega aos times).
    const spawns = await jsonLines<{ argv: string[]; cwd: string; env: Record<string, string> }>(testApp.spawnLog);
    const maestroSpawn = spawns.find((spawn) => spawn.cwd.endsWith(path.join("agents", "maestro")))!;
    expect(maestroSpawn.argv[maestroSpawn.argv.indexOf("--tools") + 1]).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
    expect(maestroSpawn.argv).not.toContain("--forward-subagent-text");
    expect(maestroSpawn.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it("conversa com o Maestro: mensagem solta não cria tarefa e a resposta fica no log da conversa (que volta no GET do agente)", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    const before = testApp.store.snapshot().tasks.length;
    const response = await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "oi, tudo bem?" } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ mode: "conversa" });
    const reply = await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent");
    expect(reply).toMatchObject({ entry: { agentId: "maestro", text: "eco: oi, tudo bem?" } });
    expect(testApp.store.snapshot().tasks).toHaveLength(before);
    // O dono acompanha a entrega: na fila, entregue (o turno começou) e respondeu, na ordem, e só desta mensagem.
    const { messageId } = response.json() as { messageId: string };
    await testApp.log.waitFor((event) => event.type === "agent:chat-status" && event.chat.messageId === messageId && event.chat.status === "answered");
    const states = testApp.log.events.flatMap((event) => (event.type === "agent:chat-status" && event.chat.messageId === messageId ? [event.chat.status] : []));
    expect(states).toEqual(["queued", "delivered", "answered"]);
    expect(testApp.log.events.some((event) => event.type === "agent:chat-status" && event.chat.agentId === "maestro" && event.chat.mode === "conversa")).toBe(true);
    const logId = (reply as { entry: AgentLogEntry }).entry.taskId;
    expect(logId).toMatch(/^conversa-maestro-\d{8}$/);
    const entries = await taskLog(testApp, logId);
    expect(entries[0]).toMatchObject({ kind: "chat", from: "user", text: "oi, tudo bem?", via: "painel" });
    expect(entries.some((entry) => entry.kind === "text" && entry.provider === "claude")).toBe(true);
    // O GET do agente junta o log da conversa (o painel mostra depois de recarregar).
    const agentLog = (await testApp.app.inject({ method: "GET", url: `${API}/agents/maestro/log` })).json() as { entries: AgentLogEntry[] };
    expect(agentLog.entries.filter((entry) => entry.kind === "chat").map((entry) => (entry as { from: string }).from)).toEqual(["user", "agent"]);
    // A mensagem chegou sem "Pedido <id>:"; como abre a conversa, leva antes o contexto do Cérebro (regras e briefing, S1).
    const sent = await jsonLines<{ text: string }>(testApp.messageLog);
    const first = sent.at(-1)!.text;
    expect(first.startsWith(MAESTRO_PRIMER_HEADER)).toBe(true);
    expect(first).toContain("# Contexto do Cérebro para a sala");
    expect(first).toMatch(/_briefing\.md/);
    expect(first.endsWith(`${MAESTRO_SEED_SEPARATOR}oi, tudo bem?`)).toBe(true);
    expect(testApp.store.snapshot().agents.find((agent) => agent.id === "maestro")!.status).not.toBe("working");
    // Só uma vez por conversa: a próxima mensagem vai crua.
    await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "e o tempo?" } });
    await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent" && event.entry.text === "eco: e o tempo?");
    expect((await jsonLines<{ text: string }>(testApp.messageLog)).at(-1)!.text).toBe("e o tempo?");
  });

  it("conversa: o Maestro abre o pedido (open_request), delega e fecha; delegar sem pedido volta erro que manda abrir antes", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "claude" });

    // Sem pedido aberto: delegar recusa e nada é criado.
    await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "[delegar:clara] Escreva um slogan" } });
    const refused = await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent");
    expect((refused as { entry: { text: string } }).entry.text).toContain("first open the request with open_request");
    expect(testApp.store.snapshot().tasks.some((task) => task.agentId === "maestro" || task.agentId === "clara")).toBe(false);

    // Com open_request: a tarefa do Maestro nasce com o título e o briefing, a subtarefa vai para a Clara e o pedido fecha.
    await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "[abrir] [delegar:clara] Escreva um slogan" } });
    const opened = await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.agentId === "maestro");
    const request = (opened as { task: Task }).task;
    expect(request.prompt).toBe("Escreva um slogan\n\nBriefing: Escreva um slogan");
    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toContain("Resposta final do Maestro");
    const subtask = testApp.store.snapshot().tasks.find((task) => task.projectId === request.id)!;
    expect(subtask).toMatchObject({ agentId: "clara", status: "done", prompt: "[entregar] Escreva um slogan" });
    const entries = await taskLog(testApp, request.id);
    expect(entries[0]).toMatchObject({ kind: "status", status: "started", message: "Pedido aberto pelo Maestro: ‘Escreva um slogan’" });
    expect(entries.some((entry) => entry.kind === "text" && entry.text.startsWith("Da conversa:"))).toBe(true);
    expect(entries.some((entry) => entry.kind === "delegation" && entry.subtaskId === subtask.id)).toBe(true);
    expect(entries.some((entry) => entry.kind === "result")).toBe(true);

    // Pedido simples: abre e conclui no mesmo turno.
    await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "[abrir] [concluir] Lista de ideias" } });
    const quick = await testApp.log.waitFor((event) => event.type === "task:upserted" && event.task.agentId === "maestro" && event.task.prompt.startsWith("Lista de ideias") && event.task.status === "done");
    expect((quick as { task: Task }).task.result).toBe("Feito direto pelo Maestro: Lista de ideias");
  });

  it("Maestro simulado: a mensagem ainda vira pedido (triagem por palavras)", async () => {
    const testApp = await setup();
    const response = await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "Escreva um post" } });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { mode: string; task: Task };
    expect(body.mode).toBe("pedido");
    expect(body.task).toMatchObject({ agentId: "maestro", prompt: "Escreva um post" });
  });

  it("sem cota: a tarefa espera na fila (sem trocar de motor) e começa sozinha quando a cota volta", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "beto", { engine: "claude" });
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    testApp.workspaces.usage.report("claude", { windows: [{ id: "five_hour", utilization: 1, resetsAt, status: "rejected" }], status: "rejected" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "[entregar] Escreva um haicai" } });
    const task = response.json() as Task;
    await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.taskId === task.id && event.entry.kind === "status" && event.entry.status === "waiting");
    expect(testApp.store.snapshot().tasks.find((candidate) => candidate.id === task.id)!.status).toBe("queued");
    const waiting = (await taskLog(testApp, task.id)).find((entry) => entry.kind === "status" && entry.status === "waiting");
    expect(waiting).toMatchObject({ message: expect.stringContaining("sem cota · volta às") });
    expect(await jsonLines(testApp.spawnLog)).toHaveLength(0);
    expect(testApp.store.snapshot().agents.find((agent) => agent.id === "beto")).toMatchObject({ engine: "claude", status: "idle" });

    // A cota voltou (uso novo da CLI/conta): a fila anda sozinha.
    testApp.workspaces.usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.1, resetsAt, status: "allowed" }], status: "allowed" });
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Feito pelo fake");
  });

  it("a cota acaba no meio do turno: a tarefa volta para a fila e recomeça quando o usuário manda tentar de novo", async () => {
    const testApp = await setup({ env: { ...process.env, FAKE_CLI_STATE: path.join(await tempDir(), "state"), FAKE_CLI_RESETS_AT: String(Math.floor(Date.now() / 1000) + 3600) } });
    await patchAgent(testApp, "beto", { engine: "claude" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "[cota] [entregar] Escreva um haicai" } });
    const task = response.json() as Task;
    await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.taskId === task.id && event.entry.kind === "status" && event.entry.status === "waiting" && event.entry.message.includes("acabou no meio"));
    expect(testApp.store.snapshot().tasks.find((candidate) => candidate.id === task.id)!.status).toBe("queued");
    expect(testApp.workspaces.usage.get("claude")).toMatchObject({ status: "rejected" });

    // "Tentar agora" (o usuário): a fila anda; a CLI falsa já tem cota e entrega.
    const retry = await testApp.app.inject({ method: "POST", url: "/api/engines/retry", payload: { engine: "claude" } });
    expect(retry.statusCode).toBe(204);
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Feito pelo fake");
  });

  it("delegar com motivo: vira o reason da delegação e o routeReason da subtarefa; o uso da assinatura vira estado, não log", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "claude" });
    const response = await testApp.app.inject({
      method: "POST",
      url: `${API}/tasks`,
      payload: { prompt: "[delegar:clara] [motivo:Clara é a redatora do time de Conteúdo] Escreva um slogan" },
    });
    const request = response.json() as Task;
    await waitTask(testApp, request.id, "done");
    const subtask = testApp.store.snapshot().tasks.find((task) => task.projectId === request.id)!;
    expect(subtask).toMatchObject({ prompt: "[entregar] Escreva um slogan", routeReason: "Clara é a redatora do time de Conteúdo" });
    const entries = await taskLog(testApp, request.id);
    const delegation = entries.find((entry) => entry.kind === "delegation");
    expect(delegation).toMatchObject({ reason: "Clara é a redatora do time de Conteúdo", toAgentId: "clara" });

    // rate_limit_event da CLI falsa: estado global de uso (usage:updated), nunca linha raw.
    expect(entries.some((entry) => entry.kind === "raw" && entry.text.includes("rate_limit"))).toBe(false);
    expect(testApp.workspaces.usage.snapshot()).toEqual([
      expect.objectContaining({
        provider: "claude",
        status: "allowed",
        windows: [expect.objectContaining({ id: "five_hour", utilization: 0.27 }), expect.objectContaining({ id: "seven_day", utilization: 0.44 })],
      }),
    ]);
    // Cada turno terminado entra no uso estimado por agente (tokens do `result` da CLI).
    const perAgent = await testApp.app.inject({ method: "GET", url: `${API}/usage/agents` });
    expect(perAgent.statusCode).toBe(200);
    const tallies = (perAgent.json() as AgentUsageResponse).agents;
    expect(tallies.map((tally) => tally.agentId).sort()).toEqual(["clara", "maestro"]);
    const clara = tallies.find((tally) => tally.agentId === "clara")!;
    expect(clara).toMatchObject({ provider: "claude", outputTokens: 200 * clara.turns, cacheReadTokens: 3000 * clara.turns });
    expect(clara.turns).toBeGreaterThanOrEqual(1);
    // E cada turno também sai como evento (usage:agents): o web soma ao vivo, sem consultar a rota em intervalo.
    const turns = testApp.log.events.flatMap((event) => (event.type === "usage:agents" ? [event.turn] : []));
    expect(turns.filter((turn) => turn.agentId === "clara")).toHaveLength(clara.turns);
    expect(turns.find((turn) => turn.agentId === "clara")).toMatchObject({ provider: "claude", usage: { outputTokens: 200, cacheReadTokens: 3000 } });
    expect((await testApp.app.inject({ method: "GET", url: `${API}/usage/agents?since=ontem` })).statusCode).toBe(400);
    const spawn = JSON.parse((await readFile(testApp.spawnLog, "utf8")).split("\n")[0]!) as { argv: string[] };
    expect(JSON.parse(spawn.argv[spawn.argv.indexOf("--settings") + 1]!)).toMatchObject({ syncClaudeAiPlugins: false });
  });

  it("request_approval do Maestro: o pedido espera você; a decisão volta para a sessão dele", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[aprovar] Posso publicar o post?" } });
    const request = response.json() as Task;
    await waitTask(testApp, request.id, "waiting_approval");
    const maestro = testApp.store.snapshot().agents.find((agent) => agent.id === "maestro")!;
    expect(maestro.status).toBe("waiting_approval");
    const decided = await testApp.app.inject({ method: "POST", url: `${API}/tasks/${request.id}/approval`, payload: { approved: true } });
    expect(decided.statusCode).toBe(200);
    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toContain("Resposta final do Maestro");
    expect(testApp.store.forYouSnapshot().find((item) => item.taskId === request.id)?.status).toBe("aprovado");
    const entries = await taskLog(testApp, request.id);
    expect(entries.some((entry) => entry.kind === "approval" && entry.phase === "decided" && entry.approved)).toBe(true);
  });

  it("request_approval do agente: a tarefa espera você; aprovar manda a decisão para a sessão e ele entrega", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "beto", { engine: "claude" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "[aprovar] Post do dia" } });
    const task = response.json() as Task;
    await waitTask(testApp, task.id, "waiting_approval");
    const item = testApp.store.forYouSnapshot().find((candidate) => candidate.taskId === task.id)!;
    expect(item).toMatchObject({ type: "post", text: "Rascunho do fake", status: "pendente" });
    const decided = await testApp.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/decision`, payload: { status: "aprovado", text: "Texto aprovado" } });
    expect(decided.statusCode).toBe(200);
    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Decisão do usuário");
  });

  it("agente sem cota: get_team marca INDISPONÍVEL e delegar recusa (o Maestro avisa o usuário)", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "gemini" });
    testApp.workspaces.usage.report("gemini", { windows: [{ id: "five_hour", utilization: 1, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] });
    const team = testApp.workspaces.get("principal").cliMaestro.team();
    expect(team).toMatch(/Clara \(agent_id: clara\) — Redatora; engine: Antigravity · padrão da CLI; access: internet, browser; status: idle; pending tasks: 0; UNAVAILABLE \(sem cota · volta às \d\d:\d\d\): do not delegate/);
    expect(team).not.toMatch(/Beto.*UNAVAILABLE/);

    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[delegar:clara] Escreva um slogan" } });
    const request = response.json() as Task;
    await waitTask(testApp, request.id, "done");
    expect(testApp.store.snapshot().tasks.some((task) => task.projectId === request.id)).toBe(false);
    const delegar = (await taskLog(testApp, request.id)).find((entry) => entry.kind === "tool" && entry.name === "mcp__office__delegate_task");
    expect(delegar).toMatchObject({ status: "error", output: expect.stringContaining("unavailable") });
  });

  it("Maestro sem cota: o pedido espera (mostra quando volta) e segue sozinho quando a cota volta", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    testApp.workspaces.usage.report("claude", { windows: [{ id: "five_hour", utilization: 1, resetsAt }], status: "rejected" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "Oi Maestro" } });
    const request = response.json() as Task;
    await testApp.log.waitFor((event) => event.type === "task:progress" && event.taskId === request.id && event.message.includes("sem cota"));
    expect(await jsonLines(testApp.spawnLog)).toHaveLength(0);
    testApp.workspaces.usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.2, resetsAt }], status: "allowed" });
    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toContain("eco: Pedido");
  });

  it("remover o agente para o terminal dele e revoga o token MCP", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "beto", { engine: "claude" });
    const started = await testApp.app.inject({ method: "POST", url: `${API}/agents/beto/terminal/start` });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ agentId: "beto", engine: "claude", status: "idle" });
    const token = await tokenOf(testApp, "beto");
    expect((await mcp(testApp, token, { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode).toBe(200);
    const removed = await testApp.app.inject({ method: "DELETE", url: `${API}/agents/beto` });
    expect(removed.statusCode).toBe(204);
    const runtime = testApp.workspaces.get("principal");
    expect(runtime.terminals.find("beto")).toBeUndefined();
    expect((await mcp(testApp, token, { jsonrpc: "2.0", id: 2, method: "ping" })).statusCode).toBe(401);
  });

  it("rotas do terminal: start/stop num agente claude; 409 num agente simulado", async () => {
    const testApp = await setup();
    const mock = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/start` });
    expect(mock.statusCode).toBe(409);
    await patchAgent(testApp, "lia", { engine: "claude" });
    const started = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/start` });
    expect(started.json()).toMatchObject({ status: "idle" });
    const stopped = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/stop` });
    expect(stopped.json()).toMatchObject({ status: "stopped" });
    // Motor sem adaptador de CLI já é recusado ao configurar o agente (400), não só ao subir o terminal.
    const notYet = await testApp.app.inject({ method: "PATCH", url: `${API}/agents/lia`, payload: { engine: "codex" } });
    expect(notYet.statusCode).toBe(400);
    expect(notYet.json()).toMatchObject({ error: expect.stringContaining("ainda não tem adaptador") });
  });

  it("agente que saiu do Claude Code (com esforço) para um modelo Gemini sobe o agy sem --effort (a CLI falsa recusa, como a de verdade)", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "claude", model: "sonnet", effort: "high" });
    await patchAgent(testApp, "clara", { engine: "gemini" });
    await patchAgent(testApp, "clara", { model: "gemini-3.8-flash-medium" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[delegar:clara] Pesquise um fato sobre pizza" } });
    const done = await waitTask(testApp, (response.json() as Task).id, "done");
    expect(done.result).toContain("Resposta final do Maestro");
    const spawns = (await readFile(testApp.spawnLog, "utf8")).split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as { cli?: string; argv: string[] });
    const agy = spawns.find((spawn) => spawn.cli === "agy")!;
    expect(agy.argv[agy.argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium");
    expect(agy.argv).not.toContain("--effort");
  });

  it("Maestro no Claude Code delega para um agente no Antigravity (gemini): GEMINI.md, MCP do workspace e retomada", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "gemini", model: "gemini-3.8-flash-medium" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[delegar:clara] Pesquise três fatos sobre pizza" } });
    const request = response.json() as Task;
    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toContain("Resposta final do Maestro");
    const subtask = testApp.store.snapshot().tasks.find((task) => task.projectId === request.id)!;
    expect(subtask).toMatchObject({ agentId: "clara", status: "done" });
    expect(subtask.result).toContain("Feito pelo agy falso");

    const entries = await taskLog(testApp, subtask.id);
    expect(entries.some((entry) => entry.kind === "tool" && entry.name === "mcp__office__submit_result" && entry.status === "ok" && entry.provider === "gemini")).toBe(true);
    expect(entries.some((entry) => entry.kind === "progress" && entry.message === "Metade feita (agy)")).toBe(true);
    expect(entries.some((entry) => entry.kind === "raw" && entry.text.startsWith("[init] conversa"))).toBe(true);

    // Pasta do agente: GEMINI.md (instruções) e .agents/mcp_config.json (token, 0600); nada de mcp.json.
    const dir = path.join(testApp.dir, "agents", "clara");
    const gemini = await readFile(path.join(dir, "GEMINI.md"), "utf8");
    expect(gemini).toContain("Você é Clara");
    // agy não deixa esconder terminal/navegador: as instruções dizem para nem tentar (nem olhar ~/.gemini).
    expect(gemini).toContain("`run_command` (terminal)");
    expect(gemini).toContain("Não leia nem liste pastas de configuração");
    const mcpConfig = JSON.parse(await readFile(path.join(dir, ".agents", "mcp_config.json"), "utf8")) as { mcpServers: { office: { url: string; headers: Record<string, string> } } };
    expect(mcpConfig.mcpServers.office.url).toBe(`http://127.0.0.1:${testApp.port}/mcp`);
    expect(mcpConfig.mcpServers.office.headers.Authorization).toMatch(/^Bearer /);
    expect((await stat(path.join(dir, ".agents", "mcp_config.json"))).mode & 0o777).toBe(0o600);
    const session = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")) as { provider: string; sessionId: string; started: boolean };
    expect(session).toMatchObject({ provider: "gemini", started: true });

    const spawns = (await readFile(testApp.spawnLog, "utf8")).split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as { cli?: string; argv: string[]; env: Record<string, string> });
    const agy = spawns.find((spawn) => spawn.cli === "agy")!;
    expect(agy.env.GEMINI_API_KEY).toBeUndefined();
    expect(agy.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(agy.argv[agy.argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium");
    expect(agy.argv).not.toContain("--conversation");

    // Parar e mandar outra tarefa: sessão por tarefa = conversa nova (sem --conversation da antiga).
    await testApp.app.inject({ method: "POST", url: `${API}/agents/clara/terminal/stop` });
    const again = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[delegar:clara] Mais um fato" } });
    await waitTask(testApp, (again.json() as Task).id, "done");
    const spawned = (await readFile(testApp.spawnLog, "utf8")).split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as { cli?: string; argv: string[] }).filter((spawn) => spawn.cli === "agy");
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.argv).not.toContain("--conversation");
    const next = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")) as { sessionId: string; started: boolean };
    expect(next.started).toBe(true);
    expect(next.sessionId).not.toBe(session.sessionId);
  });
});

describe("sessão por tarefa, diário e renovação do Maestro (CLI falsa)", () => {
  it("cada tarefa do agente abre uma conversa nova; a seguinte traz o diário e o contexto do Cérebro com as camadas", async () => {
    const testApp = await setup();
    // Time de um agente só (a fila não desvia a 2ª tarefa para um colega).
    const { room, team, agent } = await soloTeam(testApp.app);
    await patchAgent(testApp, agent.id, { engine: "claude" });
    await writeFile(path.join(testApp.dir, "brains", room.id, "briefing.md"), "# Briefing do cliente\n\nCliente quer posts curtos.");
    const post = async (prompt: string) => {
      const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: room.id, teamId: team.id, prompt } });
      return waitTask(testApp, (response.json() as Task).id, "done");
    };
    const first = await post("[entregar] Escreva o post sobre leitura");
    const second = await post("[entregar] Escreva outro post");

    const spawns = (await jsonLines<{ argv: string[] }>(testApp.spawnLog)).map((spawn) => spawn.argv);
    expect(spawns).toHaveLength(2);
    const ids = spawns.map((argv) => argv[argv.indexOf("--session-id") + 1]);
    expect(spawns.every((argv) => !argv.includes("--resume"))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(spawns[0]![spawns[0]!.indexOf("--autocompact") + 1]).toBe("auto");

    const messages = await jsonLines<{ sessionId: string; text: string }>(testApp.messageLog);
    const firstMessage = messages.find((message) => message.text.includes(`Tarefa ${first.id}:`))!;
    const secondMessage = messages.find((message) => message.text.includes(`Tarefa ${second.id}:`))!;
    expect(firstMessage.text).not.toContain("O que você fez recentemente");
    expect(secondMessage.text.startsWith("## O que você fez recentemente (seu diário)")).toBe(true);
    expect(secondMessage.text).toContain("Escreva o post sobre leitura");
    expect(secondMessage.text).toContain("Feito pelo fake");
    // Contexto em camadas: fixos e o briefing semeado; nada do histórico (o resultado da 1ª tarefa).
    expect(secondMessage.text).toContain(`\`${room.id}/_regras.md\``);
    expect(secondMessage.text).toContain(`\`${room.id}/briefing.md\``);
    expect(secondMessage.text).not.toMatch(/historico\/\d{4}-/);
    expect(secondMessage.sessionId).not.toBe(firstMessage.sessionId);

    const diary = await readFile(path.join(testApp.dir, "agents", agent.id, "diario.md"), "utf8");
    expect(diary.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    expect(diary).toContain("“[entregar] Escreva outro post” → entregue: Feito pelo fake");
  });

  it("Maestro: conversa acima do teto abre uma nova com o resumo (sem chamada extra) e o pedido segue", async () => {
    // A CLI falsa diz ~3.050 tokens de conversa por turno: com teto 3.000, o 1º turno já marca a renovação.
    const testApp = await setup({ maestroRotateTokens: 3000 });
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "claude" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[delegar:clara] Escreva um slogan" } });
    const request = response.json() as Task;
    const done = await waitTask(testApp, request.id, "done");
    expect(done.result).toContain("Resposta final do Maestro");

    const maestroDir = path.join(testApp.dir, "agents", "maestro");
    const spawns = (await jsonLines<{ argv: string[]; cwd: string }>(testApp.spawnLog)).filter((spawn) => spawn.cwd === maestroDir).map((spawn) => spawn.argv);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).not.toContain("--resume");
    expect(spawns[1]![spawns[1]!.indexOf("--session-id") + 1]).not.toBe(spawns[0]![spawns[0]!.indexOf("--session-id") + 1]);
    const seeded = (await jsonLines<{ text: string }>(testApp.messageLog)).find((message) => message.text.startsWith("(Conversa nova"))!;
    expect(seeded.text).toContain("## Pedidos em aberto");
    expect(seeded.text).toContain(`Pedido ${request.id}`);
    expect(seeded.text).toContain("## Cérebro (regras, briefing e títulos das notas)");
    expect(seeded.text).toContain("\n\n---\n\nResultado da tarefa");
  });
});

describe("servidor MCP /mcp", () => {
  it("exige token de um terminal; GET é 405", async () => {
    const testApp = await setup();
    expect((await mcp(testApp, undefined, { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode).toBe(401);
    expect((await mcp(testApp, "nao-existe", { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode).toBe(401);
    expect((await testApp.app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
  });

  it("initialize, tools/list por papel, notificação 202 e erros de ferramenta como isError", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "clara", { engine: "claude" });
    await testApp.app.inject({ method: "POST", url: `${API}/agents/maestro/terminal/start` });
    await testApp.app.inject({ method: "POST", url: `${API}/agents/clara/terminal/start` });
    const maestroToken = await tokenOf(testApp, "maestro");
    const claraToken = await tokenOf(testApp, "clara");

    const init = await mcp(testApp, maestroToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    expect(init.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-office" } } });
    expect((await mcp(testApp, maestroToken, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);

    const names = async (token: string) =>
      ((await mcp(testApp, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: { name: string; inputSchema: { type: string } }[] } }).result.tools;
    const maestroTools = await names(maestroToken);
    expect(maestroTools.map((tool) => tool.name)).toEqual([
      "get_team",
      "open_request",
      "delegate_task",
      "get_task",
      "complete_request",
      "request_approval",
      "ask_user",
      "list_pending_items",
      "update_pending_item",
      "cancel_pending_item",
      "cancel_request",
      "add_sprint",
      "update_sprint",
      "move_task",
      "assign_task",
      "reassign_task",
      "close_sprint",
      "create_project",
      "add_project_tasks",
      "resolve_task",
      "get_project",
      "update_project",
      "routine_propose",
      "routine_update_propose",
      "routine_list",
      "routine_status",
      "routine_pause",
      "routine_resume",
      "routine_item_stop",
      "routine_items",
      "get_today",
      "get_day_stats",
      "get_metrics",
      "get_report",
      "propose_rule",
      "propose_brain_cleanup",
      "set_approval_type",
      "list_room_options",
      "create_room",
      "create_team",
      "create_agent",
      "set_agent_model",
      "set_team_lead",
      ...MANAGE_TOOLS,
      ...AGENDA_TOOLS,
      "search_notes",
      "read_note",
      "save_note",
      "save_agent_rule",
      // Navegador compartilhado (ligado por padrão no workspace e no agente).
      ...BROWSER_TOOLS,
      ...MEDIA_TOOLS,
      ...BOARD_TOOLS,
      ...MURAL_TOOLS,
    ]);
    expect(maestroTools[1]!.inputSchema.type).toBe("object");
    expect((await names(claraToken)).map((tool) => tool.name)).toEqual(["get_task", "ask_user", "list_pending_items", "update_pending_item", "cancel_pending_item", "routine_items_list", "routine_item_add", "routine_item_update", "routine_item_stop", "routine_status", "routine_record", "request_help", "send_to_colleague", "submit_result", "report_progress", "request_approval", ...AGENDA_TOOLS, "search_notes", "read_note", "save_note", "save_agent_rule", ...BROWSER_TOOLS, ...MEDIA_TOOLS, ...BOARD_TOOLS, ...MURAL_TOOLS]);

    const team = await mcp(testApp, maestroToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_team", arguments: {} } });
    const teamText = (team.json() as { result: { content: { text: string }[] } }).result.content[0]!.text;
    expect(teamText).toContain("agent_id: clara");
    expect(teamText).toContain("engine: Claude Code");
    expect(teamText).not.toContain("Gerência");

    // Sem tarefa em andamento: entregar volta erro para o modelo (não derruba nada).
    const deliver = await mcp(testApp, claraToken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submit_result", arguments: { result: "x" } } });
    expect(deliver.json()).toMatchObject({ result: { isError: true } });
    const badArgs = await mcp(testApp, claraToken, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "report_progress", arguments: { percent: "muito" } } });
    expect(badArgs.json()).toMatchObject({ result: { isError: true } });
    const unknown = await mcp(testApp, claraToken, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delegate_task", arguments: {} } });
    expect(unknown.json()).toMatchObject({ error: { code: -32602 } });
    const noMethod = await mcp(testApp, claraToken, { jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(noMethod.json()).toMatchObject({ error: { code: -32601 } });
  });

  it("com mcpReadyTimeoutMs: agente de time (sem PTY) não espera o MCP; o Maestro em PTY é que espera (pty-terminal.test)", async () => {
    const testApp = await setup({ mcpReadyTimeoutMs: 10_000 });
    await patchAgent(testApp, "lia", { engine: "claude" });
    const sent = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/chat`, payload: { text: "oi" } });
    expect(sent.statusCode).toBe(202);
    const reply = await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent" && event.entry.agentId === "lia");
    expect(reply).toMatchObject({ entry: { text: expect.stringContaining("eco: Mensagem direta do usuário") } });
  });
});

describe("estado do terminal, ligar/desligar e conversa direta (CLI falsa)", () => {
  const terminalEvents = (testApp: TestApp, agentId: string) =>
    testApp.log.events.flatMap((event) => (event.type === "agent:terminal" && event.terminal.agentId === agentId ? [event.terminal] : []));

  it("criado (nunca iniciado) → iniciando → ligado → desligado pelo usuário; depois, segue \"já iniciado\" (session.json)", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "lia", { engine: "claude" });
    const runtime = testApp.workspaces.get("principal");
    expect(runtime.terminals.snapshot().lia).toMatchObject({ status: "stopped" });
    expect(runtime.terminals.snapshot().lia!.everStarted).toBeUndefined();
    await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/start` });
    const stopped = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/stop` });
    expect(stopped.json()).toMatchObject({ status: "stopped", everStarted: true, stoppedReason: "Parado por você" });
    expect(terminalEvents(testApp, "lia").map((info) => info.status)).toEqual(["starting", "idle", "stopped"]);
    // Um turno grava o session.json: sem o terminal em memória (como num server reiniciado), continua "já iniciado".
    await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/chat`, payload: { text: "oi" } });
    await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.agentId === "lia" && event.entry.kind === "chat" && event.entry.from === "agent");
    await runtime.terminals.dispose("lia");
    // Estava no ar quando "o server caiu": o motivo é o reinício (não um "Parado" sem explicação).
    expect(runtime.terminals.snapshot().lia).toMatchObject({ status: "stopped", everStarted: true, stoppedReason: "Servidor reiniciado" });
    // Parado por você antes do reinício: o motivo fica (terminal-stop.json na pasta do agente).
    await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/start` });
    await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/stop` });
    const stopFile = path.join(testApp.dir, "agents", "lia", "terminal-stop.json");
    for (let i = 0; i < 50 && !(await readFile(stopFile, "utf8").catch(() => "")).includes("Parado por você"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.terminals.dispose("lia");
    expect(runtime.terminals.snapshot().lia).toMatchObject({ status: "stopped", stoppedReason: "Parado por você" });
  });

  it("conversa direta com o agente livre: resposta no log conversa-<agente>-AAAAMMDD, balão liga e desliga; desligar no meio do turno pede confirmação", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "lia", { engine: "claude" });
    const sent = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/chat`, payload: { text: "qual é o seu foco?" } });
    expect(sent.statusCode).toBe(202);
    const { logId } = sent.json() as { mode: string; logId: string };
    expect(sent.json()).toMatchObject({ mode: "conversa" });
    expect(logId).toMatch(/^conversa-lia-\d{8}$/);
    const reply = await testApp.log.waitFor((event) => event.type === "agent:log" && event.entry.kind === "chat" && event.entry.from === "agent" && event.entry.agentId === "lia");
    expect(reply).toMatchObject({ entry: { taskId: logId, text: expect.stringContaining("eco: Mensagem direta do usuário") } });
    const chattingFlags = terminalEvents(testApp, "lia").map((info) => info.chatting ?? false);
    expect(chattingFlags).toContain(true);
    expect(chattingFlags.at(-1)).toBe(false);
    const read = await testApp.app.inject({ method: "GET", url: `${API}/agents/lia/log` });
    expect((read.json() as { entries: AgentLogEntry[] }).entries.filter((entry) => entry.kind === "chat").map((entry) => entry.kind === "chat" && entry.from)).toEqual(["user", "agent"]);

    // Turno lento em curso: desligar sem confirmação = 409; com force, desliga.
    await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/chat`, payload: { text: "pensa com calma [lento]" } });
    await testApp.log.waitFor((event) => event.type === "agent:terminal" && event.terminal.agentId === "lia" && event.terminal.status === "busy");
    const refused = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/stop` });
    expect(refused.statusCode).toBe(409);
    const forced = await testApp.app.inject({ method: "POST", url: `${API}/agents/lia/terminal/stop?force=1` });
    expect(forced.json()).toMatchObject({ status: "stopped" });
  });

  it("agente trabalhando numa tarefa: a mensagem vira nota da tarefa (no log dela) e não abre conversa", async () => {
    const testApp = await setup();
    const { room, team, agent } = await soloTeam(testApp.app, "Notas");
    await patchAgent(testApp, agent.id, { engine: "claude" });
    const created = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "Escreva devagar [lento]", roomId: room.id, teamId: team.id } });
    const task = created.json() as Task;
    await testApp.log.waitFor((event) => event.type === "agent:terminal" && event.terminal.agentId === agent.id && event.terminal.status === "busy");
    const sent = await testApp.app.inject({ method: "POST", url: `${API}/agents/${agent.id}/chat`, payload: { text: "foca no público jovem" } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({ mode: "nota", taskId: task.id });
    const log = await taskLog(testApp, task.id);
    expect(log.find((entry) => entry.kind === "chat")).toMatchObject({ from: "user", text: "foca no público jovem" });
  });
});

describe("Para você: cancelar e descartar com as CLIs (CLI falsa + MCP por HTTP)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("descartar o questionário do Maestro não o acorda: o pedido espera você e ele fica sabendo na próxima mensagem", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[perguntas] Post sobre IA" } });
    const request = response.json() as Task;
    await waitTask(testApp, request.id, "waiting_approval");
    const item = testApp.store.forYouSnapshot().find((candidate) => candidate.taskId === request.id)!;
    expect(item).toMatchObject({ kind: "questionario", status: "pendente" });
    await sleep(200);
    const before = (await jsonLines<{ text: string }>(testApp.messageLog)).length;

    const discarded = await testApp.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/cancel`, payload: { reason: "vou responder na conversa" } });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json()).toMatchObject({ status: "cancelado", cancelledBy: "usuario" });
    await sleep(300);
    // Ninguém acordou: nenhuma mensagem nova para o Maestro; o pedido segue aberto, esperando você.
    expect(await jsonLines(testApp.messageLog)).toHaveLength(before);
    const waiting = testApp.store.snapshot().tasks.find((task) => task.id === request.id)!;
    expect(waiting).toMatchObject({ status: "waiting_approval", waiting: `Você descartou ${item.id}: fale com o Maestro para seguir` });

    await testApp.app.inject({ method: "POST", url: `${API}/maestro/messages`, payload: { text: "oi, mudei de ideia" } });
    let sent: { text: string }[] = [];
    for (let attempt = 0; attempt < 80 && sent.length <= before; attempt += 1) {
      await sleep(50);
      sent = await jsonLines<{ text: string }>(testApp.messageLog);
    }
    const next = sent.at(-1)!.text;
    expect(next).toContain("oi, mudei de ideia");
    expect(next).toContain(`(Aviso do servidor: O usuário descartou o seu item ${item.id}`);
    expect(next).toContain("Motivo: vou responder na conversa.");
  });

  it("o Maestro cancela o questionário de um agente (MCP): a tarefa dele segue sem as respostas e entrega", async () => {
    const testApp = await setup();
    await patchAgent(testApp, "maestro", { engine: "claude" });
    await patchAgent(testApp, "beto", { engine: "claude" });
    await testApp.app.inject({ method: "POST", url: `${API}/agents/maestro/terminal/start` });
    const response = await testApp.app.inject({ method: "POST", url: `${API}/tasks`, payload: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "[info] Pesquisa de fontes" } });
    const task = response.json() as Task;
    await waitTask(testApp, task.id, "waiting_approval");
    const item = testApp.store.forYouSnapshot().find((candidate) => candidate.taskId === task.id)!;
    expect(item).toMatchObject({ kind: "questionario", agentId: "beto" });

    const token = await tokenOf(testApp, "maestro");
    const listed = await mcp(testApp, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_pending_items", arguments: {} } });
    expect((listed.json() as { result: { content: { text: string }[] } }).result.content[0]!.text).toContain(`${item.id} — questionnaire — “Dúvidas da pesquisa”`);
    const cancelled = await mcp(testApp, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cancel_pending_item", arguments: { id: item.id, reason: "a fonte já está no briefing" } } });
    expect((cancelled.json() as { result: { content: { text: string }[] } }).result.content[0]!.text).toContain(`Item ${item.id} cancelled`);

    const done = await waitTask(testApp, task.id, "done");
    expect(done.result).toContain("Feito pelo fake");
    expect(testApp.store.forYouSnapshot().find((candidate) => candidate.id === item.id)).toMatchObject({ status: "cancelado", cancelledBy: "maestro", cancelReason: "a fonte já está no briefing" });
    const sent = await jsonLines<{ text: string }>(testApp.messageLog);
    expect(sent.some((message) => message.text.includes("SEM RESPOSTA — o Maestro cancelou este item do Para você. Motivo: a fonte já está no briefing"))).toBe(true);
    const entries = await taskLog(testApp, task.id);
    expect(entries.some((entry) => entry.kind === "approval" && entry.phase === "decided" && !entry.approved && entry.note === "Cancelado pelo Maestro: a fonte já está no briefing")).toBe(true);
  });
});
