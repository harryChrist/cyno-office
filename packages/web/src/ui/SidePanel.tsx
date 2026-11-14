import { LOBBY_ID } from "@cyno/shared";
import { useEffect, useRef } from "react";
import { useOverlayInsets } from "../hud/useOverlayInsets";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore, type Selection } from "../store/viewStore";
import { AgentPanel } from "./AgentPanel";
import { selectPanelWide, usePanelWidthStore } from "./panelWidth";
import { LobbyPanel, RoomPanel } from "./RoomPanel";

function selectionKey(selection: Selection): string {
  return selection ? `${selection.kind}:${selection.id}` : "";
}

/** Há uma janela modal aberta (o Esc é dela, não do painel). */
function modalOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

/** Esc fecha o painel (select(null)), a menos que uma janela modal esteja aberta. */
function useEscapeToClose(enabled: boolean) {
  const select = useViewStore((state) => state.select);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || modalOpen()) return;
      // Num campo de formulário do painel (ex.: editando o agente), o 1º Esc só sai do campo.
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select") && target.closest(".side-panel")) {
        target.blur();
        return;
      }
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, select]);
}

/**
 * Painel lateral direito: agente, quarto ou lobby, conforme a seleção da viewStore. Fica por cima
 * do minimapa e dos controles (eles não se mexem); com um formulário de edição aberto, alarga.
 */
export function SidePanel() {
  const selection = useViewStore((state) => state.selection);
  const select = useViewStore((state) => state.select);
  const office = useOfficeStore((state) => state.office);
  // Editando (quarto, time ou agente), o painel alarga; vendo, fica na largura normal.
  const wide = usePanelWidthStore(selectPanelWide);
  const ref = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);
  const open = selection !== null && office !== null;
  const key = selectionKey(selection);

  useOverlayInsets("side-panel", ref, "right", open);
  useEscapeToClose(open);

  // Ao abrir (ou trocar o que está selecionado), o foco vai para o topo do painel.
  useEffect(() => {
    if (key) headingRef.current?.focus({ preventScroll: true });
  }, [key]);

  if (!open) return null;
  const kicker = selection.kind === "agent" ? "Agente" : selection.id === LOBBY_ID ? "Lobby" : "Sala";

  return (
    <aside
      ref={ref}
      className={`side-panel${wide ? " side-panel--wide" : ""}`}
      aria-label={`Painel do ${kicker.toLowerCase()}`}
      data-testid="side-panel"
      data-kind={selection.kind}
      data-wide={wide || undefined}
    >
      <header className="side-panel__header">
        <p ref={headingRef} tabIndex={-1} className="side-panel__kicker">
          {kicker}
        </p>
        <button type="button" className="ui-icon-button" aria-label="Fechar painel (Esc)" onClick={() => select(null)} data-testid="side-panel-close">
          ×
        </button>
      </header>
      <div className="side-panel__body">
        {selection.kind === "agent" && <AgentPanel key={key} office={office} agentId={selection.id} />}
        {selection.kind === "room" && selection.id === LOBBY_ID && <LobbyPanel office={office} />}
        {selection.kind === "room" && selection.id !== LOBBY_ID && <RoomPanel key={key} office={office} roomId={selection.id} />}
      </div>
    </aside>
  );
}
