/**
 * Marcadores que o MockRunner (agentes simulados) entende no texto do pedido:
 * "[aprovar]" sempre pede aprovação do usuário; "[falhar]" faz a tarefa falhar.
 */
export const MOCK_PROMPT_MARKERS = {
  approve: "[aprovar]",
  fail: "[falhar]",
} as const;

/** Resultado gravado quando o usuário recusa a aprovação pedida por um agente. */
export const APPROVAL_REFUSED_RESULT = "Recusado pelo usuário";

/** Resultado de uma recusa: com a nota do usuário, ela vira o motivo. */
export function approvalRefusedResult(note?: string): string {
  const clean = note?.trim();
  return clean ? `${APPROVAL_REFUSED_RESULT}: ${clean}` : APPROVAL_REFUSED_RESULT;
}
