import { randomUUID } from "node:crypto";
import {
  calendarEventSchema,
  compareCalendarEvents,
  type CalendarEvent,
  type CreateCalendarEventBody,
  type ListCalendarQuery,
  type Room,
  type UpdateCalendarEventBody,
} from "@cyno/shared";
import { z } from "zod";
import type { EventHub } from "../../platform/events/hub";
import { HttpError } from "../../platform/http/errors";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";

export type CalendarDeps = {
  /** data/workspaces/<id>/calendar.json */
  file: string;
  /** A mesma fila de escrita do workspace (office.json e tasks.json). */
  queue: WriteQueue;
  /** Hub do workspace: os eventos só chegam aos sockets dele. */
  hub: EventHub;
  /** Quartos atuais do workspace (para validar `roomId`). */
  rooms: () => Room[];
  now: () => Date;
};

/** Erro de validação no mesmo formato do zod (400 { error: "Dados inválidos", details }). */
function invalid(path: string, message: string): z.ZodError {
  return new z.ZodError([{ code: "custom", path: [path], message, input: undefined }]);
}

/** Campos opcionais que o PATCH apaga com `null`. */
const CLEARABLE = ["time", "endTime", "roomId", "notes"] as const;

/**
 * Calendário de um workspace: lista em memória, persistida em calendar.json com escrita
 * atômica pela fila do workspace. Toda mudança publica `calendar:upserted`/`calendar:deleted`.
 */
export class CalendarService {
  /** `items`: o conteúdo de calendar.json (veja readCalendarFile). */
  constructor(
    private items: CalendarEvent[],
    private readonly deps: CalendarDeps,
  ) {}

  /** Eventos entre `from` e `to` (inclusivos; cada um opcional), na ordem do calendário. */
  list({ from, to }: ListCalendarQuery = {}): CalendarEvent[] {
    return this.items
      .filter((item) => (!from || item.date >= from) && (!to || item.date <= to))
      .sort(compareCalendarEvents)
      .map((item) => structuredClone(item));
  }

  async create(body: CreateCalendarEventBody): Promise<CalendarEvent> {
    this.requireRoom(body.roomId);
    const at = this.deps.now().toISOString();
    const created: CalendarEvent = calendarEventSchema.parse({
      ...body,
      id: randomUUID(),
      done: body.done ?? false,
      createdAt: at,
      updatedAt: at,
    });
    await this.commit([...this.items, created], created);
    return structuredClone(created);
  }

  async update(id: string, patch: UpdateCalendarEventBody): Promise<CalendarEvent> {
    const current = this.require(id);
    if (typeof patch.roomId === "string" && patch.roomId !== current.roomId) this.requireRoom(patch.roomId);
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null && (CLEARABLE as readonly string[]).includes(key)) delete merged[key];
      else merged[key] = value;
    }
    // Tirar a hora de início leva junto o término (senão o evento ficaria inválido).
    if (patch.time === null && patch.endTime === undefined) delete merged.endTime;
    merged.updatedAt = this.deps.now().toISOString();
    const updated: CalendarEvent = calendarEventSchema.parse(merged);
    await this.commit(
      this.items.map((item) => (item.id === id ? updated : item)),
      updated,
    );
    return structuredClone(updated);
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    const next = this.items.filter((item) => item.id !== id);
    this.items = next;
    const write = this.write(next);
    this.deps.hub.publish({ type: "calendar:deleted", id });
    await write;
  }

  /** Quantos eventos estão ligados ao quarto. */
  countByRoom(roomId: string): number {
    return this.items.filter((item) => item.roomId === roomId).length;
  }

  /** Quarto removido: os eventos dele saem juntos (um calendar:deleted por evento). */
  async removeByRoom(roomId: string): Promise<number> {
    const removed = this.items.filter((item) => item.roomId === roomId);
    if (removed.length === 0) return 0;
    const next = this.items.filter((item) => item.roomId !== roomId);
    this.items = next;
    const write = this.write(next);
    for (const item of removed) this.deps.hub.publish({ type: "calendar:deleted", id: item.id });
    await write;
    return removed.length;
  }

  private require(id: string): CalendarEvent {
    const found = this.items.find((item) => item.id === id);
    if (!found) throw new HttpError(404, `Evento "${id}" não encontrado`);
    return found;
  }

  private requireRoom(roomId: string | undefined): void {
    if (roomId === undefined) return;
    if (!this.deps.rooms().some((room) => room.id === roomId)) {
      throw invalid("roomId", `a sala "${roomId}" não existe neste workspace`);
    }
  }

  /** Troca a lista na hora (síncrono), grava em disco e publica o evento. */
  private async commit(next: CalendarEvent[], changed: CalendarEvent): Promise<void> {
    this.items = next;
    const write = this.write(next);
    this.deps.hub.publish({ type: "calendar:upserted", calendarEvent: structuredClone(changed) });
    await write;
  }

  private write(items: CalendarEvent[]): Promise<void> {
    const data = structuredClone(items);
    return this.deps.queue.enqueue(() => writeJsonAtomic(this.deps.file, data));
  }
}
