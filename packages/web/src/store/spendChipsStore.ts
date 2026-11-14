import { USAGE_TASK_COSTS_PATH, type ServerEvent, type UsageHistoryResponse, type UsageTaskCostsResponse } from "@cyno/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { requestJson } from "../api/client";
import { useNavStore } from "./navStore";

/**
 * O gasto por agente e por tarefa à vista (chips no painel do agente, na tela de trabalho dele e no cartão da
 * tarefa). A fonte é a da página Gastos: `usage/history` (hoje, por agente) e `usage/task-costs` (por tarefa),
 * recarregados 1,5 s depois de cada turno gravado (`usage:agents`), só enquanto algum chip está na tela.
 */

export type ChipTotals = { tokens: number; costUsd: number; turns: number };

type ChipsData = { workspaceId: string; today: string; agents: Record<string, ChipTotals>; tasks: Record<string, { costUsd: number; tokens: number }> };

type SpendChipsStore = {
  data: ChipsData | null;
  /** Sobe a cada turno gravado: os chips na tela recarregam. */
  version: number;
  apply: (event: ServerEvent) => void;
  set: (data: ChipsData | null) => void;
  reset: () => void;
};

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
export const SPEND_CHIPS_DELAY_MS = 1500;

export const useSpendChipsStore = create<SpendChipsStore>()((set) => ({
  data: null,
  version: 0,
  apply(event) {
    if (watchers === 0 || event.type !== "usage:agents") return;
    clearTimeout(timer);
    timer = setTimeout(() => set((state) => ({ version: state.version + 1 })), SPEND_CHIPS_DELAY_MS);
  },
  set: (data) => set({ data }),
  reset() {
    clearTimeout(timer);
    set({ data: null });
  },
}));

const dayKey = (now: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

/** Os dois pedidos (agentes de hoje e custo por tarefa) montados num dado só. */
export async function fetchSpendChips(workspaceId: string, now: Date = new Date()): Promise<ChipsData> {
  const base = `/api/w/${encodeURIComponent(workspaceId)}`;
  const today = dayKey(now);
  const [history, costs] = await Promise.all([
    requestJson<UsageHistoryResponse>(`${base}/usage/history?${new URLSearchParams({ from: today, to: today, groupBy: "agent" }).toString()}`),
    requestJson<UsageTaskCostsResponse>(`${base}${USAGE_TASK_COSTS_PATH}`),
  ]);
  const agents: Record<string, ChipTotals> = {};
  for (const group of history.groups) agents[group.key] = { tokens: group.totals.totalTokens, costUsd: group.totals.costUsd, turns: group.totals.turns };
  return { workspaceId, today, agents, tasks: costs.tasks };
}

/** Mantém os dados dos chips frescos enquanto a tela que os usa está montada (vale para qualquer chip). */
export function useSpendChips(): ChipsData | null {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const data = useSpendChipsStore((state) => state.data);
  const version = useSpendChipsStore((state) => state.version);
  useEffect(() => {
    watchers += 1;
    return () => {
      watchers -= 1;
    };
  }, []);
  useEffect(() => {
    if (!workspaceId) return;
    let stale = false;
    void fetchSpendChips(workspaceId)
      .then((next) => {
        if (!stale) useSpendChipsStore.getState().set(next);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [workspaceId, version]);
  return data && data.workspaceId === workspaceId ? data : null;
}
