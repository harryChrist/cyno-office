import type { UsageHistoryGroup, UsageTotals } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  barSegments,
  chartRange,
  chartSeries,
  costShares,
  formatMoney,
  niceMax,
  parseRate,
  periodKey,
  periodRange,
  periodTitle,
  shiftPeriod,
  spendInsights,
  todayKey,
} from "./spendView";

const totals = (patch: Partial<UsageTotals> = {}): UsageTotals => ({
  turns: 10,
  measuredTurns: 10,
  unmeasuredTurns: 0,
  inputTokens: 1000,
  outputTokens: 1000,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 2000,
  costUsd: 10,
  costBrl: 55,
  costByType: { input: 1, output: 1, cacheRead: 1, cacheWrite: 7, webSearch: 0 },
  unpricedTurns: 0,
  unpricedTokens: 0,
  cacheHitRatio: 0.9,
  durationMs: 0,
  ...patch,
});

const group = (key: string, label: string, cost: number, stack?: { key: string; label: string; costUsd: number }[]): UsageHistoryGroup => ({
  key,
  label,
  totals: totals({ costUsd: cost }),
  ...(stack ? { stack: stack.map((part) => ({ ...part, costBrl: 0, totalTokens: 1, turns: 1 })) } : {}),
});

describe("períodos da página Gastos", () => {
  it("hoje em São Paulo, mesmo de madrugada em UTC", () => {
    expect(todayKey(new Date("2026-11-11T02:30:00.000Z"))).toBe("2026-11-10");
  });

  it("dia, semana (segunda a domingo) e mês, e a navegação entre eles", () => {
    expect(periodRange("2026-11-10", "day")).toEqual({ from: "2026-11-10", to: "2026-11-10" });
    expect(periodRange("2026-11-15", "week")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(periodRange("2026-02-10", "month")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(shiftPeriod("2026-11-10", "week", -1)).toBe("2026-11-02");
    expect(shiftPeriod("2026-01-31", "month", -1)).toBe("2025-12-01");
    expect(chartRange("2026-11-10", "day")).toEqual({ from: "2026-10-28", to: "2026-11-10" });
    expect(chartRange("2026-11-10", "month")).toEqual({ from: "2025-12-01", to: "2026-11-30" });
    expect(periodKey("2026-11-15", "week")).toBe("2026-11-09");
    expect(periodTitle("2026-11-10", "day")).toBe("terça, 10/11/2026");
    expect(periodTitle("2026-11-10", "week")).toBe("09/11 – 15/11/2026");
    expect(periodTitle("2026-11-10", "month")).toBe("novembro de 2026");
  });
});

describe("dinheiro e cotação", () => {
  it("formata em BRL/USD e mostra '< R$ 0,01' para centavos de fração", () => {
    expect(formatMoney(12.345, "BRL").replace(/\s/g, " ")).toBe("R$ 12,35");
    expect(formatMoney(2.5, "USD").replace(/\s/g, " ")).toBe("US$ 2,50");
    expect(formatMoney(0.001, "BRL").replace(/\s/g, " ")).toBe("< R$ 0,01");
    expect(formatMoney(0, "BRL").replace(/\s/g, " ")).toBe("R$ 0,00");
  });

  it("lê a cotação com vírgula ou ponto e recusa o inválido", () => {
    expect(parseRate("5,51")).toBe(5.51);
    expect(parseRate(" 5.6 ")).toBe(5.6);
    expect(parseRate("R$ 5,4")).toBe(5.4);
    expect(parseRate("0")).toBeNull();
    expect(parseRate("abc")).toBeNull();
  });
});

describe("gráfico", () => {
  it("as 7 séries mais caras do intervalo têm cor fixa; o resto vira Outros", () => {
    const parts = Array.from({ length: 9 }, (_, index) => ({ key: `a${index}`, label: `A${index}`, costUsd: 9 - index }));
    const groups = [group("2026-11-09", "09/11", 45, parts), group("2026-11-10", "10/11", 1, [{ key: "a8", label: "A8", costUsd: 1 }])];
    const series = chartSeries(groups);
    expect(series.map((item) => [item.key, item.slot])).toEqual([
      ["a0", 1],
      ["a1", 2],
      ["a2", 3],
      ["a3", 4],
      ["a4", 5],
      ["a5", 6],
      ["a6", 7],
      ["_outros", 0],
    ]);
    expect(barSegments(groups[1]!, series)).toEqual([{ key: "_outros", label: "Outros", slot: 0, value: 1 }]);
    expect(barSegments(groups[0]!, series).at(-1)).toEqual({ key: "_outros", label: "Outros", slot: 0, value: 2 + 1 });
  });

  it("topo redondo do eixo", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7.3)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(0.42)).toBe(0.5);
  });
});

describe("onde melhorar", () => {
  it("custo por tipo, maior primeiro, e dicas do que mais pesa", () => {
    const period = totals();
    expect(costShares(period).map((share) => share.key)).toEqual(["cacheWrite", "input", "output", "cacheRead"]);
    const models = [group("claude-opus-5-5", "Claude Opus 5.5", 8), group("claude-sonnet-5-5", "Claude Sonnet 5.5", 2)];
    const agents = [group("eco", "Eco", 6), group("radar", "Radar", 4)];
    const tips = spendInsights(period, agents, models);
    expect(tips).toHaveLength(3);
    expect(tips.some((tip) => tip.startsWith("Gravar no cache é 70% do custo"))).toBe(true);
    expect(tips.some((tip) => tip.startsWith("Claude Opus 5.5 responde por 80%"))).toBe(true);
    expect(tips.some((tip) => tip.startsWith("Eco gastou 60%"))).toBe(true);
    expect(spendInsights(totals({ unmeasuredTurns: 2, unpricedTurns: 1, costByType: { input: 5, output: 3, cacheRead: 2, cacheWrite: 0, webSearch: 0 } }), [], [])).toEqual([
      '1 turno de modelo sem preço na tabela ficou fora do custo ("sem preço").',
      "2 turnos vieram sem contagem de tokens (a CLI não informou): contam como turno, sem custo.",
    ]);
  });
});
