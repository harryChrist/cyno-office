import {
  CALENDAR_LIMITS,
  calendarDateSchema,
  calendarTimeSchema,
  createCalendarEventBodySchema,
  listCalendarQuerySchema,
  updateCalendarEventBodySchema,
  type CalendarEvent,
  type OfficeState,
} from "@cyno/shared";
import { z } from "zod";
import type { CalendarService } from "../workspace/calendar/calendar-service";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";
import { findByRef } from "./structure-tools";

/**
 * Calendário do workspace para o Maestro: o mesmo modelo das rotas /calendar (dia AAAA-MM-DD, hora
 * HH:MM opcional; sem hora = o dia todo) e o mesmo serviço, então o `calendar:upserted`/`deleted`
 * sai igual e a página do calendário atualiza ao vivo. Datas no fuso do servidor.
 */

export type CalendarToolsDeps = {
  state: { read(): OfficeState };
  calendar: Pick<CalendarService, "list" | "create" | "update" | "remove">;
  now: () => Date;
};

const error = (text: string): McpToolResult => ({ text, isError: true });
const ok = (text: string): McpToolResult => ({ text });

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (value: number) => String(value).padStart(2, "0");

/** Dia de hoje no fuso do servidor (AAAA-MM-DD). */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Dia da semana (em inglês, para o modelo) de um AAAA-MM-DD. */
function weekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()]!;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "local";

/** "Hoje é …": vai em toda resposta (o modelo não sabe o dia nem o fuso do servidor). */
function today(now: () => Date): string {
  const date = localDate(now());
  return `Today is ${date} (${weekday(date)}), server time zone ${serverZone()}.`;
}

function describeEvent(event: CalendarEvent, rooms: OfficeState["rooms"]): string {
  const when = event.time ? `${event.time}${event.endTime ? `–${event.endTime}` : ""}` : "all day";
  const room = event.roomId ? `; room: ${rooms.find((candidate) => candidate.id === event.roomId)?.name ?? event.roomId}` : "";
  const notes = event.notes ? `; notes: ${event.notes.replace(/\s+/g, " ").slice(0, 160)}` : "";
  return `- ${event.date} (${weekday(event.date).slice(0, 3)}) ${when} — ${event.title}${event.done ? " [done]" : ""} (id: ${event.id})${room}${notes}`;
}

const dateField = calendarDateSchema.describe("Day, YYYY-MM-DD (server time zone)");
const timeField = calendarTimeSchema.describe("Start time, HH:MM (24h). Omitted = all day");

export function calendarTools(deps: CalendarToolsDeps): McpTool[] {
  /** Quarto pelo id ou nome (os eventos podem ficar ligados a um quarto). */
  const roomId = (ref: string | undefined | null): string | undefined | null => {
    if (ref === undefined || ref === null) return ref;
    const room = findByRef(deps.state.read().rooms, ref);
    if (!room) throw new Error(`Room "${ref}" not found. See the ids with get_team.`);
    return room.id;
  };
  return [
    defineTool({
      name: "list_events",
      description: "Lists the workspace calendar events (POSTS and content plans of this workspace; commitments that take the owner's time are on agenda_list) between two days (inclusive). Default: from today to 30 days ahead. The answer starts with today's date.",
      input: z.object({
        from: dateField.optional().describe("First day, YYYY-MM-DD (default: today)"),
        to: dateField.optional().describe("Last day, YYYY-MM-DD (default: 30 days after from)"),
      }),
      call: ({ from, to }) => {
        const start = from ?? localDate(deps.now());
        const end = to ?? addDays(start, 30);
        const query = listCalendarQuerySchema.safeParse({ from: start, to: end });
        if (!query.success) return error(`${today(deps.now)} The end (to) cannot be before the start (from).`);
        const events = deps.calendar.list(query.data);
        const rooms = deps.state.read().rooms;
        const body = events.length > 0 ? events.map((event) => describeEvent(event, rooms)).join("\n") : "(no events)";
        return ok(`${today(deps.now)}\nEvents from ${start} to ${end}:\n${body}`);
      },
    }),
    defineTool({
      name: "create_event",
      description: "Adds a POST or content-plan event to the workspace calendar (the user sees it on the Calendar page, layer \"Postagens\", right away). It does NOT check the owner's time: for commitments that take the owner's time (meeting, call, recording), use agenda_book. Without time = all-day. Resolve relative dates (\"amanhã\", \"sexta\") from today's date (list_events shows it).",
      input: z.object({
        title: z.string().trim().min(1).max(CALENDAR_LIMITS.title).describe("Title, in Brazilian Portuguese"),
        date: dateField,
        time: timeField.optional(),
        end_time: calendarTimeSchema.optional().describe("End time, HH:MM (needs time)"),
        room: z.string().trim().min(1).max(64).optional().describe("Related room id (or name), if any"),
        notes: z.string().trim().max(CALENDAR_LIMITS.notes).optional().describe("Notes"),
      }),
      call: async ({ title, date, time, end_time, room, notes }) => {
        const body = createCalendarEventBodySchema.safeParse({
          title,
          date,
          ...(time ? { time } : {}),
          ...(end_time ? { endTime: end_time } : {}),
          ...(room ? { roomId: roomId(room) } : {}),
          ...(notes ? { notes } : {}),
        });
        if (!body.success) return error(`Event not created: ${body.error.issues.map((issue) => issue.message).join("; ")}.`);
        const created = await deps.calendar.create(body.data);
        return ok(`Event created:\n${describeEvent(created, deps.state.read().rooms)}\n${today(deps.now)}`);
      },
    }),
    defineTool({
      name: "update_event",
      description: "Changes a calendar event (by id, see list_events): only the fields you pass change; null clears time/end_time/room/notes (no time = all day). done: true marks it as done.",
      input: z.object({
        id: z.string().trim().min(1).max(64).describe("Event id"),
        title: z.string().trim().min(1).max(CALENDAR_LIMITS.title).optional(),
        date: dateField.optional(),
        time: calendarTimeSchema.nullable().optional().describe("HH:MM, or null = all day"),
        end_time: calendarTimeSchema.nullable().optional().describe("HH:MM, or null = no end"),
        room: z.string().trim().min(1).max(64).nullable().optional().describe("Room id (or name), or null = none"),
        notes: z.string().trim().max(CALENDAR_LIMITS.notes).nullable().optional(),
        done: z.boolean().optional(),
      }),
      call: async ({ id, title, date, time, end_time, room, notes, done }) => {
        const patch = updateCalendarEventBodySchema.parse({
          ...(title !== undefined ? { title } : {}),
          ...(date !== undefined ? { date } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(end_time !== undefined ? { endTime: end_time } : {}),
          ...(room !== undefined ? { roomId: roomId(room) } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(done !== undefined ? { done } : {}),
        });
        if (Object.keys(patch).length === 0) return error("Nothing to change.");
        const updated = await deps.calendar.update(id, patch);
        return ok(`Event updated:\n${describeEvent(updated, deps.state.read().rooms)}`);
      },
    }),
    defineTool({
      name: "delete_event",
      description: "Deletes a calendar event (by id, see list_events). Only when the user asked.",
      input: z.object({ id: z.string().trim().min(1).max(64).describe("Event id") }),
      call: async ({ id }) => {
        const event = deps.calendar.list().find((candidate) => candidate.id === id);
        if (!event) return error(`Event "${id}" not found. See the ids with list_events.`);
        await deps.calendar.remove(id);
        return ok(`Event “${event.title}” (${event.date}) deleted.`);
      },
    }),
  ];
}
