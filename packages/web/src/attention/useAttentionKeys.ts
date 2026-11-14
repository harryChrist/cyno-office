import { useEffect } from "react";
import { useAttentionStore } from "../store/attentionStore";
import { openAlert } from "./openAlert";

/** O evento da tecla é de quem digita (campo de texto, seleção, `contenteditable`) ou há um diálogo aberto? Aí a tecla não é nossa. */
export function keyBelongsToTyping(event: Pick<KeyboardEvent, "target" | "defaultPrevented" | "ctrlKey" | "metaKey" | "altKey">, modalOpen: boolean): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return true;
  if (modalOpen) return true;
  const target = event.target as Partial<HTMLElement> | null;
  if (!target) return false;
  const tag = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
}

/** Anda no percurso dos alertas e abre o lugar do próximo. É o que o clique no contador e a tecla `P` fazem. */
export function stepAttention(dir: 1 | -1 = 1): boolean {
  const next = useAttentionStore.getState().step(dir);
  if (!next) return false;
  openAlert(next);
  return true;
}

/** `P` vai ao próximo alerta que espera você e `Shift+P` volta (ignorado em campo de texto e com diálogo aberto). */
export function useAttentionKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "p") return;
      if (keyBelongsToTyping(event, document.querySelector("dialog[open]") !== null)) return;
      if (stepAttention(event.shiftKey ? -1 : 1)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
