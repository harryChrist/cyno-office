import {
  isoWeekday,
  periodBoundsFor,
  ROUTINE_TIMEZONE,
  shiftDay,
  startOfLocalDay,
  zoned,
  type PaceStatus,
  type RoutinePeriod,
} from "./routines";

/**
 * Projeção da meta ("no ritmo atual fecha em 7 de 10"). Contas puras: `now` vem de quem chama e nada lê o
 * relógio nem o disco. `projetado = entregues + max(0, ritmo7d) x dias úteis restantes`.
 */

export const GOAL_CONFIDENCES = ["baixa", "media", "alta"] as const;
export type GoalConfidence = (typeof GOAL_CONFIDENCES)[number];

/** Quantos dias para trás a projeção olha o ritmo. */
export const GOAL_LOOKBACK_DAYS = 7;

export type GoalProjection = {
  routineId: string;
  title: string;
  period: RoutinePeriod;
  periodKey: string;
  target: number;
  delivered: number;
  expected: number;
  pace: PaceStatus;
  /** Entregas dos últimos 7 dias (as amostras da projeção). */
  n: number;
  /** Entregas por dia útil ponderado (dias preferidos pesam o dobro); null = ainda sem ritmo medido. */
  ratePerDay: number | null;
  /** Dias úteis ponderados que restam no período (hoje entra pela fração que falta). */
  daysLeft: number;
  /** `entregues + max(0, ritmo) x dias úteis restantes`, para baixo (null = sem ritmo). */
  projected: number | null;
  closes: boolean;
  /** n < 5 baixa, n < 15 média, o resto alta. */
  confidence: GoalConfidence;
  /** "no ritmo atual fecha em 7 de 10 (poucos dados)". */
  text: string;
};

export type GoalProjectionInput = {
  routineId: string;
  title: string;
  goal: { target: number; period: RoutinePeriod; preferredDays?: readonly number[] | undefined };
  now: Date;
  delivered: number;
  expected: number;
  pace: PaceStatus;
  /** Instantes (ms) das entregas da meta (de qualquer período): a projeção só lê os dos últimos 7 dias. */
  deliveredAt: readonly number[];
  paused?: boolean;
};

/** Peso do dia: dia útil pesa 1, dia preferido pesa 2 (mesmo no fim de semana), o resto 0. */
function dayWeight(weekday: number, preferred: ReadonlySet<number>): number {
  if (preferred.has(weekday)) return 2;
  return weekday <= 5 ? 1 : 0;
}

/** Dias ponderados entre `from` e `to` (ms): cada dia local entra pela fração que cai dentro do intervalo. */
export function weightedDays(from: number, to: number, preferredDays: readonly number[] | undefined, timeZone: string = ROUTINE_TIMEZONE): number {
  if (to <= from) return 0;
  const preferred = new Set<number>(preferredDays ?? []);
  const first = zoned(from, timeZone);
  let total = 0;
  for (let offset = 0; offset < 400; offset += 1) {
    const day = shiftDay(first.year, first.month, first.day, offset);
    const start = startOfLocalDay(day.year, day.month, day.day, timeZone);
    if (start >= to) break;
    const next = shiftDay(day.year, day.month, day.day, 1);
    const end = startOfLocalDay(next.year, next.month, next.day, timeZone);
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap <= 0) continue;
    total += dayWeight(isoWeekday(day.year, day.month, day.day), preferred) * (overlap / (end - start));
  }
  return total;
}

/** Projeta a meta: `ritmo7d` = entregas dos últimos 7 dias por dia útil ponderado (preferidos pesam o dobro, nos dois lados da conta). */
export function projectGoal(input: GoalProjectionInput): GoalProjection {
  const { goal, now } = input;
  const bounds = periodBoundsFor(now, goal.period);
  const nowMs = now.getTime();
  const lookbackFrom = nowMs - GOAL_LOOKBACK_DAYS * 86_400_000;
  const n = input.deliveredAt.filter((at) => at >= lookbackFrom && at <= nowMs).length;
  const past = weightedDays(lookbackFrom, nowMs, goal.preferredDays);
  const daysLeft = weightedDays(nowMs, bounds.end.getTime(), goal.preferredDays);
  const ratePerDay = past > 0 ? n / past : null;
  const confidence: GoalConfidence = n < 5 ? "baixa" : n < 15 ? "media" : "alta";
  const projected = ratePerDay === null ? null : Math.floor(input.delivered + Math.max(0, ratePerDay) * daysLeft + 1e-9);
  const closes = input.delivered >= goal.target || (projected !== null && projected >= goal.target);
  const note = n < 5 ? "poucos dados" : "";
  let text: string;
  if (input.delivered >= goal.target) text = "meta batida";
  else if (input.paused) text = "pausada: sem projeção";
  else if (projected === null) text = "sem ritmo medido ainda";
  else if (closes) text = `no ritmo atual bate a meta${note ? ` (${note})` : ""}`;
  else text = `no ritmo atual fecha em ${projected} de ${goal.target}${note ? ` (${note})` : ""}`;
  return {
    routineId: input.routineId,
    title: input.title,
    period: goal.period,
    periodKey: bounds.key,
    target: goal.target,
    delivered: input.delivered,
    expected: input.expected,
    pace: input.pace,
    n,
    ratePerDay: ratePerDay === null ? null : Math.round(ratePerDay * 1000) / 1000,
    daysLeft: Math.round(daysLeft * 100) / 100,
    projected,
    closes,
    confidence,
    text,
  };
}
