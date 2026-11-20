import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { ClaudeCliAdapter } from "./claude-adapter";
import { bracketedPaste, PtyTerminal, promptMatches, stripAnsi, type PtyTerminalOptions } from "./pty-terminal";
import type { ToolsWaitOutcome } from "../../mcp/tokens";
import type { TerminalEvent, TerminalSpec, ToolsGate } from "./types";

/** CLI interativa falsa (imita o `claude` TUI e grava a conversa como ele; veja fake-tui.mjs). */
export const FAKE_TUI = fileURLToPath(new URL("./fake-tui.mjs", import.meta.url));

const tempDir = useTempDirs();
const terminals: PtyTerminal[] = [];
afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.dispose()));
});

type Setup = { terminal: PtyTerminal; events: TerminalEvent[]; root: string; cwd: string; projects: string; spawnLog: string };

async function setup(options: Partial<PtyTerminalOptions> & { env?: Record<string, string>; root?: string } = {}): Promise<Setup> {
  const root = options.root ?? (await tempDir());
  const cwd = path.join(root, "agents", "maestro");
  const projects = path.join(root, "projects");
  const spawnLog = path.join(root, "spawns.jsonl");
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const spec: TerminalSpec = { agentId: "maestro", cwd, systemPrompt: "Você é o Maestro.", mcpConfigFile: path.join(cwd, "mcp.json"), tools: ["Read", "Glob"], model: "haiku", effort: "low" };
  const terminal = new PtyTerminal({
    adapter: new ClaudeCliAdapter({ command: process.execPath, prefixArgs: [FAKE_TUI] }),
    spec,
    projectsDir: projects,
    keepAlive: () => true,
    idleMs: 0,
    maxRetries: 2,
    backoffMs: () => 20,
    pollMs: 20,
    readyTimeoutMs: 3000,
    submitDelayMs: 30,
    stopGraceMs: 1000,
    remoteControlName: () => "Maestro · Teste",
    ...options,
    env: { ...process.env, FAKE_TUI_PROJECTS: projects, FAKE_TUI_LOG: spawnLog, FAKE_TUI_STATE: path.join(root, "fake-state"), ANTHROPIC_API_KEY: "sk-ant-NAO-PODE", ...options.env },
  });
  terminals.push(terminal);
  const events: TerminalEvent[] = [];
  terminal.onEvent((event) => events.push(event));
  return { terminal, events, root, cwd, projects, spawnLog };
}

async function until<T>(check: () => T | undefined | false, timeoutMs = 6000, label = "condição"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Tempo esgotado esperando ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const spawns = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; cols: number });

async function waitSpawns(file: string, count: number) {
  const started = Date.now();
  for (;;) {
    const list = await spawns(file);
    if (list.length >= count || Date.now() - started > 4000) return list;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Espera das ferramentas MCP controlada pelo teste (no lugar do McpTokens): uma por subida. */
function manualGate() {
  const waits: { settle: (outcome: ToolsWaitOutcome) => void; cancelled: boolean }[] = [];
  const gate: ToolsGate = () => {
    let settle!: (outcome: ToolsWaitOutcome) => void;
    const done = new Promise<ToolsWaitOutcome>((resolve) => (settle = resolve));
    const entry = { settle, cancelled: false };
    waits.push(entry);
    return {
      done,
      cancel: () => {
        entry.cancelled = true;
        settle("cancelled");
      },
    };
  };
  return { gate, waits };
}

const turnEnd = (events: TerminalEvent[], tag?: string) => events.find((event): event is Extract<TerminalEvent, { type: "turn_end" }> => event.type === "turn_end" && event.tag === tag);

describe("PtyTerminal (Maestro interativo com a CLI falsa)", () => {
  it("sobe com as flags do TUI, responde o diálogo de confiança, liga o Remote Control e fica pronto", async () => {
    const { terminal, events, spawnLog } = await setup({ env: { FAKE_TUI_TRUST: "1" } });
    const output: string[] = [];
    terminal.onOutput((data) => output.push(data));
    await terminal.ensureRunning();
    await until(() => terminal.status() === "idle", 6000, "idle");
    const [spawn] = await spawns(spawnLog);
    expect(spawn!.argv).toContain("--restricted");
    expect(spawn!.argv).not.toContain("--disable-slash-commands");
    expect(spawn!.argv).not.toContain("-p");
    expect(spawn!.argv[spawn!.argv.indexOf("--remote-control") + 1]).toBe("Maestro · Teste");
    expect(spawn!.argv[spawn!.argv.indexOf("--disallowedTools") + 1]).toBe("Bash");
    expect(spawn!.argv[spawn!.argv.indexOf("--allowedTools") + 1]).toBe("Read,Glob,mcp__office");
    expect(spawn!.argv).toContain("--session-id");
    expect(spawn!.argv[spawn!.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(spawn!.cols).toBe(120);
    expect(events.some((event) => event.type === "raw" && event.text.includes("diálogo de confiança respondido"))).toBe(true);
    // Só ficou pronto depois do diálogo (o "❯ No, exit" do diálogo não conta como prompt).
    expect(stripAnsi(output.join(""))).toContain("Fake Claude Code");
    const remote = await until(() => terminal.remote()?.active && terminal.remote(), 4000, "remote");
    expect(remote).toEqual({ active: true, name: "Maestro · Teste", url: "https://claude.ai/code/session_FAKE123" });
    expect(stripAnsi(output.join(""))).toContain("Fake Claude Code");
    expect(terminal.replay()).toContain("Fake Claude Code");
  });

  it("responde sozinho o diálogo \"Adding a new directory\" das pastas de trabalho (escolhe \"Yes, add it\", nunca o \"No, exit\")", async () => {
    const { terminal, events } = await setup({ env: { FAKE_TUI_TRUST: "add-dir" } });
    const output: string[] = [];
    terminal.onOutput((data) => output.push(data));
    await terminal.ensureRunning();
    await until(() => terminal.status() === "idle", 6000, "idle");
    expect(events.some((event) => event.type === "raw" && event.text.includes("Pasta de trabalho liberada"))).toBe(true);
    // A CLI não saiu (um Enter no "No, exit" a fecharia) e chegou ao prompt de verdade.
    expect(stripAnsi(output.join(""))).toContain("Fake Claude Code");
    expect(terminal.status()).toBe("idle");
  });

  it("send cola a mensagem (bracketed paste + Enter); o turno vem da conversa em disco, com a tag, o texto e os tokens", async () => {
    const { terminal, events, cwd } = await setup();
    terminal.send("Pedido de teste [ferramenta]\nsegunda linha", "t1");
    const end = await until(() => turnEnd(events, "t1"), 8000, "turn_end t1");
    expect(end).toMatchObject({ ok: true, result: "ok: Pedido de teste [ferramenta]" });
    expect(end.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheCreationTokens: 0 });
    expect(events.find((event) => event.type === "turn_start")).toEqual({ type: "turn_start", tag: "t1" });
    expect(events.some((event) => event.type === "tool_use" && event.name === "Read")).toBe(true);
    expect(events.some((event) => event.type === "tool_result" && event.output === "conteúdo")).toBe(true);
    expect(events.some((event) => event.type === "text" && event.text === "ok: Pedido de teste [ferramenta]")).toBe(true);
    expect(terminal.status()).toBe("idle");
    await terminal.flushSession();
    const session = JSON.parse(await readFile(path.join(cwd, "session.json"), "utf8")) as { started: boolean; sessionId: string };
    expect(session.started).toBe(true);
    expect(session.sessionId).toBe(terminal.sessionId());
  });

  it("alguém digitando no terminal abre um turno sem tag (com o texto); comandos / não viram turno", async () => {
    const { terminal, events } = await setup();
    const output: string[] = [];
    terminal.onOutput((data) => output.push(data));
    await terminal.ensureRunning();
    await until(() => terminal.status() === "idle", 6000, "idle");
    terminal.write("/help\r");
    await until(() => stripAnsi(output.join("")).includes("Comandos: /help"), 4000, "saída do /help");
    terminal.write("oi do terminal\r");
    await until(() => turnEnd(events, undefined), 6000, "turn_end sem tag");
    const starts = events.filter((event) => event.type === "turn_start");
    expect(starts).toEqual([{ type: "turn_start", prompt: "oi do terminal" }]);
    expect(turnEnd(events, undefined)).toMatchObject({ ok: true, result: "ok: oi do terminal" });
  });

  it("reinício (terminal novo na mesma pasta, como o server voltando): --resume na mesma sessão e só o que é novo vira evento", async () => {
    const first = await setup();
    first.terminal.send("primeiro pedido", "a");
    await until(() => turnEnd(first.events, "a"), 8000, "turn_end a");
    const sessionId = first.terminal.sessionId();
    await first.terminal.dispose();

    const second = await setup({ root: first.root });
    second.terminal.send("segundo pedido", "b");
    await until(() => turnEnd(second.events, "b"), 8000, "turn_end b");
    const argv = (await spawns(second.spawnLog)).at(-1)!.argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe(sessionId);
    expect(second.terminal.sessionId()).toBe(sessionId);
    // A conversa antiga não volta como turno novo.
    expect(second.events.filter((event) => event.type === "turn_start")).toEqual([{ type: "turn_start", tag: "b" }]);
  });

  it("caiu no meio do turno: sobe de novo sozinho (keepAlive) e reenvia a mensagem", async () => {
    const { terminal, events, spawnLog } = await setup();
    terminal.send("faça [crash]", "c");
    const end = await until(() => turnEnd(events, "c"), 10_000, "turn_end c");
    expect(end.ok).toBe(true);
    expect(end.result).toContain("Mensagem reenviada");
    expect((await spawns(spawnLog)).length).toBe(2);
    expect(events.some((event) => event.type === "status" && event.status === "error")).toBe(true);
  }, 15_000);

  it("não sobe: tenta de novo com espera e desiste depois de maxRetries (status error)", async () => {
    const { terminal, events, spawnLog } = await setup({ env: { FAKE_TUI_FAIL_START: "1" }, maxRetries: 2 });
    await terminal.ensureRunning();
    await until(() => events.filter((event) => event.type === "status" && event.status === "error").length >= 3 && terminal.status() === "error", 8000, "desistir");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await spawns(spawnLog)).length).toBe(3);
  });

  it("sem keepAlive para depois de ocioso; com keepAlive fica rodando", async () => {
    let keepAlive = false;
    const { terminal } = await setup({ keepAlive: () => keepAlive, idleMs: 150 });
    terminal.send("rapidinho", "x");
    await until(() => terminal.status() === "stopped", 6000, "parar por ociosidade");
    keepAlive = true;
    terminal.refreshPolicy();
    await until(() => terminal.status() === "idle", 6000, "subir com keepAlive");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(terminal.status()).toBe("idle");
  });

  it("freshSession vira /clear: a conversa nova é seguida e o session.json acompanha", async () => {
    const { terminal, events, cwd } = await setup();
    terminal.send("conversa antiga", "old");
    await until(() => turnEnd(events, "old"), 8000, "turn_end old");
    const before = terminal.sessionId();
    terminal.send("conversa nova", "new", { freshSession: true, sessionKey: "k1" });
    await until(() => turnEnd(events, "new"), 10_000, "turn_end new");
    expect(terminal.sessionId()).not.toBe(before);
    await terminal.flushSession();
    const session = JSON.parse(await readFile(path.join(cwd, "session.json"), "utf8")) as { sessionId: string; key?: string };
    expect(session.sessionId).toBe(terminal.sessionId());
    expect(events.some((event) => event.type === "raw" && event.text.includes("/clear"))).toBe(true);
  });

  it("nome da sessão do Remote Control trocado: /rename quando o terminal fica livre, sem reiniciar", async () => {
    let name = "Maestro · Teste";
    const { terminal, events, spawnLog } = await setup({ remoteControlName: () => name });
    const output: string[] = [];
    terminal.onOutput((data) => output.push(data));
    terminal.send("faça [lento]", "s");
    await until(() => terminal.status() === "busy", 6000, "ocupado");
    name = "Meu Maestro";
    terminal.renameRemote();
    // Ocupado: o nome novo fica pendente (a tela mostra "aplica quando ficar livre").
    expect(terminal.remote()).toMatchObject({ name: "Maestro · Teste", pendingName: "Meu Maestro" });
    await until(() => stripAnsi(output.join("")).includes("Session renamed to: Meu Maestro"), 8000, "/rename");
    expect(turnEnd(events, "s")?.ok).toBe(true);
    expect(terminal.remote()).toMatchObject({ name: "Meu Maestro" });
    expect(terminal.remote()?.pendingName).toBeUndefined();
    expect(events.some((event) => event.type === "raw" && event.text.includes("renomeada para “Meu Maestro”"))).toBe(true);
    // O /rename não é um prompt (não abre turno) e o processo é o mesmo.
    expect(events.filter((event) => event.type === "turn_start")).toEqual([{ type: "turn_start", tag: "s" }]);
    expect((await spawns(spawnLog)).length).toBe(1);
    // Mesmo nome de novo: nada a fazer.
    terminal.renameRemote();
    expect(terminal.remote()?.pendingName).toBeUndefined();
  });

  it("nome trocado com o terminal parado: a próxima subida já nasce com o nome novo", async () => {
    let name = "Maestro · Teste";
    const { terminal, spawnLog } = await setup({ remoteControlName: () => name });
    await terminal.ensureRunning();
    await until(() => terminal.status() === "idle", 6000, "idle");
    await terminal.stop("teste");
    name = "Outro nome";
    terminal.renameRemote();
    expect(terminal.remote()).toMatchObject({ active: false, name: "Outro nome" });
    await terminal.ensureRunning();
    const argv = (await waitSpawns(spawnLog, 2)).at(-1)!.argv;
    expect(argv[argv.indexOf("--remote-control") + 1]).toBe("Outro nome");
  });

  it("resize muda o tamanho do pty (e a próxima subida já nasce com ele)", async () => {
    const { terminal, spawnLog } = await setup();
    terminal.resize(90, 30);
    await terminal.ensureRunning();
    expect((await waitSpawns(spawnLog, 1))[0]!.cols).toBe(90);
    expect(terminal.dimensions()).toEqual({ cols: 90, rows: 30 });
  });
});

describe("PtyTerminal: espera a CLI conectar no MCP antes da primeira mensagem", () => {
  it("a fila só anda depois do tools/list (fica 'starting'); o que alguém digita no terminal passa direto, e a ordem da fila se mantém", async () => {
    const { gate, waits } = manualGate();
    const { terminal, events } = await setup({ waitForTools: gate });
    const output: string[] = [];
    terminal.onOutput((data) => output.push(data));
    terminal.send("primeira", "t1");
    terminal.send("segunda", "t2");
    await until(() => stripAnsi(output.join("")).includes("❯"), 6000, "prompt da CLI");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(waits).toHaveLength(1);
    expect(terminal.status()).toBe("starting");
    expect(events.some((event) => event.type === "turn_start")).toBe(false);

    // Digitado no terminal (navegador ou Remote Control): não espera o MCP.
    terminal.write("oi do terminal\r");
    await until(() => turnEnd(events, undefined), 6000, "turn_end sem tag");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.some((event) => event.type === "turn_start" && event.tag !== undefined)).toBe(false);

    waits[0]!.settle("ready");
    await until(() => turnEnd(events, "t2"), 8000, "turn_end t2");
    expect(events.filter((event) => event.type === "turn_start")).toEqual([
      { type: "turn_start", prompt: "oi do terminal" },
      { type: "turn_start", tag: "t1" },
      { type: "turn_start", tag: "t2" },
    ]);
    expect(terminal.status()).toBe("idle");
    expect(events.some((event) => event.type === "raw" && event.text.includes("MCP"))).toBe(false);
  });

  it("sem conexão a tempo: manda assim mesmo, com um aviso", async () => {
    const { gate, waits } = manualGate();
    const { terminal, events } = await setup({ waitForTools: gate });
    terminal.send("vai assim mesmo", "t1");
    await until(() => waits.length === 1, 6000, "espera armada");
    waits[0]!.settle("timeout");
    await until(() => turnEnd(events, "t1"), 8000, "turn_end t1");
    expect(events.some((event) => event.type === "raw" && event.text.includes("não conectou no MCP do escritório a tempo"))).toBe(true);
  });

  it("cada subida espera de novo (parado por ociosidade e de volta); parar no meio da espera desiste dela", async () => {
    const { gate, waits } = manualGate();
    const { terminal, events } = await setup({ waitForTools: gate, keepAlive: () => false, idleMs: 150 });
    terminal.send("primeira", "a");
    await until(() => waits.length === 1, 6000, "primeira espera");
    waits[0]!.settle("ready");
    await until(() => turnEnd(events, "a"), 8000, "turn_end a");
    await until(() => terminal.status() === "stopped", 6000, "parar por ociosidade");

    terminal.send("depois da ociosidade", "b");
    await until(() => waits.length === 2, 6000, "segunda espera");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turnEnd(events, "b")).toBeUndefined();
    waits[1]!.settle("ready");
    await until(() => turnEnd(events, "b"), 8000, "turn_end b");

    await until(() => terminal.status() === "stopped", 6000, "parar de novo");
    await terminal.ensureRunning();
    expect(waits).toHaveLength(3);
    await terminal.stop("Parado pelo usuário");
    expect(waits[2]!.cancelled).toBe(true);
  }, 20_000);
});

describe("ajudas do terminal interativo", () => {
  it("bracketedPaste tira ESC e caracteres de controle (nada de sequência escondida)", () => {
    expect(bracketedPaste("oi\x1b[201~\x07 tudo\r\nbem")).toBe("\x1b[200~oi[201~ tudo\nbem\x1b[201~");
  });

  it("promptMatches compara o começo, ignorando espaços", () => {
    expect(promptMatches("Pedido 1:  faça\nisso agora", "Pedido 1: faça isso agora")).toBe(true);
    expect(promptMatches("outra coisa", "Pedido 1: faça")).toBe(false);
  });

  it("stripAnsi tira cores e movimentos de cursor (o avanço do cursor vira espaço)", () => {
    expect(stripAnsi("\x1b[2K\r\x1b[38;5;12m❯\x1b[0m oi\x1b]0;título\x07")).toBe("\r❯ oi");
    expect(stripAnsi("Yes,\x1b[1CI\x1b[2Ctrust")).toBe("Yes, I  trust");
  });
});
