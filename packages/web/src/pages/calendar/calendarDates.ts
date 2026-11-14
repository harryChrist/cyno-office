import { compareCalendarEvents, type CalendarEvent } from "@cyno/shared";

/**
 * Datas do calendário no fuso local do navegador. Um dia é sempre uma chave "AAAA-MM-DD"
 * (o mesmo formato de `CalendarEvent.date`): comparar chaves como texto já dá a ordem certa.
 */
export type DateKey = string;

/** Mês exibido: `month` de 0 (janeiro) a 11 (dezembro). */
export type MonthRef = { year: number; month: number };

export const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/** Dias da semana, começando no domingo (a grade também começa no domingo). */
export const WEEKDAYS = [
  { short: "Dom", long: "domingo" },
  { short: "Seg", long: "segunda-feira" },
  { short: "Ter", long: "terça-feira" },
  { short: "Qua", long: "quarta-feira" },
  { short: "Qui", long: "quinta-feira" },
  { short: "Sex", long: "sexta-feira" },
  { short: "Sáb", long: "sábado" },
] as const;

/** Quantos eventos cada dia da grade mostra antes do "+N". */
export const MAX_EVENTS_PER_DAY = 3;
/** Dias da lista "Próximos" (hoje incluído). */
export const UPCOMING_DAYS = 14;

const pad = (value: number) => String(value).padStart(2, "0");

/** Chave do dia (no fuso local) de uma data. */
export function toDateKey(date: Date): DateKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Meia-noite local do dia (ou o primeiro instante dele, em dia de horário de verão). */
export function fromDateKey(key: DateKey): Date {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(key: DateKey, days: number): DateKey {
  const date = fromDateKey(key);
  return toDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

export function monthOf(key: DateKey): MonthRef {
  const date = fromDateKey(key);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function shiftMonth({ year, month }: MonthRef, delta: number): MonthRef {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function sameMonth(a: MonthRef, b: MonthRef): boolean {
  return a.year === b.year && a.month === b.month;
}

/** "Novembro de 2026". */
export function formatMonthTitle({ year, month }: MonthRef): string {
  const name = MONTH_NAMES[month] ?? "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${year}`;
}

/** "sábado, 7 de novembro de 2026". */
export function formatLongDate(key: DateKey): string {
  const date = fromDateKey(key);
  return `${WEEKDAYS[date.getDay()]?.long}, ${date.getDate()} de ${MONTH_NAMES[date.getMonth()]} de ${date.getFullYear()}`;
}

/** Rótulo curto de um dia na lista: "Hoje", "Amanhã" ou "seg., 9 de novembro". */
export function formatDayLabel(key: DateKey, todayKey: DateKey): string {
  if (key === todayKey) return "Hoje";
  if (key === addDays(todayKey, 1)) return "Amanhã";
  const date = fromDateKey(key);
  return `${WEEKDAYS[date.getDay()]?.short.toLowerCase()}., ${date.getDate()} de ${MONTH_NAMES[date.getMonth()]}`;
}

/** "09:00–10:30", "09:00" ou "Dia todo". */
export function formatEventTime(event: Pick<CalendarEvent, "time" | "endTime">): string {
  if (!event.time) return "Dia todo";
  return event.endTime ? `${event.time}–${event.endTime}` : event.time;
}

export type GridDay = {
  key: DateKey;
  /** Dia do mês (1..31). */
  day: number;
  /** 0 = domingo. */
  weekday: number;
  /** Do mês exibido (os outros completam a primeira e a última semana). */
  inMonth: boolean;
  isToday: boolean;
};

/**
 * Grade do mês: semanas de domingo a sábado, da semana do dia 1 até a semana do último dia
 * (4 a 6 semanas). Os dias de fora do mês completam as pontas.
 */
export function buildMonthGrid(ref: MonthRef, todayKey: DateKey): GridDay[][] {
  const first = new Date(ref.year, ref.month, 1);
  const last = new Date(ref.year, ref.month + 1, 0);
  let key = addDays(toDateKey(first), -first.getDay());
  const end = addDays(toDateKey(last), 6 - last.getDay());
  const weeks: GridDay[][] = [];
  while (key <= end) {
    const week: GridDay[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = fromDateKey(key);
      week.push({
        key,
        day: date.getDate(),
        weekday,
        inMonth: date.getMonth() === ref.month && date.getFullYear() === ref.year,
        isToday: key === todayKey,
      });
      key = addDays(key, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export type DateRange = { from: DateKey; to: DateKey };

/** Primeiro e último dia da grade. */
export function gridRange(grid: GridDay[][]): DateRange {
  const from = grid[0]?.[0]?.key ?? "";
  const lastWeek = grid[grid.length - 1];
  return { from, to: lastWeek?.[lastWeek.length - 1]?.key ?? from };
}

/** O que a página precisa do server: a grade do mês e os próximos dias, juntos. */
export function pageRange(ref: MonthRef, todayKey: DateKey): DateRange {
  const grid = gridRange(buildMonthGrid(ref, todayKey));
  const upcomingEnd = addDays(todayKey, UPCOMING_DAYS - 1);
  return {
    from: grid.from < todayKey ? grid.from : todayKey,
    to: grid.to > upcomingEnd ? grid.to : upcomingEnd,
  };
}

/** Eventos agrupados por dia, cada dia na ordem do calendário (dia todo, depois por hora). */
export function groupByDay(events: readonly CalendarEvent[]): Map<DateKey, CalendarEvent[]> {
  const byDay = new Map<DateKey, CalendarEvent[]>();
  for (const event of [...events].sort(compareCalendarEvents)) {
    const list = byDay.get(event.date);
    if (list) list.push(event);
    else byDay.set(event.date, [event]);
  }
  return byDay;
}

/** O que cabe na célula do dia: os primeiros eventos e quantos ficaram de fora ("+N"). */
export function dayPreview(events: readonly CalendarEvent[], max = MAX_EVENTS_PER_DAY): { shown: CalendarEvent[]; hidden: number } {
  return { shown: events.slice(0, max), hidden: Math.max(0, events.length - max) };
}

export type UpcomingDay = { key: DateKey; events: CalendarEvent[] };

/** Dias com eventos de hoje até `days - 1` dias depois, em ordem. */
export function upcomingDays(events: readonly CalendarEvent[], todayKey: DateKey, days = UPCOMING_DAYS): UpcomingDay[] {
  const end = addDays(todayKey, days - 1);
  const inRange = events.filter((event) => event.date >= todayKey && event.date <= end);
  return [...groupByDay(inRange)].map(([key, list]) => ({ key, events: list }));
}

/** Dia para onde as setas do teclado levam o foco na grade. */
export function moveFocus(key: DateKey, keyName: string): DateKey | null {
  switch (keyName) {
    case "ArrowLeft":
      return addDays(key, -1);
    case "ArrowRight":
      return addDays(key, 1);
    case "ArrowUp":
      return addDays(key, -7);
    case "ArrowDown":
      return addDays(key, 7);
    case "Home":
      return addDays(key, -fromDateKey(key).getDay());
    case "End":
      return addDays(key, 6 - fromDateKey(key).getDay());
    default:
      return null;
  }
}
