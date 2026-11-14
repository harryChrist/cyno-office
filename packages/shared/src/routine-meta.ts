import type { ForYouItem } from "./for-you";
import {
  expectedByNow,
  isoWeekday,
  paceStatus,
  periodBoundsFor,
  periodKeyFor,
  ROUTINE_LIMITS,
  ROUTINE_TIMEZONE,
  routineEntryKey,
  shiftDay,
  startOfLocalDay,
  zoned,
  type MetaGoal,
  type PaceStatus,
  type RoutineEntry,
  type Weekday,
} from "./routines";
import { isActiveTaskStatus, type Task } from "./types";

/**
 * Vigia da Meta v2 (contas puras, sem relógio nem disco). A meta é um alvo por período (semana ISO ou
 * mês, fuso de São Paulo): o que conta é fechar o alvo, não o dia. Os dias preferidos só ajustam a
 * curva (cobra mais cedo neles); nos dois últimos dias do período qualquer dia vale. O servidor só
 * cobra o necessário: nunca quando o que está em preparo, esperando OK ou aprovado já cobre o que falta,
 * e nunca depois de bater (as opções que sobram são dispensadas).
 */

/** Teto de candidatos por lote (o máximo de itens de um `request_approval`). */
export const META_MAX_CANDIDATES = 10;
/** Nos últimos dias do período qualquer dia vale para cobrar. */
export const META_LAST_DAYS_MS = 2 * 86_400_000;

/** Meta com os padrões da v1 (um arquivo antigo sem `goal` continua valendo). */
export function goalOf(routine: { goal?: MetaGoal; target: number; period: MetaGoal["period"] }): MetaGoal {
  return { stopOnHit: true, prepareFactor: 1, ...routine.goal, target: routine.target, period: routine.period };
}

/**
 * Quanto da meta já deveria estar pronto agora. Sem dias preferidos é a curva do período inteiro; com
 * eles, a meta é distribuída só pelos dias preferidos (cada um que já começou libera a sua parte) e nos
 * dois últimos dias do período já se espera a meta toda.
 */
export function expectedMeta(goal: Pick<MetaGoal, "target" | "period" | "preferredDays">, now: Date, timeZone: string = ROUTINE_TIMEZONE): number {
  const bounds = periodBoundsFor(now, goal.period, timeZone);
  const preferred = new Set<number>(goal.preferredDays ?? []);
  if (preferred.size === 0) return expectedByNow(goal.target, now, bounds);
  if (bounds.end.getTime() - now.getTime() <= META_LAST_DAYS_MS) return goal.target;
  let total = 0;
  let started = 0;
  const first = zoned(bounds.start.getTime() + 3_600_000, timeZone);
  for (let offset = 0; ; offset += 1) {
    const day = shiftDay(first.year, first.month, first.day, offset);
    const dayStart = startOfLocalDay(day.year, day.month, day.day, timeZone);
    if (dayStart >= bounds.end.getTime()) break;
    if (!preferred.has(isoWeekday(day.year, day.month, day.day) as Weekday)) continue;
    total += 1;
    if (dayStart <= now.getTime()) started += 1;
  }
  if (total === 0) return expectedByNow(goal.target, now, bounds);
  return Math.min(goal.target, Math.max(0, Math.ceil((goal.target * started) / total - 1e-9)));
}

/** Entrada do plano: o que o servidor já sabe (entregue, aprovado e esperando entrega, opções esperando OK). */
export type MetaPlanInput = {
  goal: MetaGoal;
  now: Date;
  /** Entregues no período (tarefa concluída + link). */
  delivered: number;
  /** Aprovadas (ou registradas) cuja tarefa ainda não terminou: vão contar quando entregarem. */
  inFlight: number;
  /** Opções esperando o seu OK. */
  pending: number;
  /** Há tarefa aberta desta rotina. */
  taskOpen: boolean;
  /** Quantas ainda cabem hoje pelo teto diário (Infinity = sem teto). */
  dailyLeft: number;
  /** Lembrete de horário: ignora o ritmo (mas nunca o teto da meta). */
  force?: boolean;
  /** Aprovadas (tarefa que já terminou) sem link registrado: o servidor só cobra o registro, sem preparar opções novas. */
  approvedNoLink?: number;
};

/** cobrar = preparar um lote novo; registrar = só pedir o link das aprovadas; pular = nada agora. */
export type MetaAction = "cobrar" | "registrar" | "pular";

export type MetaPlan = {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  target: number;
  delivered: number;
  /** Aprovadas esperando entrega. */
  inFlight: number;
  /** Opções esperando OK. */
  pending: number;
  /** Quanto as opções esperando OK cobrem do que falta (opções / fator, para cima). */
  pendingCover: number;
  /** Entregues + aprovadas: o que já vai fechar a meta. */
  committed: number;
  /** O que falta para o alvo, contando só o que já foi entregue ou aprovado (`target - committed`). */
  missing: number;
  expected: number;
  pace: PaceStatus;
  /** Bateu (entregue + aprovado >= alvo). */
  hit: boolean;
  /** Aprovadas sem link registrado (não contam como entregues). */
  approvedNoLink?: number;
  action: MetaAction;
  reason: string;
  /** Quantos fazer neste lote (0 ao pular). */
  batch: number;
  /** Quantas opções preparar para escolher as `batch` melhores (batch × fator, até META_MAX_CANDIDATES). */
  candidates: number;
};

function hitReason(delivered: number, inFlight: number, target: number): string {
  return inFlight > 0 && delivered < target ? `meta coberta (${delivered} entregue(s) + ${inFlight} aprovada(s) em andamento, alvo ${target})` : `meta batida (${delivered + inFlight}/${target})`;
}

/** Decide, sem token, se cobra agora e de quanto (o vigia e os lembretes de horário usam a mesma conta). */
export function planMeta(input: MetaPlanInput): MetaPlan {
  const { goal, now, delivered, inFlight, pending } = input;
  const bounds = periodBoundsFor(now, goal.period);
  const factor = Math.min(3, Math.max(1, Math.floor(goal.prepareFactor || 1)));
  const committed = delivered + inFlight;
  const missing = Math.max(0, goal.target - committed);
  const pendingCover = pending > 0 ? Math.ceil(pending / factor) : 0;
  const expected = expectedMeta(goal, now);
  const hit = committed >= goal.target;
  const rawPace = paceStatus({ delivered: committed, target: goal.target, expected });
  // "Batida" só quando entregou; aprovada esperando entrega ainda é "no ritmo" ou "adiantada".
  const pace: PaceStatus = delivered >= goal.target ? "concluida" : rawPace === "concluida" ? (committed > expected ? "adiantada" : "no_ritmo") : rawPace;
  const base = {
    periodKey: bounds.key,
    periodStart: bounds.start.toISOString(),
    periodEnd: bounds.end.toISOString(),
    target: goal.target,
    delivered,
    inFlight,
    pending,
    pendingCover,
    committed,
    missing,
    expected,
    pace,
    hit,
    approvedNoLink: Math.max(0, Math.floor(input.approvedNoLink ?? 0)),
  };
  const skip = (reason: string): MetaPlan => ({ ...base, action: "pular", reason, batch: 0, candidates: 0 });
  if (input.taskOpen) {
    // Meta já coberta (entregues + aprovadas em andamento): o motivo diz o que é de cada uma.
    return skip(hit ? hitReason(delivered, inFlight, goal.target) : "já há uma tarefa aberta desta rotina");
  }
  // Aprovadas cuja tarefa terminou sem registrar o link: cobra SÓ o registro (nada de opções novas).
  if (base.approvedNoLink > 0 && delivered < goal.target) {
    const n = base.approvedNoLink;
    return { ...base, action: "registrar", reason: `${n} aprovada(s) sem link registrado: cobra só o registro`, batch: n, candidates: 0 };
  }
  if (hit) return skip(hitReason(delivered, inFlight, goal.target));
  const needed = missing - pendingCover;
  if (needed <= 0) return skip(`o que está em preparo já cobre o que falta (${pending} opção(ões) esperando, ${inFlight} aprovada(s))`);
  if (!input.force && committed + pendingCover >= expected) return skip(`no ritmo (${committed}/${goal.target}, esperado ${expected})`);
  if (input.dailyLeft <= 0) return skip("teto diário atingido");
  const batch = Math.max(1, Math.min(needed, ROUTINE_LIMITS.batch, Math.floor(input.dailyLeft)));
  const candidates = Math.min(META_MAX_CANDIDATES, Math.max(batch, Math.ceil(batch * factor)));
  // O teto diário do site encolhe o lote (e as opções com ele): o motivo diz, para ninguém achar que o fator de preparo falhou.
  const capped = batch < Math.min(needed, ROUTINE_LIMITS.batch) ? `; teto diário do site: só ${batch} hoje, o resto fica para os próximos dias` : "";
  return { ...base, action: "cobrar", reason: `lote de ${batch} (${candidates} opção(ões) a preparar; ${committed}/${goal.target}, esperado ${expected}${capped})`, batch, candidates };
}

// ---------- O que está em andamento (tarefas, cartões de aprovação e links registrados) ----------

export type MetaFlight = { inFlight: number; pending: number; taskOpen: boolean; openTaskIds: string[] };

/**
 * Das tarefas abertas da rotina: quantas aprovações já saíram (ou links já registrados, o que for
 * maior, para não contar duas vezes a mesma entrega) e quantas opções ainda esperam o OK. Item
 * aprovado de tarefa que não terminou bem nunca conta: ao terminar, vale só o que tem link.
 */
export function metaFlight(input: {
  routineId: string;
  tasks: readonly Pick<Task, "id" | "routineId" | "status">[];
  items: readonly Pick<ForYouItem, "taskId" | "status" | "kind">[];
  entries: readonly RoutineEntry[];
  periodKey: string;
}): MetaFlight {
  const open = input.tasks.filter((task) => task.routineId === input.routineId && isActiveTaskStatus(task.status));
  let inFlight = 0;
  let pending = 0;
  for (const task of open) {
    const mine = input.items.filter((item) => item.taskId === task.id && (item.kind === undefined || item.kind === "aprovacao"));
    const approved = mine.filter((item) => item.status === "aprovado").length;
    const registered = new Set(input.entries.filter((entry) => entry.taskId === task.id && entry.periodKey === input.periodKey && entry.stage === "registrado").map(routineEntryKey)).size;
    inFlight += Math.max(approved, registered);
    pending += mine.filter((item) => item.status === "pendente").length;
  }
  return { inFlight, pending, taskOpen: open.length > 0, openTaskIds: open.map((task) => task.id) };
}

/**
 * Aprovadas sem link: cartões aprovados (`aprovado`, no período) de tarefas da rotina que JÁ TERMINARAM
 * bem, menos os links registrados ou entregues no período (o registro de uma cobrança posterior vale).
 * Nunca negativo. Tarefa que ainda roda não entra (é `inFlight`); tarefa que falhou não executou nada.
 */
export function approvedWithoutLink(input: {
  routineId: string;
  period: MetaGoal["period"];
  periodKey: string;
  tasks: readonly Pick<Task, "id" | "routineId" | "status">[];
  items: readonly Pick<ForYouItem, "taskId" | "status" | "kind" | "decidedAt" | "createdAt">[];
  entries: readonly RoutineEntry[];
}): number {
  const done = new Set(input.tasks.filter((task) => task.routineId === input.routineId && task.status === "done").map((task) => task.id));
  if (done.size === 0) return 0;
  const approved = input.items.filter(
    (item) => item.status === "aprovado" && item.taskId !== undefined && done.has(item.taskId) && (item.kind === undefined || item.kind === "aprovacao") && approvedInPeriod(item, input.period, input.periodKey),
  ).length;
  const linked = new Set(input.entries.filter((entry) => entry.routineId === input.routineId && entry.periodKey === input.periodKey && entry.stage !== "descartado").map(routineEntryKey)).size;
  return Math.max(0, approved - linked);
}

/** O cartão foi decidido dentro do período (sem data legível, não conta). */
export function approvedInPeriod(item: Pick<ForYouItem, "decidedAt" | "createdAt">, period: MetaGoal["period"], periodKey: string): boolean {
  const at = Date.parse(item.decidedAt ?? item.createdAt ?? "");
  return !Number.isNaN(at) && periodKeyFor(new Date(at), period) === periodKey;
}
