import { create } from "zustand";
import { useNavStore } from "./navStore";

type ForYouTypesSheetState = {
  /** A janela "Tipos" da página "Para você" está aberta? */
  open: boolean;
  /** Vai para "Para você" e abre a janela (o link do aviso no sino). */
  show: () => void;
  setOpen: (open: boolean) => void;
};

export const useForYouTypesSheet = create<ForYouTypesSheetState>()((set) => ({
  open: false,
  show: () => {
    set({ open: true });
    useNavStore.getState().go("para-voce");
  },
  setOpen: (open) => set({ open }),
}));
