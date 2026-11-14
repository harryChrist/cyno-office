import { addDays, dayKeyOf, dayStart, parseDayKey, parseGestaoClock, parseGestaoWeekly, periodBounds, periodBoundsOfKey, ROUTINE_TIMEZONE, startOfLocalDay, type ReportKind } from "@cyno/shared";

/** Um período de relatório: [from, to) em ms, dias e semanas de São Paulo (nunca o fuso da máquina). */
export type Period = { kind: ReportKind; key: string; from: number; to: number };

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const HOUR = 3_600_000;

/** A semana (ISO) pertence ao mês da sua quinta-feira: "2026-W46" -> "2026-11". */
export function monthOfWeek(week: Period): string {
  return dayKeyOf(week.from + 3 * 24 * HOUR + HOUR).slice(0, 7);
}

function weekPeriod(key: string): Period | undefined {
  const bounds = WEEK_RE.test(key) ? periodBoundsOfKey(key) : undefined;
  return bounds ? { kind: "week", key, from: bounds.start.getTime(), to: bounds.end.getTime() } : undefined;
}

function dayPeriod(key: string): Period | undefined {
  if (!parseDayKey(key)) return undefined;
  return { kind: "day", key, from: dayStart(key), to: dayStart(addDays(key, 1)) };
}

/** As semanas (da mais antiga à mais nova) que pertencem ao mês "2026-11" (pela quinta-feira). */
export function weeksOfMonth(monthKey: string): Period[] {
  const match = MONTH_RE.exec(monthKey);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return [];
  const first = startOfLocalDay(Number(match[1]), Number(match[2]), 1, ROUTINE_TIMEZONE);
  const weeks: Period[] = [];
  let bounds = periodBounds(new Date(first + HOUR));
  for (let i = 0; i < 7; i += 1) {
    const week = weekPeriod(bounds.key);
    if (week && monthOfWeek(week) === monthKey) weeks.push(week);
    bounds = periodBounds(new Date(bounds.end.getTime() + HOUR));
  }
  return weeks;
}

/** O mês vai do começo da primeira semana ao fim da última (as semanas que a quinta-feira põe nele). */
function monthPeriod(key: string): Period | undefined {
  const weeks = weeksOfMonth(key);
  if (weeks.length === 0) return undefined;
  return { kind: "month", key, from: weeks[0]!.from, to: weeks.at(-1)!.to };
}

/** A chave tem a forma do tipo (dia 2026-11-10, semana 2026-W46, mês 2026-11)? Só a forma: se existe, é outra conversa (404). */
export function hasPeriodFormat(kind: ReportKind, key: string): boolean {
  return (kind === "day" ? /^\d{4}-\d{2}-\d{2}$/ : kind === "week" ? /^\d{4}-W\d{2}$/ : /^\d{4}-\d{2}$/).test(key);
}

/** O período de uma chave ("2026-11-10", "2026-W46", "2026-11"); undefined se a chave não vale para o tipo. */
export function periodOf(kind: ReportKind, key: string): Period | undefined {
  if (kind === "day") return dayPeriod(key);
  if (kind === "week") return weekPeriod(key);
  return monthPeriod(key);
}

/** O período que contém o instante (o mês é o da quinta-feira da semana do instante). */
export function periodAt(kind: ReportKind, ms: number): Period {
  if (kind === "day") return dayPeriod(dayKeyOf(ms))!;
  const week = weekPeriod(periodBounds(new Date(ms)).key)!;
  return kind === "week" ? week : monthPeriod(monthOfWeek(week))!;
}

/** O período anterior ao `period`. */
export function previousPeriod(period: Period): Period {
  return periodAt(period.kind, period.from - HOUR);
}

/** O último período JÁ FECHADO (ontem, a semana passada, o mês passado). */
export function latestClosed(kind: ReportKind, now: number): Period {
  return previousPeriod(periodAt(kind, now));
}

/** "latest", vazio ou uma chave -> o período. Texto que não vale: undefined. */
export function resolvePeriod(kind: ReportKind, requested: string | undefined, now: number): Period | undefined {
  const text = requested?.trim();
  if (!text || text === "latest") return latestClosed(kind, now);
  return periodOf(kind, text);
}

/** O período já fechou? */
export const isClosed = (period: Period, now: number): boolean => now >= period.to;

export type DueMoment = { at: number; period: Period };

/**
 * O último horário da cerimônia que já chegou (`at`) e o período que ela fecha. Dia: hoje às HH:MM (ou ontem, se ainda não
 * deu a hora). Semana: o último "seg 08:30": na segunda fecha a semana que passou; em outro dia, a semana que contém o horário.
 */
export function dailyDue(dailyAt: string, now: number): DueMoment | undefined {
  const minutes = parseGestaoClock(dailyAt);
  if (minutes === undefined) return undefined;
  const at = (key: string) => dayStart(key) + minutes * 60_000;
  const today = dayKeyOf(now);
  const key = at(today) <= now ? today : addDays(today, -1);
  return { at: at(key), period: dayPeriod(key)! };
}

export function weeklyDue(weekly: string, now: number): DueMoment | undefined {
  const parsed = parseGestaoWeekly(weekly);
  if (!parsed) return undefined;
  const thisWeek = periodAt("week", now);
  const at = (week: Period) => dayStart(addDays(dayKeyOf(week.from + HOUR), parsed.weekday - 1)) + parsed.minutes * 60_000;
  const week = at(thisWeek) <= now ? thisWeek : previousPeriod(thisWeek);
  // Segunda: o horário abre a semana nova; o que ele fecha é a que acabou.
  return { at: at(week), period: parsed.weekday === 1 ? previousPeriod(week) : week };
}

/** O mês que a semana fecha (ela é a última das suas), ou undefined se o mês ainda tem semana por vir. */
export function monthClosedBy(week: Period): Period | undefined {
  const month = monthPeriod(monthOfWeek(week));
  return month && month.to === week.to ? month : undefined;
}
