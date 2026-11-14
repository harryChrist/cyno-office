import { create } from "zustand";

export type SystemWarning = { id: number; message: string; at: string };

type SystemWarningState = {
  warnings: SystemWarning[];
  push: (message: string, at: string) => void;
  dismiss: (id: number) => void;
};

let nextId = 1;
/** Quantos avisos ficam na tela ao mesmo tempo (os mais velhos saem primeiro). */
const KEEP = 3;

/** Avisos do servidor (`system:warning`), ex.: uma gravação falhou mesmo depois das novas tentativas. */
export const useSystemWarningStore = create<SystemWarningState>()((set) => ({
  warnings: [],
  push: (message, at) =>
    set((state) => {
      // O mesmo aviso repetido não empilha.
      if (state.warnings.some((warning) => warning.message === message)) return state;
      return { warnings: [...state.warnings, { id: nextId++, message, at }].slice(-KEEP) };
    }),
  dismiss: (id) => set((state) => ({ warnings: state.warnings.filter((warning) => warning.id !== id) })),
}));
