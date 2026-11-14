import { describe, expect, it } from "vitest";
import { CLAUDE_SUBAGENT_TOOL, ClaudeCliAdapter, ClaudeStreamParser, DEFAULT_AGENT_TOOLS, parseClaudeRateLimit } from "./claude-adapter";
import { isStrippedEnvName, sanitizeChildEnv } from "./env";
import { terminalLogBridge } from "./log-bridge";
import type { TerminalAccess, TerminalEvent, TerminalSpec } from "./types";

const spec: TerminalSpec = {
  agentId: "redator",
  cwd: "/dados/workspaces/lab/agents/redator",
  systemPrompt: "Você é o Redator.",
  mcpConfigFile: "/dados/workspaces/lab/agents/redator/mcp.json",
  tools: DEFAULT_AGENT_TOOLS,
};

const line = (event: unknown) => JSON.stringify(event);

describe("ClaudeStreamParser", () => {
  it("traduz init, texto, ferramenta, resultado de ferramenta e o fim do turno", () => {
    const parser = new ClaudeStreamParser();
    const events = [
      line({ type: "system", subtype: "init", session_id: "s-1", model: "sonnet", tools: ["Read"], mcp_servers: [{ name: "office", status: "connected" }], apiKeySource: "none" }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Vou ler." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } }] }, parent_tool_use_id: null }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "conteúdo" }] }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "falhou", is_error: true }] } }),
      line({ type: "result", subtype: "success", is_error: false, result: "Pronto" }),
    ].flatMap((raw) => parser.parse(raw));
    expect(events[0]).toEqual({ type: "session", sessionId: "s-1", model: "sonnet", tools: ["Read"], mcpServers: [{ name: "office", status: "connected" }], apiKeySource: "none" });
    expect(events[1]).toMatchObject({ type: "raw", stream: "stdout" });
    expect((events[1] as { text: string }).text).toContain("office: connected");
    expect(events.slice(2)).toEqual([
      { type: "text", text: "Vou ler." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } },
      { type: "tool_result", id: "t1", ok: true, output: "conteúdo" },
      { type: "tool_result", id: "t2", ok: false, output: "falhou" },
      { type: "turn_end", ok: true, result: "Pronto" },
    ]);
  });

  it("mensagens com parent_tool_use_id vão para a thread do subagente (Task/Agent)", () => {
    const parser = new ClaudeStreamParser();
    const events = [
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_sub", name: "Task", input: { description: "Pesquisa", prompt: "Pesquise X" } }] }, parent_tool_use_id: null }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "dentro" }, { type: "tool_use", id: "t9", name: "Grep", input: { pattern: "x" } }] }, parent_tool_use_id: "toolu_sub" }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "1 linha" }] }, parent_tool_use_id: "toolu_sub" }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "Achei X" }] }, parent_tool_use_id: null }),
    ].flatMap((raw) => parser.parse(raw));
    expect(events).toEqual([
      { type: "subagent_start", id: "toolu_sub", label: "Pesquisa", goal: "Pesquise X" },
      { type: "text", text: "dentro", thread: "toolu_sub" },
      { type: "tool_use", id: "t9", name: "Grep", input: { pattern: "x" }, thread: "toolu_sub" },
      { type: "tool_result", id: "t9", ok: true, output: "1 linha", thread: "toolu_sub" },
      { type: "subagent_end", id: "toolu_sub", ok: true, result: "Achei X" },
    ]);
  });

  it("subagente leva o modelo: o que a chamada Agent pediu ou o padrão da sessão; task_* do system não viram log", () => {
    const parser = new ClaudeStreamParser("haiku");
    const events = [
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Simples", prompt: "Liste X" } }] }, parent_tool_use_id: null }),
      line({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "a1", description: "Simples" }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "a2", name: "Agent", input: { description: "Difícil", prompt: "Analise Y", model: "sonnet" } }] }, parent_tool_use_id: null }),
      line({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" }),
    ].flatMap((raw) => parser.parse(raw));
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", label: "Simples", goal: "Liste X", model: "haiku" },
      { type: "subagent_start", id: "a2", label: "Difícil", goal: "Analise Y", model: "sonnet" },
    ]);
    // Sem padrão configurado e sem `model`: o modelo fica desconhecido (herda o do agente).
    const plain = new ClaudeStreamParser().parse(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "a3", name: "Agent", input: { description: "X", prompt: "X" } }] } }));
    expect(plain).toEqual([{ type: "subagent_start", id: "a3", label: "X", goal: "X" }]);
  });

  it("linhas quebradas, desconhecidas ou estranhas viram raw (nunca lança)", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.parse("isto não é json")).toEqual([{ type: "raw", stream: "stdout", text: "isto não é json" }]);
    expect(parser.parse("[1,2]")).toEqual([{ type: "raw", stream: "stdout", text: "[1,2]" }]);
    expect(parser.parse(line({ type: "evento_novo", info: 1 }))[0]).toMatchObject({ type: "raw" });
    expect(parser.parse(line({ type: "system", subtype: "compact_boundary" }))[0]).toMatchObject({ type: "raw" });
    expect(parser.parse(line({ type: "assistant", message: null }))).toEqual([]);
    expect(parser.parse(line({ type: "user", message: { content: [{ type: "tool_result" }] } }))).toEqual([]);
    expect(parser.parse(line({ type: "control_response", response: {} }))).toEqual([]);
    expect(parser.parse("   ")).toEqual([]);
  });

  it("system/thinking_tokens não vira linha no log", () => {
    const parser = new ClaudeStreamParser();
    const line = JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50, session_id: "s" });
    expect(parser.parse(line)).toEqual([]);
  });

  it("resultado com erro vira turn_end não ok", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.parse(line({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual([
      { type: "turn_end", ok: false, result: "Erro da CLI (error_max_turns)" },
    ]);
    expect(parser.parse(line({ type: "result", subtype: "error_during_execution", errors: ["caiu"] }))).toEqual([{ type: "turn_end", ok: false, result: "caiu" }]);
  });

  it("o turn_end leva os tokens do turno (usage do result), quando vierem", () => {
    const parser = new ClaudeStreamParser();
    const usage = { input_tokens: 12, output_tokens: 340.4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 150, service_tier: "standard" };
    // Sem `usage` nas mensagens do assistente, o tamanho da conversa sai da entrada do turno (estimativa por cima).
    expect(parser.parse(line({ type: "result", subtype: "success", result: "Pronto", usage, total_cost_usd: 0.1 }))).toEqual([
      { type: "turn_end", ok: true, result: "Pronto", usage: { inputTokens: 12, outputTokens: 340, cacheReadTokens: 9000, cacheCreationTokens: 150 }, contextTokens: 9162 },
    ]);
    expect(parser.parse(line({ type: "result", subtype: "success", result: "Pronto", usage: { input_tokens: 0, output_tokens: "x" } }))).toEqual([
      { type: "turn_end", ok: true, result: "Pronto" },
    ]);
  });
});

describe("terminalLogBridge", () => {
  it("leva os eventos para os ganchos de log, com threads de subagente", () => {
    const calls: unknown[] = [];
    const thread = (id: string) => ({
      id,
      log: (entry: unknown) => calls.push(["log", id, entry]),
      toolResult: (toolId: string, result: unknown) => calls.push(["toolResult", id, toolId, result]),
      progress: () => undefined,
      finish: (result: unknown) => calls.push(["finish", id, result]),
    });
    const bridge = terminalLogBridge({
      log: (entry) => calls.push(["log", "main", entry]),
      toolResult: (toolId, result) => calls.push(["toolResult", "main", toolId, result]),
      subagent: (sub) => {
        calls.push(["subagent", sub]);
        return thread(sub.id!);
      },
    });
    const events: TerminalEvent[] = [
      { type: "text", text: "oi" },
      { type: "subagent_start", id: "sa", label: "Pesquisa", goal: "X" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" }, thread: "sa" },
      { type: "tool_result", id: "t1", ok: false, output: "erro", thread: "sa" },
      { type: "subagent_end", id: "sa", ok: true, result: "pronto" },
      { type: "raw", stream: "stderr", text: "aviso" },
      { type: "turn_end", ok: true, result: "fim" },
    ];
    for (const event of events) bridge.handle(event);
    expect(calls).toEqual([
      ["log", "main", { kind: "text", text: "oi" }],
      ["subagent", { id: "sa", label: "Pesquisa", goal: "X" }],
      ["log", "sa", { kind: "tool", toolUseId: "t1", name: "Read", input: { file_path: "a" } }],
      ["toolResult", "sa", "t1", { status: "error", output: "erro" }],
      ["finish", "sa", { status: "ok", result: "pronto" }],
      ["log", "main", { kind: "raw", stream: "stderr", text: "aviso" }],
    ]);
  });
});

describe("resumo do init", () => {
  it("lista os nomes dos plugins que ainda carregaram (e omite quando não há)", () => {
    // A retomada do turno repete o init igual: só a primeira vira linha (e sem a lista inteira de ferramentas).
    const repeat = new ClaudeStreamParser();
    const init = line({ type: "system", subtype: "init", session_id: "s-1", model: "sonnet", tools: ["Read", "Edit"], mcp_servers: [{ name: "office", status: "connected" }] });
    const first = repeat.parse(init);
    expect(first.filter((event) => event.type === "raw")).toEqual([{ type: "raw", stream: "stdout", text: "[init] sessão s-1 · modelo sonnet · 2 ferramentas · MCP: office: connected" }]);
    expect(repeat.parse(init).filter((event) => event.type === "raw")).toEqual([]);
    expect(repeat.parse(line({ type: "system", subtype: "init", session_id: "s-2", model: "sonnet", tools: ["Read", "Edit"], mcp_servers: [{ name: "office", status: "connected" }] })).filter((event) => event.type === "raw")).toHaveLength(1);
    const withPlugins = new ClaudeStreamParser().parse(line({ type: "system", subtype: "init", session_id: "s", plugins: [{ name: "embutido", path: "/x" }, "outro", 3] }));
    expect((withPlugins[1] as { text: string }).text).toContain("plugins: embutido, outro, ?");
    const none = new ClaudeStreamParser().parse(line({ type: "system", subtype: "init", session_id: "s", plugins: [] }));
    expect((none[1] as { text: string }).text).not.toContain("plugins");
  });
});

describe("uso da assinatura (rate_limit_event)", () => {
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1794105600,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      unifiedWindows: {
        five_hour: { utilization: 0.27, resetsAt: 1794105600, status: "allowed" },
        seven_day: { utilization: 0.44, resetsAt: 1794600000, status: "allowed" },
      },
    },
    uuid: "u-1",
    session_id: "s-1",
  };

  it("vira um evento usage com as janelas (nunca uma linha raw)", () => {
    const events = new ClaudeStreamParser().parse(line(event));
    expect(events).toEqual([
      {
        type: "usage",
        status: "allowed",
        windows: [
          { id: "five_hour", utilization: 0.27, resetsAt: new Date(1794105600 * 1000).toISOString(), status: "allowed" },
          { id: "seven_day", utilization: 0.44, resetsAt: new Date(1794600000 * 1000).toISOString(), status: "allowed" },
        ],
      },
    ]);
  });

  it("sem unifiedWindows usa a janela única; tolera porcentagem e ignora janelas inválidas", () => {
    expect(parseClaudeRateLimit({ rate_limit_info: { rateLimitType: "seven_day", utilization: 81, resetsAt: "2026-11-10T00:00:00Z" } })).toEqual({
      windows: [{ id: "seven_day", utilization: 0.81, resetsAt: "2026-11-10T00:00:00.000Z" }],
    });
    const mixed = parseClaudeRateLimit({
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 2 }, "Nome Ruim!": { utilization: 0.1 }, seven_day: { utilization: "muito" }, opus: null } },
    });
    expect(mixed).toEqual({ windows: [{ id: "five_hour", utilization: 0.02 }] });
  });

  it("formatos desconhecidos são ignorados sem lançar (nem viram raw)", () => {
    const parser = new ClaudeStreamParser();
    for (const odd of [{ type: "rate_limit_event" }, { type: "rate_limit_event", rate_limit_info: 1 }, { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, { type: "rate_limit_event", rate_limit_info: { unifiedWindows: [] } }]) {
      expect(parser.parse(line(odd))).toEqual([]);
    }
    expect(parseClaudeRateLimit(null)).toBeNull();
    expect(parseClaudeRateLimit("x")).toBeNull();
  });
});

describe("ClaudeCliAdapter", () => {
  const off: TerminalAccess = { internet: false, browser: false, terminal: false, allowedDomains: [], blockedDomains: [], allowLocalNetwork: false };
  const flags = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it("acesso: internet = WebSearch/WebFetch, terminal = Bash; domínios viram regras do WebFetch (headless e interativo)", () => {
    const adapter = new ClaudeCliAdapter();
    for (const build of [
      (s: TerminalSpec) => adapter.command(s, { sessionId: "s", resume: false }).args,
      (s: TerminalSpec) => adapter.interactiveCommand(s, { sessionId: "s", resume: false }).args,
    ]) {
      const none = build({ ...spec, access: off });
      expect(flags(none, "--tools")).toBe("Read,Write,Edit,Glob,Grep");
      expect(flags(none, "--disallowedTools")).toBe("Bash");
      const web = build({ ...spec, access: { ...off, internet: true } });
      expect(flags(web, "--tools")).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
      expect(flags(web, "--allowedTools")).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,mcp__office");
      expect(flags(web, "--disallowedTools")).toBe("Bash");
      const terminal = build({ ...spec, access: { ...off, terminal: true } });
      expect(flags(terminal, "--tools")).toBe("Read,Write,Edit,Glob,Grep,Bash");
      expect(flags(terminal, "--allowedTools")).toBe("Read,Write,Edit,Glob,Grep,Bash,mcp__office");
      expect(terminal).not.toContain("--disallowedTools");
      const domains = build({ ...spec, access: { ...off, internet: true, allowedDomains: ["exemplo.com"], blockedDomains: ["ruim.com"] } });
      expect(flags(domains, "--allowedTools")).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch(domain:exemplo.com),WebFetch(domain:*.exemplo.com),mcp__office");
      expect(flags(domains, "--disallowedTools")).toBe("WebFetch(domain:ruim.com),WebFetch(domain:*.ruim.com),Bash");
    }
  });

  it("acesso: o spec não traz WebFetch/Bash de contrabando (só o acesso libera)", () => {
    const sneaky = { ...spec, tools: [...spec.tools, "WebFetch", "Bash"], access: off };
    const { args } = new ClaudeCliAdapter().command(sneaky, { sessionId: "s", resume: false });
    expect(flags(args, "--tools")).toBe("Read,Write,Edit,Glob,Grep");
  });

  it("monta os argumentos: stream-json, isolamento, MCP estrito, ferramentas e sessão nova", () => {
    const adapter = new ClaudeCliAdapter();
    const { command, args } = adapter.command(spec, { sessionId: "uuid-1", resume: false });
    expect(command).toBe("claude");
    expect(args.slice(0, 7)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--restricted"]);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--setting-sources")).toBe("project,local");
    expect(JSON.parse(value("--settings")!)).toEqual({ disableAllHooks: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
    expect(args).toContain("--strict-mcp-config");
    expect(value("--mcp-config")).toBe(spec.mcpConfigFile);
    expect(args).toContain("--disable-slash-commands");
    expect(value("--tools")).toBe("Read,Write,Edit,Glob,Grep");
    expect(value("--allowedTools")).toBe("Read,Write,Edit,Glob,Grep,mcp__office");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--permission-prompts")).toBe("none");
    expect(value("--append-system-prompt")).toBe("Você é o Redator.");
    expect(value("--system-prompt-snapshot")).toBe("off");
    expect(value("--session-id")).toBe("uuid-1");
    expect(args).not.toContain("--resume");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet"); // sem modelo no agente: o padrão da plataforma
    expect(value("--effort")).toBe("low");
    expect(value("--disallowedTools")).toBe("Bash");
    expect(args.some((arg) => /webfetch|websearch/i.test(arg))).toBe(false);
  });

  it("contextTokens = prompt da última chamada do agente principal no turno (não a soma do turno nem os subagentes)", () => {
    const parser = new ClaudeStreamParser();
    const call = (input: number, cacheRead: number, parent: string | null = null) =>
      line({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content: [{ type: "text", text: "x" }], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 5 } } });
    parser.parse(call(10, 40_000));
    parser.parse(call(5, 41_000));
    parser.parse(call(999, 500_000, "toolu_sub")); // dentro de um subagente: outra conversa
    const usage = { input_tokens: 15, output_tokens: 10, cache_read_input_tokens: 81_000, cache_creation_input_tokens: 0 };
    expect(parser.parse(line({ type: "result", subtype: "success", result: "ok", usage }))).toEqual([
      expect.objectContaining({ type: "turn_end", contextTokens: 41_005 }),
    ]);
    // O turno seguinte começa do zero.
    expect(parser.parse(line({ type: "result", subtype: "success", result: "ok" }))).toEqual([{ type: "turn_end", ok: true, result: "ok" }]);
  });

  it("--autocompact conservador por padrão (configurável; vazio = sem a flag)", () => {
    const flag = (adapter: ClaudeCliAdapter) => {
      const { args } = adapter.command(spec, { sessionId: "s", resume: false });
      return args.includes("--autocompact") ? args[args.indexOf("--autocompact") + 1] : undefined;
    };
    expect(flag(new ClaudeCliAdapter())).toBe("auto");
    expect(flag(new ClaudeCliAdapter({ autocompact: "200000" }))).toBe("200000");
    expect(flag(new ClaudeCliAdapter({ autocompact: "" }))).toBeUndefined();
  });

  it("retoma com --resume, passa --model/--effort do agente e aceita comando de teste", () => {
    const adapter = new ClaudeCliAdapter({ command: "node", prefixArgs: ["fake.mjs"], defaultEffort: "", autocompact: "" });
    const plain = adapter.command(spec, { sessionId: "uuid-2", resume: true });
    expect(plain.command).toBe("node");
    expect(plain.args[0]).toBe("fake.mjs");
    expect(plain.args[plain.args.indexOf("--resume") + 1]).toBe("uuid-2");
    expect(plain.args).not.toContain("--session-id");
    expect(plain.args).not.toContain("--effort");
    const tuned = adapter.command({ ...spec, model: "sonnet", effort: "medium" }, { sessionId: "uuid-2", resume: true });
    expect(tuned.args.slice(-4)).toEqual(["--model", "sonnet", "--effort", "medium"]);
  });

  it("codifica mensagens e o interrupt no formato stream-json", () => {
    const adapter = new ClaudeCliAdapter();
    expect(JSON.parse(adapter.encodeMessage("oi", "s-1"))).toEqual({ type: "user", message: { role: "user", content: "oi" }, parent_tool_use_id: null, session_id: "s-1" });
    expect(JSON.parse(adapter.encodeInterrupt("r-1"))).toEqual({ type: "control_request", request_id: "r-1", request: { subtype: "interrupt" } });
    expect(adapter.isMissingSession("Error: No conversation found with session ID: x")).toBe(true);
  });

  it("o ambiente do processo nunca leva chave de API (só a assinatura)", () => {
    const env = new ClaudeCliAdapter().env(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        ANTHROPIC_API_KEY: "sk-ant-api",
        ANTHROPIC_AUTH_TOKEN: "tok",
        ANTHROPIC_BASE_URL: "https://proxy",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDECODE: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "assinatura",
        OPENAI_API_KEY: "sk-openai",
      },
      spec,
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("assinatura");
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "OPENAI_API_KEY"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(env.GIT_CEILING_DIRECTORIES).toBe("/dados/workspaces/lab/agents");
  });

  it("subagentes: com a ferramenta Agent, --forward-subagent-text e o padrão do workspace por env; sem ela, nada disso", () => {
    const adapter = new ClaudeCliAdapter();
    const withAgent: TerminalSpec = { ...spec, tools: [...DEFAULT_AGENT_TOOLS, CLAUDE_SUBAGENT_TOOL], subagent: { model: "haiku", effort: "low" } };
    const { args } = adapter.command(withAgent, { sessionId: "s1", resume: false });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Write,Edit,Glob,Grep,Agent");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Write,Edit,Glob,Grep,Agent,mcp__office");
    expect(args).toContain("--forward-subagent-text");
    const env = adapter.env({ PATH: "/usr/bin", CLAUDE_CODE_SUBAGENT_MODEL: "opus-herdado" }, withAgent);
    expect(env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku", CLAUDE_CODE_SUBAGENT_EFFORT: "low", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });

    const plain = adapter.command(spec, { sessionId: "s1", resume: false }).args;
    expect(plain).not.toContain("--forward-subagent-text");
    const plainEnv = adapter.env({ PATH: "/usr/bin", CLAUDE_CODE_SUBAGENT_MODEL: "opus-herdado" }, { ...spec, subagent: { model: "haiku" } });
    // Variável herdada da sessão em que o server roda nunca passa; sem Agent, não há padrão de subagente.
    expect(plainEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(plainEnv.CLAUDE_CODE_SUBAGENT_EFFORT).toBeUndefined();
  });

  it("sanitizeChildEnv: extra não reintroduz ANTHROPIC_*", () => {
    expect(sanitizeChildEnv({ A: "1" }, { ANTHROPIC_API_KEY: "x", B: "2" })).toEqual({ A: "1", B: "2" });
    expect(isStrippedEnvName("ANTHROPIC_FOO")).toBe(true);
    expect(isStrippedEnvName("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  });
});

describe("ClaudeStreamParser: o `usage` do `result` é POR TURNO (conferido nos dados reais) e a conta de reserva do turno cortado", () => {
  const msg = (id: string, output: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "assistant", message: { id, model: "claude-haiku-4-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: 4, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }, ...extra }, parent_tool_use_id: null });
  const result = (output: number, cacheRead: number) =>
    JSON.stringify({ type: "result", subtype: "success", result: "ok", queued_turn_count: 0, usage: { input_tokens: 4, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 10 } });

  it("dois turnos seguidos no mesmo processo: cada turn_end leva só o uso do próprio turno (nada de acumulado)", () => {
    const parser = new ClaudeStreamParser();
    // Os números do 1º e do 2º turno do Maestro do workspace de demonstração (saída 1174, depois 1544): o 2º NÃO é a soma.
    const first = parser.parse(result(1174, 63385)).find((event) => event.type === "turn_end");
    const second = parser.parse(result(1544, 196709)).find((event) => event.type === "turn_end");
    expect(first).toMatchObject({ usage: { outputTokens: 1174, cacheReadTokens: 63385 } });
    expect(second).toMatchObject({ usage: { outputTokens: 1544, cacheReadTokens: 196709 } });
  });

  it("sem result: o maior valor por message.id (3 e depois 40 contam 40, não 43) e as mensagens de subagente também contam", () => {
    const parser = new ClaudeStreamParser();
    parser.parse(msg("m1", 3));
    parser.parse(msg("m1", 40));
    parser.parse(JSON.stringify({ type: "assistant", message: { id: "m2", model: "claude-haiku-4-5", content: [], usage: { input_tokens: 2, output_tokens: 7 } }, parent_tool_use_id: "toolu_sub" }));
    expect(parser.takePartialUsage()).toEqual({ inputTokens: 6, outputTokens: 47, cacheReadTokens: 1000, cacheCreationTokens: 10, models: ["claude-haiku-4-5"] });
    // Pedir de novo devolve nada (a conta zerou: um segundo corte não conta de novo).
    expect(parser.takePartialUsage()).toBeUndefined();
  });

  it("mensagem <synthetic> sem tokens não entra; mensagem sem id conta uma vez cada", () => {
    const parser = new ClaudeStreamParser();
    parser.parse(JSON.stringify({ type: "assistant", message: { id: "s", model: "<synthetic>", content: [], usage: { input_tokens: 0, output_tokens: 0 } } }));
    expect(parser.takePartialUsage()).toBeUndefined();
    parser.parse(JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [], usage: { output_tokens: 5 } } }));
    parser.parse(JSON.stringify({ type: "assistant", message: { content: [], usage: { output_tokens: 6 } } }));
    expect(parser.takePartialUsage()).toMatchObject({ outputTokens: 11 });
  });

  it("o result fecha o turno e zera a conta de reserva (o turno seguinte não herda)", () => {
    const parser = new ClaudeStreamParser();
    parser.parse(msg("m1", 40));
    parser.parse(result(40, 1000));
    expect(parser.takePartialUsage()).toBeUndefined();
    parser.parse(msg("m2", 9));
    expect(parser.takePartialUsage()).toMatchObject({ outputTokens: 9 });
  });
});
