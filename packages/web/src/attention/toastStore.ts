import type { AttentionAlert } from "@cyno/shared";
import { create } from "zustand";
import { addToast, dismissToast, expireToasts, pauseToast, pruneToasts, resumeToast, type Toast } from "./toasts";

type ToastStore = {
  toasts: Toast[];
  push: (alert: Pick<AttentionAlert, "key" | "level">, now?: number) => void;
  /** Tira os alertas que a causa já limpou. */
  prune: (open: ReadonlyMap<string, Pick<AttentionAlert, "level">>, now?: number) => void;
  /** Tira os que já passaram da vida. */
  tick: (now?: number) => void;
  pause: (id: string, now?: number) => void;
  resume: (id: string, now?: number) => void;
  dismiss: (id: string) => void;
  clear: () => void;
};

let seq = 0;

export const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],
  push: (alert, now = Date.now()) => set((state) => ({ toasts: addToast(state.toasts, alert, now, `toast-${now}-${(seq += 1)}`) })),
  prune: (open, now = Date.now()) =>
    set((state) => {
      const next = pruneToasts(state.toasts, open, now);
      return next.length === state.toasts.length && next.every((toast, index) => toast === state.toasts[index]) ? state : { toasts: next };
    }),
  tick: (now = Date.now()) =>
    set((state) => {
      const next = expireToasts(state.toasts, now);
      return next.length === state.toasts.length ? state : { toasts: next };
    }),
  pause: (id, now = Date.now()) => set((state) => ({ toasts: pauseToast(state.toasts, id, now) })),
  resume: (id, now = Date.now()) => set((state) => ({ toasts: resumeToast(state.toasts, id, now) })),
  dismiss: (id) => set((state) => ({ toasts: dismissToast(state.toasts, id) })),
  clear: () => set({ toasts: [] }),
}));
