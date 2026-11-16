import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_DENY, ANTIGRAVITY_MCP_CONFIG, AntigravityCliAdapter, AntigravityStreamParser, antigravitySessionSettings } from "./antigravity-adapter";
import { DEFAULT_AGENT_TOOLS } from "./claude-adapter";
import { detectEngines, EngineCatalog, parseAgyModels, type EngineProbe } from "./engines";
import { isStrippedEnvName, sanitizeChildEnv } from "./env";
import type { TerminalAccess, TerminalEvent, TerminalSpec } from "./types";

const CWD = "/dados/workspaces/lab/agents/pesquisador";
const spec: TerminalSpec = {
  agentId: "pesquisador",
  cwd: CWD,
  systemPrompt: "Você é o Pesquisador.",
  mcpConfigFile: `${CWD}/mcp.json`,
  tools: DEFAULT_AGENT_TOOLS,
};

/** Saída real do `agy` 1.5.3 (dois processos: 2 turnos e depois --conversation), capturada no smoke test. */
const FIXTURE = readFileSync(new URL("./fixtures/agy-stream-json.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

const parseAll = (lines: string[]) => {
  const parser = new AntigravityStreamParser();
  return lines.flatMap((line) => parser.parse(line));
};
const line = (event: unknown) => JSON.stringify(event);

describe("AntigravityStreamParser (saída real do agy capturada)", () => {
  it("traduz init, ferramentas, MCP, texto e o fim de cada turno", () => {
    const events = parseAll(FIXTURE);
    const sessions = events.filter((event) => event.type === "session");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ sessionId: "00948f55-cf14-46ce-8048-086dcf78791f", model: "gemini-3.8-flash-low" });
    expect((sessions[0] as { tools?: string[] }).tools).toContain("call_mcp_tool");

    // Ferramenta embutida: ACTIVE -> tool_use, DONE -> tool_result com a saída.
    const read = events.find((event) => event.type === "tool_use" && event.name === "read_file");
    expect(read).toMatchObject({ id: "agy-00948f55-2", input: { Path: expect.stringContaining("entregar.json") } });
    expect(events).toContainEqual({ type: "tool_result", id: "agy-00948f55-2", ok: true, output: "1 lines, 172 bytes" });

    // call_mcp_tool vira mcp__office__<ferramenta> com os argumentos (como no Claude Code).
    expect(events).toContainEqual({ type: "tool_use", id: "agy-00948f55-7", name: "mcp__office__submit_result", input: { result: "fim" } });
    expect(events).toContainEqual({ type: "tool_result", id: "agy-00948f55-7", ok: true, output: "Submitted. The task will be completed when you finish this turn." });

    // Os text_delta de um passo viram um texto só, quando o passo fica DONE.
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text)).toEqual([
      "fim",
      'A última coisa que você pediu antes desta mensagem foi para responder apenas "fim".',
    ]);

    const ends = events.filter((event) => event.type === "turn_end");
    // Tokens de cada turno = soma dos `usage` dos passos (o do result é acumulado da conversa:
    // 15424 → 31486 → 56812 de entrada, inclusive depois de retomar com --conversation).
    const turn = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(ends).toEqual([
      { type: "turn_end", ok: true, result: "", usage: turn(7633 + 7791, 38 + 54) },
      { type: "turn_end", ok: true, result: "fim", usage: turn(7978 + 8084, 36 + 1) },
      { type: "turn_end", ok: true, result: 'A última coisa que você pediu antes desta mensagem foi para responder apenas "fim".', usage: turn(8319 + 8450 + 8557, 65 + 37 + 16) },
    ]);
    // Leitura fora da pasta negada (modo headless): vira uma linha no log, antes do fim do turno.
    expect(events.some((event) => event.type === "raw" && event.stream === "stderr" && event.text.startsWith("[negado] read_file (ReadFile)"))).toBe(true);
    // user_input/system_message não viram nada; o init vira um resumo.
    expect(events.filter((event) => event.type === "raw" && event.text.startsWith("[init]"))).toHaveLength(1); // o init repetido da retomada não vira outra linha
    expect(events.some((event) => event.type === "raw" && event.text.includes("user_input"))).toBe(false);
  });

  it("erro de ferramenta, resultado com erro, subagente, JSON quebrado e eventos desconhecidos (nunca lança)", () => {
    const parser = new AntigravityStreamParser();
    const events: TerminalEvent[] = [
      ...parser.parse(line({ event: "init", conversation_id: "conv-1", init: { cwd: CWD, tools: [], permission_mode: "request-review" } })),
      ...parser.parse(line({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 3, state: "DONE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: { Path: "/x" }, error: { type: "PERMISSION", message: "negado" } } } })),
      ...parser.parse(line({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", subagent_info: { name: "Pesquisa", prompt: "Pesquise X", conversation_id: "conv-filha" } } })),
      ...parser.parse(line({ event: "step_update", step_update: { conversation_id: "conv-filha", step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "dentro do subagente" } })),
      ...parser.parse(line({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 4, state: "DONE", step_type: "tool", subagent_info: { name: "Pesquisa", result: "Achei X" } } })),
      ...parser.parse(line({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 5, state: "DONE", step_type: "planner_magic" } })),
      ...parser.parse("{quebrado"),
      ...parser.parse("[1,2]"),
      ...parser.parse(line({ event: "novidade" })),
      ...parser.parse(line({ event: "step_update", step_update: "x" })),
      ...parser.parse(""),
      ...parser.parse(line({ event: "result", result: { conversation_id: "conv-1", status: "ERROR", response: "", error: "unknown model" } })),
    ];
    expect(events).toContainEqual({ type: "tool_use", id: "agy-conv1-3", name: "write_file", input: { Path: "/x" } });
    expect(events).toContainEqual({ type: "tool_result", id: "agy-conv1-3", ok: false, output: "PERMISSION: negado" });
    expect(events).toContainEqual({ type: "subagent_start", id: "agy-conv1-4", label: "Pesquisa", goal: "Pesquise X" });
    // Modelo do subagente: o Model pedido no invoke_subagent, senão o padrão do workspace.
    const withDefault = new AntigravityStreamParser("gemini-3.8-flash-low");
    withDefault.parse(line({ event: "init", conversation_id: "c", init: {} }));
    expect(withDefault.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "ACTIVE", step_type: "tool", subagent_info: { name: "A", prompt: "a" } } }))).toEqual([
      { type: "subagent_start", id: "agy-c-1", label: "A", goal: "a", model: "gemini-3.8-flash-low" },
    ]);
    expect(
      withDefault.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 2, state: "ACTIVE", step_type: "tool", tool_info: { name: "invoke_subagent", parameters: { Model: "pro" } }, subagent_info: { name: "B", prompt: "b" } } })),
    ).toEqual([{ type: "subagent_start", id: "agy-c-2", label: "B", goal: "b", model: "pro" }]);
    expect(events).toContainEqual({ type: "text", text: "dentro do subagente", thread: "agy-conv1-4" });
    expect(events).toContainEqual({ type: "subagent_end", id: "agy-conv1-4", ok: true, result: "Achei X" });
    expect(events.filter((event) => event.type === "raw" && !event.text.startsWith("[init]"))).toHaveLength(5);
    expect(events.at(-1)).toEqual({ type: "turn_end", ok: false, result: "unknown model" });
  });

  it("invoke_subagent no formato real do agy 1.5.3: nasce no passo 'subagent' e acaba no system_message", () => {
    // Linhas capturadas de uma sessão real (agy 1.5.3, gemini-3.8-flash-low), com os caminhos encurtados.
    const step = (index: number, rest: Record<string, unknown>) => line({ event: "step_update", step_update: { conversation_id: "pai", step_index: index, ...rest } });
    const parser = new AntigravityStreamParser("gemini-3.8-flash-low");
    parser.parse(line({ event: "init", conversation_id: "pai", init: {} }));
    const active = parser.parse(step(2, { state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", tool_info: { name: "invoke_subagent", parameters: { Role: "Coffee Consultant", TypeName: "self" } } }));
    expect(active).toEqual([]);
    const spawned = parser.parse(
      step(2, {
        state: "DONE",
        step_type: "subagent",
        tool_name: "invoke_subagent",
        subagent_info: { subagents: [{ type_name: "self", role: "Coffee Consultant", initial_prompt: "2 palavras sobre café", conversation_id: "filho", log_uri: "file:///x" }] },
      }),
    );
    expect(spawned).toEqual([{ type: "subagent_start", id: "agy-pai-2", label: "Coffee Consultant", goal: "2 palavras sobre café", model: "gemini-3.8-flash-low" }]);
    // O agente principal segue (outra ferramenta, texto) enquanto o subagente roda.
    expect(parser.parse(step(4, { state: "DONE", step_type: "tool", tool_name: "manage_subagents", tool_info: { name: "manage_subagents", parameters: { Action: "list" }, output: "1 ativo" } }))).toContainEqual({
      type: "tool_result",
      id: "agy-pai-4",
      ok: true,
      output: "1 ativo",
    });
    expect(parser.parse(step(6, { state: "DONE", step_type: "system_message" }))).toEqual([{ type: "subagent_end", id: "agy-pai-2", ok: true }]);
    // Outro system_message (sem subagente rodando) continua quieto.
    expect(parser.parse(step(7, { state: "DONE", step_type: "system_message" }))).toEqual([]);
    expect(parser.parse(line({ event: "result", result: { conversation_id: "pai", status: "SUCCESS", response: "Aroma intenso" } }))).toEqual([{ type: "turn_end", ok: true, result: "Aroma intenso" }]);
  });

  it("subagente do agy que não avisou o fim fecha com o turno; invoke_subagent com erro vira subagente que falhou", () => {
    const step = (index: number, rest: Record<string, unknown>) => line({ event: "step_update", step_update: { conversation_id: "pai", step_index: index, ...rest } });
    const parser = new AntigravityStreamParser();
    parser.parse(line({ event: "init", conversation_id: "pai", init: {} }));
    parser.parse(step(1, { state: "DONE", step_type: "subagent", subagent_info: { subagents: [{ role: "A", initial_prompt: "a" }, { role: "B", initial_prompt: "b" }] } }));
    parser.parse(step(2, { state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", tool_info: { name: "invoke_subagent", parameters: { Role: "C", Model: "flash" } } }));
    expect(parser.parse(step(2, { state: "DONE", step_type: "tool", tool_name: "invoke_subagent", tool_info: { name: "invoke_subagent", error: { message: "limite" } } }))).toEqual([
      { type: "subagent_start", id: "agy-pai-2", label: "C", goal: "C", model: "flash" },
      { type: "subagent_end", id: "agy-pai-2", ok: false, result: "limite" },
    ]);
    expect(parser.parse(line({ event: "result", result: { status: "SUCCESS", response: "ok" } }))).toEqual([
      { type: "subagent_end", id: "agy-pai-1", ok: false },
      { type: "subagent_end", id: "agy-pai-1-2", ok: false },
      { type: "turn_end", ok: true, result: "ok" },
    ]);
  });

  it("ferramenta MCP que termina em ERROR (agy 1.5.5) mostra o texto real do erro, não 'Sem resposta'", () => {
    const parser = new AntigravityStreamParser();
    const params = { ServerName: "office", ToolName: "read_note", Arguments: {} };
    const opened = parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: params } } }));
    expect(opened).toMatchObject([{ type: "tool_use", name: "mcp__office__read_note" }]);
    const failed = parser.parse(
      line({
        event: "step_update",
        step_update: {
          conversation_id: "c", step_index: 2, state: "ERROR", step_type: "tool", tool_name: "call_mcp_tool",
          tool_info: { name: "call_mcp_tool", parameters: params, output: 'Error: You cannot see the Brain "redacao"', error: { type: "TOOL_ERROR", message: 'Error: You cannot see the Brain "redacao"' } },
        },
      }),
    );
    expect(failed).toEqual([{ type: "tool_result", id: "agy-c-2", ok: false, output: 'Error: You cannot see the Brain "redacao"' }]);
    // O fim do turno não acrescenta um segundo resultado "Sem resposta".
    expect(parser.parse(line({ event: "result", result: { status: "SUCCESS", response: "ok" } }))).toEqual([{ type: "turn_end", ok: true, result: "ok" }]);
  });

  it("fecha o que ficou aberto quando o turno acaba", () => {
    const parser = new AntigravityStreamParser();
    parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "ACTIVE", step_type: "tool", tool_info: { name: "view_file" } } }));
    parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "meio" } }));
    const events = parser.parse(line({ event: "result", result: { status: "CANCELED" } }));
    expect(events).toEqual([
      { type: "text", text: "meio" },
      { type: "tool_result", id: "agy-c-1", ok: false, output: "Sem resposta da ferramenta" },
      { type: "turn_end", ok: false, result: "Erro da CLI (CANCELED)" },
    ]);
  });
});

describe("AntigravityStreamParser: tokens do turno (usage)", () => {
  const tokens = (input: number, output: number, extra: Record<string, number> = {}) => ({
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: input + output,
    ...extra,
  });
  const step = (index: number, usage: unknown, state = "DONE") =>
    line({ event: "step_update", step_update: { conversation_id: "c", step_index: index, state, step_type: "agent_response", text_delta: "", usage } });
  const result = (usage: unknown, numTurns: number) => line({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "ok", num_turns: numTurns, usage } });
  const usageOf = (events: TerminalEvent[]) => events.filter((event) => event.type === "turn_end").map((event) => (event as { usage?: unknown }).usage);

  it("soma os passos DONE do turno (um por passo; o ACTIVE e o DONE repetido não contam de novo)", () => {
    const parser = new AntigravityStreamParser();
    const events = [step(1, tokens(100, 5), "ACTIVE"), step(1, tokens(100, 5)), step(1, tokens(100, 5)), step(2, tokens(200, 7)), result(tokens(300, 12), 1)].flatMap((l) => parser.parse(l));
    expect(usageOf(events)).toEqual([{ inputTokens: 300, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0 }]);
  });

  it("raciocínio conta como saída; o cache lido sai da entrada (vem dentro dela, como no Gemini)", () => {
    const parser = new AntigravityStreamParser();
    const events = [step(1, tokens(1000, 10, { thinking_tokens: 40, cache_read_tokens: 600, total_tokens: 1050 })), result(undefined, 1)].flatMap((l) => parser.parse(l));
    expect(usageOf(events)).toEqual([{ inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheCreationTokens: 0 }]);
    // Se o total mostrar o cache à parte, a entrada fica como veio.
    const separate = new AntigravityStreamParser();
    const more = [step(1, tokens(1000, 10, { cache_read_tokens: 600, total_tokens: 1610 })), result(undefined, 1)].flatMap((l) => separate.parse(l));
    expect(usageOf(more)).toEqual([{ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 600, cacheCreationTokens: 0 }]);
  });

  it("sem usage nos passos: a diferença do acumulado do result (e nada quando não dá para separar)", () => {
    const parser = new AntigravityStreamParser();
    const events = [result(tokens(100, 1), 1), result(tokens(250, 4), 2)].flatMap((l) => parser.parse(l));
    expect(usageOf(events)).toEqual([
      { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { inputTokens: 150, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    // Processo novo de uma conversa retomada (num_turns 3): o acumulado inclui turnos de antes.
    const resumed = new AntigravityStreamParser();
    expect(usageOf(resumed.parse(result(tokens(900, 9), 3)))).toEqual([undefined]);
    // Sem usage nenhum: turno sem tokens.
    expect(usageOf(new AntigravityStreamParser().parse(line({ event: "result", result: { status: "SUCCESS", response: "x" } })))).toEqual([undefined]);
  });
});

describe("AntigravityCliAdapter", () => {
  it("monta os argumentos: stream-json sem -p, configuração da sessão restrita e conversa nova", () => {
    const adapter = new AntigravityCliAdapter();
    const { command, args } = adapter.command(spec, { sessionId: "marcador", resume: false });
    expect(command).toBe("agy");
    expect(args.slice(0, 5)).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"]);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--conversation");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium"); // sem modelo no agente: o padrão da plataforma
    expect(args).not.toContain("--effort");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as ReturnType<typeof antigravitySessionSettings>;
    expect(settings).toEqual(antigravitySessionSettings(CWD));
    expect(settings).toMatchObject({ toolPermission: "request-review", allowNonWorkspaceAccess: false, modelProvider: "", useG1Credits: false, agentMode: "" });
    expect(settings.permissions).toEqual({
      allow: ["mcp(office/*)", `read_file(${CWD})`, `write_file(${CWD})`],
      deny: ["command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)", "download_url(*)"],
    });
  });

  it("acesso: internet libera ler URL (a busca não tem permissão), terminal libera comandos; o navegador e o resto ficam negados", () => {
    const base: TerminalAccess = { internet: false, browser: false, terminal: false, allowedDomains: [], blockedDomains: [], allowLocalNetwork: false };
    const settingsOf = (access: TerminalAccess) => {
      const { args } = new AntigravityCliAdapter().command({ ...spec, access }, { sessionId: "m", resume: false });
      return (JSON.parse(args[args.indexOf("--settings") + 1]!) as { permissions: { allow: string[]; deny: string[] } }).permissions;
    };
    expect(settingsOf(base).deny).toEqual([...ANTIGRAVITY_DENY]);
    const web = settingsOf({ ...base, internet: true, browser: true });
    expect(web.allow).toContain("read_url(*)");
    expect(web.deny).toEqual(["command(*)", "unsandboxed(*)", "execute_url(*)", "download_url(*)"]);
    const terminal = settingsOf({ ...base, terminal: true });
    expect(terminal.allow).toContain("command(*)");
    expect(terminal.deny).toEqual(["unsandboxed(*)", "read_url(*)", "execute_url(*)", "download_url(*)"]);
    const domains = settingsOf({ ...base, internet: true, allowedDomains: ["exemplo.com", "gov.br"], blockedDomains: ["ruim.com"] });
    expect(domains.allow).toEqual(["mcp(office/*)", `read_file(${CWD})`, `write_file(${CWD})`, "read_url(exemplo.com)", "read_url(gov.br)"]);
    expect(domains.deny).toContain("read_url(ruim.com)");
    expect(domains.deny).toContain("execute_url(*)");
  });

  it("retoma com --conversation e passa --model do agente; modelo de outra família leva --effort", () => {
    const adapter = new AntigravityCliAdapter({ command: "node", prefixArgs: ["fake-agy.mjs"] });
    const { command, args } = adapter.command({ ...spec, model: "outro-modelo-1", effort: "high" }, { sessionId: "conv-9", resume: true });
    expect(command).toBe("node");
    expect(args[0]).toBe("fake-agy.mjs");
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-9");
    expect(args.slice(-4)).toEqual(["--model", "outro-modelo-1", "--effort", "high"]);
  });

  it("modelo Gemini nunca leva --effort (o nível vai no nome; a CLI recusa), nem o padrão de ambiente nem o do agente", () => {
    const adapter = new AntigravityCliAdapter({ command: "node", prefixArgs: ["fake-agy.mjs"], defaultEffort: "medium" });
    const named = adapter.command({ ...spec, model: "gemini-3.8-flash-medium", effort: "high" }, { sessionId: "conv-9", resume: false });
    expect(named.args.slice(-2)).toEqual(["--model", "gemini-3.8-flash-medium"]);
    expect(named.args).not.toContain("--effort");
    const fallback = adapter.command({ ...spec, effort: "high" }, { sessionId: "conv-9", resume: false });
    expect(fallback.args).not.toContain("--effort");
  });

  it("mensagem no formato do agy, sem interrupt por mensagem, e conversa perdida", () => {
    const adapter = new AntigravityCliAdapter();
    expect(JSON.parse(adapter.encodeMessage("oi"))).toEqual({ event: "user", message: { content: "oi" } });
    expect((adapter as { encodeInterrupt?: unknown }).encodeInterrupt).toBeUndefined();
    expect(adapter.isMissingSession('warning: conversation "x" not found')).toBe(true);
  });

  it("grava GEMINI.md e o .agents/mcp_config.json do workspace (com o token, secreto)", () => {
    const files = new AntigravityCliAdapter().agentFiles({ spec, mcpUrl: "http://127.0.0.1:3068/mcp", token: "tok-1" });
    expect(files).toEqual([
      { path: `${CWD}/GEMINI.md`, content: "Você é o Pesquisador.\n" },
      { path: `${CWD}/${ANTIGRAVITY_MCP_CONFIG}`, content: expect.any(String), secret: true },
    ]);
    expect(JSON.parse(files[1]!.content)).toEqual({ mcpServers: { office: { url: "http://127.0.0.1:3068/mcp", headers: { Authorization: "Bearer tok-1" } } } });
  });

  it("o ambiente nunca leva chave de API de nenhum provedor", () => {
    const env = new AntigravityCliAdapter().env(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        GEMINI_API_KEY: "g",
        GOOGLE_API_KEY: "g2",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_APPLICATION_CREDENTIALS: "/sa.json",
        GOOGLE_CLOUD_PROJECT: "p",
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY: "o",
        OPENAI_ORG_ID: "org",
      },
      spec,
    );
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", GIT_CEILING_DIRECTORIES: "/dados/workspaces/lab/agents" });
    expect(sanitizeChildEnv({}, { GEMINI_API_KEY: "x", GOOGLE_API_KEY: "y", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(isStrippedEnvName("GEMINI_API_KEY")).toBe(true);
  });
});

describe("motores disponíveis (GET /api/engines)", () => {
  const AGY_MODELS = "Fetching available models...\ngemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";

  it("lê a lista de `agy models`", () => {
    expect(parseAgyModels(AGY_MODELS)).toEqual([
      { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
    expect(parseAgyModels("")).toEqual([]);
  });

  it("detecta os binários pelo --version e guarda a detecção", async () => {
    const calls: string[] = [];
    const probe: EngineProbe = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "claude") return { ok: true, stdout: "2.1.319 (Claude Code)\n" };
      if (args[0] === "--version") return { ok: true, stdout: "1.5.3\n" };
      return { ok: true, stdout: AGY_MODELS };
    };
    const engines = await detectEngines({ claude: { command: "claude" }, gemini: { command: "agy" } }, probe);
    expect(engines.map((engine) => [engine.engine, engine.label, engine.available, engine.version])).toEqual([
      ["mock", "Simulado", true, undefined],
      ["claude", "Claude Code", true, "2.1.319 (Claude Code)"],
      ["gemini", "Antigravity", true, "1.5.3"],
    ]);
    expect(engines[2]!.models).toHaveLength(3);
    expect(calls).toEqual(["claude --version", "agy --version", "agy models"]);

    const missing = await detectEngines({ claude: { command: "claude" }, gemini: { command: "agy" } }, async (command) =>
      command === "agy" ? { ok: false, stdout: "", error: "comando agy não encontrado" } : { ok: true, stdout: "2.1.319" },
    );
    expect(missing[2]).toMatchObject({ engine: "gemini", available: false, reason: "comando agy não encontrado", models: [] });

    let runs = 0;
    const catalog = new EngineCatalog(async () => {
      runs += 1;
      return engines;
    });
    await catalog.list();
    await catalog.list();
    expect(runs).toBe(1);
    await catalog.list(true);
    expect(runs).toBe(2);
  });
});

describe("AntigravityStreamParser: subagente traz ferramentas e resposta do transcript", () => {
  const transcript = [
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "call_mcp_tool", args: { Arguments: "{}", ServerName: '"office"', ToolName: '"good"' } }, { name: "read_file", args: { Path: '"/x/srv.mjs"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "Created At: 1\nCompleted At: 2\nall good" },
    { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", content: "Created At: 1\nCompleted At: 2\n14 lines" },
    { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "send_message", args: { Message: '"Tudo certo: good devolveu all good."', Recipient: '"c"' } }] },
    { step_index: 5, source: "MODEL", type: "GENERIC", status: "DONE", content: "Message sent" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  it("no fim do subagente, as ferramentas dele entram na thread e a mensagem ao principal vira o resultado", () => {
    const parser = new AntigravityStreamParser(undefined, (uri) => (uri === "file:///log/transcript.jsonl" ? transcript : undefined));
    parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 8, state: "ACTIVE", step_type: "tool", tool_info: { name: "invoke_subagent", parameters: { Role: "Helper" } } } }));
    parser.parse(
      line({ event: "step_update", step_update: { conversation_id: "c", step_index: 8, state: "DONE", step_type: "subagent", subagent_info: { subagents: [{ role: "Helper", initial_prompt: "faça", conversation_id: "kid", log_uri: "file:///log/transcript.jsonl" }] } } }),
    );
    const events = parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 10, state: "DONE", step_type: "system_message" } }));
    expect(events).toEqual([
      { type: "tool_use", id: "agy-c-8-t1", name: "mcp__office__good", input: {}, thread: "agy-c-8" },
      { type: "tool_use", id: "agy-c-8-t2", name: "read_file", input: { Path: "/x/srv.mjs" }, thread: "agy-c-8" },
      { type: "tool_result", id: "agy-c-8-t1", ok: true, output: "all good", thread: "agy-c-8" },
      { type: "tool_result", id: "agy-c-8-t2", ok: true, output: "14 lines", thread: "agy-c-8" },
      { type: "subagent_end", id: "agy-c-8", ok: true, result: "Tudo certo: good devolveu all good." },
    ]);
  });

  it("sem transcript legível, o subagente fecha como antes (sem ferramentas nem texto)", () => {
    const parser = new AntigravityStreamParser(undefined, () => undefined);
    parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 8, state: "DONE", step_type: "subagent", subagent_info: { subagents: [{ role: "H", log_uri: "file:///nada" }] } } }));
    expect(parser.parse(line({ event: "step_update", step_update: { conversation_id: "c", step_index: 10, state: "DONE", step_type: "system_message" } }))).toEqual([{ type: "subagent_end", id: "agy-c-8", ok: true }]);
  });
});
