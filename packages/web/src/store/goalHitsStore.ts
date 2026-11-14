import type { ServerEvent } from "@cyno/shared";
import { create } from "zustand";

/** Uma meta de rotina batida (evento `routine:goal-hit`), como o mapa a recebe. */
export type GoalHit = { key: string; routineId: string; periodKey: string; title: string; agentId?: string; teamId?: string; at: number };

const KEPT = 20;

type GoalHitsState = {
  /** Só o que chegou ao vivo nesta aba: a carga inicial nunca traz festa. */
  hits: readonly GoalHit[];
  apply: (event: ServerEvent, now?: number) => void;
  reset: () => void;
};

export const useGoalHitsStore = create<GoalHitsState>()((set, get) => ({
  hits: [],
  apply(event, now = Date.now()) {
    if (event.type !== "routine:goal-hit") return;
    const key = `${event.routineId}:${event.periodKey}`;
    if (get().hits.some((hit) => hit.key === key)) return;
    const hit: GoalHit = { key, routineId: event.routineId, periodKey: event.periodKey, title: event.title, ...(event.agentId ? { agentId: event.agentId } : {}), ...(event.teamId ? { teamId: event.teamId } : {}), at: now };
    set({ hits: [...get().hits, hit].slice(-KEPT) });
  },
  reset: () => set({ hits: [] }),
}));
