import { forYouKind, forYouOriginalText, type ForYouItem } from "./for-you";

/**
 * Aprovar em lote (Gestão, "Esperando seu OK"): as regras de quem pode entrar, num lugar só. O servidor as aplica em
 * `POST /for-you/batch` e a tela as usa para mostrar, antes de confirmar, quem ficou de fora e por quê.
 */

/** Teto de itens por lote. */
export const FOR_YOU_BATCH_MAX = 20;
/** Rota do lote (dentro de /api/w/:ws). */
export const FOR_YOU_BATCH_PATH = "/for-you/batch";
/** Tipos que saem para fora (convite, post): só entram no lote se o agente já tiver uma aprovação individual desse tipo no histórico. */
export const BATCH_GUARDED_TYPES: readonly string[] = ["convite", "post"];

export const BATCH_EXCLUSION_REASONS = ["missing", "not_pending", "not_approval", "edited", "no_history"] as const;
export type BatchExclusionReason = (typeof BATCH_EXCLUSION_REASONS)[number];

export const BATCH_EXCLUSION_TEXT: Record<BatchExclusionReason, string> = {
  missing: "o item não existe mais",
  not_pending: "já foi decidido",
  not_approval: "não é uma aprovação de texto (plano, rotina, sprint e perguntas se decidem um a um)",
  edited: "tem edição sua: aprove abrindo o item",
  no_history: "convite e post só entram em lote depois de uma aprovação individual deste agente nesse tipo",
};

export type BatchExclusion = { id: string; reason: BatchExclusionReason; text: string };

/** O texto foi mexido (por você, ou o rascunho foi trocado): a decisão precisa olhar o texto final. */
export function hasPendingEdit(item: Pick<ForYouItem, "editedByUser" | "text" | "originalText">): boolean {
  return item.editedByUser || item.text !== forYouOriginalText(item);
}

/** O agente já teve um item deste tipo aprovado individualmente por você (sem Automático e sem lote)? */
export function hasIndividualApproval(items: readonly ForYouItem[], agentId: string, type: string): boolean {
  return items.some((other) => other.agentId === agentId && other.type === type && isIndividualApproval(other));
}

/** O item é uma aprovação individual sua (a que libera o lote do agente naquele tipo)? */
const isIndividualApproval = (item: ForYouItem): boolean => item.status === "aprovado" && forYouKind(item) === "aprovacao" && item.decidedBy !== "automatico" && item.viaBatch !== true;

/**
 * Ids que não podem sair da lista viva para o arquivo, senão o lote de convite e post voltaria a pedir uma aprovação
 * individual: a aprovação individual MAIS RECENTE de cada agente em cada tipo guardado. É uma por agente e tipo, então
 * a lista viva não cresce por causa disso.
 */
export function batchHistoryKeepers(items: readonly ForYouItem[]): Set<string> {
  const latest = new Map<string, ForYouItem>();
  for (const item of items) {
    if (!BATCH_GUARDED_TYPES.includes(item.type) || !isIndividualApproval(item)) continue;
    const key = `${item.agentId}\u0000${item.type}`;
    const current = latest.get(key);
    if (!current || (item.decidedAt ?? item.createdAt) >= (current.decidedAt ?? current.createdAt)) latest.set(key, item);
  }
  return new Set([...latest.values()].map((item) => item.id));
}

/** Por que um item não pode entrar no lote (undefined = pode). Não olha o tipo comum: isso é do conjunto. */
export function batchExclusion(item: ForYouItem, all: readonly ForYouItem[]): BatchExclusionReason | undefined {
  if (item.status !== "pendente") return "not_pending";
  if (forYouKind(item) !== "aprovacao") return "not_approval";
  if (hasPendingEdit(item)) return "edited";
  if (BATCH_GUARDED_TYPES.includes(item.type) && !hasIndividualApproval(all, item.agentId, item.type)) return "no_history";
  return undefined;
}

export type BatchPlan = {
  /** Os que entram (na ordem pedida). */
  eligible: ForYouItem[];
  excluded: BatchExclusion[];
  /** Tipos diferentes entre os que entram: com mais de um, o lote não vale (um tipo por vez). */
  types: string[];
};

/** Separa os ids pedidos entre os que entram e os que ficam de fora (com o motivo). */
export function batchPlan(all: readonly ForYouItem[], ids: readonly string[]): BatchPlan {
  const byId = new Map(all.map((item) => [item.id, item]));
  const eligible: ForYouItem[] = [];
  const excluded: BatchExclusion[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    const reason: BatchExclusionReason | undefined = item ? batchExclusion(item, all) : "missing";
    if (reason) excluded.push({ id, reason, text: BATCH_EXCLUSION_TEXT[reason] });
    else if (item) eligible.push(item);
  }
  return { eligible, excluded, types: [...new Set(eligible.map((item) => item.type))] };
}
