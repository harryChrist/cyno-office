import { BUDGET_PATH, updateBudgetBodySchema, type BudgetResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { SpendSettingsStore } from "../engines/usage/spend-settings";
import type { BudgetWatcher } from "../platform/budget/budget-watcher";

/**
 * Orçamento de consumo equivalente (só avisa, nunca trava), atrás da senha:
 * - GET /api/spend/budget -> BudgetResponse (os limites e o consumo de cada período com limite; sem limite, `periods` vazio);
 * - PUT /api/spend/budget { dayUsd?, weekUsd?, monthUsd? } -> BudgetResponse (`null` tira o limite; troca só o que veio; 400 fora de 0–1.000.000).
 */
export function registerBudgetRoutes(app: FastifyInstance, store: SpendSettingsStore, watcher: Pick<BudgetWatcher, "status" | "limitsChanged">, now: () => Date): void {
  app.get(BUDGET_PATH, async (): Promise<BudgetResponse> => watcher.status());
  app.put(BUDGET_PATH, async (request): Promise<BudgetResponse> => {
    const body = updateBudgetBodySchema.parse(request.body ?? {});
    await store.setBudget(body, now());
    await watcher.limitsChanged();
    return watcher.status();
  });
}
