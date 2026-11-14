import { useEffect, useLayoutEffect, type RefObject } from "react";

/** Arrastar mais que isso (px) no escritório é mover a câmera, não clicar: o painel fica aberto. */
const CLICK_SLOP = 6;

/** O que importa de um keydown para decidir se o Esc recolhe o painel do Maestro. */
export type DockEscapeInput = {
  key: string;
  defaultPrevented: boolean;
  /** Há uma janela modal aberta (o Esc é dela). */
  modalOpen: boolean;
  /** O foco está dentro do painel/caixa do Maestro. */
  insideDock: boolean;
  /** O foco está no terminal do Maestro (lá o Esc é do Claude Code: interrompe o turno). */
  insideTerminal: boolean;
  /** O foco está solto na página (body) ou no escritório (canvas). */
  onPage: boolean;
};

/**
 * Esc recolhe o painel acoplado quando o foco está nele ou solto na página/escritório, a menos que
 * outro dono cuide do Esc: uma janela modal, um popover que já tratou (preventDefault) ou o
 * terminal do Maestro (lá o Esc vai para o Claude Code). Recolher marca o Esc como tratado, então
 * ele não volta também a câmera ao mapa nem fecha o painel lateral (escapeReturnsToMap).
 */
export function dockEscapeCollapses(input: DockEscapeInput): boolean {
  if (input.key !== "Escape" || input.defaultPrevented || input.modalOpen || input.insideTerminal) return false;
  return input.insideDock || input.onPage;
}

/** Um clique (pointerdown → pointerup quase no mesmo lugar) e não um arrasto da câmera? */
export function isClick(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.abs(up.x - down.x) + Math.abs(up.y - down.y) <= CLICK_SLOP;
}

/**
 * Enquanto o painel do Maestro está aberto: Esc recolhe (ver `dockEscapeCollapses`) e um clique no
 * escritório (sem arrastar) também. Escuta no `document`, que vem antes dos ouvintes da `window`
 * (o Esc do canvas e o do painel lateral), para marcar o Esc como tratado a tempo.
 */
export function useDockDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, collapse: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const collapses = dockEscapeCollapses({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        modalOpen: document.querySelector("dialog[open]") !== null || target?.closest("dialog") != null,
        insideDock: Boolean(target && rootRef.current?.contains(target)),
        insideTerminal: Boolean(target?.closest(".mterm")),
        onPage: !target || target === document.body || target === document.documentElement || target.closest(".office-canvas") !== null,
      });
      if (!collapses) return;
      event.preventDefault();
      collapse();
    };
    let press: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      press = target?.closest(".office-canvas") ? { x: event.clientX, y: event.clientY } : null;
    };
    const onUp = (event: PointerEvent) => {
      if (press && isClick(press, { x: event.clientX, y: event.clientY })) collapse();
      press = null;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
    };
  }, [open, rootRef, collapse]);
}

/**
 * A altura da caixa do rodapé vira `--taskbox-h` na raiz: no celular os controles do escritório
 * (zoom, "+ Quarto") sobem para cima dela em vez de cobri-la.
 */
export function useTaskboxHeight(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--taskbox-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--taskbox-h");
    };
  }, [ref]);
}
