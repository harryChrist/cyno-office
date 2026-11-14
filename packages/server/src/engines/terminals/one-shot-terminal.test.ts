import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { HermesAdapter, hermesAgentHomeOf, hermesFailureText } from "./hermes-adapter";
import { CONVERSATION_MEMORY_MAX_CHARS, OneShotTerminal, ONE_SHOT_IDLE_REASON, type OneShotAdapter } from "./one-shot-terminal";
import { classifyOpenClawFailure, OpenClawAdapter, openclawFailureText } from "./openclaw-adapter";
import type { TerminalEvent, TerminalSpec } from "./types";

export const FAKE_OPENCLAW = fileURLToPath(new URL("./fake-openclaw.mjs", import.meta.url));
export const FAKE_HERMES = fileURLToPath(new URL("./fake-hermes.mjs", import.meta.url));

const tempDir = useTempDirs();

const OR_KEY = "sk-or-v1-CHAVE-DE-TESTE-1234";
const OFFICE = { url: "http://127.0.0.1:9/mcp", token: "tok-teste" };

type Recorder = { events: TerminalEvent[]; waitFor: (predicate: (event: TerminalEvent) => boolean, timeoutMs?: number) => Promise<TerminalEvent> };

function record(terminal: OneShotTerminal): Recorder {
  const events: TerminalEvent[] = [];
  const waiters = new Set<() => void>();
  terminal.onEvent((event) => {
    events.push(event);
    for (const wake of [...waiters]) wake();
  });
  return {
    events,
    waitFor: (predicate, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        let seen = 0;
        const check = () => {
          for (; seen < events.length; seen++) {
            if (predicate(events[seen]!)) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(events[seen]!);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`evento esperado não chegou: ${JSON.stringify(events.slice(-6))}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      }),
  };
}

type Setup = { terminal: OneShotTerminal; rec: Recorder; cwd: string; dir: string; logFile: string; home: string };

async function setupWith(make: (input: { dir: string; home: string }) => OneShotAdapter, options: { turnTimeoutMs?: number; stopGraceMs?: number; access?: TerminalSpec["access"]; conversation?: boolean } = {}): Promise<Setup> {
  const dir = await tempDir();
  const cwd = path.join(dir, "agents", "redator");
  const home = path.join(dir, "engine");
  const logFile = path.join(dir, "runs.jsonl");
  const adapter = make({ dir, home });
  const base: TerminalSpec = {
    agentId: "redator",
    cwd,
    systemPrompt: "Você é o Redator.",
    mcpConfigFile: path.join(cwd, "mcp.json"),
    tools: [],
    ...(options.access ? { access: options.access } : {}),
  };
  const terminal = new OneShotTerminal({
    adapter,
    spec: base,
    // Como o TerminalManager: grava os arquivos do adaptador antes de cada turno.
    prepare: async () => {
      const spec: TerminalSpec = { ...base, mcp: OFFICE };
      await mkdir(cwd, { recursive: true });
      for (const file of adapter.agentFiles({ spec, mcpUrl: OFFICE.url, token: OFFICE.token })) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content, "utf8");
      }
      return spec;
    },
    env: { ...process.env, FAKE_CLI_LOG: logFile, FAKE_CLI_STATE: path.join(dir, "fake-state"), ANTHROPIC_API_KEY: "sk-ant-NAO-PODE", OPENAI_API_KEY: "sk-NAO-PODE", OPENROUTER_API_KEY: "sk-or-NAO-PODE" },
    turnTimeoutMs: options.turnTimeoutMs ?? 20_000,
    stopGraceMs: options.stopGraceMs ?? 300,
    ...(options.conversation ? { conversation: true } : {}),
  });
  return { terminal, rec: record(terminal), cwd, dir, logFile, home };
}

const openclaw = (options?: Parameters<typeof setupWith>[1]) => setupWith(({ home }) => new OpenClawAdapter({ command: process.execPath, prefixArgs: [FAKE_OPENCLAW], homeDir: home, defaultModel: "deepseek/deepseek-chat", openrouterKey: () => OR_KEY }), options);
const hermes = (options?: Parameters<typeof setupWith>[1]) => setupWith(({ home }) => new HermesAdapter({ command: process.execPath, prefixArgs: [FAKE_HERMES], homeDir: home, defaultModel: "deepseek/deepseek-chat", openrouterKey: () => OR_KEY }), options);

type Run = { argv: string[]; cwd: string; env: Record<string, string>; config?: Record<string, unknown>; message?: string; agents?: string };
async function runs(file: string): Promise<Run[]> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as Run);
}

const turnEnd = (event: TerminalEvent): event is Extract<TerminalEvent, { type: "turn_end" }> => event.type === "turn_end";

describe("OneShotTerminal com o OpenClaw falso", () => {
  it("um turno: sobe um processo, entrega o texto final, os tokens e o estado volta a parado", async () => {
    const { terminal, rec, logFile, cwd } = await openclaw();
    terminal.send("Escreva um haicai", "t1", { freshSession: true });
    const end = (await rec.waitFor(turnEnd)) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(end).toMatchObject({ ok: true, tag: "t1", result: "eco: Escreva um haicai", usage: { inputTokens: 120, outputTokens: 8 } });
    expect(end.usage?.reportedCostUsd).toBeUndefined();
    await rec.waitFor((event) => event.type === "status" && event.status === "stopped");
    expect(terminal.status()).toBe("stopped");
    expect(rec.events.find((event) => event.type === "status" && event.status === "stopped")).toMatchObject({ reason: ONE_SHOT_IDLE_REASON });
    expect(rec.events.map((event) => event.type)).toEqual(expect.arrayContaining(["status", "turn_start", "session", "text", "turn_end"]));
    expect(rec.events.find((event) => event.type === "session")).toMatchObject({ model: "openrouter/deepseek/deepseek-chat" });
    const [run] = await runs(logFile);
    // O comando: exec isolado com mensagem por arquivo, pasta, configuração e estado próprios, JSON e prazo.
    expect(run!.argv.slice(0, 2)).toEqual(["agent", "exec"]);
    for (const flag of ["--message-file", "--cwd", "--config", "--state-dir", "--timeout", "--json"]) expect(run!.argv).toContain(flag);
    expect(run!.argv[run!.argv.indexOf("--cwd") + 1]).toBe(cwd);
    expect(run!.argv).not.toContain("--auth-env-only");
    // As instruções do agente vão na mensagem; o arquivo temporário some depois do turno.
    expect(run!.message).toContain("Você é o Redator.");
    expect(run!.message).toContain("Escreva um haicai");
    expect((await readdir(cwd)).filter((name) => name.startsWith(".turn-"))).toEqual([]);
    // Ambiente: sem nenhuma chave de API, com HOME e estado próprios do Cyno.
    expect(run!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run!.env.OPENAI_API_KEY).toBeUndefined();
    // A única chave que chega é a do OpenRouter do dono (a do ambiente do servidor sai); o modelo vai como openrouter/<id>.
    expect(run!.env.OPENROUTER_API_KEY).toBe(OR_KEY);
    expect(run!.argv[run!.argv.indexOf("--model") + 1]).toBe("openrouter/deepseek/deepseek-chat");
    expect(run!.env.OPENCLAW_STATE_DIR).toContain(path.join("engine", "state"));
    expect(run!.env.HOME).toContain(path.join("engine", "home"));
  });

  it("a configuração do agente tem o MCP office (URL e Authorization) e nega exec e internet sem acesso", async () => {
    const { terminal, rec, logFile } = await openclaw({ access: { internet: false, browser: false, terminal: false, allowedDomains: [], blockedDomains: [], allowLocalNetwork: false } });
    terminal.send("oi", "t1", { freshSession: true });
    await rec.waitFor(turnEnd);
    const [run] = await runs(logFile);
    expect(run!.config).toMatchObject({ mcp: { servers: { office: { url: OFFICE.url, transport: "streamable-http", headers: { Authorization: `Bearer ${OFFICE.token}` } } } } });
    const tools = (run!.config as { tools: { deny: string[]; toolSearch: boolean } }).tools;
    // Grupos do programa de verdade (conferidos com o OpenClaw 2026.11.3): terminal e web saem; sem toolSearch o MCP chega ao modelo com o nome próprio.
    expect(tools.deny).toEqual(expect.arrayContaining(["group:runtime", "group:web", "group:ui", "group:messaging", "group:automation", "group:sessions", "secrets"]));
    expect(tools.toolSearch).toBe(false);
  });

  it("com acesso a terminal e internet, a política não nega exec nem a web (o navegador continua negado)", async () => {
    const { terminal, rec, logFile } = await openclaw({ access: { internet: true, browser: false, terminal: true, allowedDomains: [], blockedDomains: [], allowLocalNetwork: false } });
    terminal.send("oi", "t1", { freshSession: true });
    await rec.waitFor(turnEnd);
    const deny = ((await runs(logFile))[0]!.config as { tools: { deny: string[] } }).tools.deny;
    expect(deny).not.toContain("group:runtime");
    expect(deny).not.toContain("group:web");
    // O navegador (group:ui) continua negado.
    expect(deny).toContain("group:ui");
  });

  it("erro do modelo vira turn_end com falha e a mensagem; sem conta e sem cota têm texto próprio", async () => {
    const { terminal, rec } = await openclaw();
    terminal.send("[erro] algo", "e1", { freshSession: true });
    expect(await rec.waitFor((event) => turnEnd(event) && event.tag === "e1")).toMatchObject({ ok: false, result: "falha simulada do modelo" });
    terminal.send("[semconta]", "e2", { freshSession: true });
    const noAccount = (await rec.waitFor((event) => turnEnd(event) && event.tag === "e2")) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(noAccount.ok).toBe(false);
    expect(noAccount.result).toContain("chave não está configurada ou foi recusada");
    expect(noAccount.result).toContain("Configurações › Motores › OpenClaw");
    terminal.send("[cota]", "e3", { freshSession: true });
    const quota = (await rec.waitFor((event) => turnEnd(event) && event.tag === "e3")) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(quota.result).toContain("está limitando");
    expect(rec.events.some((event) => event.type === "usage" && event.status === "rejected" && event.windows[0]?.utilization === 1)).toBe(true);
  });

  it("custo maior que zero vai no uso do turno (sinal de chave de API paga)", async () => {
    const { terminal, rec } = await openclaw();
    terminal.send("[custo]", "c1", { freshSession: true });
    const end = (await rec.waitFor(turnEnd)) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(end.ok).toBe(true);
    expect(end.usage?.reportedCostUsd).toBeCloseTo(0.37);
  });

  it("chamadas de ferramenta do toolSummary viram eventos tool_use/tool_result", async () => {
    const { terminal, rec } = await openclaw();
    terminal.send("[ferramentas]", "f1", { freshSession: true });
    await rec.waitFor(turnEnd);
    expect(rec.events.filter((event) => event.type === "tool_use").map((event) => (event as { name: string }).name)).toEqual(["read", "write"]);
    expect(rec.events.filter((event) => event.type === "tool_result")).toHaveLength(2);
  });

  it("o prazo do turno estoura: encerra o processo e devolve a falha com o motivo", async () => {
    const { terminal, rec } = await openclaw({ turnTimeoutMs: 700 });
    terminal.send("[lento]", "l1", { freshSession: true });
    const end = (await rec.waitFor(turnEnd)) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(end.ok).toBe(false);
    expect(end.result).toContain("tempo máximo");
  });

  it("fila: duas mensagens rodam uma de cada vez; cancelar tira só a que ainda não começou", async () => {
    const { terminal, rec } = await openclaw();
    terminal.send("primeira", "a", { freshSession: true });
    terminal.send("segunda", "b", { freshSession: true });
    terminal.send("terceira", "c", { freshSession: true });
    expect(terminal.cancel("c")).toEqual(["terceira"]);
    await rec.waitFor((event) => turnEnd(event) && event.tag === "b");
    const tags = rec.events.filter(turnEnd).map((event) => event.tag);
    expect(tags).toEqual(["a", "b"]);
    // Nunca dois processos ao mesmo tempo: cada turn_start vem depois do turn_end anterior.
    const order = rec.events.filter((event) => event.type === "turn_start" || event.type === "turn_end").map((event) => `${event.type}:${(event as { tag?: string }).tag}`);
    expect(order).toEqual(["turn_start:a", "turn_end:a", "turn_start:b", "turn_end:b"]);
  });

  it("interromper corta o turno em curso (SIGTERM e, se ele ignorar, SIGKILL) e a fila segue", async () => {
    const { terminal, rec } = await openclaw({ stopGraceMs: 300 });
    terminal.send("[teimoso]", "x", { freshSession: true });
    terminal.send("depois", "y", { freshSession: true });
    await rec.waitFor((event) => event.type === "turn_start" && event.tag === "x");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const started = Date.now();
    terminal.interrupt();
    await rec.waitFor((event) => event.type === "dropped" && event.tag === "x");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(rec.events.find((event) => event.type === "dropped")).toMatchObject({ reason: "Interrompido" });
    expect(await rec.waitFor((event) => turnEnd(event) && event.tag === "y")).toMatchObject({ ok: true });
  });

  it("parar descarta a fila e corta o turno; depois o terminal aceita ordens de novo", async () => {
    const { terminal, rec } = await openclaw({ stopGraceMs: 200 });
    terminal.send("[lento]", "x", { freshSession: true });
    terminal.send("na fila", "y", { freshSession: true });
    await rec.waitFor((event) => event.type === "turn_start" && event.tag === "x");
    await terminal.stop("Parado por você");
    expect(rec.events.filter((event) => event.type === "dropped").map((event) => (event as { tag?: string }).tag)).toEqual(expect.arrayContaining(["x", "y"]));
    expect(terminal.status()).toBe("stopped");
    terminal.send("de novo", "z", { freshSession: true });
    expect(await rec.waitFor((event) => turnEnd(event) && event.tag === "z")).toMatchObject({ ok: true });
  });

  it("sem retomada: a mensagem seguinte da mesma conversa leva o trecho anterior; conversa nova não leva", async () => {
    const { terminal, rec, logFile } = await openclaw();
    terminal.send("Escreva um haicai", "t1", { freshSession: true });
    await rec.waitFor((event) => turnEnd(event) && event.tag === "t1");
    terminal.send("A resposta do usuário: sim", "t1");
    await rec.waitFor((event) => turnEnd(event) && event.tag === "t1" && rec.events.filter(turnEnd).length === 2);
    terminal.send("Outra tarefa", "t2", { freshSession: true });
    await rec.waitFor((event) => turnEnd(event) && event.tag === "t2");
    const [first, second, third] = await runs(logFile);
    expect(first!.message).not.toContain("Mensagem anterior");
    expect(second!.message).toContain("Mensagem anterior que você recebeu");
    expect(second!.message).toContain("Escreva um haicai");
    expect(second!.message).toContain("eco: Escreva um haicai");
    expect(third!.message).not.toContain("Mensagem anterior");
    expect(await terminal.hasHistory()).toBe(true);
    expect(terminal.currentSessionKey()).toBe("t2");
  });

  it("CLI que não existe: o turno falha com a mensagem em vez de travar a fila", async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, "a");
    const terminal = new OneShotTerminal({
      adapter: new OpenClawAdapter({ command: path.join(dir, "nao-existe"), homeDir: path.join(dir, "e") }),
      spec: { agentId: "a", cwd, systemPrompt: "x", mcpConfigFile: "", tools: [] },
      turnTimeoutMs: 5000,
    });
    const rec = record(terminal);
    terminal.send("oi", "t", { freshSession: true });
    const end = (await rec.waitFor(turnEnd)) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(end.ok).toBe(false);
    expect(end.result).toMatch(/não encontrado|ENOENT/);
  });
});

describe("OneShotTerminal com o Hermes falso", () => {
  it("um turno: texto juntado, tokens, sessão do result; as instruções vão no AGENTS.md e o MCP no config.yaml do Cyno", async () => {
    const { terminal, rec, logFile, cwd, home } = await hermes();
    terminal.send("Escreva um haicai", "t1", { freshSession: true });
    const end = (await rec.waitFor(turnEnd)) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(end).toMatchObject({ ok: true, tag: "t1", result: "eco: Escreva um haicai", usage: { inputTokens: 90, outputTokens: 6, cacheReadTokens: 10 } });
    // Os pedaços do texto viram um `text` só antes do fim.
    const texts = rec.events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text);
    expect(texts).toEqual(["Vou trabalhar. eco: Escreva um haicai"]);
    const [run] = await runs(logFile);
    expect(run!.argv.slice(0, 1)).toEqual(["chat"]);
    for (const flag of ["--query-file", "--oneshot", "-Q", "--format", "stream-json", "-t", "--yolo"]) expect(run!.argv).toContain(flag);
    expect(run!.argv[run!.argv.indexOf("-t") + 1]).toBe("file,mcp-office");
    expect(run!.argv).not.toContain("--resume");
    expect(run!.agents).toContain("Você é o Redator.");
    expect(run!.message).toBe("Escreva um haicai");
    // O gateway do Hermes lê o MCP do config.yaml do HERMES_HOME DO AGENTE (o ambiente do turno não chega a ele): url e token ali, com as travas.
    expect(run!.config).toContain("mcp_servers:");
    expect(run!.config).toContain(`Authorization: "Bearer ${OFFICE.token}"`);
    expect(run!.config).toContain("adopt_external_logins: false");
    expect(run!.config).toContain('enabled: "off"');
    expect(run!.env.CYNO_MCP_TOKEN).toBeUndefined();
    expect(run!.env.HERMES_HOME).toBe(hermesAgentHomeOf(path.join(home), cwd));
    expect(run!.env.HOME).toBe(path.join(home, "userhome"));
    expect(run!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run!.env.OPENAI_API_KEY).toBeUndefined();
    expect(run!.env.OPENROUTER_API_KEY).toBe(OR_KEY);
    expect(run!.argv.slice(run!.argv.indexOf("--provider"), run!.argv.indexOf("--provider") + 4)).toEqual(["--provider", "openrouter", "-m", "deepseek/deepseek-chat"]);
    expect(cwd).toContain("agents");
    expect(terminal.sessionId()).toBeTruthy();
  });

  it("a mesma conversa retoma com --resume <id da sessão>; conversa nova (outra chave) não retoma", async () => {
    const { terminal, rec, logFile } = await hermes();
    terminal.send("primeira", "t1", { freshSession: true });
    await rec.waitFor((event) => event.type === "status" && event.status === "stopped");
    const sessionId = terminal.sessionId();
    terminal.send("a decisão chegou", "t1");
    await rec.waitFor(() => rec.events.filter(turnEnd).length === 2);
    await rec.waitFor(() => rec.events.filter((event) => event.type === "status" && event.status === "stopped").length === 2);
    terminal.send("outra", "t2", { freshSession: true });
    await rec.waitFor(() => rec.events.filter(turnEnd).length === 3);
    const [a, b, c] = await runs(logFile);
    expect(a!.argv).not.toContain("--resume");
    expect(b!.argv[b!.argv.indexOf("--resume") + 1]).toBe(sessionId);
    expect(c!.argv).not.toContain("--resume");
  });

  it("chamadas de ferramenta e o MCP: tool_use e tool_result com o id da chamada", async () => {
    const { terminal, rec } = await hermes();
    terminal.send("[ferramentas]", "f1", { freshSession: true });
    await rec.waitFor(turnEnd);
    expect(rec.events.find((event) => event.type === "tool_use")).toMatchObject({ id: "call_1", name: "read_file", input: { path: "a.txt" } });
    expect(rec.events.find((event) => event.type === "tool_result")).toMatchObject({ id: "call_1", ok: true });
  });

  it("as ferramentas do escritório viram mcp__office__<nome> (o jeito que o log e o resto do Cyno esperam)", async () => {
    const { terminal, rec } = await hermes();
    terminal.send("[entregar]", "f2", { freshSession: true });
    await rec.waitFor(turnEnd);
    expect(rec.events.filter((event) => event.type === "tool_use").map((event) => (event as { name: string }).name)).toEqual(["mcp__office__report_progress", "mcp__office__submit_result"]);
  });

  it("erro do result, sem conta (stderr), sem cota e saída sem result viram falhas com texto útil", async () => {
    const { terminal, rec } = await hermes();
    terminal.send("[erro]", "e1", { freshSession: true });
    expect(await rec.waitFor((event) => turnEnd(event) && event.tag === "e1")).toMatchObject({ ok: false, result: "falha simulada do modelo" });
    terminal.send("[semconta]", "e2", { freshSession: true });
    const noAccount = (await rec.waitFor((event) => turnEnd(event) && event.tag === "e2")) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(noAccount.result).toContain("chave não está configurada ou foi recusada");
    terminal.send("[cota]", "e3", { freshSession: true });
    expect(((await rec.waitFor((event) => turnEnd(event) && event.tag === "e3")) as Extract<TerminalEvent, { type: "turn_end" }>).result).toContain("está limitando");
    expect(rec.events.some((event) => event.type === "usage" && event.status === "rejected")).toBe(true);
    terminal.send("[semresult]", "e4", { freshSession: true });
    const none = (await rec.waitFor((event) => turnEnd(event) && event.tag === "e4")) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(none.ok).toBe(false);
    expect(none.result).toContain("sem dar resposta");
  });

  it("prazo estourado e processo teimoso (ignora SIGTERM) são derrubados com SIGKILL", async () => {
    const { terminal, rec } = await hermes({ turnTimeoutMs: 600, stopGraceMs: 200 });
    terminal.send("[teimoso]", "x", { freshSession: true });
    const end = (await rec.waitFor(turnEnd, 6000)) as Extract<TerminalEvent, { type: "turn_end" }>;
    expect(end.ok).toBe(false);
    expect(end.result).toContain("tempo máximo");
  });
});

describe('o 401 "User not found" do OpenRouter (chave de gerenciamento ou apagada)', () => {
  it("vira a explicação certa nos dois adaptadores, sem o texto genérico de chave recusada", () => {
    const original = '{"error":{"message":"User not found.","code":401}}';
    expect(classifyOpenClawFailure(original)).toBe("no_account");
    for (const text of [openclawFailureText("no_account", original), hermesFailureText("no_account", original)]) {
      expect(text).toContain("de gerenciamento");
      expect(text).toContain("foi apagada");
      expect(text).toContain("crie uma chave de API comum");
      expect(text).not.toContain("foi recusada");
    }
    // Outros 401 seguem com a mensagem de antes.
    expect(openclawFailureText("no_account", "401 invalid api key")).toContain("foi recusada");
    expect(hermesFailureText("no_account", "401 invalid api key")).toContain("foi recusada");
  });
});

describe("OneShotTerminal numa conversa (Maestro e Cyno)", () => {
  it("OpenClaw, sem retomada: cada turno leva o resumo corrido da conversa inteira, com teto, guardado na pasta do agente", async () => {
    const { terminal, rec, logFile, cwd } = await openclaw({ conversation: true });
    for (const [index, word] of ["um", "dois", "tres"].entries()) {
      terminal.send(`Fale ${word}`, `c${index}`);
      await rec.waitFor((event) => turnEnd(event) && event.tag === `c${index}`);
    }
    const [first, second, third] = await runs(logFile);
    expect(first!.message).not.toContain("Resumo corrido");
    expect(second!.message).toContain("Resumo corrido da conversa");
    expect(second!.message).toContain("Fale um");
    expect(third!.message).toContain("Fale um");
    expect(third!.message).toContain("Fale dois");
    expect(third!.message).toContain("Você respondeu: eco: Fale dois");
    // Fica no disco, na pasta do agente (sobrevive a um reinício do servidor).
    await rec.waitFor((event) => event.type === "status" && event.status === "stopped");
    const saved = JSON.parse(await readFile(path.join(cwd, "conversation-memory.json"), "utf8")) as { lines: string[] };
    expect(saved.lines.join("\n")).toContain("Fale tres");
  });

  it("o resumo tem teto: as falas mais antigas saem e o aviso de corte aparece", async () => {
    const { terminal, rec, logFile } = await openclaw({ conversation: true });
    const long = "x".repeat(450);
    for (let index = 0; index < 14; index += 1) {
      terminal.send(`${index} ${long}`, `c${index}`);
      await rec.waitFor((event) => turnEnd(event) && event.tag === `c${index}`);
    }
    const all = await runs(logFile);
    const last = all.at(-1)!.message!;
    const memory = last.slice(last.indexOf("Resumo corrido"));
    expect(memory.length).toBeLessThan(CONVERSATION_MEMORY_MAX_CHARS + 600);
    expect(memory).toContain("falas mais antigas foram omitidas");
    expect(memory).not.toContain("- Mensagem: 0 xxx");
    expect(memory).toContain("- Mensagem: 12 xxx");
  });

  it("uma conversa nova (outra chave) começa sem o resumo da anterior", async () => {
    const { terminal, rec, logFile } = await openclaw({ conversation: true });
    terminal.send("Primeira conversa", "a");
    await rec.waitFor((event) => turnEnd(event) && event.tag === "a");
    terminal.send("Conversa nova", "b", { freshSession: true, sessionKey: "nova" });
    await rec.waitFor((event) => turnEnd(event) && event.tag === "b");
    const [, second] = await runs(logFile);
    expect(second!.message).not.toContain("Resumo corrido");
  });

  it("Hermes retoma a sessão salva: nada de resumo (a conversa vai pela sessão)", async () => {
    const { terminal, rec, logFile } = await hermes({ conversation: true });
    terminal.send("Fale um", "c0");
    await rec.waitFor((event) => turnEnd(event) && event.tag === "c0");
    terminal.send("Fale dois", "c1");
    await rec.waitFor((event) => turnEnd(event) && event.tag === "c1");
    const [first, second] = await runs(logFile);
    expect(first!.argv).not.toContain("--resume");
    expect(second!.argv).toContain("--resume");
    expect(second!.message).not.toContain("Resumo corrido");
  });

  it("mensagens da mesma etiqueta que esperam um turno em curso vão juntas num turno só; etiquetas diferentes nunca se juntam", async () => {
    const { terminal, rec, logFile } = await hermes({ conversation: true });
    terminal.send("[lento] primeiro", "r1");
    // Enquanto o processo roda (o [lento] dorme), chegam duas do mesmo pedido e uma de outro.
    await rec.waitFor((event) => event.type === "turn_start" && event.tag === "r1");
    for (let attempt = 0; attempt < 100 && (await runs(logFile)).length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    terminal.send("aviso A", "r2");
    terminal.send("aviso B", "r2");
    terminal.send("conversa C", "c9");
    terminal.interrupt();
    await rec.waitFor((event) => turnEnd(event) && event.tag === "c9", 20_000);
    const starts = rec.events.filter((event) => event.type === "turn_start").map((event) => (event as { tag?: string }).tag);
    // r1 (1) + r2 (duas mensagens = dois turn_start, um processo) + c9 (1).
    expect(starts).toEqual(["r1", "r2", "r2", "c9"]);
    const processes = await runs(logFile);
    expect(processes).toHaveLength(3);
    const merged = processes[1]!.message!;
    expect(merged).toContain("aviso A");
    expect(merged).toContain("aviso B");
    expect(merged).toContain("Outra mensagem que chegou junto");
    expect(processes[2]!.message).toContain("conversa C");
    expect(processes[2]!.message).not.toContain("aviso A");
  });
});
