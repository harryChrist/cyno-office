import { useEffect, type RefObject } from "react";

/**
 * Menu/popover da barra: fecha ao clicar fora de `rootRef` ou com Esc (aí o foco volta para o
 * botão que abriu). O Esc fica "tratado" (preventDefault), para não fechar também o painel lateral
 * nem voltar a câmera ao mapa.
 */
export function usePopover(open: boolean, close: () => void, rootRef: RefObject<HTMLElement | null>, buttonRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, rootRef, buttonRef]);
}
