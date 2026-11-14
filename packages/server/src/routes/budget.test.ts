import { BUDGET_PATH, SPEND_SETTINGS_PATH, type BudgetResponse, type SpendSettingsResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

describe("API: orçamento de consumo (só avisa)", () => {
  it("sem orçamento: nada aparece; definir, ler e tirar os limites", async () => {
    const { app } = await setupApp();
    const empty = await call<BudgetResponse>(app, "GET", BUDGET_PATH);
    expect(empty).toMatchObject({ limits: {}, periods: [] });

    const set = await call<BudgetResponse>(app, "PUT", BUDGET_PATH, { dayUsd: 5, monthUsd: 100 }, 200);
    expect(set.limits).toEqual({ dayUsd: 5, monthUsd: 100 });
    expect(set.periods.map((period) => period.period)).toEqual(["day", "month"]);
    expect(set.periods[0]).toMatchObject({ limitUsd: 5, spentUsd: 0, percent: 0, step: 0, tone: "ok" });

    // Troca só o que veio; `null` tira o limite daquele período.
    const next = await call<BudgetResponse>(app, "PUT", BUDGET_PATH, { dayUsd: null, weekUsd: 20 }, 200);
    expect(next.limits).toEqual({ weekUsd: 20, monthUsd: 100 });
    expect((await call<BudgetResponse>(app, "GET", BUDGET_PATH)).periods.map((period) => period.period)).toEqual(["week", "month"]);

    // A cotação continua independente do orçamento.
    const spend = await call<SpendSettingsResponse>(app, "PUT", SPEND_SETTINGS_PATH, { usdBrl: 6 }, 200);
    expect(spend.usdBrl).toBe(6);
    expect((await call<BudgetResponse>(app, "GET", BUDGET_PATH)).limits).toEqual({ weekUsd: 20, monthUsd: 100 });
  });

  it("valor inválido é recusado (400)", async () => {
    const { app } = await setupApp();
    for (const body of [{ dayUsd: 0 }, { dayUsd: -3 }, { weekUsd: "muito" }, { semana: 5 }]) {
      const response = await app.inject({ method: "PUT", url: BUDGET_PATH, payload: body });
      expect(response.statusCode).toBe(400);
    }
  });
});
