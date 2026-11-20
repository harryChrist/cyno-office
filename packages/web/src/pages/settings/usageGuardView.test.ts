import type { UsageGuardRuleView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { groupGuardRules, guardRowState, parseGuardPercent } from "./usageGuardView";

const NOW = Date.parse("2026-11-19T15:00:00Z");
const rule = (extra: Partial<UsageGuardRuleView> = {}): UsageGuardRuleView => ({ key: "claude:five_hour", engine: "claude", engineLabel: "Claude Code", windowId: "five_hour", label: "5 h", kind: "window", enabled: true, percent: 90, paused: false, ...extra });

describe("guardRowState", () => {
  it("pausado mostra a hora de volta", () => {
    const state = guardRowState(rule({ paused: true, resumesAt: "2026-11-19T17:30:00Z" }), NOW);
    expect(state.tone).toBe("paused");
    // Sempre no horário de Brasília, como o aviso do servidor (17:30 UTC = 14:30).
    expect(state.text).toBe("Pausado · volta às 14:30");
    expect(guardRowState(rule({ paused: true, resumesAt: "2026-11-22T20:00:00Z" }), NOW).text).toBe("Pausado · volta em 22/11 17:00");
  });
  it("liberada na mão diz até quando a regra fica sem pausar", () => {
    expect(guardRowState(rule({ utilization: 0.47, percent: 40, releasedUntil: "2026-11-19T17:30:00Z" }), NOW)).toEqual({ text: "47% de uso · liberado até as 14:30", tone: "warn" });
    expect(guardRowState(rule({ utilization: 0.47, percent: 40, releasedUntil: "2026-11-22T20:00:00Z" }), NOW).text).toBe("47% de uso · liberado até 22/11 17:00");
  });
  it("pausado sem hora informada não inventa", () => {
    expect(guardRowState(rule({ paused: true }), NOW).text).toBe("Pausado");
  });
  it("desligada, sem leitura e com leitura", () => {
    expect(guardRowState(rule({ enabled: false }), NOW).text).toBe("Desligada");
    expect(guardRowState(rule({ enabled: false, utilization: 0.47 }), NOW)).toEqual({ text: "Desligada · 47% de uso", tone: "idle" });
    expect(guardRowState(rule(), NOW).text).toBe("Sem leitura");
    expect(guardRowState(rule({ utilization: 0.62 }), NOW)).toEqual({ text: "62% de uso", tone: "ok" });
    expect(guardRowState(rule({ utilization: 0.82 }), NOW).tone).toBe("warn");
  });
});

describe("groupGuardRules e parseGuardPercent", () => {
  it("agrupa por motor mantendo a ordem", () => {
    const groups = groupGuardRules({ rules: [rule(), rule({ key: "claude:seven_day", windowId: "seven_day", label: "semana" }), rule({ key: "freebuff:daily_hours", engine: "freebuff", engineLabel: "Freebuff" })] });
    expect(groups.map((group) => [group.engine, group.rules.length])).toEqual([["claude", 2], ["freebuff", 1]]);
  });
  it("o percentual digitado fica entre 10 e 100", () => {
    expect(parseGuardPercent("85")).toBe(85);
    expect(parseGuardPercent("85%")).toBe(85);
    expect(parseGuardPercent("3")).toBe(10);
    expect(parseGuardPercent("150")).toBe(100);
    expect(parseGuardPercent("abc")).toBeUndefined();
    expect(parseGuardPercent("")).toBeUndefined();
  });
});
