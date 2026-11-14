import { describe, expect, it } from "vitest";
import {
  agentFieldsFromChoice,
  cleanModelDefaults,
  modelUsesEffort,
  withoutUnusedEffort,
  describeModelChoice,
  engineBlock,
  engineBlockLabel,
  INITIAL_MODEL_DEFAULTS,
  modelDefaultsSchema,
  quotaBlock,
  subagentChoiceFor,
} from "./models";
import type { SubscriptionUsage } from "./usage";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const inOneHour = new Date(NOW + 3600_000).toISOString();
const inTwoHours = new Date(NOW + 7200_000).toISOString();
const anHourAgo = new Date(NOW - 3600_000).toISOString();

const usage = (windows: SubscriptionUsage["windows"], status?: string): SubscriptionUsage => ({
  provider: "claude",
  windows,
  ...(status ? { status } : {}),
  updatedAt: new Date(NOW).toISOString(),
});

describe("modelos padrão", () => {
  it("os iniciais passam no schema", () => {
    expect(modelDefaultsSchema.parse(INITIAL_MODEL_DEFAULTS)).toEqual(INITIAL_MODEL_DEFAULTS);
  });

  it("agentFieldsFromChoice: simulado não leva motor nem modelo", () => {
    expect(agentFieldsFromChoice({ engine: "mock", model: "x" })).toEqual({});
    expect(agentFieldsFromChoice({ engine: "claude", model: "sonnet", effort: "medium" })).toEqual({ engine: "claude", model: "sonnet", effort: "medium" });
  });

  it("subagentChoiceFor: só motores com subagentes", () => {
    expect(subagentChoiceFor(INITIAL_MODEL_DEFAULTS.subagentes, "claude")).toEqual({ model: "sonnet", effort: "medium" });
    expect(subagentChoiceFor(INITIAL_MODEL_DEFAULTS.subagentes, "gemini")?.model).toMatch(/flash/);
    expect(subagentChoiceFor(INITIAL_MODEL_DEFAULTS.subagentes, "mock")).toBeUndefined();
    expect(subagentChoiceFor(undefined, "claude")).toBeUndefined();
  });

  it("describeModelChoice", () => {
    expect(describeModelChoice({ engine: "claude", model: "opus", effort: "high" })).toBe("Claude Code · opus · alto");
    expect(describeModelChoice({ engine: "gemini" })).toBe("Antigravity · padrão da CLI");
    expect(describeModelChoice({ engine: "mock", model: "x" })).toBe("Simulado");
    // Haiku não tem níveis de esforço: não mostrar um esforço que não vale.
    expect(describeModelChoice({ engine: "claude", model: "haiku", effort: "medium" })).toBe("Claude Code · haiku");
  });
});

describe("quotaBlock: cota esgotada", () => {
  it("janela a 100% (ou rejected) bloqueia até o resetsAt", () => {
    expect(quotaBlock(usage([{ id: "five_hour", utilization: 1, resetsAt: inOneHour }]), NOW)).toEqual({ resetsAt: inOneHour });
    expect(quotaBlock(usage([{ id: "five_hour", utilization: 0.5, resetsAt: inOneHour, status: "rejected" }]), NOW)).toEqual({ resetsAt: inOneHour });
  });

  it("duas janelas cheias: volta quando a ÚLTIMA zerar", () => {
    const block = quotaBlock(usage([{ id: "five_hour", utilization: 1, resetsAt: inOneHour }, { id: "seven_day", utilization: 1, resetsAt: inTwoHours }]), NOW);
    expect(block).toEqual({ resetsAt: inTwoHours });
  });

  it("resetsAt já passou: livre (mesmo sem dado novo)", () => {
    expect(quotaBlock(usage([{ id: "five_hour", utilization: 1, resetsAt: anHourAgo }], "rejected"), NOW)).toBeUndefined();
  });

  it("status geral rejected sem janela cheia: vale a janela mais usada", () => {
    expect(quotaBlock(usage([{ id: "five_hour", utilization: 0.97, resetsAt: inOneHour }, { id: "seven_day", utilization: 0.3, resetsAt: inTwoHours }], "rejected"), NOW)).toEqual({ resetsAt: inOneHour });
  });

  it("sem resetsAt conhecido: bloqueado sem hora; uso normal: livre", () => {
    expect(quotaBlock(usage([{ id: "five_hour", utilization: 1 }]), NOW)).toEqual({});
    expect(quotaBlock(usage([{ id: "five_hour", utilization: 0.99, resetsAt: inOneHour, status: "allowed_warning" }], "allowed"), NOW)).toBeUndefined();
    expect(quotaBlock(undefined, NOW)).toBeUndefined();
  });
});

describe("engineBlock", () => {
  const blocked = usage([{ id: "five_hour", utilization: 1, resetsAt: inOneHour }]);

  it("simulado nunca; motor real sem cota: quota; CLI ausente: unavailable", () => {
    expect(engineBlock("mock", { usage: [blocked], now: NOW })).toBeUndefined();
    expect(engineBlock(undefined, { usage: [blocked], now: NOW })).toBeUndefined();
    expect(engineBlock("claude", { usage: [blocked], now: NOW })).toEqual({ reason: "quota", resetsAt: inOneHour });
    expect(engineBlock("gemini", { usage: [blocked], now: NOW })).toBeUndefined();
    const engines = [{ engine: "gemini" as const, label: "Antigravity", available: false, reason: "comando agy não encontrado", models: [], freeModel: false }];
    expect(engineBlock("gemini", { usage: [], engines, now: NOW })).toEqual({ reason: "unavailable", detail: "comando agy não encontrado" });
  });

  it("rótulos", () => {
    expect(engineBlockLabel({ reason: "quota", resetsAt: inOneHour }, NOW, "UTC")).toBe("sem cota · volta às 13:00");
    expect(engineBlockLabel({ reason: "quota", resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() }, NOW, "UTC")).toBe("sem cota · volta às 10/11 12:00");
    expect(engineBlockLabel({ reason: "quota" }, NOW)).toBe("sem cota");
    expect(engineBlockLabel({ reason: "unavailable" }, NOW)).toBe("motor indisponível");
  });
});

describe("esforço onde o motor e o modelo aceitam", () => {
  it("Gemini leva o nível no nome do modelo: sem esforço; outros modelos e o Claude Code seguem", () => {
    expect(modelUsesEffort("gemini", "gemini-3.8-flash-medium")).toBe(false);
    expect(modelUsesEffort("gemini", undefined)).toBe(false);
    expect(modelUsesEffort("gemini", "outro-modelo")).toBe(true);
    expect(modelUsesEffort("claude", "sonnet")).toBe(true);
    expect(modelUsesEffort("claude", "haiku")).toBe(false);
    expect(modelUsesEffort("freebuff", undefined)).toBe(false);
  });

  it("withoutUnusedEffort e cleanModelDefaults tiram só o esforço que não vale", () => {
    expect(withoutUnusedEffort({ engine: "gemini" as const, model: "gemini-3.8-flash-medium", effort: "high" as const })).toEqual({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(withoutUnusedEffort({ engine: "claude" as const, model: "sonnet", effort: "high" as const }).effort).toBe("high");
    const cleaned = cleanModelDefaults({ ...INITIAL_MODEL_DEFAULTS, maestro: { engine: "gemini", model: "gemini-3.8-flash-medium", effort: "high" } });
    expect(cleaned.maestro).toEqual({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(cleaned.agentes).toEqual(INITIAL_MODEL_DEFAULTS.agentes);
  });
});
