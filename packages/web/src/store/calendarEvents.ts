import type { CalendarEvent, CalendarServerEvent } from "@cyno/shared";

/**
 * Aplica um evento `calendar:*` à lista (função pura; devolve o MESMO array se nada mudou).
 * Uma versão mais antiga que a da lista (`updatedAt` menor) é ignorada: assim, reaplicar os
 * eventos que chegaram durante um GET não volta um item para trás.
 */
export function applyCalendarEvent(items: readonly CalendarEvent[], event: CalendarServerEvent): CalendarEvent[] {
  const list = items as CalendarEvent[];
  if (event.type === "calendar:deleted") {
    const kept = list.filter((item) => item.id !== event.id);
    return kept.length === list.length ? list : kept;
  }
  const incoming = event.calendarEvent;
  const index = list.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...list, incoming];
  if (list[index]!.updatedAt > incoming.updatedAt) return list;
  return list.map((item, i) => (i === index ? incoming : item));
}
