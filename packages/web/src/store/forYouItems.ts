import type { ForYouItem, ServerEvent, Task } from "@cyno/shared";

/** Itens do "Para você" do workspace atual; null = ainda não carregados (GET /for-you). */
export type ForYouItems = readonly ForYouItem[] | null;

/** Aplica um evento foryou:* (os outros devolvem a mesma lista). Antes do GET, ignora. */
export function applyForYouEvent(items: ForYouItems, event: ServerEvent): ForYouItems {
  if (items === null) return items;
  if (event.type === "foryou:deleted") {
    return items.some((item) => item.id === event.id) ? items.filter((item) => item.id !== event.id) : items;
  }
  if (event.type !== "foryou:upserted") return items;
  const index = items.findIndex((item) => item.id === event.item.id);
  if (index === -1) return [...items, event.item];
  return items.map((item, i) => (i === index ? event.item : item));
}

/** Quantos itens esperam o usuário (o selo da aba "Para você"). */
export function pendingCount(items: ForYouItems): number {
  return items ? items.reduce((sum, item) => sum + (item.status === "pendente" ? 1 : 0), 0) : 0;
}

/**
 * Item pendente ligado a uma tarefa: o da própria tarefa ou, numa tarefa do Maestro, o da
 * subtarefa do time (o mais novo).
 */
export function pendingItemForTask(items: ForYouItems, tasks: readonly Task[], taskId: string): ForYouItem | undefined {
  if (!items) return undefined;
  const ids = new Set([taskId, ...tasks.filter((task) => task.projectId === taskId).map((task) => task.id)]);
  return items.filter((item) => item.status === "pendente" && item.taskId !== undefined && ids.has(item.taskId)).at(-1);
}
