import { useEffect } from "react";
import { useWorkPanelStore } from "../agentWork/workPanelStore";

/** Atalho no Mac é ⌘K; no resto, Ctrl+K. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const COMMAND_SHORTCUT_LABEL = IS_MAC ? "⌘K" : "Ctrl K";

/** Ctrl/⌘+K: o atalho do diálogo de comando. */
export function isCommandShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/**
 * Atalho Ctrl/⌘+K: abre o painel do Maestro de qualquer página (volta ao Office) e põe o foco no
 * campo. Não desenha nada (o botão da barra de cima saiu; a entrada é a caixa do rodapé, TaskBox).
 */
export function CommandShortcut() {
  const openMaestro = useWorkPanelStore((state) => state.openMaestro);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCommandShortcut(event) || event.defaultPrevented) return;
      // Outra janela modal aberta: o atalho não empilha um diálogo por cima dela.
      if (document.querySelector("dialog[open]")) return;
      // No terminal do Maestro o Ctrl+K é do Claude Code (apaga até o fim da linha).
      if (event.target instanceof Element && event.target.closest(".mterm")) return;
      event.preventDefault();
      openMaestro();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMaestro]);

  return null;
}
