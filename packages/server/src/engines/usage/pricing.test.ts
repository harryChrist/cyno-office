import { describe, expect, it } from "vitest";
import { computeCost, PRICE_TABLE, parsePriceTable, resolveModel } from "./pricing";

const AT = "2026-11-10T12:00:00.000Z";
const tokens = (input: number, output: number, cacheRead = 0, cacheCreation = 0, split?: { m5: number; h1: number }) => ({
  input,
  output,
  cacheRead,
  cacheCreation,
  ...(split ? { cacheCreation5m: split.m5, cacheCreation1h: split.h1 } : {}),
});

describe("tabela de preços", () => {
  it("carrega o prices.json com fonte e data de conferência", () => {
    expect(PRICE_TABLE.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.values(PRICE_TABLE.sources).join(" ")).toContain("platform.claude.com/docs/en/about-claude/pricing");
    expect(Object.values(PRICE_TABLE.sources).join(" ")).toContain("ai.google.dev/gemini-api/docs/pricing");
    // Todo alias aponta para um modelo da tabela.
    for (const target of Object.values(PRICE_TABLE.aliases)) expect(PRICE_TABLE.models[target]).toBeDefined();
  });

  it("resolve aliases, [1m], data, prefixo de nuvem e o nível de esforço do nome", () => {
    expect(resolveModel("opus")?.id).toBe("claude-opus-5-5");
    expect(resolveModel("sonnet")?.id).toBe("claude-sonnet-5-5");
    expect(resolveModel("claude-opus-5-5[1m]")?.id).toBe("claude-opus-5-5");
    expect(resolveModel("claude-opus-4-1-20250805")?.id).toBe("claude-opus-4-1");
    expect(resolveModel("anthropic.claude-sonnet-4-5")?.id).toBe("claude-sonnet-4-5");
    expect(resolveModel("claude-opus-5-5-high")?.id).toBe("claude-opus-5-5");
    expect(resolveModel("gemini-3.8-flash-low")).toEqual({ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini" });
    expect(resolveModel("gpt-oss-120b-medium")).toBeUndefined();
    expect(resolveModel(undefined)).toBeUndefined();
  });
});

describe("computeCost", () => {
  it("soma entrada, saída, cache lido e cache gravado com 5 min e 1 h pelo preço de cada um", () => {
    const cost = computeCost({ model: "claude-opus-5-5", at: AT, tokens: tokens(1000, 2000, 10_000, 3000, { m5: 1000, h1: 2000 }) });
    // 1000×4 + 2000×20 + 10000×0,2 + 1000×5 + 2000×8 = 67000 por milhão
    expect(cost.usd).toBeCloseTo(0.067, 10);
    expect(cost.byType.input).toBeCloseTo(0.004, 10);
    expect(cost.byType.output).toBeCloseTo(0.04, 10);
    expect(cost.byType.cacheRead).toBeCloseTo(0.002, 10);
    expect(cost.byType.cacheWrite).toBeCloseTo(0.021, 10);
    expect(cost.model?.label).toBe("Claude Opus 5.5");
  });

  it("cache gravado sem a separação por validade vai pelo preço de 5 min", () => {
    const cost = computeCost({ model: "opus", at: AT, tokens: tokens(1000, 2000, 10_000, 3000) });
    expect(cost.usd).toBeCloseTo(0.061, 10);
  });

  it("modelo desconhecido ou turno sem tokens: custo null (sem preço), nunca um chute", () => {
    expect(computeCost({ model: "gpt-9", at: AT, tokens: tokens(1000, 1000) }).usd).toBeNull();
    expect(computeCost({ model: undefined, at: AT, tokens: tokens(1000, 1000) }).usd).toBeNull();
    expect(computeCost({ model: "sonnet", at: AT }).usd).toBeNull();
  });

  it("modo rápido: entrada/saída do modo rápido e o cache na mesma proporção", () => {
    const cost = computeCost({ model: "claude-opus-5-5", at: AT, speed: "fast", tokens: tokens(1_000_000, 1_000_000, 1_000_000) });
    expect(cost.byType.input).toBeCloseTo(8, 10);
    expect(cost.byType.output).toBeCloseTo(40, 10);
    expect(cost.byType.cacheRead).toBeCloseTo(0.4, 10);
    // Modelo sem modo rápido na tabela: preço normal.
    expect(computeCost({ model: "claude-sonnet-5-5", at: AT, speed: "fast", tokens: tokens(1_000_000, 0) }).usd).toBeCloseTo(2, 10);
  });

  it("Haiku 5.5: prompt de uma chamada acima de 100 mil tokens paga a faixa maior", () => {
    const usage = tokens(150_000, 0);
    expect(computeCost({ model: "haiku", at: AT, tokens: usage }).usd).toBeCloseTo(0.015, 10);
    expect(computeCost({ model: "haiku", at: AT, tokens: usage, promptTokens: 150_000 }).usd).toBeCloseTo(0.075, 10);
    expect(computeCost({ model: "haiku", at: AT, tokens: usage, promptTokens: 100_000 }).usd).toBeCloseTo(0.015, 10);
  });

  it("Gemini: cache lido pelo preço de cache e o preço que valia no dia do turno", () => {
    const usage = tokens(1_000_000, 1_000_000, 1_000_000);
    expect(computeCost({ model: "gemini-3.8-flash-high", at: "2026-12-31T23:00:00.000Z", tokens: usage }).usd).toBeCloseTo(0.75 + 3.75 + 0.075, 10);
    expect(computeCost({ model: "gemini-3.8-flash-high", at: "2027-01-01T10:00:00.000Z", tokens: usage }).usd).toBeCloseTo(1.5 + 7.5 + 0.15, 10);
    expect(computeCost({ model: "gemini-4-argon", at: "2026-11-30T12:00:00.000Z", tokens: tokens(1_000_000, 0) }).usd).toBeCloseTo(2, 10);
    expect(computeCost({ model: "gemini-4-argon", at: "2026-12-01T12:00:00.000Z", tokens: tokens(1_000_000, 0) }).usd).toBeCloseTo(4, 10);
  });

  it("buscas na web do Claude: US$ 10 a cada mil", () => {
    const cost = computeCost({ model: "sonnet", at: AT, tokens: tokens(0, 0), webSearches: 3 });
    expect(cost.byType.webSearch).toBeCloseTo(0.03, 10);
  });

  it("uma tabela corrigida vale para o passado (o custo é calculado na hora)", () => {
    const fixed = parsePriceTable({ ...PRICE_TABLE, models: { ...PRICE_TABLE.models, "claude-opus-5-5": { ...PRICE_TABLE.models["claude-opus-5-5"]!, prices: [{ input: 1, output: 1, cacheRead: 1 }] } } });
    expect(computeCost({ model: "opus", at: "2025-01-01T00:00:00.000Z", tokens: tokens(1_000_000, 0) }, fixed).usd).toBeCloseTo(1, 10);
  });
});
