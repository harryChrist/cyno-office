import { useEffect } from "react";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { DEFAULT_SHORTCUTS, matchesBinding, shortcuts, type KeyBinding } from "./shortcuts";

/** O atalho do chat do Maestro (padrão Ctrl/⌘+K; o dono troca em Configurações > Atalhos do teclado). */
export function isCommandShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, binding: KeyBinding = DEFAULT_SHORTCUTS.maestro): boolean {
  return matchesBinding(event, binding);
}

/**
 * O atalho do Maestro (padrão Ctrl/⌘+K): abre o painel do Maestro de qualquer página (volta ao Office) e põe o foco no
 * campo. A combinação é lida a cada tecla, então trocar nas Configurações vale na hora. Não desenha nada (o botão da barra de cima saiu; a entrada é a caixa do rodapé, TaskBox).
 */
export function CommandShortcut() {
  const openMaestro = useWorkPanelStore((state) => state.openMaestro);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCommandShortcut(event, shortcuts().maestro) || event.defaultPrevented) return;
      // Outra janela modal aberta: o atalho não empilha um diálogo por cima dela.
      if (document.querySelector("dialog[open]")) return;
      // No terminal do Maestro as teclas são do Claude Code (o Ctrl+K apaga até o fim da linha).
      if (event.target instanceof Element && event.target.closest(".mterm")) return;
      event.preventDefault();
      openMaestro();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMaestro]);

  return null;
}
