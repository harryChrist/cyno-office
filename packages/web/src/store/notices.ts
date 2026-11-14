import { create } from "zustand";

/** Aviso do sino que não é atividade de tarefa (ex.: "O Maestro criou o tipo “Reels”"). */
export type Notice = {
  key: string;
  text: string;
  at: string;
  /** O que o link do aviso abre. */
  target: "foryou-types" | "gestao";
  /** Aviso em destaque (ex.: uma inscrição virou Entrevista). */
  alert?: boolean;
};

export const NOTICES_LIMIT = 10;

/** A entrada da Atividade de uma rotina de acompanhamento que merece um aviso no sino (uma por execução com mudanças). */
export function routineNoticeOf(entry: { id: string; at: string; category: string; action: string; summary: string }): Notice | undefined {
  if (entry.category !== "rotina" || !["mudou", "alerta", "expirou"].includes(entry.action)) return undefined;
  return { key: `rotina:${entry.id}`, text: entry.summary, at: entry.at, target: "gestao", ...(entry.action === "alerta" ? { alert: true } : {}) };
}

type NoticesState = {
  notices: Notice[];
  /** Quantos chegaram desde a última vez que o sino foi aberto. */
  unread: number;
  push: (notice: Notice) => void;
  markRead: () => void;
  reset: () => void;
};

export const useNoticesStore = create<NoticesState>()((set, get) => ({
  notices: [],
  unread: 0,
  push(notice) {
    const { notices, unread } = get();
    if (notices.some((current) => current.key === notice.key)) return;
    set({ notices: [notice, ...notices].slice(0, NOTICES_LIMIT), unread: unread + 1 });
  },
  markRead() {
    if (get().unread > 0) set({ unread: 0 });
  },
  reset() {
    set({ notices: [], unread: 0 });
  },
}));
