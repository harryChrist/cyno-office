import { useLayoutEffect, type RefObject } from "react";
import { NO_INSETS, useViewStore, type Insets } from "../store/viewStore";

export type OverlaySide = "left" | "right" | "top" | "bottom";

/** Quanto um retângulo encostado em `side` cobre daquela borda (o espaço até a borda conta junto). */
export function overlayInsets(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">, side: OverlaySide, viewport: { w: number; h: number }): Insets {
  const size = Math.max(0, Math.round(side === "left" ? rect.right : side === "right" ? viewport.w - rect.left : side === "top" ? rect.bottom : viewport.h - rect.top));
  return { ...NO_INSETS, [side]: size };
}

/**
 * Painel que fica por cima do canvas informa quanto da tela ele cobre, para a câmera enquadrar o
 * escritório na área livre. Um painel encostado numa borda vira uma faixa naquela borda
 * (o espaço entre ele e a borda conta junto). `enabled = false` libera a área.
 */
export function useOverlayInsets(key: string, ref: RefObject<HTMLElement | null>, side: OverlaySide, enabled: boolean): void {
  const setOverlay = useViewStore((state) => state.setOverlay);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) {
      setOverlay(key, null);
      return;
    }
    const measure = () => setOverlay(key, overlayInsets(el.getBoundingClientRect(), side, { w: window.innerWidth, h: window.innerHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      setOverlay(key, null);
    };
  }, [key, ref, side, enabled, setOverlay]);
}
