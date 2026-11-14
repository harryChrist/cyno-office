import type { ActivityEntry } from "@cyno/shared";
import { create } from "zustand";

/** Quantas entradas ao vivo ficam na memória (a página só usa as que chegaram desde que abriu). */
const KEEP = 200;

type ActivityLogState = {
  /** Entradas novas da Atividade (`activity:appended`), as mais novas no fim. */
  live: ActivityEntry[];
  /** Conta as chegadas: quem observa só precisa saber que mudou. */
  version: number;
  push: (entry: ActivityEntry) => void;
  clear: () => void;
};

/**
 * Entradas da Atividade que chegam pelo WebSocket (as do workspace aberto e as do servidor). O
 * histórico vem por GET; isto só alimenta a lista ao vivo da página Atividade.
 */
export const useActivityLogStore = create<ActivityLogState>()((set) => ({
  live: [],
  version: 0,
  push: (entry) =>
    set((state) => {
      if (state.live.some((item) => item.id === entry.id)) return state; // o workspace e a lista geral podem repetir
      const live = [...state.live, entry];
      return { live: live.length > KEEP ? live.slice(live.length - KEEP) : live, version: state.version + 1 };
    }),
  clear: () => set({ live: [], version: 0 }),
}));
