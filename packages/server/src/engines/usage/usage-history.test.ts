import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, Task, UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { pickModel, taskTitleOf, UsageHistory } from "./usage-history";

const tempDir = useTempDirs();
const log = { warn: () => undefined };

const agent = (id: string, model?: string): Agent => ({ id, name: id.toUpperCase(), ...(model ? { model } : {}) }) as Agent;
const task = (id: string, projectId?: string): Task =>
  ({ id, roomId: "r", teamId: "t", prompt: `Pedido ${id}\ncom duas linhas`, status: "in_progress", createdAt: "", updatedAt: "", ...(projectId ? { projectId } : {}) }) as Task;

async function setup(now: { value: Date }, agents: Agent[] = [], tasks: Task[] = []) {
  const dir = path.join(await tempDir(), "usage");
  const history = new UsageHistory({ dir, queue: new WriteQueue(), agents: () => agents, tasks: () => tasks, log, now: () => now.value });
  return { dir, history };
}

const lines = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as UsageRecord);

describe("UsageHistory: arquivo JSONL por mês", () => {
  it("grava uma linha por turno no arquivo do mês no fuso de São Paulo (vira o mês às 03:00 UTC)", async () => {
    const now = { value: new Date("2026-11-01T02:30:00.000Z") }; // ainda 31/10 em São Paulo
    const { dir, history } = await setup(now, [agent("eco", "sonnet")]);
    history.observe("eco", "claude", { type: "turn_start", tag: "x" });
    history.observe("eco", "claude", { type: "turn_end", ok: true, result: "", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 } });
    now.value = new Date("2026-11-01T03:00:00.000Z"); // 00:00 de 01/11 em São Paulo
    history.observe("eco", "claude", { type: "turn_end", ok: true, result: "" });
    await history.idle();
    expect((await readdir(dir)).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
    const [october] = await lines(path.join(dir, "2026-10.jsonl"));
    expect(october).toMatchObject({
      v: 1,
      at: "2026-11-01T02:30:00.000Z",
      agentId: "eco",
      agentName: "ECO",
      provider: "claude",
      model: "sonnet",
      modelSource: "config",
      source: "live",
      measured: true,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      channel: "other",
      durationMs: 0,
      priceVersion: expect.any(String),
    });
    expect(october!.costUsd).toBeGreaterThan(0);
    const [november] = await lines(path.join(dir, "2026-11.jsonl"));
    // Turno sem tokens: conta como turno, sem custo.
    expect(november).toMatchObject({ measured: false, costUsd: null });
    expect(november!.tokens).toBeUndefined();
    // Leitura por intervalo (o fim é exclusivo) e só o que mudou é relido.
    expect(await history.read(Date.parse("2026-11-01T03:00:00.000Z"))).toHaveLength(1);
    expect(await history.read()).toHaveLength(2);
  });

  it("liga o turno à tarefa (e ao pedido de origem), à sessão e ao modelo que a CLI relatou", async () => {
    const now = { value: new Date("2026-11-10T15:00:00.000Z") };
    const tasks = [task("pedido"), task("sub", "pedido")];
    const { dir, history } = await setup(now, [agent("eco", "sonnet")], tasks);
    history.observe("eco", "claude", { type: "session", sessionId: "s-1", model: "claude-sonnet-5-5" });
    history.observe("eco", "claude", { type: "turn_start", tag: "sub" });
    now.value = new Date("2026-11-10T15:00:05.000Z");
    // Nota injetada: só tokens (não conta turno), na tarefa do turno em curso.
    history.observe("eco", "claude", { type: "turn_partial", usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    history.observe("eco", "claude", {
      type: "turn_end",
      tag: "sub",
      ok: true,
      result: "",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 30,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 30,
        models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
        durationMs: 4200,
      },
    });
    await history.idle();
    const [partial, end] = await lines(path.join(dir, "2026-11.jsonl"));
    expect(partial).toMatchObject({ turns: 0, taskId: "sub", measured: true });
    expect(end).toMatchObject({
      taskId: "sub",
      taskTitle: "Pedido sub",
      parentTaskId: "pedido",
      rootTaskId: "pedido",
      channel: "task",
      sessionId: "s-1",
      model: "claude-sonnet-5-5",
      modelSource: "cli",
      durationMs: 4200,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 30, cacheCreation5m: 0, cacheCreation1h: 30 },
    });
    expect(end!.turns).toBeUndefined();
    // 10×2 + 20×10 + 30×4 (1 h) = 340 por milhão
    expect(end!.costUsd).toBeCloseTo(0.00034, 10);
  });

  it("ignora linhas quebradas na leitura", async () => {
    const now = { value: new Date("2026-11-10T15:00:00.000Z") };
    const { dir, history } = await setup(now);
    history.observe("eco", "gemini", { type: "turn_end", ok: true, result: "" });
    await history.idle();
    const file = path.join(dir, "2026-11.jsonl");
    await writeFile(file, `${await readFile(file, "utf8")}{quebrado\n{"id":"x"}\n`);
    expect(await history.read()).toHaveLength(1);
  });

  it("pickModel: o da CLI (o da sessão se vieram vários), senão o da sessão, senão o configurado", () => {
    expect(pickModel(["claude-haiku-5-5"], "claude-opus-5-5", "opus")).toEqual({ model: "claude-haiku-5-5", modelSource: "cli" });
    expect(pickModel(["claude-haiku-5-5", "claude-opus-5-5"], "claude-opus-5-5", "opus")).toEqual({ model: "claude-opus-5-5", modelSource: "cli" });
    expect(pickModel(undefined, "gemini-3.8-flash-low", undefined)).toEqual({ model: "gemini-3.8-flash-low", modelSource: "cli" });
    expect(pickModel([], undefined, "opus")).toEqual({ model: "opus", modelSource: "config" });
    expect(pickModel(undefined, undefined, undefined)).toEqual({});
  });
});

describe("taskTitleOf", () => {
  it("usa só a primeira linha do pedido (título), sem emendar a descrição", () => {
    expect(taskTitleOf({ prompt: "Slogan para a pizzaria Forno Azul\n\nEscrever um slogan curto (até 8 palavras)" })).toBe("Slogan para a pizzaria Forno Azul");
    expect(taskTitleOf({ prompt: "\n  Só   o   título  " })).toBe("Só o título");
    expect(taskTitleOf({ prompt: "x".repeat(200) })).toHaveLength(120);
  });
});

describe("UsageHistory: turno cortado (parcial) e guarda de sanidade", () => {
  const usage = { inputTokens: 10, outputTokens: 47, cacheReadTokens: 500, cacheCreationTokens: 40 };

  it("turn_cut grava uma linha `partial` (turns 0) com o uso parcial; o mesmo corte visto duas vezes grava uma só", async () => {
    const now = { value: new Date("2026-11-10T15:00:00.000Z") };
    const { dir, history } = await setup(now, [agent("eco", "sonnet")], [task("t1")]);
    history.observe("eco", "claude", { type: "turn_start", tag: "t1" });
    history.observe("eco", "claude", { type: "turn_cut", tag: "t1", usage, reason: "Parado" });
    history.observe("eco", "claude", { type: "turn_cut", tag: "t1", usage, reason: "Parado" });
    await history.idle();
    const rows = await lines(path.join(dir, "2026-11.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partial: true, turns: 0, measured: true, taskId: "t1", tokens: { input: 10, output: 47, cacheRead: 500, cacheCreation: 40 } });
  });

  it("turno retomado depois da queda: o corte e o turno final são linhas diferentes (cada um é uma chamada cobrada), sem dobrar o corte", async () => {
    const now = { value: new Date("2026-11-10T15:00:00.000Z") };
    const { dir, history } = await setup(now, [agent("eco", "sonnet")], [task("t1")]);
    history.observe("eco", "claude", { type: "turn_start", tag: "t1" });
    history.observe("eco", "claude", { type: "turn_cut", tag: "t1", usage, reason: "caiu" });
    now.value = new Date("2026-11-10T15:00:30.000Z");
    // A retomada começa de novo (turn_start com outro instante) e fecha com o result dela.
    history.observe("eco", "claude", { type: "turn_start", tag: "t1" });
    history.observe("eco", "claude", { type: "turn_end", tag: "t1", ok: true, result: "", usage: { ...usage, outputTokens: 200 } });
    await history.idle();
    const rows = await lines(path.join(dir, "2026-11.jsonl"));
    expect(rows.map((row) => [row.partial === true, row.turns ?? 1, row.tokens?.output])).toEqual([
      [true, 0, 47],
      [false, 1, 200],
    ]);
  });

  it("valor impossível é gravado com `suspect` (não se perde dado)", async () => {
    const now = { value: new Date("2026-11-10T15:00:00.000Z") };
    const { dir, history } = await setup(now, [agent("eco", "sonnet")]);
    history.observe("eco", "claude", { type: "turn_start", tag: "x" });
    history.observe("eco", "claude", { type: "turn_end", ok: true, result: "", usage: { inputTokens: 1, outputTokens: 600_000, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    history.observe("eco", "claude", { type: "turn_end", ok: true, result: "", usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    await history.idle();
    const rows = await lines(path.join(dir, "2026-11.jsonl"));
    expect(rows[0]).toMatchObject({ suspect: "output", measured: true });
    expect(rows[1]!.suspect).toBeUndefined();
  });
});

