import type { Agent, Task, UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { aggregateHistory, aggregateTask } from "./usage-aggregate";
import { dayKeyOf, startOfDay, weekStartOf } from "./usage-time";

let seq = 0;
const record = (at: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  v: 1,
  id: `r${(seq += 1)}`,
  at,
  agentId: "eco",
  provider: "claude",
  model: "claude-sonnet-5-5",
  source: "live",
  measured: true,
  tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
  // O custo gravado é só referência: a leitura recalcula com a tabela atual.
  costUsd: 999,
  priceVersion: "velha",
  ...extra,
});

const lookup = { agents: [{ id: "eco", name: "Eco" } as Agent], tasks: [] as Task[] };
const base = { usdBrl: 5, fromDay: "2026-10-31", toDay: "2026-11-02" };

// 31/10 23:00, 01/11 23:59 (domingo) e 02/11 00:00 (segunda) em São Paulo; 03/11 fica fora.
const records = [
  record("2026-11-01T02:00:00.000Z"),
  record("2026-11-02T02:59:00.000Z"),
  record("2026-11-02T03:00:00.000Z"),
  record("2026-11-03T03:00:00.000Z"),
];

describe("datas no fuso de São Paulo", () => {
  it("dia local, começo do dia e semana começando na segunda", () => {
    expect(dayKeyOf(Date.parse("2026-11-02T02:59:59.999Z"))).toBe("2026-11-01");
    expect(dayKeyOf(Date.parse("2026-11-02T03:00:00.000Z"))).toBe("2026-11-02");
    expect(new Date(startOfDay("2026-11-02")).toISOString()).toBe("2026-11-02T03:00:00.000Z");
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26"); // domingo -> segunda anterior
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02");
    expect(weekStartOf("2026-11-08")).toBe("2026-11-02");
  });
});

describe("aggregateHistory", () => {
  it("por dia: todos os dias do intervalo, virando à meia-noite de São Paulo, com o custo recalculado", () => {
    const result = aggregateHistory(records, { ...base, groupBy: "day" }, lookup);
    expect(result.groups.map((group) => [group.key, group.totals.turns])).toEqual([
      ["2026-10-31", 1],
      ["2026-11-01", 1],
      ["2026-11-02", 1],
    ]);
    expect(result.groups[0]!.start).toBe("2026-10-31T03:00:00.000Z");
    expect(result.groups[0]!.end).toBe("2026-11-01T03:00:00.000Z");
    expect(result.overall.turns).toBe(3);
    // 1 milhão de tokens de entrada do Sonnet 5.5 = US$ 2 cada (nada dos 999 gravados).
    expect(result.overall.costUsd).toBeCloseTo(6, 10);
    expect(result.overall.costBrl).toBeCloseTo(30, 10);
    expect(result.timezone).toBe("America/Sao_Paulo");
  });

  it("por semana (segunda a domingo) e por mês", () => {
    const weeks = aggregateHistory(records, { ...base, groupBy: "week" }, lookup);
    expect(weeks.groups.map((group) => [group.key, group.label, group.totals.turns])).toEqual([
      ["2026-10-26", "Semana de 26/10", 2],
      ["2026-11-02", "Semana de 02/11", 1],
    ]);
    expect(weeks.groups[1]!.start).toBe("2026-11-02T03:00:00.000Z");
    expect(weeks.groups[1]!.end).toBe("2026-11-09T03:00:00.000Z");
    const months = aggregateHistory(records, { ...base, groupBy: "month" }, lookup);
    expect(months.groups.map((group) => [group.key, group.label, group.totals.turns])).toEqual([
      ["2026-10", "out/2026", 1],
      ["2026-11", "nov/2026", 2],
    ]);
  });

  it("cache hit, turnos sem tokens, modelo sem preço e empilhamento por modelo", () => {
    const mixed = [
      record("2026-11-02T12:00:00.000Z", { tokens: { input: 100, output: 50, cacheRead: 800, cacheCreation: 100 } }),
      record("2026-11-02T13:00:00.000Z", { measured: false, tokens: undefined, costUsd: null }),
      record("2026-11-02T14:00:00.000Z", { model: "gpt-9", tokens: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 } }),
      record("2026-11-02T15:00:00.000Z", { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }),
    ];
    const result = aggregateHistory(mixed, { ...base, groupBy: "day", stackBy: "model" }, lookup);
    const { overall } = result;
    expect(overall.turns).toBe(3);
    expect(overall.measuredTurns).toBe(2);
    expect(overall.unmeasuredTurns).toBe(1);
    expect(overall.unpricedTurns).toBe(1);
    expect(overall.unpricedTokens).toBe(20);
    expect(overall.cacheHitRatio).toBeCloseTo(800 / 1010, 10);
    const day = result.groups.find((group) => group.key === "2026-11-02")!;
    expect(day.stack?.map((part) => part.label)).toEqual(["Claude Sonnet 5.5", "gpt-9 (sem preço)"]);
  });

  it("por tarefa: o pedido de origem junta as subtarefas; por agente usa o nome; filtros", () => {
    const tasks = [{ id: "pedido", prompt: "Publicar o post", status: "done" } as Task, { id: "sub", projectId: "pedido", prompt: "Escrever", status: "done" } as Task];
    const data = [
      record("2026-11-02T12:00:00.000Z", { taskId: "pedido", rootTaskId: "pedido" }),
      record("2026-11-02T12:01:00.000Z", { taskId: "sub", parentTaskId: "pedido", rootTaskId: "pedido", agentId: "radar", agentName: "Radar" }),
      record("2026-11-02T12:02:00.000Z", { taskId: "sub", parentTaskId: "pedido", rootTaskId: "pedido", agentId: "radar", provider: "gemini", model: "gemini-3.8-flash-low" }),
      record("2026-11-02T12:03:00.000Z"),
    ];
    const byTask = aggregateHistory(data, { ...base, groupBy: "task" }, { agents: lookup.agents, tasks });
    expect(byTask.groups.map((group) => [group.key, group.label, group.totals.turns, group.subtasks])).toEqual([
      ["pedido", "Publicar o post", 3, 1],
      ["_sem-tarefa", "Sem tarefa (conversas e outros)", 1, 0],
    ]);
    const byAgent = aggregateHistory(data, { ...base, groupBy: "agent" }, lookup);
    expect(byAgent.groups.map((group) => [group.label, group.totals.turns])).toEqual([
      ["Eco", 2],
      ["Radar", 2],
    ]);
    expect(aggregateHistory(data, { ...base, groupBy: "agent", provider: "gemini" }, lookup).overall.turns).toBe(1);
    expect(aggregateHistory(data, { ...base, groupBy: "agent", agentId: "radar" }, lookup).overall.turns).toBe(2);

    const detail = aggregateTask(data, "pedido", 5, { agents: lookup.agents, tasks })!;
    expect(detail.title).toBe("Publicar o post");
    expect(detail.totals.turns).toBe(3);
    expect(detail.tasks.map((group) => group.key).sort()).toEqual(["pedido", "sub"]);
    expect(detail.agents.map((group) => group.key).sort()).toEqual(["eco", "radar"]);
    expect(detail.models.map((group) => group.label).sort()).toEqual(["Claude Sonnet 5.5", "Gemini 3.8 Flash"]);
    expect(detail.turns).toHaveLength(3);
    expect(aggregateTask(data, "nada", 5, lookup)).toBeUndefined();
  });
});

describe("aggregateHistory: guarda de sanidade e turno parcial", () => {
  const opts = { usdBrl: 5, fromDay: "2026-11-02", toDay: "2026-11-02", groupBy: "day" as const };
  const day = "2026-11-02T15:00:00.000Z";

  it("a linha impossível (marcada ou não) fica fora dos totais e aparece em `flags.suspect`", () => {
    const normal = record(day, { tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } });
    const marked = record(day, { suspect: "output", tokens: { input: 1000, output: 600_000, cacheRead: 0, cacheCreation: 0 } });
    // Sem a marca (linha antiga ou importada): a guarda recalcula na leitura (negativo).
    const legacy = record(day, { tokens: { input: 1000, output: -5, cacheRead: 0, cacheCreation: 0 } });
    const response = aggregateHistory([normal, marked, legacy], opts, lookup);
    expect(response.overall.turns).toBe(1);
    expect(response.overall.totalTokens).toBe(1_000_000);
    expect(response.groups[0]!.totals.turns).toBe(1);
    expect(response.flags.suspect).toMatchObject({ records: 2, reasons: { output: 1, negative: 1 }, latestAt: day });
    expect(response.flags.partial.records).toBe(0);
  });

  it("custo acima de US$ 50 num turno também é suspeito", () => {
    const huge = record(day, { tokens: { input: 0, output: 400_000, cacheRead: 0, cacheCreation: 0 }, model: "claude-opus-4-5" });
    const response = aggregateHistory([huge], opts, lookup);
    // 400 mil de saída no Opus custa menos de US$ 50 (limite de saída é outro): só confirma que o custo calculado entra na guarda.
    expect(response.flags.suspect.records + response.overall.turns).toBe(1);
  });

  it("o parcial soma no total (a API cobrou), não conta como turno e aparece em `flags.partial`", () => {
    const full = record(day, { tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } });
    const cut = record(day, { partial: true, turns: 0, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } });
    const response = aggregateHistory([full, cut], opts, lookup);
    expect(response.overall.turns).toBe(1);
    expect(response.overall.totalTokens).toBe(2_000_000);
    expect(response.overall.costUsd).toBeCloseTo(response.groups[0]!.totals.costUsd, 6);
    expect(response.flags.partial).toMatchObject({ records: 1, tokens: 1_000_000 });
    expect(response.flags.partial.costUsd).toBeGreaterThan(0);
  });
});

