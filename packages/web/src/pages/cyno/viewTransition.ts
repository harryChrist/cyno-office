import { flushSync } from "react-dom";

type DocumentComTransicao = Document & { startViewTransition?: (atualizar: () => void) => unknown };

/**
 * Troca de tela com animação do navegador (View Transitions): elementos com o mesmo `view-transition-name` (a caixa de
 * mensagem do Cyno, `cyno-composer`) se movem de um lugar para o outro e o resto some/aparece com fade. É só enfeite:
 * sem suporte, ou com "reduzir movimento" ligado no sistema, a troca acontece igual, sem animação.
 */
export function withViewTransition(update: () => void): void {
  const doc = typeof document === "undefined" ? undefined : (document as DocumentComTransicao);
  const reduzido = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc || typeof doc.startViewTransition !== "function" || reduzido) {
    update();
    return;
  }
  doc.startViewTransition(() => {
    // O novo estado precisa estar no DOM quando a função termina, para o navegador capturar o "depois".
    flushSync(update);
  });
}
