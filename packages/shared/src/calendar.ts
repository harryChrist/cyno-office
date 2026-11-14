import { z } from "zod";
import { idSchema, roomIdSchema } from "./api";
import type { CalendarEvent } from "./types";

/** Limites dos campos de um evento do calendário. */
export const CALENDAR_LIMITS = { title: 200, notes: 2000 } as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2026-11-07" é um dia que existe no calendário? (rejeita "2026-02-30", "2026-13-01"...) */
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  // Dia 0 do mês seguinte = último dia deste mês (em UTC, sem depender do fuso).
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "09:30" (00:00 a 23:59)? */
export function isCalendarTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export const calendarDateSchema = z.string().refine(isCalendarDate, "data inválida: use um dia que exista, no formato AAAA-MM-DD");
export const calendarTimeSchema = z.string().refine(isCalendarTime, "hora inválida: use HH:MM, de 00:00 a 23:59");
const titleSchema = z
  .string()
  .trim()
  .min(1, "o título não pode ficar vazio")
  .max(CALENDAR_LIMITS.title, `o título pode ter até ${CALENDAR_LIMITS.title} caracteres`);
const notesSchema = z.string().trim().max(CALENDAR_LIMITS.notes, `as observações podem ter até ${CALENDAR_LIMITS.notes} caracteres`);

type Times = { time?: string | null; endTime?: string | null };

/** Problemas do horário: término sem início, ou antes do início. */
export function calendarTimeProblems({ time, endTime }: Times): string[] {
  if (!endTime) return [];
  if (!time) return ["o horário de término precisa de um horário de início"];
  if (endTime < time) return ["o horário de término não pode ser antes do início"];
  return [];
}

function checkTimes(value: Times, ctx: z.RefinementCtx): void {
  for (const message of calendarTimeProblems(value)) ctx.addIssue({ code: "custom", path: ["endTime"], message });
}

export const calendarEventSchema = z
  .object({
    id: idSchema,
    title: titleSchema,
    date: calendarDateSchema,
    time: calendarTimeSchema.optional(),
    endTime: calendarTimeSchema.optional(),
    roomId: roomIdSchema.optional(),
    notes: notesSchema.optional(),
    done: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine(checkTimes) satisfies z.ZodType<CalendarEvent>;

/** data/workspaces/<id>/calendar.json. */
export const calendarFileSchema = z.array(calendarEventSchema);

/** POST /api/w/:ws/calendar (campos extras = 400). */
export const createCalendarEventBodySchema = z
  .strictObject({
    title: titleSchema,
    date: calendarDateSchema,
    time: calendarTimeSchema.optional(),
    endTime: calendarTimeSchema.optional(),
    roomId: roomIdSchema.optional(),
    notes: notesSchema.optional(),
    done: z.boolean().optional(),
  })
  .superRefine(checkTimes);

/**
 * PATCH /api/w/:ws/calendar/:id: só os campos enviados mudam. `null` apaga um campo opcional
 * (hora, término, quarto, observações). O horário é conferido depois de juntar com o atual.
 */
export const updateCalendarEventBodySchema = z.strictObject({
  title: titleSchema.optional(),
  date: calendarDateSchema.optional(),
  time: calendarTimeSchema.nullable().optional(),
  endTime: calendarTimeSchema.nullable().optional(),
  roomId: roomIdSchema.nullable().optional(),
  notes: notesSchema.nullable().optional(),
  done: z.boolean().optional(),
});

/** GET /api/w/:ws/calendar?from=&to= (os dois opcionais e inclusivos). */
export const listCalendarQuerySchema = z
  .object({ from: calendarDateSchema.optional(), to: calendarDateSchema.optional() })
  .refine(({ from, to }) => !from || !to || from <= to, { path: ["to"], message: "o fim do período não pode ser antes do início" });

export type CreateCalendarEventBody = z.input<typeof createCalendarEventBodySchema>;
export type UpdateCalendarEventBody = z.input<typeof updateCalendarEventBodySchema>;
export type ListCalendarQuery = z.input<typeof listCalendarQuerySchema>;

/** Ordem do calendário: por dia; no dia, primeiro os sem hora (dia todo), depois por hora e título. */
export function compareCalendarEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const aTime = a.time ?? "";
  const bTime = b.time ?? "";
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return a.title.localeCompare(b.title, "pt-BR") || a.createdAt.localeCompare(b.createdAt);
}
