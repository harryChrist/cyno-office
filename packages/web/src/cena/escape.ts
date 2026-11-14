/** O que importa de um keydown para decidir se o Esc volta ao mapa. */
export type EscapeInput = {
  key: string;
  defaultPrevented: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
  /** Há uma janela modal (`<dialog open>`) na página? */
  modalOpen: boolean;
};

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Esc no canvas volta ao mapa, a menos que outro dono cuide dele: um campo de formulário (o 1º Esc
 * só sai do campo), uma janela modal aberta (o Esc fecha só a janela) ou um handler que já tratou o
 * evento (`preventDefault`).
 */
export function escapeReturnsToMap(input: EscapeInput): boolean {
  if (input.key !== "Escape" || input.defaultPrevented || input.modalOpen) return false;
  const target = input.target;
  return !(target && (target.isContentEditable || FORM_TAGS.has(target.tagName)));
}
