import { create } from "zustand";
import { useNavStore } from "./navStore";

type GestaoFocusState = {
  /** Rotina que a página Gestão deve abrir ao entrar (null = nenhuma). */
  routineId: string | null;
  /** "Abrir na Gestão": vai para a página e pede a rotina aberta. */
  open: (routineId: string) => void;
  clear: () => void;
};

export const useGestaoFocus = create<GestaoFocusState>()((set) => ({
  routineId: null,
  open: (routineId) => {
    set({ routineId });
    useNavStore.getState().go("gestao", "rotinas");
  },
  clear: () => set({ routineId: null }),
}));
