import {
  AGENDA_LIMITS,
  AGENDA_SEARCH_DAYS,
  AGENDA_STEP_MINUTES,
  AGENDA_SUGGESTIONS,
  type AgendaEvent,
  type Availability,
  type FreeSlot,
  type SlotCheck,
  type SlotConflict,
  type SlotProblem,
} from "./agenda";
import { localInstant } from "./routine-schedule";
import { pad2, shiftDay, zoned } from "./routines";

/**
 * A conferência da "Sua agenda", em código e sem IA: funções puras (o chamador passa `now`) que dizem
 * se um horário serve (choque com outro compromisso, fora da disponibilidade, antecedência mínima) e
 * quais são os próximos horários livres. Tudo vale no fuso da disponibilidade.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

type Interval = { start: number; end: number };
type Local = { year: number; month: number; day: number };

/** O dia local (y/m/d) do instante no fuso. */
export function localDayOf(ms: number, timeZone: string): Local {
  const p = zoned(ms, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** "AAAA-MM-DD" do dia local do instante. */
export function localDateKey(ms: number, timeZone: string): string {
  const d = localDayOf(ms, timeZone);
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** O instante de "HH:MM" num dia local ("24:00" = início do dia seguinte). */
function instantOf(day: Local, time: string, timeZone: string): number {
  const minutes = minutesOf(time);
  if (minutes >= 24 * 60) {
    const next = shiftDay(day.year, day.month, day.day, 1);
    return localInstant(next, 0, 0, timeZone);
  }
  return localInstant(day, Math.floor(minutes / 60), minutes % 60, timeZone);
}

/** As janelas de disponibilidade de um dia local (a exceção do dia manda; `off` não deixa nenhuma). */
function windowsOfDay(availability: Availability, day: Local): { from: string; to: string }[] {
  const key = `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
  const exception = availability.exceptions.find((candidate) => candidate.date === key);
  if (exception) return exception.off || !exception.from || !exception.to ? [] : [{ from: exception.from, to: exception.to }];
  const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  return availability.weekly.filter((window) => window.weekday === weekday).map(({ from, to }) => ({ from, to }));
}

/**
 * Os intervalos (em ms, juntando os que se encostam, até os de dias vizinhos) em que o dono está
 * disponível, cobrindo de `fromMs` a `toMs`. Um compromisso que atravessa a meia-noite só cabe se as
 * janelas dos dois dias se encostam (ex.: até 24:00 e a partir de 00:00).
 */
export function availabilityIntervals(availability: Availability, fromMs: number, toMs: number): Interval[] {
  const zone = availability.timezone;
  const first = localDayOf(fromMs - DAY, zone);
  const lastMs = toMs + DAY;
  const intervals: Interval[] = [];
  for (let ahead = 0; ahead < 4000; ahead += 1) {
    const day = shiftDay(first.year, first.month, first.day, ahead);
    if (instantOf(day, "00:00", zone) > lastMs) break;
    for (const window of windowsOfDay(availability, day)) {
      const start = instantOf(day, window.from, zone);
      const end = instantOf(day, window.to, zone);
      if (end > start) intervals.push({ start, end });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

const active = (events: readonly AgendaEvent[], ignoreId?: string) => events.filter((event) => event.status === "marcado" && event.id !== ignoreId);

/** Compromissos que tocam [start, end) respeitando o intervalo entre compromissos. */
function conflictsOf(events: readonly AgendaEvent[], start: number, end: number, bufferMs: number): AgendaEvent[] {
  return events.filter((event) => start < Date.parse(event.end) + bufferMs && end > Date.parse(event.start) - bufferMs);
}

const toConflict = (event: AgendaEvent): SlotConflict => ({ id: event.id, title: event.title, start: event.start, end: event.end, ...(event.workspace ? { workspace: event.workspace } : {}) });
const iso = (ms: number) => new Date(ms).toISOString();
const ceilTo = (ms: number, step: number) => Math.ceil(ms / step) * step;

export type SlotOptions = {
  now: Date;
  /** Ignora este compromisso (ao mover o próprio). */
  ignoreId?: string;
  /** O dono não precisa respeitar a antecedência mínima. */
  skipNotice?: boolean;
};

/** "qui 12/11 17:00" no fuso (para as mensagens). */
export function describeInstant(ms: number, timeZone: string): string {
  const p = zoned(ms, timeZone);
  const weekday = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]!;
  return `${weekday} ${pad2(p.day)}/${pad2(p.month)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

function describeRange(startMs: number, endMs: number, timeZone: string): string {
  const e = zoned(endMs, timeZone);
  const sameDay = localDateKey(startMs, timeZone) === localDateKey(endMs, timeZone);
  return `${describeInstant(startMs, timeZone)}-${sameDay ? `${pad2(e.hour)}:${pad2(e.minute)}` : describeInstant(endMs, timeZone)}`;
}

/**
 * O horário [start, end) serve? Ordem dos problemas: duração inválida, antecedência, fora da
 * disponibilidade, choque. O resultado de um problema já traz as sugestões (`nextFree`, 3 horários
 * livres de mesma duração a partir do pedido).
 */
export function checkSlot(events: readonly AgendaEvent[], availability: Availability, slot: { start: string; end: string }, options: SlotOptions): SlotCheck {
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  const zone = availability.timezone;
  const refuse = (problem: SlotProblem, reason: string, conflicts: SlotConflict[] = []): SlotCheck => ({
    ok: false,
    problem,
    reason,
    conflicts,
    nextFree: Number.isFinite(start) && end > start ? suggestSlots(events, availability, { start, end }, options) : [],
  });
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return refuse("invalid", "O fim precisa ser depois do início");
  if (end - start > AGENDA_LIMITS.maxDurationMinutes * MINUTE) return refuse("invalid", "Um compromisso não pode durar mais de 24 horas");
  const nowMs = options.now.getTime();
  if (!options.skipNotice) {
    const earliest = nowMs + availability.minNoticeMinutes * MINUTE;
    if (start < earliest) {
      return refuse("notice", start < nowMs ? "Esse horário já passou" : `Falta menos que a antecedência mínima (${availability.minNoticeMinutes} min) para esse horário`);
    }
  }
  const inside = availabilityIntervals(availability, start, end).some((interval) => interval.start <= start && interval.end >= end);
  const bufferMs = availability.bufferMinutes * MINUTE;
  const conflicts = conflictsOf(active(events, options.ignoreId), start, end, bufferMs).sort((a, b) => a.start.localeCompare(b.start));
  if (!inside) return refuse("outside_availability", `Fora da disponibilidade do dono (${describeRange(start, end, zone)})`, conflicts.map(toConflict));
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    const where = first.workspace ? ` (${first.workspace})` : "";
    return refuse("conflict", `Choca com "${first.title}"${where}, ${describeRange(Date.parse(first.start), Date.parse(first.end), zone)}`, conflicts.map(toConflict));
  }
  return { ok: true };
}

export type FreeSlotOptions = SlotOptions & {
  /** Duração de cada horário. */
  durationMs: number;
  /** A partir de quando procurar (padrão: agora). */
  from?: number;
  /** Até quando (o horário inteiro precisa caber). Padrão: 30 dias depois de `from`. */
  until?: number;
  /** Quantos devolver (padrão 3). */
  count?: number;
  /** Passo entre candidatos em minutos (padrão 15). */
  stepMinutes?: number;
};

/**
 * Os próximos horários livres de uma duração: dentro da disponibilidade, depois da antecedência
 * mínima, sem tocar em outro compromisso (com o intervalo entre eles). As sugestões não se sobrepõem
 * (a seguinte começa depois do fim da anterior) e andam em passos de 15 minutos.
 */
export function nextFreeSlots(events: readonly AgendaEvent[], availability: Availability, options: FreeSlotOptions): FreeSlot[] {
  const step = (options.stepMinutes ?? AGENDA_STEP_MINUTES) * MINUTE;
  const count = options.count ?? AGENDA_SUGGESTIONS;
  const nowMs = options.now.getTime();
  const from = Math.max(options.from ?? nowMs, nowMs, options.skipNotice ? 0 : nowMs + availability.minNoticeMinutes * MINUTE);
  const until = options.until ?? from + AGENDA_SEARCH_DAYS * DAY;
  const bufferMs = availability.bufferMinutes * MINUTE;
  const busy = active(events, options.ignoreId).sort((a, b) => a.start.localeCompare(b.start));
  const intervals = availabilityIntervals(availability, from, until);
  const out: FreeSlot[] = [];
  let cursor = ceilTo(from, step);
  for (let guard = 0; guard < 20_000 && out.length < count && cursor + options.durationMs <= until; guard += 1) {
    const interval = intervals.find((candidate) => candidate.end > cursor);
    if (!interval) break;
    if (cursor < interval.start) {
      cursor = ceilTo(interval.start, step);
      continue;
    }
    if (cursor + options.durationMs > interval.end) {
      cursor = interval.end;
      continue;
    }
    const clash = conflictsOf(busy, cursor, cursor + options.durationMs, bufferMs);
    if (clash.length > 0) {
      cursor = ceilTo(Math.max(...clash.map((event) => Date.parse(event.end))) + bufferMs, step);
      continue;
    }
    out.push({ start: iso(cursor), end: iso(cursor + options.durationMs) });
    cursor = ceilTo(cursor + options.durationMs, step);
  }
  return out;
}

/**
 * As `AGENDA_SUGGESTIONS` sugestões mais próximas do horário pedido: as livres nas 24 horas ANTES dele
 * (ainda depois de agora) e as próximas DEPOIS, escolhidas pela menor distância e devolvidas em ordem
 * cronológica. Quando não há nada livre antes, são só as próximas depois.
 */
export function suggestSlots(events: readonly AgendaEvent[], availability: Availability, request: { start: number; end: number }, options: SlotOptions): FreeSlot[] {
  const durationMs = request.end - request.start;
  const after = nextFreeSlots(events, availability, { ...options, durationMs, from: request.start });
  const before = nextFreeSlots(events, availability, { ...options, durationMs, from: request.start - DAY, until: request.start, count: 96 });
  const distance = (slot: FreeSlot) => Math.abs(Date.parse(slot.start) - request.start);
  return [...before, ...after]
    .sort((a, b) => distance(a) - distance(b) || a.start.localeCompare(b.start))
    .slice(0, AGENDA_SUGGESTIONS)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** "qui 12/11 17:00-18:00" de uma sugestão. */
export function describeFreeSlot(slot: FreeSlot, timeZone: string): string {
  return describeRange(Date.parse(slot.start), Date.parse(slot.end), timeZone);
}

export { describeRange as describeAgendaRange };
