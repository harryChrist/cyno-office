import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { ClaudeCliAdapter, DEFAULT_AGENT_TOOLS } from "./claude-adapter";
import { ProcessTerminal } from "./process-terminal";
import type { ToolsWaitOutcome } from "../../mcp/tokens";
import type { TerminalEvent, ToolsGate } from "./types";

/** CLI falsa (node + script): os testes nunca chamam o `claude` de verdade. */
export const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

const tempDir = useTempDirs();

type Recorder = { events: TerminalEvent[]; waitFor: (predicate: (event: TerminalEvent) => boolean, timeoutMs?: number) => Promise<TerminalEvent> };

function record(terminal: ProcessTerminal): Recorder {
  const events: TerminalEvent[] = [];
  const waiters = new Set<() => void>();
  terminal.onEvent((event) => {
    events.push(event);
    for (const wake of [...waiters]) wake();
  });
  return {
    events,
    waitFor: (predicate, timeoutMs = 5000) =>
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
          reject(new Error(`evento esperado não chegou: ${JSON.stringify(events.slice(-5))}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      }),
  };
}

async function setup(options: { idleMs?: number; maxRetries?: number; env?: NodeJS.ProcessEnv; waitForTools?: ToolsGate } = {}) {
  const dir = await tempDir();
  const cwd = path.join(dir, "agents", "redator");
  const logFile = path.join(dir, "spawns.jsonl");
  const make = () =>
    new ProcessTerminal({
      adapter: new ClaudeCliAdapter({ command: process.execPath, prefixArgs: [FAKE_CLI] }),
      spec: { agentId: "redator", cwd, systemPrompt: "Você é o Redator.", mcpConfigFile: path.join(cwd, "mcp.json"), tools: DEFAULT_AGENT_TOOLS },
      env: { ...process.env, FAKE_CLI_LOG: logFile, FAKE_CLI_STATE: path.join(dir, "fake-state"), ANTHROPIC_API_KEY: "sk-ant-NAO-PODE", ...options.env },
      idleMs: options.idleMs ?? 0,
      maxRetries: options.maxRetries ?? 2,
      backoffMs: () => 10,
      stopGraceMs: 2000,
      ...(options.waitForTools ? { waitForTools: options.waitForTools } : {}),
    });
  const spawns = async () =>
    (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((raw) => JSON.parse(raw) as { argv: string[]; cwd: string; env: Record<string, string> });
  const session = async () => JSON.parse(await readFile(path.join(cwd, "session.json"), "utf8")) as { sessionId: string; started: boolean; provider: string };
  return { dir, cwd, make, spawns, session };
}

const terminals: ProcessTerminal[] = [];
const track = (terminal: ProcessTerminal) => (terminals.push(terminal), terminal);
afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.dispose()));
});

describe("ProcessTerminal + ClaudeCliAdapter (CLI falsa)", () => {
  it("sobe sozinho na primeira ordem, faz o turno e guarda a sessão; sem chave de API no ambiente", async () => {
    const { make, spawns, session, cwd } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("Escreva um haicai", "t1");
    const end = await rec.waitFor((event) => event.type === "turn_end");
    expect(end).toEqual({
      type: "turn_end",
      tag: "t1",
      ok: true,
      result: "eco: Escreva um haicai",
      usage: { inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheCreationTokens: 40 },
      contextTokens: 3050,
    });
    expect(rec.events.map((event) => event.type)).toEqual(expect.arrayContaining(["status", "turn_start", "session", "raw", "text", "turn_end"]));
    expect(rec.events.find((event) => event.type === "raw" && event.text === "linha que não é JSON")).toBeDefined();
    expect(terminal.status()).toBe("idle");
    await terminal.flushSession();
    const saved = await session();
    expect(saved).toMatchObject({ provider: "claude", started: true, sessionId: terminal.sessionId() });
    const [first] = await spawns();
    expect(first!.cwd).toBe(cwd);
    expect(first!.argv).toContain("--session-id");
    expect(first!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(first!.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    await terminal.dispose();
  });

  it("parar e mandar de novo retoma a mesma sessão com --resume (também num terminal novo, como num restart)", async () => {
    const { make, spawns } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("primeira", "a");
    await rec.waitFor((event) => event.type === "turn_end");
    const sessionId = terminal.sessionId();
    await terminal.stop();
    expect(terminal.status()).toBe("stopped");
    terminal.send("segunda", "b");
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "b");
    await terminal.dispose();

    const restarted = track(make());
    const rec2 = record(restarted);
    restarted.send("terceira", "c");
    await rec2.waitFor((event) => event.type === "turn_end" && event.tag === "c");
    expect(restarted.sessionId()).toBe(sessionId);
    const argvs = (await spawns()).map((spawn) => spawn.argv);
    expect(argvs).toHaveLength(3);
    expect(argvs[0]![argvs[0]!.indexOf("--session-id") + 1]).toBe(sessionId);
    expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe(sessionId);
    expect(argvs[2]![argvs[2]!.indexOf("--resume") + 1]).toBe(sessionId);
    await restarted.dispose();
  });

  it("para sozinho quando fica ocioso e a próxima ordem retoma", async () => {
    const { make, spawns } = await setup({ idleMs: 80 });
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("oi", "a");
    await rec.waitFor((event) => event.type === "turn_end");
    await rec.waitFor((event) => event.type === "status" && event.status === "stopped");
    terminal.send("de novo", "b");
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "b");
    const argvs = (await spawns()).map((spawn) => spawn.argv);
    expect(argvs[1]).toContain("--resume");
    await terminal.dispose();
  });

  it("sessão por tarefa: freshSession com histórico para entre turnos e sobe com --session-id novo; o resto da tarefa segue na conversa dela", async () => {
    const { make, spawns, session } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("tarefa A", "a", { freshSession: true });
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "a");
    const first = terminal.sessionId();
    // Mensagem da mesma tarefa (ex.: a decisão de uma aprovação): mesma conversa, mesmo processo.
    terminal.send("decisão da tarefa A", "a");
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "a" && event.result.includes("decisão"));
    expect(terminal.sessionId()).toBe(first);
    expect(await spawns()).toHaveLength(1);

    terminal.send("tarefa B", "b", { freshSession: true });
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "b");
    const second = terminal.sessionId();
    expect(second).not.toBe(first);
    const argvs = (await spawns()).map((spawn) => spawn.argv);
    expect(argvs).toHaveLength(2);
    expect(argvs[1]![argvs[1]!.indexOf("--session-id") + 1]).toBe(second);
    expect(argvs[1]).not.toContain("--resume");
    await terminal.flushSession();
    expect(await session()).toMatchObject({ sessionId: second, started: true, key: "b" });
    await terminal.dispose();
  });

  it("sessão por tarefa: terminal parado não retoma a conversa antiga; a mesma tarefa (reinício, aprovação depois de ocioso) retoma a dela", async () => {
    const { make, spawns } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("tarefa A", "a", { freshSession: true });
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "a");
    const sessionA = terminal.sessionId();
    await terminal.stop();
    // A decisão da aprovação chega depois do processo parar por ociosidade: retoma a conversa da tarefa.
    terminal.send("decisão", "a");
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "a" && event.result.includes("decisão"));
    await terminal.dispose();

    // Server reiniciou e a tarefa A roda de novo (mesma chave): continua a conversa dela.
    const again = track(make());
    const rec2 = record(again);
    again.send("tarefa A de novo", "a", { freshSession: true });
    await rec2.waitFor((event) => event.type === "turn_end" && event.tag === "a");
    expect(again.sessionId()).toBe(sessionA);
    await again.stop();
    // Tarefa nova com o processo parado: conversa nova, sem --resume.
    again.send("tarefa C", "c", { freshSession: true });
    await rec2.waitFor((event) => event.type === "turn_end" && event.tag === "c");
    expect(again.sessionId()).not.toBe(sessionA);
    const argvs = (await spawns()).map((spawn) => spawn.argv);
    expect(argvs.map((argv) => (argv.includes("--resume") ? "resume" : "new"))).toEqual(["new", "resume", "resume", "new"]);
    await again.dispose();
  });

  it("caiu no meio do turno: sobe de novo (retomando) e reenvia a mensagem", async () => {
    const { make, spawns } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("aquece", "a");
    await rec.waitFor((event) => event.type === "turn_end");
    terminal.send("[crash] agora", "b");
    await rec.waitFor((event) => event.type === "status" && event.status === "error");
    const end = await rec.waitFor((event) => event.type === "turn_end" && event.tag === "b");
    expect(end).toMatchObject({ ok: true });
    const argvs = (await spawns()).map((spawn) => spawn.argv);
    expect(argvs).toHaveLength(2);
    expect(argvs[1]).toContain("--resume");
    await terminal.dispose();
  });

  it("sessão salva que a CLI não conhece: começa uma conversa nova", async () => {
    const { make, spawns, dir } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("oi", "a");
    await rec.waitFor((event) => event.type === "turn_end");
    const old = terminal.sessionId();
    await terminal.dispose();
    // A CLI "perdeu" as sessões (ex.: limpeza do ~/.claude).
    const { rm } = await import("node:fs/promises");
    await rm(path.join(dir, "fake-state", "sessions"), { recursive: true, force: true });
    const again = track(make());
    const rec2 = record(again);
    again.send("de novo", "b");
    await rec2.waitFor((event) => event.type === "turn_end" && event.tag === "b");
    expect(again.sessionId()).not.toBe(old);
    const argvs = (await spawns()).map((spawn) => spawn.argv);
    expect(argvs.at(-2)).toContain("--resume");
    expect(argvs.at(-1)).toContain("--session-id");
    await again.dispose();
  });

  it("desiste depois de muitas quedas e descarta as mensagens (dropped)", async () => {
    const { make } = await setup({ maxRetries: 1, env: { FAKE_CLI_STATE: "/dev/null/impossivel" } });
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("oi", "x");
    const dropped = await rec.waitFor((event) => event.type === "dropped");
    expect(dropped).toMatchObject({ tag: "x" });
    expect(terminal.status()).toBe("error");
    await terminal.dispose();
  });

  it("interrupt fecha o turno em curso sem matar o processo", async () => {
    const { make } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("[lento] escreva", "a");
    await rec.waitFor((event) => event.type === "text" && event.text.includes("devagar"));
    terminal.interrupt();
    const end = await rec.waitFor((event) => event.type === "turn_end");
    expect(end).toMatchObject({ tag: "a", ok: false });
    expect(terminal.status()).toBe("idle");
    await terminal.dispose();
    expect(terminal.status()).toBe("stopped");
  });

  it("com a espera do MCP: a primeira mensagem só vai depois do tools/list da subida (status 'starting' até lá), e na ordem", async () => {
    const settles: ((outcome: ToolsWaitOutcome) => void)[] = [];
    const gate: ToolsGate = () => {
      let settle!: (outcome: ToolsWaitOutcome) => void;
      const done = new Promise<ToolsWaitOutcome>((resolve) => (settle = resolve));
      settles.push(settle);
      return { done, cancel: () => settle("cancelled") };
    };
    const { make } = await setup({ waitForTools: gate });
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("primeira", "t1");
    terminal.send("segunda", "t2");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settles).toHaveLength(1);
    expect(terminal.status()).toBe("starting");
    expect(rec.events.some((event) => event.type === "turn_start")).toBe(false);
    settles[0]!("ready");
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "t2");
    expect(rec.events.filter((event) => event.type === "turn_start").map((event) => (event as { tag?: string }).tag)).toEqual(["t1", "t2"]);
    expect(terminal.status()).toBe("idle");
  });

  it("parar com mensagem em curso a descarta (dropped) e o status vira stopped", async () => {
    const { make } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("[lento] escreva", "a");
    await rec.waitFor((event) => event.type === "text");
    await terminal.stop("Parado pelo usuário");
    expect(rec.events).toContainEqual({ type: "dropped", tag: "a", reason: "Parado pelo usuário" });
    expect(terminal.status()).toBe("stopped");
    await terminal.dispose();
  });

  it("turno cortado: parar no meio grava o uso parcial (maior valor por mensagem) como turn_cut, uma vez", async () => {
    const { make } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("[lento] [parcial] escreva", "a");
    await rec.waitFor((event) => event.type === "text" && event.text.includes("devagar"));
    await terminal.stop("Parado pelo usuário");
    const cuts = rec.events.filter((event) => event.type === "turn_cut");
    expect(cuts).toHaveLength(1);
    // m1: saída 40 (não 3 + 40) e m2: 7 -> 47; entrada 5 + 5; cache lido 100 + 400; cache gravado 20 + 20.
    expect(cuts[0]).toMatchObject({ type: "turn_cut", tag: "a", reason: "Parado pelo usuário", usage: { inputTokens: 10, outputTokens: 47, cacheReadTokens: 500, cacheCreationTokens: 40, models: ["claude-haiku-4-5"] } });
    // Sem turn_end (o turno nunca fechou): o corte é a única fonte do gasto.
    expect(rec.events.some((event) => event.type === "turn_end")).toBe(false);
    await terminal.dispose();
  });

  it("turno cortado por queda: grava o parcial da tentativa que caiu e a retomada fecha o turno com o `result` dela (sem somar os dois)", async () => {
    const { make } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("[crash] [parcial] agora", "b");
    const end = await rec.waitFor((event) => event.type === "turn_end" && event.tag === "b");
    const cuts = rec.events.filter((event) => event.type === "turn_cut");
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ tag: "b", usage: { outputTokens: 47 } });
    // O `result` da retomada traz só o uso da segunda tentativa (200 de saída), não 200 + 47.
    expect(end).toMatchObject({ ok: true, usage: { outputTokens: 200 } });
    await terminal.dispose();
  });

  it("turno que fecha normalmente não gera turn_cut, e o turno seguinte não herda a conta do anterior", async () => {
    const { make } = await setup();
    const terminal = track(make());
    const rec = record(terminal);
    terminal.send("um", "a");
    await rec.waitFor((event) => event.type === "turn_end" && event.tag === "a");
    terminal.send("[lento] dois", "b");
    await rec.waitFor((event) => event.type === "text" && event.text.includes("devagar"));
    await terminal.stop("Parado");
    expect(rec.events.some((event) => event.type === "turn_cut")).toBe(false);
    await terminal.dispose();
  });
});
