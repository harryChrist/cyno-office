import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { minimalChildEnv } from "./env";
import { HermesAdapter, HermesStreamParser, hermesAgentConfig, hermesAgentHomeOf, hermesEnv, hermesToolsets, yamlDropSection, yamlSetNested } from "./hermes-adapter";
import { OpenClawAdapter, OpenClawEnvelopeParser, openclawAgentConfig, openclawDeniedTools } from "./openclaw-adapter";
import { parseHermesConfigProviders } from "./program-account";
import type { TerminalEvent, TerminalSpec } from "./types";

/**
 * O que os programas de VERDADE mandaram (OpenClaw 2026.11.3 e Hermes v0.23.1, rodados em 13/11/2026 contra o provedor falso
 * `src/dev/fake-openai-provider.mjs`, sem conta nenhuma): as amostras estão em `fixtures/`. Aqui os parsers e a política de
 * ferramentas são conferidos contra elas.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const text = (name: string) => readFileSync(path.join(dir, name), "utf8");
const toolLists = JSON.parse(text("tool-lists.json")) as Record<string, string[] | null>;
/** O processo ainda existe? (espera um instante: o sinal leva um pouco para valer) */
async function alive(pid: number): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const turnEnd = (events: TerminalEvent[]) => events.find((event) => event.type === "turn_end") as Extract<TerminalEvent, { type: "turn_end" }> | undefined;

describe("OpenClaw: amostras reais", () => {
  it("envelope de sucesso: sessão, ferramentas (office__ vira mcp__office__), tokens e custo em usage.cost.total", () => {
    const costs: number[] = [];
    const parser = new OpenClawEnvelopeParser(undefined, (usd) => costs.push(usd));
    for (const line of text("openclaw-success.json").split("\n")) parser.parse(line);
    const events = parser.finish({ code: 0, stderr: "", timedOut: false });
    expect(events.find((event) => event.type === "session")).toMatchObject({ model: "fakeai/fake/model" });
    const uses = events.filter((event) => event.type === "tool_use").map((event) => (event as { name: string }).name);
    expect(uses).toEqual(["write", "mcp__office__submit_result"]);
    // A última chamada falhou no programa (`toolSummary.unresolvedError`): o resultado dela sai com ok: false.
    expect(events.filter((event) => event.type === "tool_result").map((event) => (event as { ok: boolean }).ok)).toEqual([true, false]);
    expect(turnEnd(events)).toMatchObject({ ok: true, usage: { inputTokens: 513, outputTokens: 51 } });
    expect(costs).toEqual([]); // custo zero não conta
  });

  it("envelope de tempo estourado: status timeout vira a falha do Cyno, sem o conselho de configuração do programa", () => {
    const parser = new OpenClawEnvelopeParser();
    for (const line of text("openclaw-timeout.json").split("\n")) parser.parse(line);
    const end = turnEnd(parser.finish({ code: 2, stderr: "", timedOut: false }));
    expect(end).toMatchObject({ ok: false });
    expect(end!.result).toContain("tempo máximo");
    expect(end!.result).not.toContain("timeoutSeconds");
  });

  it("os avisos de rotina do stderr não viram erro no registro; um erro de verdade continua aparecendo", () => {
    const adapter = new OpenClawAdapter({ homeDir: "/x" });
    expect(adapter.isQuietStderr("[agents/agent-command] [agent] run d30ae009-5e64-4176-bf43-77bcb25bf7c0 ended with stopReason=stop")).toBe(true);
    expect(adapter.isQuietStderr("[state/agent-db] agent database clean-close receipt: written")).toBe(true);
    expect(adapter.isQuietStderr("[agent/embedded] embedded run agent end: runId=x isError=true error=Couldn't sign in")).toBe(false);
  });

  it("a política nega por GRUPOS do programa e a lista de ferramentas gravada confere", () => {
    const off = openclawDeniedTools({ access: { internet: false, browser: false, terminal: false, allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] } });
    expect(off).toEqual(expect.arrayContaining(["group:ui", "group:automation", "group:messaging", "group:nodes", "group:sessions", "group:media", "group:agents", "group:runtime", "group:web", "secrets"]));
    const on = openclawDeniedTools({ access: { internet: true, browser: false, terminal: true, allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] } });
    expect(on).not.toContain("group:runtime");
    expect(on).not.toContain("group:web");
    // O que o programa mandou ao modelo com essa política: sem terminal/internet não há exec, process, terminal, web_*, browser…
    const closed = toolLists.openclaw_sem_terminal_nem_internet!;
    for (const name of ["exec", "process", "terminal", "web_fetch", "web_search", "browser", "message", "cron", "gateway", "sessions_spawn", "subagents", "secrets"]) expect(closed).not.toContain(name);
    expect(closed).toEqual(expect.arrayContaining(["read", "write", "edit", "apply_patch", "office__submit_result", "office__report_progress"]));
    expect(toolLists.openclaw_com_terminal_e_internet).toEqual(expect.arrayContaining(["exec", "process", "web_fetch"]));
    // Sem `toolSearch: false` as ferramentas do MCP somem atrás de tool_search/dispatch_action (só 10 chegam ao modelo).
    expect(toolLists.openclaw_padrao_sem_toolSearch_false).toEqual(expect.arrayContaining(["tool_search", "dispatch_action"]));
    expect(toolLists.openclaw_padrao_sem_toolSearch_false!.some((name) => name.startsWith("office__"))).toBe(false);
    const config = openclawAgentConfig({}, { mcpUrl: "http://x/mcp", token: "t", denied: off }) as { tools: { toolSearch: boolean } };
    expect(config.tools.toolSearch).toBe(false);
  });
});

describe("Hermes: amostras reais", () => {
  const run = (name: string, exit: { stderr?: string } = {}) => {
    const parser = new HermesStreamParser();
    const events: TerminalEvent[] = [];
    for (const line of text(name).split("\n")) events.push(...parser.parse(line));
    events.push(...parser.finish({ stderr: exit.stderr ?? "", timedOut: false }));
    return events;
  };

  it("tarefa de arquivo: write_file, texto juntado, id da sessão no result (local-…) e tokens", () => {
    const events = run("hermes-stream-file-task.jsonl");
    expect(events.find((event) => event.type === "tool_use")).toMatchObject({ name: "write_file", input: { path: "ola.txt", content: "olá" } });
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ ok: true });
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
    const session = events.find((event) => event.type === "session") as { sessionId: string };
    expect(session.sessionId).toMatch(/^local-/);
    expect(turnEnd(events)).toMatchObject({ ok: true, result: "Pronto: ola.txt criado e resultado entregue.", usage: { inputTokens: 389, outputTokens: 34 } });
  });

  it("retomada: o mesmo id volta no result; id que não existe é falha e o adaptador reconhece a sessão perdida", () => {
    const resumed = run("hermes-resumed.jsonl");
    expect((resumed.find((event) => event.type === "session") as { sessionId: string }).sessionId).toMatch(/^local-/);
    const missing = turnEnd(run("hermes-missing-session.jsonl"));
    expect(missing).toMatchObject({ ok: false });
    expect(missing!.result).toContain("No session found matching");
    expect(new HermesAdapter({ homeDir: "/x" }).isMissingSession(missing!.result)).toBe(true);
    expect(new HermesAdapter({ homeDir: "/x" }).isMissingSession("API error: 401")).toBe(false);
  });

  it("o id da sessão repetido no stderr não vira erro no registro", () => {
    const adapter = new HermesAdapter({ homeDir: "/x" });
    expect(adapter.isQuietStderr("Session: local-75e5d8f3841da47b8b1d481ebce1eb88")).toBe(true);
    expect(adapter.isQuietStderr("session_id: local-75e5d8f3841da47b8b1d481ebce1eb88")).toBe(true);
    expect(adapter.isQuietStderr("Error: invalid_params")).toBe(false);
  });

  it("conjunto de ferramentas inexistente é invalid_params (o mcp-office só entra quando há MCP no turno)", () => {
    expect(turnEnd(run("hermes-invalid-toolset.jsonl"))).toMatchObject({ ok: false, result: "invalid_params" });
    const base = { access: { internet: false, browser: false, terminal: false, allowLocalNetwork: false, allowedDomains: [], blockedDomains: [] } };
    expect(hermesToolsets(base)).toEqual(["file"]);
    expect(hermesToolsets({ ...base, mcp: { url: "u", token: "t" } })).toEqual(["file", "mcp-office"]);
    expect(hermesToolsets({ access: { ...base.access, terminal: true, internet: true }, mcp: { url: "u", token: "t" } })).toEqual(["file", "mcp-office", "terminal", "web"]);
  });

  it("as listas de ferramentas gravadas: sem terminal e internet só as de arquivo; o MCP chega como mcp__office__", () => {
    expect(toolLists.hermes_sem_terminal_nem_internet).toEqual(["patch", "read_file", "search_files", "write_file"]);
    expect(toolLists.hermes_com_terminal_e_internet).toContain("terminal");
    // Padrão do Hermes: as ferramentas do MCP ficam atrás de tool_search/tool_describe/tool_call (por isso o config.yaml do agente desliga isso).
    expect(toolLists.hermes_padrao_com_tool_search).toEqual(expect.arrayContaining(["tool_search", "tool_describe", "tool_call"]));
    expect(toolLists.hermes_com_mcp).toEqual(expect.arrayContaining(["mcp__office__submit_result", "mcp__office__report_progress"]));
  });
});

describe("Hermes: HERMES_HOME do agente, ambiente mínimo e travas no config.yaml", () => {
  it("o ambiente não leva chave de provedor, login nem pasta de configuração do dono; HOME e HERMES_HOME são do Cyno", () => {
    const env = hermesEnv({ PATH: "/bin", LANG: "pt_BR.UTF-8", HOME: "/home/dono", XAI_API_KEY: "k", GROQ_API_KEY: "k", CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", CLAUDE_CODE_MESSAGING_TOKEN: "t", HTTPS_PROXY: "http://p" }, "/cyno/hermes", "/cyno/hermes/agent-homes/a", "sk-or-1");
    expect(env).toEqual({ PATH: "/bin", LANG: "pt_BR.UTF-8", HTTPS_PROXY: "http://p", HERMES_HOME: "/cyno/hermes/agent-homes/a", HOME: "/cyno/hermes/userhome", NO_COLOR: "1", OPENROUTER_API_KEY: "sk-or-1" });
    expect(minimalChildEnv({ PATH: "/bin", SECRET_THING: "x", FAKE_CLI_LOG: "/l" })).toEqual({ PATH: "/bin", FAKE_CLI_LOG: "/l" });
  });

  it("o HERMES_HOME é estável por pasta de trabalho e diferente entre agentes", () => {
    expect(hermesAgentHomeOf("/h", "/w/a")).toBe(hermesAgentHomeOf("/h", "/w/a"));
    expect(hermesAgentHomeOf("/h", "/w/a")).not.toBe(hermesAgentHomeOf("/h", "/w/b"));
  });

  it("o config.yaml do agente: a base do dono sem os MCPs dele, as travas e o MCP office com o token", () => {
    const base = "model:\n  provider: fakeai\nauth:\n    adopt_external_logins: true\n    outra: 1\ntools:\n  tool_search:\n    enabled: auto\n  outra: x\nmcp_servers:\n  do-dono:\n    url: http://dono\n";
    const config = hermesAgentConfig(base, { mcpUrl: "http://127.0.0.1:1/mcp", token: "tok" });
    expect(config).toContain("provider: fakeai");
    expect(config).not.toContain("do-dono");
    expect(config).toContain("    adopt_external_logins: false\n    outra: 1");
    expect(config).toContain('tool_search:\n    enabled: "off"');
    expect(config).toContain("  outra: x");
    expect(config).toContain("unmanaged_idle_exit_seconds: 60");
    expect(config).toContain("model_catalog:\n  enabled: false");
    expect(config).toContain("updates:\n  check: false");
    expect(config).toContain('Authorization: "Bearer tok"');
    // Sem MCP (o turno de teste do Verificar): nenhum bloco mcp_servers.
    expect(hermesAgentConfig("", { mcpUrl: "", token: "" })).not.toContain("mcp_servers");
    // Seção em estilo inline é trocada, não duplicada.
    expect(hermesAgentConfig("tools: {}\nauth: {}\n", { mcpUrl: "", token: "" }).match(/^tools:/gm)).toHaveLength(1);
    expect(yamlDropSection("a: 1\nb:\n  c: 2\nd: 3\n", "b")).toBe("a: 1\nd: 3\n");
    expect(yamlSetNested("a:\n  k: 1\n  z: 2\n", "a", "k", [[0, "k: 9"]])).toBe("a:\n  k: 9\n  z: 2\n");
  });

  it("quando o config.yaml (token do MCP) ou a chave muda, o gateway velho do agente é encerrado antes do turno; igual, não", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cyno-gw-"));
    const cwd = path.join(root, "agente");
    let key = "k1";
    let fence = false;
    const adapter = new HermesAdapter({ homeDir: root, account: () => ({ mode: "openrouter", location: "cyno" }), openrouterKey: () => key, fence: () => fence, fenceSupport: () => ({ available: true, abi: 8, python: "/usr/bin/python3" }) });
    const spec = { agentId: "a", cwd, systemPrompt: "", mcpConfigFile: "", tools: [] } as TerminalSpec;
    const home = hermesAgentHomeOf(root, cwd);
    mkdirSync(home, { recursive: true });
    const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, HERMES_HOME: home }, stdio: "ignore" });
    try {
      writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid: daemon.pid, kind: "hermes-gateway" }));
      writeFileSync(path.join(home, "config.yaml"), "a: 1\n");
      await adapter.beforeTurn(spec); // primeira vez: impressão digital nova, o gateway "velho" cai
      expect(await alive(daemon.pid!)).toBe(false);
      const second = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, HERMES_HOME: home }, stdio: "ignore" });
      try {
        writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid: second.pid }));
        await adapter.beforeTurn(spec); // nada mudou: o gateway fica
        expect(await alive(second.pid!)).toBe(true);
        key = "k2";
        await adapter.beforeTurn(spec); // a chave mudou
        expect(await alive(second.pid!)).toBe(false);
        // O arquivo guarda só o hash, nunca a chave.
        expect(readFileSync(path.join(home, ".cyno-launch"), "utf8")).not.toContain("k2");
        // Ligar a cerca também troca o gateway: o que está no ar subiu sem ela e continuaria alcançando fora da pasta.
        const third = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, HERMES_HOME: home }, stdio: "ignore" });
        try {
          writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid: third.pid }));
          await adapter.beforeTurn(spec); // nada mudou
          expect(await alive(third.pid!)).toBe(true);
          fence = true;
          await adapter.beforeTurn(spec); // a cerca foi ligada
          expect(await alive(third.pid!)).toBe(false);
        } finally {
          third.kill();
        }
      } finally {
        second.kill();
      }
    } finally {
      daemon.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("os nomes dos provedores que o config.yaml liga (só nomes): providers:, model.provider e custom_providers", () => {
    const yaml = "model:\n  provider: custom\n  api_key: SEGREDO\nproviders:\n  meu-proxy:\n    base_url: http://x\n    key_env: K\ncustom_providers:\n  - name: antigo\n    api_key: SEGREDO\n";
    expect(parseHermesConfigProviders(yaml)).toEqual(["custom", "meu-proxy", "antigo"]);
  });
});
