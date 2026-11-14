import { create } from "zustand";
import { useNavStore } from "./navStore";

type ForYouFocusState = {
  /** Item que a página "Para você" deve mostrar e focar ao abrir (null = nenhum). */
  itemId: string | null;
  /** "Abrir em Aprovações": vai para a página e pede o foco no item. */
  open: (itemId: string) => void;
  clear: () => void;
};

export const useForYouFocus = create<ForYouFocusState>()((set) => ({
  itemId: null,
  open: (itemId) => {
    set({ itemId });
    useNavStore.getState().go("para-voce");
  },
  clear: () => set({ itemId: null }),
}));
