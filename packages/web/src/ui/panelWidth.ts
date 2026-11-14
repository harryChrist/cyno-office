import { useEffect } from "react";
import { create } from "zustand";

/**
 * Largura do painel lateral: ver é na largura normal; enquanto algum formulário de edição está
 * aberto dentro dele (quarto, time ou agente), o painel alarga (`.side-panel--wide`). Cada
 * formulário aberto "pede" a largura e devolve ao fechar (salvar, cancelar ou trocar de seleção).
 */
type PanelWidthState = {
  wideClaims: number;
  /** Pede o painel largo; devolve a função que libera o pedido (chamar uma vez só). */
  claimWide: () => () => void;
};

export const usePanelWidthStore = create<PanelWidthState>((set) => ({
  wideClaims: 0,
  claimWide: () => {
    set((state) => ({ wideClaims: state.wideClaims + 1 }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((state) => ({ wideClaims: Math.max(0, state.wideClaims - 1) }));
    };
  },
}));

export const selectPanelWide = (state: PanelWidthState): boolean => state.wideClaims > 0;

/** Alarga o painel lateral enquanto `active` (e o componente estiver montado). */
export function useWidePanel(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return usePanelWidthStore.getState().claimWide();
  }, [active]);
}
