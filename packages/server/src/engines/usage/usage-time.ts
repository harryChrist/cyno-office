import { USAGE_HISTORY_TIMEZONE } from "@cyno/shared";

/**
 * Datas do histórico de gastos no fuso de São Paulo: dia (YYYY-MM-DD), semana (começa na segunda)
 * e mês (YYYY-MM). Funções puras com Intl (sem depender do fuso da máquina).
 */

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Data/hora local de um instante no fuso (weekday: 0 = domingo). */
export function zonedParts(ms: number, timeZone: string = USAGE_HISTORY_TIMEZONE): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" do dia local do instante. */
export function dayKeyOf(ms: number, timeZone?: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM" do mês local do instante (é o nome do arquivo do mês). */
export function monthKeyOf(ms: number, timeZone?: string): string {
  return dayKeyOf(ms, timeZone).slice(0, 7);
}

/** Instante (ms) em que começa o dia local `YYYY-MM-DD` no fuso. */
export function startOfDay(dayKey: string, timeZone: string = USAGE_HISTORY_TIMEZONE): number {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  // O deslocamento do fuso naquele dia (duas passadas cobrem mudança de horário de verão).
  let ms = guess;
  for (let i = 0; i < 2; i += 1) {
    const p = zonedParts(ms, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    ms = guess - (asUtc - ms);
  }
  return ms;
}

/** Dia `YYYY-MM-DD` somado de `days` (calendário puro, sem fuso). */
export function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day + days));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Segunda-feira da semana do dia (as semanas começam na segunda). */
export function weekStartOf(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(dayKey, -((weekday + 6) % 7));
}

/** Primeiro dia do mês seguinte a `YYYY-MM`. */
export function nextMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
}

export type TimeGroupBy = "day" | "week" | "month";

/** O período (dia, semana ou mês) a que um dia pertence: chave e dias de início/fim (fim exclusive). */
export function periodOf(dayKey: string, groupBy: TimeGroupBy): { key: string; firstDay: string; nextDay: string } {
  if (groupBy === "day") return { key: dayKey, firstDay: dayKey, nextDay: addDays(dayKey, 1) };
  if (groupBy === "week") {
    const monday = weekStartOf(dayKey);
    return { key: monday, firstDay: monday, nextDay: addDays(monday, 7) };
  }
  const month = dayKey.slice(0, 7);
  return { key: month, firstDay: `${month}-01`, nextDay: `${nextMonth(month)}-01` };
}

/** Os meses (YYYY-MM) entre dois dias, inclusive (para saber quais arquivos ler). */
export function monthsBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  let month = fromDay.slice(0, 7);
  const last = toDay.slice(0, 7);
  while (month <= last && out.length < 1200) {
    out.push(month);
    month = nextMonth(month);
  }
  return out;
}
