import { BUDGET_PATH, type BudgetResponse, type UpdateBudgetBody } from "@cyno/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { describeError, requestJson } from "../api/client";
import { useAttentionStore } from "./attentionStore";

/**
 * O orçamento de consumo equivalente (só avisa, nunca trava): a barra da aba Gastos e do Painel da Gestão
 * lê daqui. Recarrega a cada minuto enquanto alguma tela usa e quando nasce ou some um alerta de orçamento.
 */
type BudgetStore = {
  budget: BudgetResponse | null;
  error: string | null;
  load: () => Promise<void>;
  save: (body: UpdateBudgetBody) => Promise<void>;
};

export const useBudgetStore = create<BudgetStore>()((set) => ({
  budget: null,
  error: null,
  async load() {
    try {
      set({ budget: await requestJson<BudgetResponse>(BUDGET_PATH), error: null });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },
  async save(body) {
    set({ budget: await requestJson<BudgetResponse>(BUDGET_PATH, { method: "PUT", body }), error: null });
  },
}));

const REFRESH_MS = 60_000;

/** O orçamento atual (null enquanto carrega) e um recarregar; mantém a leitura fresca enquanto a tela está montada. */
export function useBudget(): { budget: BudgetResponse | null; error: string | null; reload: () => void } {
  const budget = useBudgetStore((state) => state.budget);
  const error = useBudgetStore((state) => state.error);
  const load = useBudgetStore((state) => state.load);
  const alertKeys = useAttentionStore((state) =>
    state.open
      .filter((alert) => alert.kind === "budget")
      .map((alert) => alert.key)
      .join("|"),
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, alertKeys]);
  return { budget, error, reload: () => void load() };
}
