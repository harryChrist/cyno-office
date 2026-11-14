import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { ClaudeCliAdapter, DEFAULT_AGENT_TOOLS } from "./claude-adapter";
import { ProcessTerminal, type SpawnFn } from "./process-terminal";
import type { TerminalEvent } from "./types";

const tempDir = useTempDirs();

/** Processo falso controlado pelo teste: o que o terminal escreve fica em `inputs`; `say` imprime uma linha JSON. */
class ScriptedChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly inputs: Record<string, unknown>[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) this.inputs.push(JSON.parse(line) as Record<string, unknown>);
      this.emit("input");
    });
    this.stdin.on("finish", () => this.exit(0));
    queueMicrotask(() => this.emit("spawn"));
  }
  say(data: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(data)}\n`);
  }
  text(text: string): void {
    this.say({ type: "assistant", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null });
  }
  result(text: string, queued?: number): void {
    this.say({ type: "result", subtype: "success", is_error: false, result: text, ...(queued === undefined ? {} : { queued_turn_count: queued }) });
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalCode = signal;
    this.exit(null);
    return true;
  }
  private exit(code: number | null): void {
    if (this.exitCode !== null || this.listenerCount("exit") === 0) {
      this.exitCode ??= code ?? 0;
      return;
    }
    this.exitCode = code ?? 0;
    this.emit("exit", code, this.signalCode);
  }
}

async function setup() {
  const dir = await tempDir();
  const cwd = path.join(dir, "agents", "redator");
  const children: ScriptedChild[] = [];
  const spawn: SpawnFn = () => {
    const child = new ScriptedChild();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const terminal = new ProcessTerminal({
    adapter: new ClaudeCliAdapter({ command: "claude-falso" }),
    spec: { agentId: "redator", cwd, systemPrompt: "Você é o Redator.", mcpConfigFile: path.join(cwd, "mcp.json"), tools: DEFAULT_AGENT_TOOLS },
    env: {},
    idleMs: 0,
    maxRetries: 1,
    backoffMs: () => 10,
    stopGraceMs: 200,
    spawn,
  });
  const events: TerminalEvent[] = [];
  terminal.onEvent((event) => events.push(event));
  terminals.push(terminal);
  return { terminal, children, events };
}

const terminals: ProcessTerminal[] = [];
afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.dispose()));
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condição não chegou");
    await tick();
  }
}

describe("ProcessTerminal: nota ao vivo no meio do turno (stream-json com queued_turn_count)", () => {
  it("a nota entra no turno em curso: o result com fila > 0 não fecha o turno; o seguinte (fila 0) fecha com a tag da tarefa", async () => {
    const { terminal, children, events } = await setup();
    terminal.send("Tarefa t1: escreva um post", "t1");
    await until(() => children[0]?.inputs.length === 1);
    const child = children[0]!;
    // A primeira ordem precisa de um turno completo (com queued_turn_count) para o terminal saber que a CLI aceita entrada ao vivo.
    child.result("pronto", 0);
    await until(() => events.some((event) => event.type === "turn_end"));
    terminal.send("Tarefa t2: outra", "t2");
    await until(() => child.inputs.length === 2);
    expect(terminal.status()).toBe("busy");

    expect(terminal.inject("Nota: foca no público jovem")).toBe(true);
    await until(() => child.inputs.length === 3);
    expect(child.inputs[2]).toMatchObject({ type: "user", message: { role: "user", content: "Nota: foca no público jovem" } });

    // A CLI fechou um pedaço e ainda tem a nota na fila: o turno continua (só conta os tokens).
    child.result("parte 1", 1);
    await until(() => events.some((event) => event.type === "turn_partial"));
    expect(terminal.status()).toBe("busy");
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);

    child.text("Ajustei para o público jovem.");
    child.result("feito com a nota", 0);
    await until(() => events.filter((event) => event.type === "turn_end").length === 2);
    expect(events.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({ tag: "t2", result: "feito com a nota", queuedTurns: 0 });
    expect(terminal.status()).toBe("idle");
  });

  it("nota absorvida pela CLI (um result só, fila 0): o turno fecha uma vez", async () => {
    const { terminal, children, events } = await setup();
    terminal.send("primeira", "a");
    await until(() => children[0]?.inputs.length === 1);
    children[0]!.result("ok", 0);
    await until(() => terminal.status() === "idle");
    terminal.send("segunda", "b");
    await until(() => children[0]!.inputs.length === 2);
    expect(terminal.inject("nota")).toBe(true);
    children[0]!.result("absorvi a nota", 0);
    await until(() => events.filter((event) => event.type === "turn_end").length === 2);
    expect(terminal.status()).toBe("idle");
  });

  it("a nota que a CLI deixou para depois do turno vira um turno adotado com a mesma tag", async () => {
    const { terminal, children, events } = await setup();
    terminal.send("primeira", "a");
    await until(() => children[0]?.inputs.length === 1);
    children[0]!.result("ok", 0);
    await until(() => terminal.status() === "idle");
    terminal.send("tarefa", "t9");
    await until(() => children[0]!.inputs.length === 2);
    expect(terminal.inject("nota tardia")).toBe(true);
    // Corrida: o result saiu antes de a CLI ver a nota (fila 0)…
    children[0]!.result("terminei", 0);
    await until(() => terminal.status() === "idle");
    // …e depois ela roda a nota sozinha.
    children[0]!.text("Vi sua nota.");
    await until(() => terminal.status() === "busy");
    expect(events.filter((event) => event.type === "turn_start").at(-1)).toEqual({ type: "turn_start", tag: "t9" });
    children[0]!.result("nota considerada", 0);
    await until(() => events.filter((event) => event.type === "turn_end").length === 3);
    expect(events.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({ tag: "t9", result: "nota considerada" });
  });

  it("CLI que não diz queued_turn_count: nada de nota ao vivo (inject devolve false)", async () => {
    const { terminal, children } = await setup();
    terminal.send("primeira", "a");
    await until(() => children[0]?.inputs.length === 1);
    children[0]!.result("ok");
    await until(() => terminal.status() === "idle");
    terminal.send("segunda", "b");
    await until(() => children[0]!.inputs.length === 2);
    expect(terminal.inject("nota")).toBe(false);
  });

  it("inject fora de um turno devolve false; parar manda o motivo no status stopped", async () => {
    const { terminal, events } = await setup();
    expect(terminal.inject("nota")).toBe(false);
    await terminal.ensureRunning();
    await terminal.stop("Parado pelo usuário");
    expect(events.filter((event) => event.type === "status").at(-1)).toEqual({ type: "status", status: "stopped", reason: "Parado pelo usuário" });
  });
});
