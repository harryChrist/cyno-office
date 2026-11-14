import { isTerminalFilter, type TerminalFilter } from "./terminalSearch";

/**
 * Parte pura da tela do terminal: o quanto se desenha (conversa de milhares de entradas), as novas
 * mensagens que chegam enquanto o dono lê mais acima e o filtro lembrado por agente.
 */

/** Quantas linhas a tela desenha de uma vez (as mais novas); "mostrar anteriores" soma mais um passo. */
export const WINDOW_STEP = 300;

/** A janela (de `start` a `end`, sem incluir o fim) de `WINDOW_STEP` linhas ao redor da linha `index`: o salto da busca. */
export function windowAround(total: number, index: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW_STEP / 2), total - WINDOW_STEP));
  return { start, end: Math.min(total, start + WINDOW_STEP) };
}

/** A janela que a tela desenha: a do salto da busca (`focus`) ou, sem ela, as `limit` mais novas. */
export function visibleRange(total: number, limit: number, focus: { start: number; end: number } | null): { start: number; end: number } {
  if (!focus) return { start: Math.max(0, total - limit), end: total };
  const start = Math.min(Math.max(0, focus.start), total);
  return { start, end: Math.min(Math.max(start, focus.end), total) };
}

/** Novas mensagens não vistas: soma as que chegaram só se o dono não está no fim; chegou ao fim, zera. */
export function nextUnread(unread: number, previousTotal: number, total: number, atEnd: boolean): number {
  if (atEnd) return 0;
  return total > previousTotal ? unread + (total - previousTotal) : unread;
}

const FILTER_PREFIX = "agent-office:term-filter:";

/** O filtro lembrado deste agente ("all" se não há, ou se o valor guardado é inválido). */
export function loadFilter(agentId: string | undefined, storage: Pick<Storage, "getItem"> | undefined): TerminalFilter {
  if (!agentId || !storage) return "all";
  try {
    const value = storage.getItem(FILTER_PREFIX + agentId);
    return isTerminalFilter(value) ? value : "all";
  } catch {
    return "all";
  }
}

export function saveFilter(agentId: string | undefined, filter: TerminalFilter, storage: Pick<Storage, "setItem" | "removeItem"> | undefined): void {
  if (!agentId || !storage) return;
  try {
    if (filter === "all") storage.removeItem(FILTER_PREFIX + agentId);
    else storage.setItem(FILTER_PREFIX + agentId, filter);
  } catch {
    // Sem storage: só não lembra.
  }
}
