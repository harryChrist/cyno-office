import { isoWeekday, localDayKey, pad2, ROUTINE_TIMEZONE, shiftDay, zoned, type NextSlot, type Routine, type RoutineSchedule, type ScheduleDays } from "./routines";

/**
 * O relógio dos horários das rotinas: funções puras (sem relógio próprio, o chamador passa `now`).
 * A chave do horário (`slotKey`, "2026-11-11T08:00") é a HORA LOCAL do fuso, então um horário que
 * "não existe" (pulo do horário de verão) ou que repete roda uma vez só, e comparar chaves como
 * texto é comparar no tempo.
 */

/** Servidor desligado na hora: o horário só é recuperado se passou há até isto; os mais antigos viram "pulada". */
export const SLOT_CATCHUP_MS = 2 * 3_600_000;
/** Quanto para trás procurar horários perdidos (acima disso ninguém se importa mais). */
export const SLOT_LOOKBACK_DAYS = 7;
const NEXT_LOOKAHEAD_DAYS = 400;

export type DueSlot = {
  scheduleId: string;
  slotKey: string;
  /** O instante (ISO) em que o horário vencia. */
  at: string;
  /** run = rodar agora; skip = vira "pulada" (`skipReason` diz por quê). */
  action: "run" | "skip";
  skipReason?: string;
};

export const SKIP_SERVER_DOWN = "servidor desligado";

type Local = { year: number; month: number; day: number };

/** O dia local casa com a regra de dias do horário? (mês curto roda no último dia) */
export function dayMatches(days: ScheduleDays, day: Local): boolean {
  switch (days.kind) {
    case "todo_dia":
      return true;
    case "uteis":
      return isoWeekday(day.year, day.month, day.day) <= 5;
    case "semana":
      return (days.weekdays as number[]).includes(isoWeekday(day.year, day.month, day.day));
    case "mes": {
      const last = new Date(Date.UTC(day.year, day.month, 0)).getUTCDate();
      return day.day === Math.min(days.monthDay, last);
    }
  }
}

/**
 * O instante do relógio local (dia + hora:minuto) no fuso. Hora que não existe (pulo para a frente)
 * vira o instante logo depois da lacuna; hora repetida (volta) vale a primeira vez.
 */
export function localInstant(day: Local, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const offsetAt = (ms: number) => {
    const p = zoned(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  const candidates = [...new Set([guess - offsetAt(guess - 43_200_000), guess - offsetAt(guess + 43_200_000)])].sort((a, b) => a - b);
  const valid = candidates.filter((ms) => {
    const p = zoned(ms, timeZone);
    return p.year === day.year && p.month === day.month && p.day === day.day && p.hour === hour && p.minute === minute;
  });
  return valid[0] ?? candidates[candidates.length - 1]!;
}

const keyOf = (day: Local, time: string) => `${day.year}-${pad2(day.month)}-${pad2(day.day)}T${time}`;

/** Os horários (chave e instante) de um schedule num dia local, em ordem. */
function slotsOfDay(schedule: RoutineSchedule, day: Local, timeZone: string): { key: string; at: number }[] {
  if (schedule.trigger || !dayMatches(schedule.days, day)) return [];
  const out: { key: string; at: number }[] = [];
  for (const time of [...new Set(schedule.times)].sort()) {
    const [h, m] = time.split(":").map(Number);
    if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) continue;
    out.push({ key: keyOf(day, time), at: localInstant(day, h, m, timeZone) });
  }
  return out;
}

export type DueSlotsOptions = { timeZone?: string; catchupMs?: number; lookbackDays?: number };

/**
 * Horários vencidos de cada schedule ligado: os que têm chave maior que `lastSlotKey` e instante até
 * `now`. De cada schedule, só o MAIS RECENTE pode rodar, e só se venceu há até 2 h; os mais antigos
 * (ou todos, se o mais recente já passou da janela) voltam como "skip" (pulada, servidor desligado).
 * Schedule sem `lastSlotKey` (nunca tratado) só considera a janela de recuperação, sem pulados.
 * Pausa e rotina inativa são decididas por quem chama (ele nem pergunta).
 */
export function dueSlots(routine: Pick<Routine, "schedules">, now: Date, options: DueSlotsOptions = {}): DueSlot[] {
  const timeZone = options.timeZone ?? ROUTINE_TIMEZONE;
  const catchup = options.catchupMs ?? SLOT_CATCHUP_MS;
  const lookback = options.lookbackDays ?? SLOT_LOOKBACK_DAYS;
  const nowMs = now.getTime();
  const today = zoned(nowMs, timeZone);
  const result: DueSlot[] = [];
  for (const schedule of routine.schedules) {
    if (!schedule.enabled || schedule.trigger || schedule.times.length === 0) continue;
    const found: { key: string; at: number }[] = [];
    for (let back = lookback; back >= 0; back -= 1) {
      const day = shiftDay(today.year, today.month, today.day, -back);
      for (const slot of slotsOfDay(schedule, day, timeZone)) {
        if (slot.at > nowMs) continue;
        if (schedule.lastSlotKey !== undefined && slot.key <= schedule.lastSlotKey) continue;
        found.push(slot);
      }
    }
    found.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
    if (found.length === 0) continue;
    const newest = found[found.length - 1]!;
    const fresh = nowMs - newest.at <= catchup;
    if (schedule.lastSlotKey === undefined) {
      if (fresh) result.push({ scheduleId: schedule.id, slotKey: newest.key, at: new Date(newest.at).toISOString(), action: "run" });
      continue;
    }
    for (const slot of found.slice(0, -1)) {
      result.push({ scheduleId: schedule.id, slotKey: slot.key, at: new Date(slot.at).toISOString(), action: "skip", skipReason: SKIP_SERVER_DOWN });
    }
    result.push(
      fresh
        ? { scheduleId: schedule.id, slotKey: newest.key, at: new Date(newest.at).toISOString(), action: "run" }
        : { scheduleId: schedule.id, slotKey: newest.key, at: new Date(newest.at).toISOString(), action: "skip", skipReason: SKIP_SERVER_DOWN },
    );
  }
  return result.sort((a, b) => a.at.localeCompare(b.at));
}

/** A chave do instante (o `lastSlotKey` de um horário recém-criado ou retomado: o que já passou não é recuperado). */
export function slotKeyNow(now: Date, timeZone: string = ROUTINE_TIMEZONE): string {
  const p = zoned(now.getTime(), timeZone);
  return `${localDayKey(now, timeZone)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Os próximos `count` horários (de todos os schedules ligados), do mais próximo ao mais distante, depois de `now`. */
export function nextSlots(routine: Pick<Routine, "schedules">, now: Date, count: number, timeZone: string = ROUTINE_TIMEZONE): NextSlot[] {
  const nowMs = now.getTime();
  const today = zoned(nowMs, timeZone);
  const out: NextSlot[] = [];
  const active = routine.schedules.filter((schedule) => schedule.enabled && !schedule.trigger && schedule.times.length > 0);
  if (active.length === 0) return out;
  for (let ahead = 0; ahead <= NEXT_LOOKAHEAD_DAYS; ahead += 1) {
    const day = shiftDay(today.year, today.month, today.day, ahead);
    for (const schedule of active) {
      for (const slot of slotsOfDay(schedule, day, timeZone)) {
        if (slot.at <= nowMs) continue;
        out.push({ scheduleId: schedule.id, label: schedule.label, slotKey: slot.key, at: new Date(slot.at).toISOString(), action: schedule.action });
      }
    }
    // Os dias vêm em ordem: ao juntar `count` horários, os primeiros já são os certos.
    if (out.length >= count) break;
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.scheduleId.localeCompare(b.scheduleId)).slice(0, count);
}

/**
 * Os horários (de todos os schedules ligados) dentro de [from, to), em ordem, no máximo `limit`.
 * Só anda os dias do período pedido (a agenda pede uma semana ou um mês de cada vez, nunca varre 400 dias).
 */
export function slotsBetween(routine: Pick<Routine, "schedules">, from: Date, to: Date, limit: number, timeZone: string = ROUTINE_TIMEZONE): NextSlot[] {
  const out: NextSlot[] = [];
  const active = routine.schedules.filter((schedule) => schedule.enabled && !schedule.trigger && schedule.times.length > 0);
  if (active.length === 0 || to.getTime() <= from.getTime()) return out;
  const first = zoned(from.getTime(), timeZone);
  const last = zoned(to.getTime(), timeZone);
  const lastDay = Date.UTC(last.year, last.month - 1, last.day);
  for (let ahead = 0; ahead <= NEXT_LOOKAHEAD_DAYS; ahead += 1) {
    const day = shiftDay(first.year, first.month, first.day, ahead);
    if (Date.UTC(day.year, day.month - 1, day.day) > lastDay) break;
    for (const schedule of active) {
      for (const slot of slotsOfDay(schedule, day, timeZone)) {
        if (slot.at < from.getTime() || slot.at >= to.getTime()) continue;
        out.push({ scheduleId: schedule.id, label: schedule.label, slotKey: slot.key, at: new Date(slot.at).toISOString(), action: schedule.action });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.scheduleId.localeCompare(b.scheduleId)).slice(0, limit);
}

/** "hoje às 9h", "amanhã às 9h30", "sex 14/11 às 9h" (dia local de `now`). */
export function describeSlotWhen(at: Date, now: Date, timeZone: string = ROUTINE_TIMEZONE): string {
  const day = localDayKey(at, timeZone);
  const today = localDayKey(now, timeZone);
  const t = zoned(now.getTime(), timeZone);
  const tomorrow = shiftDay(t.year, t.month, t.day, 1);
  const tomorrowKey = `${tomorrow.year}-${pad2(tomorrow.month)}-${pad2(tomorrow.day)}`;
  const p = zoned(at.getTime(), timeZone);
  const time = describeTimes([`${pad2(p.hour)}:${pad2(p.minute)}`]);
  if (day === today) return `hoje às ${time}`;
  if (day === tomorrowKey) return `amanhã às ${time}`;
  return `${WEEKDAY_SHORT[isoWeekday(p.year, p.month, p.day) - 1]} ${pad2(p.day)}/${pad2(p.month)} às ${time}`;
}

const WEEKDAY_SHORT = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/** "Dias úteis", "Todo dia", "Seg, qua e sex", "Dia 15 de cada mês". */
export function describeDays(days: ScheduleDays): string {
  switch (days.kind) {
    case "todo_dia":
      return "Todo dia";
    case "uteis":
      return "Dias úteis";
    case "semana": {
      const names = [...new Set(days.weekdays)].sort().map((d) => WEEKDAY_SHORT[d - 1]!);
      const text = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : (names[0] ?? "");
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case "mes":
      return `Dia ${days.monthDay} de cada mês`;
  }
}

/** "9h, 13h, 18h" ou "8h30, 18h". */
export function describeTimes(times: readonly string[]): string {
  const parts = [...new Set(times)].sort().map((time) => {
    const [h, m] = time.split(":");
    return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
  });
  return parts.join(", ");
}
