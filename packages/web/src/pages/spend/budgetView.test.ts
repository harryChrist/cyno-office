import type { BudgetPeriodStatus, BudgetResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { budgetBodyOf, budgetFormOf, budgetRows, budgetSummary, parseBudgetField } from "./budgetView";

const status = (period: BudgetPeriodStatus["period"], spentUsd: number, limitUsd: number): BudgetPeriodStatus => {
  const percent = (spentUsd / limitUsd) * 100;
  return { period, limitUsd, spentUsd, spentBrl: spentUsd * 5, percent, step: percent >= 100 ? 100 : percent >= 80 ? 80 : 0, tone: percent >= 80 ? "danger" : percent >= 50 ? "warn" : "ok", start: "", end: "" };
};
const response = (...periods: BudgetPeriodStatus[]): BudgetResponse => ({ limits: {}, usdBrl: 5, periods });
const usd = (value: number) => `US$ ${value.toFixed(2)}`;

describe("budgetRows: a barra de consumo", () => {
  it("sem orçamento (ou sem resposta) não há linha", () => {
    expect(budgetRows(null, usd)).toEqual([]);
    expect(budgetRows(response(), usd)).toEqual([]);
  });

  it("abaixo de 80%: barra normal, sem nota; entre 50 e 79 é aviso de cor", () => {
    const [low, mid] = budgetRows(response(status("day", 1, 5), status("week", 3, 5)), usd);
    expect(low).toMatchObject({ title: "Hoje", amounts: "US$ 1.00 de US$ 5.00", percentText: "20%", width: 20, tone: "ok", step: 0, note: "" });
    expect(mid).toMatchObject({ title: "Esta semana", percentText: "60%", tone: "warn", note: "" });
  });

  it("80% e estourado: cor de perigo, a nota diz que o Cyno avisou e que o trabalho segue; a barra para em 100 e o número não", () => {
    const [near, over] = budgetRows(response(status("day", 4.1, 5), status("month", 7.5, 5)), usd);
    expect(near).toMatchObject({ percentText: "82%", tone: "danger", step: 80, note: "Passou de 80%: o Cyno avisou." });
    expect(over).toMatchObject({ title: "Este mês", percentText: "150%", width: 100, step: 100 });
    expect(over!.note).toContain("o trabalho segue");
    expect(budgetSummary([near!, over!])).toBe("Hoje 82% · Mês 150%");
  });
});

describe("campo de valor do orçamento", () => {
  it("aceita vírgula, ponto e US$; vazio tira o limite; inválido é recusado", () => {
    expect(parseBudgetField("5")).toBe(5);
    expect(parseBudgetField("5,50")).toBe(5.5);
    expect(parseBudgetField("US$ 12.5")).toBe(12.5);
    expect(parseBudgetField("1.000")).toBe(1000);
    expect(parseBudgetField("")).toBeNull();
    expect(parseBudgetField("  ")).toBeNull();
    for (const bad of ["abc", "0", "-3", "0,001", "2000000"]) expect(parseBudgetField(bad)).toBeUndefined();
  });

  it("o formulário parte dos limites e o corpo do PUT leva só o que mudou", () => {
    expect(budgetFormOf(undefined)).toEqual({ day: "", week: "", month: "" });
    const form = budgetFormOf({ dayUsd: 5, monthUsd: 120.5 });
    expect(form).toEqual({ day: "5", week: "", month: "120,5" });
    expect(budgetBodyOf(form, { dayUsd: 5, monthUsd: 120.5 })).toEqual({ body: {} });
    expect(budgetBodyOf({ day: "", week: "20", month: "120,5" }, { dayUsd: 5, monthUsd: 120.5 })).toEqual({ body: { dayUsd: null, weekUsd: 20 } });
    expect(budgetBodyOf({ day: "x", week: "", month: "" }, undefined)).toMatchObject({ period: "day", error: expect.stringContaining("dia") });
  });
});
