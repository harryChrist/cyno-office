import { AGENDA_KINDS, AGENDA_LIMITS, AGENDA_TIMEZONE, localDateKey, localInstant, shiftDay, zoned, type AgendaEvent, type FreeSlot, type SlotCheck } from "@cyno/shared";
import { z } from "zod";
import type { AgendaActor, AgendaService } from "../platform/agenda/agenda-service";
import { HttpError } from "../platform/http/errors";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";

/**
 * "Sua agenda" para os Maestros, os agentes de time e o Cyno: o tempo do DONO é um só para a
 * plataforma inteira. Quem tenta marcar (`agenda_book`) passa pela conferência do servidor (choque,
 * disponibilidade, antecedência): se não serve, volta `NOT BOOKED` com o motivo e 3 horários livres.
 * Não existe "forçar" por aqui (só o dono sobrepõe, pela tela). Os horários são do fuso de São Paulo
 * quando vêm sem deslocamento. Workspaces só veem, de outros workspaces, "BUSY" sem detalhes.
 */

export type AgendaToolsDeps = {
  agenda: Pick<AgendaService, "book" | "change" | "cancel" | "list" | "freeSlots" | "getAvailability" | "get">;
  actor: Extract<AgendaActor, { kind: "agente" | "cyno" }>;
  now: () => Date;
  workspaceName?: (id: string) => string | undefined;
  /** A tarefa que o agente está executando: o compromisso nasce ligado a ela (e ao projeto). */
  currentTask?: () => { id: string; projectId?: string; work?: { projectId: string } } | undefined;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (value: number) => String(value).padStart(2, "0");
const MINUTE = 60_000;
const DAY = 86_400_000;

const result = (text: string, isError = false): McpToolResult => ({ text, ...(isError ? { isError: true } : {}) });

/** "2026-11-12T17:00" (hora de São Paulo), o formato que as ferramentas aceitam de volta. */
function localIso(ms: number, zone: string): string {
  const p = zoned(ms, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function weekday(ms: number, zone: string): string {
  const p = zoned(ms, zone);
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]!;
}

/** "Thu 2026-11-12 17:00-18:00" (o fim só leva o dia se for outro dia). */
function range(startMs: number, endMs: number, zone: string): string {
  const same = localDateKey(startMs, zone) === localDateKey(endMs, zone);
  return `${weekday(startMs, zone)} ${localIso(startMs, zone).replace("T", " ")}-${same ? localIso(endMs, zone).slice(11) : `${weekday(endMs, zone)} ${localIso(endMs, zone).replace("T", " ")}`}`;
}

/** Instante de "AAAA-MM-DDTHH:MM[:SS][Z|±HH:MM]"; sem deslocamento vale a hora de São Paulo. */
export function parseAgendaInstant(value: string, zone: string = AGENDA_TIMEZONE): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, offset] = match;
  if (Number(h) > 23 || Number(mi) > 59) return undefined;
  if (offset) {
    const fixed = offset.toUpperCase() === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${fixed}`);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const day = { year: Number(y), month: Number(mo), day: Number(d) };
  if (day.month < 1 || day.month > 12 || day.day < 1 || day.day > 31) return undefined;
  return localInstant(day, Number(h), Number(mi), zone) + Number(s ?? 0) * 1000;
}

/** Dia puro ("AAAA-MM-DD") ou data e hora; `edge` diz se o dia puro vale o começo ou o fim do dia. */
function parseBound(value: string, edge: "start" | "end", zone: string): number | undefined {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) {
    const base = { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) };
    const at = edge === "start" ? base : shiftDay(base.year, base.month, base.day, 1);
    return localInstant(at, 0, 0, zone);
  }
  return parseAgendaInstant(value, zone);
}

const startField = z.string().trim().min(10).max(40).describe('Start: "YYYY-MM-DDTHH:MM" in the owner\'s time zone (America/Sao_Paulo), e.g. "2026-11-12T17:00". An explicit offset ("-03:00", "Z") is also accepted');

/** O que um agente vê como motivo: do outro workspace só diz que está ocupado. */
function explain(check: Extract<SlotCheck, { ok: false }>, deps: AgendaToolsDeps, zone: string): string {
  const own = deps.actor.kind === "agente" ? deps.actor.workspace : undefined;
  const lines: string[] = [];
  switch (check.problem) {
    case "invalid":
      lines.push(`the time range is invalid (${check.reason})`);
      break;
    case "notice":
      lines.push("it is too soon: the owner needs more notice, or the time already passed");
      break;
    case "outside_availability":
      lines.push("it is outside the hours the owner marked as available");
      break;
    case "conflict":
      lines.push("the owner is already busy at that time");
      break;
  }
  for (const conflict of check.conflicts) {
    const visible = deps.actor.kind === "cyno" || conflict.workspace === own;
    const when = range(Date.parse(conflict.start), Date.parse(conflict.end), zone);
    lines.push(visible ? `conflicts with "${conflict.title}" (${conflict.id}) ${when}` : `busy ${when} (another workspace's commitment)`);
  }
  return lines.join("; ");
}

function suggestions(slots: FreeSlot[], zone: string): string {
  if (slots.length === 0) return `No free slot of that length in the next 30 days.`;
  return `Nearest free slots (${zone}): ${slots.map((slot, index) => `${index + 1}) ${weekday(Date.parse(slot.start), zone)} ${localIso(Date.parse(slot.start), zone)} to ${localIso(Date.parse(slot.end), zone).slice(11)}`).join("; ")}.`;
}

export function agendaTools(deps: AgendaToolsDeps): McpTool[] {
  const { agenda, actor } = deps;
  const zone = () => agenda.getAvailability().timezone;
  const isCyno = actor.kind === "cyno";
  const today = () => {
    const now = deps.now();
    return `Now: ${weekday(now.getTime(), zone())} ${localIso(now.getTime(), zone())} (${zone()}).`;
  };
  const nameOf = (workspace: string | undefined) => (workspace ? (deps.workspaceName?.(workspace) ?? workspace) : "owner");
  const canTouch = (event: AgendaEvent) => isCyno || event.workspace === (actor.kind === "agente" ? actor.workspace : undefined);

  const book = defineTool({
    name: "agenda_book",
    description:
      "Books something that uses the OWNER's time (meeting, call, recording, deadline) on the owner's agenda, which is ONE for the whole platform and shared by every workspace. The server checks for clashes with other commitments (from any workspace), the hours the owner is available and the minimum notice. If free, it books. If not, it answers `NOT BOOKED` with the reason and 3 nearby free slots: then offer those slots to the user (ask in the chat, or with ask_user) and book the one they choose. There is no way to force it. Do not use it for post schedules (create_event). Times are in the owner's time zone (America/Sao_Paulo). Resolve relative dates (\"amanhã\", \"sexta\") from the date given in the answer of agenda_list.",
    input: z.object({
      title: z.string().trim().min(1).max(AGENDA_LIMITS.title).describe("Title, in Brazilian Portuguese"),
      start: startField,
      end: z.string().trim().min(10).max(40).optional().describe("End, same format as start (or use duration_minutes)"),
      duration_minutes: z.number().int().min(5).max(AGENDA_LIMITS.maxDurationMinutes).optional().describe("Length in minutes (default: the owner's default, usually 60)"),
      kind: z.enum(AGENDA_KINDS).optional().describe("reuniao (meeting), call, gravacao (recording), prazo (deadline), pessoal, outro"),
      notes: z.string().trim().max(AGENDA_LIMITS.notes).optional().describe("Notes (agenda, who, what to bring), in Brazilian Portuguese"),
      link: z.string().trim().max(AGENDA_LIMITS.link).optional().describe("Call or meeting link"),
      location: z.string().trim().max(AGENDA_LIMITS.location).optional().describe("Place, if in person"),
    }),
    call: async ({ title, start, end, duration_minutes, kind, notes, link, location }) => {
      const startMs = parseAgendaInstant(start, zone());
      if (startMs === undefined) return result(`NOT BOOKED: "${start}" is not a valid start. Use "YYYY-MM-DDTHH:MM" (owner time zone). ${today()}`, true);
      let endMs: number | undefined;
      if (end) {
        endMs = parseAgendaInstant(end, zone());
        if (endMs === undefined) return result(`NOT BOOKED: "${end}" is not a valid end. Use "YYYY-MM-DDTHH:MM". ${today()}`, true);
      } else {
        endMs = startMs + (duration_minutes ?? agenda.getAvailability().defaultDurationMinutes) * MINUTE;
      }
      const task = deps.currentTask?.();
      const projectId = task?.projectId ?? task?.work?.projectId;
      try {
        const outcome = await agenda.book(
          { title, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), ...(kind ? { kind } : {}), ...(notes ? { notes } : {}), ...(link ? { link } : {}), ...(location ? { location } : {}), ...(projectId ? { projectId } : {}), ...(task ? { taskId: task.id } : {}) },
          actor,
        );
        if (outcome.ok) return result(`BOOKED ${outcome.event.id}: "${outcome.event.title}" ${range(startMs, endMs, zone())}. It is on the owner's agenda ("Sua agenda").`);
        const check = outcome.check;
        return result(`NOT BOOKED: ${explain(check, deps, zone())}. ${suggestions(check.nextFree, zone())} Do not insist on this time: offer the options to the user (chat or ask_user) and, when they pick one, call agenda_book again with it. ${today()}`, true);
      } catch (error) {
        if (error instanceof HttpError) return result(`NOT BOOKED: ${error.message}.`, true);
        throw error;
      }
    },
  });

  const freeSlots = defineTool({
    name: "agenda_free_slots",
    description: "Lists the owner's free slots of a given length between two moments, inside the hours the owner is available, respecting the minimum notice and the gap between commitments (up to 10 slots, from the earliest). Use it before proposing a time to the user.",
    input: z.object({
      from: z.string().trim().min(10).max(40).describe('Start of the search: "YYYY-MM-DD" (the whole day) or "YYYY-MM-DDTHH:MM"'),
      to: z.string().trim().min(10).max(40).describe('End of the search: "YYYY-MM-DD" (that day included) or "YYYY-MM-DDTHH:MM"'),
      duration_minutes: z.number().int().min(5).max(AGENDA_LIMITS.maxDurationMinutes).describe("How long the commitment is"),
    }),
    call: ({ from, to, duration_minutes }) => {
      const fromMs = parseBound(from, "start", zone());
      const toMs = parseBound(to, "end", zone());
      if (fromMs === undefined || toMs === undefined || toMs <= fromMs) return result(`Invalid range. Use "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" and a "to" after "from". ${today()}`, true);
      const slots = agenda.freeSlots({ from: fromMs, to: toMs, durationMinutes: duration_minutes, count: 10 }, actor);
      return result(`${today()}\n${slots.length === 0 ? `No free ${duration_minutes}-minute slot between ${localIso(fromMs, zone())} and ${localIso(toMs, zone())}.` : `Free ${duration_minutes}-minute slots (${zone()}), earliest first:\n${slots.map((slot) => `- ${weekday(Date.parse(slot.start), zone())} ${localIso(Date.parse(slot.start), zone())} to ${localIso(Date.parse(slot.end), zone()).slice(11)}`).join("\n")}`}`);
    },
  });

  const list = defineTool({
    name: "agenda_list",
    description: isCyno
      ? "Lists the owner's agenda between two days, with every commitment (title, who booked it, from which workspace). Default: today to 7 days ahead. The answer starts with the current date and time."
      : "Shows the owner's agenda between two days: your workspace's commitments with title, and everything else as BUSY (no details: it belongs to other workspaces), plus the hours the owner is available. Default: today to 7 days ahead. The answer starts with the current date and time.",
    input: z.object({
      from: z.string().trim().min(10).max(40).optional().describe('First day, "YYYY-MM-DD" (default: today)'),
      to: z.string().trim().min(10).max(40).optional().describe('Last day, "YYYY-MM-DD" (default: 7 days after from)'),
    }),
    call: ({ from, to }) => {
      const now = deps.now();
      const fromMs = from ? parseBound(from, "start", zone()) : parseBound(localDateKey(now.getTime(), zone()), "start", zone());
      const toMs = to ? parseBound(to, "end", zone()) : fromMs === undefined ? undefined : fromMs + 7 * DAY;
      if (fromMs === undefined || toMs === undefined || toMs <= fromMs) return result(`Invalid range. Use "YYYY-MM-DD". ${today()}`, true);
      const events = agenda.list({ from: fromMs, to: toMs });
      const availability = agenda.getAvailability();
      const hours = availability.weekly.length === 0 ? "no weekly hours set" : availability.weekly.map((window) => `${WEEKDAYS[window.weekday]} ${window.from}-${window.to}`).join(", ");
      const own = actor.kind === "agente" ? actor.workspace : undefined;
      const lines = events.map((event) => {
        const when = range(Date.parse(event.start), Date.parse(event.end), zone());
        if (isCyno) return `- ${when} · "${event.title}" (${event.id}) · ${event.workspace ? `workspace: ${nameOf(event.workspace)}` : "booked by the owner"}${event.by.name ? ` · by ${event.by.name}` : ""}${event.link ? ` · ${event.link}` : ""}`;
        if (event.workspace === own) return `- ${when} · "${event.title}" (${event.id}, yours)${event.link ? ` · ${event.link}` : ""}${event.notes ? ` · ${event.notes.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
        return `- ${when} · BUSY`;
      });
      return result(
        `${today()}\nOwner's available hours: ${hours}; minimum notice ${availability.minNoticeMinutes} min; gap between commitments ${availability.bufferMinutes} min.\nAgenda from ${localIso(fromMs, zone()).slice(0, 10)} to ${localIso(toMs - 1, zone()).slice(0, 10)}:\n${lines.length > 0 ? lines.join("\n") : "(nothing booked: the whole available time is free)"}`,
      );
    },
  });

  const cancel = defineTool({
    name: "agenda_cancel",
    description: isCyno ? "Cancels a commitment on the owner's agenda (by id, see agenda_list). Only when the user asked." : "Cancels a commitment that YOUR workspace booked (by id, see agenda_list). You cannot cancel the ones of other workspaces. Only when the user asked or the commitment no longer makes sense.",
    input: z.object({ id: z.string().trim().min(1).max(40).describe("Commitment id, e.g. G-0007"), reason: z.string().trim().max(300).optional().describe("Why, in Brazilian Portuguese") }),
    call: async ({ id, reason }) => {
      const event = agenda.get(id);
      if (!event) return result(`Commitment "${id}" not found. See the ids with agenda_list.`, true);
      if (!canTouch(event)) return result(`Not cancelled: ${id} was booked by another workspace. Only the owner (or the platform agent) can cancel it.`, true);
      try {
        await agenda.cancel(id, actor, reason);
        return result(`Cancelled ${id}: "${event.title}" ${range(Date.parse(event.start), Date.parse(event.end), zone())}. The time is free again.`);
      } catch (error) {
        if (error instanceof HttpError) return result(`Not cancelled: ${error.message}.`, true);
        throw error;
      }
    },
  });

  const move = defineTool({
    name: "agenda_move",
    description:
      isCyno
        ? "Moves a commitment on the owner's agenda to a new start (same length unless end or duration_minutes is given). The same check as agenda_book applies: on a clash, NOT MOVED with 3 free slots."
        : "Moves a commitment that YOUR workspace booked to a new start (same length unless end or duration_minutes is given). The same check as agenda_book applies: on a clash or outside the owner's hours, NOT MOVED with 3 free slots (it stays where it was).",
    input: z.object({
      id: z.string().trim().min(1).max(40).describe("Commitment id, e.g. G-0007"),
      start: startField,
      end: z.string().trim().min(10).max(40).optional().describe("New end (or use duration_minutes)"),
      duration_minutes: z.number().int().min(5).max(AGENDA_LIMITS.maxDurationMinutes).optional(),
    }),
    call: async ({ id, start, end, duration_minutes }) => {
      const event = agenda.get(id);
      if (!event) return result(`Commitment "${id}" not found. See the ids with agenda_list.`, true);
      if (!canTouch(event)) return result(`Not moved: ${id} was booked by another workspace. Only the owner (or the platform agent) can move it.`, true);
      const startMs = parseAgendaInstant(start, zone());
      if (startMs === undefined) return result(`NOT MOVED: "${start}" is not a valid start. ${today()}`, true);
      const length = duration_minutes ? duration_minutes * MINUTE : Date.parse(event.end) - Date.parse(event.start);
      const endMs = end ? parseAgendaInstant(end, zone()) : startMs + length;
      if (endMs === undefined) return result(`NOT MOVED: "${end}" is not a valid end. ${today()}`, true);
      try {
        const outcome = await agenda.change(id, { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }, actor);
        if (outcome.ok) return result(`MOVED ${id}: "${outcome.event.title}" is now ${range(startMs, endMs, zone())}.`);
        return result(`NOT MOVED: ${explain(outcome.check, deps, zone())}. ${suggestions(outcome.check.nextFree, zone())} It stays at ${range(Date.parse(event.start), Date.parse(event.end), zone())}. Offer the options to the user before trying again.`, true);
      } catch (error) {
        if (error instanceof HttpError) return result(`NOT MOVED: ${error.message}.`, true);
        throw error;
      }
    },
  });

  return [book, freeSlots, list, move, cancel];
}
