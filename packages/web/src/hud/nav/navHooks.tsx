import { useCallback, useEffect, useState, useSyncExternalStore, type FocusEvent, type PointerEvent as ReactPointerEvent } from "react";
import { pendingCount } from "../../store/forYouItems";
import { isNavToggleShortcut, useNavLayoutStore } from "../../store/navLayoutStore";
import { behindCount, useRoutinesStore } from "../../store/routinesStore";
import { useNavStore, type PageId } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useAwaiting } from "../../pages/work/useWork";
import type { Badge } from "./navItems";

/** Contadores das páginas: o que espera você em Projetos e tarefas (a mesma conta da página e do painel), os atrasados da Gestão e os pendentes de Aprovações. */
export function useNavBadges(): Partial<Record<PageId, Badge>> {
  const pending = useOfficeStore((state) => pendingCount(state.forYou));
  const awaiting = useAwaiting().count;
  const behind = useRoutinesStore((state) => behindCount(state.overview));
  const workspaceId = useNavStore((state) => state.workspaceId);
  // O selo precisa dos números mesmo fora da Gestão: busca uma vez por workspace (os eventos de rotina mantêm em dia).
  useEffect(() => {
    if (workspaceId) void useRoutinesStore.getState().load();
  }, [workspaceId]);
  return {
    gestao: { count: behind, singular: "atrasada", plural: "atrasadas", testId: "nav-gestao-count", tone: "danger" },
    trabalho: { count: awaiting, singular: "esperando você", plural: "esperando você", testId: "nav-trabalho-count" },
    "para-voce": { count: pending, singular: "pendente", plural: "pendentes", testId: "nav-para-voce-count" },
  };
}

function subscribeQuery(query: string) {
  return (notify: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", notify);
    return () => list.removeEventListener("change", notify);
  };
}

/** A tela bate com a media query? (re-renderiza quando muda). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => subscribeQuery(query)(notify), [query]);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Dica da barra recolhida: o nome do item, ao lado do ícone, ao passar o mouse ou focar pelo
 * teclado. Fica fora da lista (posição fixa), então a rolagem da barra não corta.
 */
export function useRailTip(enabled: boolean) {
  const [tip, setTip] = useState<{ label: string; hint: string; top: number } | null>(null);
  const show = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
    if (!el) return setTip(null);
    const rect = el.getBoundingClientRect();
    setTip({ label: el.dataset.tip ?? "", hint: el.dataset.tipHint ?? "", top: rect.top + rect.height / 2 });
  };
  // Clicar (inclusive no "Expandir") apaga a dica: ao recolher de novo ela não volta velha.
  const handlers = enabled
    ? {
        onPointerOver: (event: ReactPointerEvent) => show(event.target),
        onPointerLeave: () => setTip(null),
        onFocus: (event: FocusEvent) => (event.target instanceof HTMLElement && event.target.matches(":focus-visible") ? show(event.target) : undefined),
        onBlur: () => setTip(null),
        onClick: () => setTip(null),
      }
    : {};
  const node =
    enabled && tip ? (
      <span className="sidenav__tip" style={{ top: tip.top }} aria-hidden="true">
        {tip.label}
        {tip.hint && <span className="sidenav__tip-hint">{tip.hint}</span>}
      </span>
    ) : null;
  return { handlers, node };
}

/** Ctrl+B (⌘B) recolhe ou abre a barra lateral, fora de campos, do terminal e de janelas. */
export function useNavToggleShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      const terminal = target?.closest(".mterm, .xterm") != null;
      const modalOpen = document.querySelector("dialog[open]") !== null;
      if (!isNavToggleShortcut(event, { typing, terminal, modalOpen })) return;
      event.preventDefault();
      useNavLayoutStore.getState().toggleCollapsed();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
