import {
  dailyCapOf,
  deliveredCount,
  goalOf,
  isActiveTaskStatus,
  isRoutinePaused,
  metaFlight,
  nextSlots,
  periodBoundsFor,
  periodKey,
  periodKeyFor,
  approvedWithoutLink,
  planMeta,
  projectGoal,
  registeredCount,
  type ForYouItem,
  type GoalVerdict,
  type MetaPlan,
  type OfficeState,
  type Routine,
  type RoutineCost,
  type RoutineNextDispatch,
  type RoutineOverviewItem,
  type RoutinesOverview,
  type Task,
  type UsageRecord,
} from "@cyno/shared";
import { priceRecord } from "../../engines/usage/usage-aggregate";
import type { RoutineService } from "./routine-service";
import { backoffRetryAt, clockOf, ROUTINE_BACKOFF_MS } from "./scheduler";

/** Gasto (USD) das tarefas de cada rotina, por período e no total. */
export type RoutineCosts = Map<string, { byPeriod: Map<string, number>; total: number }>;

/**
 * Soma o custo equivalente das tarefas de cada rotina (pelo histórico de gastos). O registro guarda
 * `taskId`/`rootTaskId`; a tarefa da rotina é a própria raiz, então basta o `routineId` da tarefa.
 */
export function routineCosts(records: readonly UsageRecord[], tasks: readonly Pick<Task, "id" | "routineId">[]): RoutineCosts {
  const routineOf = new Map<string, string>();
  for (const task of tasks) if (task.routineId) routineOf.set(task.id, task.routineId);
  const out: RoutineCosts = new Map();
  if (routineOf.size === 0) return out;
  for (const record of records) {
    const routineId = routineOf.get(record.rootTaskId ?? record.taskId ?? "");
    if (!routineId) continue;
    const priced = priceRecord(record);
    if (priced.suspect) continue;
    const usd = priced.cost.usd ?? 0;
    const bucket = out.get(routineId) ?? { byPeriod: new Map(), total: 0 };
    // O custo vale para a semana e para o mês do registro (cada meta lê o seu período).
    for (const key of [periodKey(new Date(record.at)), periodKeyFor(new Date(record.at), "month")]) bucket.byPeriod.set(key, (bucket.byPeriod.get(key) ?? 0) + usd);
    bucket.total += usd;
    out.set(routineId, bucket);
  }
  return out;
}

export type OverviewRoutines = Pick<RoutineService, "entries" | "todayCount" | "history" | "ownerOf" | "statsFor"> & Partial<Pick<RoutineService, "firstRunsOf">>;

export type OverviewInput = {
  routines: OverviewRoutines;
  state: { read(): OfficeState };
  now: Date;
  costs?: RoutineCosts;
  usdBrl?: number;
  /** Itens do "Para você" (as opções esperando OK e as aprovadas de uma Meta com preparo). */
  forYou?: readonly ForYouItem[];
};

/** Uma rotina com o ritmo, o histórico, o custo e a próxima cobrança. */
export function overviewItem(input: OverviewInput, routine: Routine): RoutineOverviewItem {
  const { routines, now } = input;
  const isMeta = routine.type === "meta";
  const goal = goalOf(routine);
  const period = isMeta ? goal.period : "week";
  const bounds = periodBoundsFor(now, period);
  const tasks = input.state.read().tasks;
  const delivered = deliveredCount(routines.entries, routine.id, bounds.key);
  const registered = registeredCount(routines.entries, routine.id, bounds.key);
  const paused = isRoutinePaused(routine, now);
  const open = tasks.find((task) => task.routineId === routine.id && isActiveTaskStatus(task.status));
  const cap = dailyCapOf(routine);
  const today = routines.todayCount(routine.id, now);
  const flight = isMeta ? metaFlight({ routineId: routine.id, tasks, items: input.forYou ?? [], entries: routines.entries, periodKey: bounds.key }) : { inFlight: 0, pending: 0, taskOpen: false, openTaskIds: [] };
  const approvedNoLink = isMeta ? approvedWithoutLink({ routineId: routine.id, period, periodKey: bounds.key, tasks, items: input.forYou ?? [], entries: routines.entries }) : 0;
  const plan: MetaPlan | undefined = isMeta
    ? planMeta({ goal, now, delivered, inFlight: flight.inFlight, pending: flight.pending, taskOpen: open !== undefined, dailyLeft: cap === undefined ? Number.POSITIVE_INFINITY : cap - today, approvedNoLink })
    : undefined;
  const expected = routine.status === "proposta" || !plan ? 0 : plan.expected;
  // Acompanhamento não tem ritmo de meta: nunca "atrasado".
  const pace = plan ? (delivered >= goal.target ? "concluida" : paused ? "pausada" : plan.pace) : paused ? "pausada" : "no_ritmo";
  const usdBrl = input.usdBrl ?? 0;
  const bucket = input.costs?.get(routine.id);
  const periodUsd = bucket?.byPeriod.get(bounds.key) ?? 0;
  const totalUsd = bucket?.total ?? 0;
  const perUnit = delivered > 0 ? periodUsd / delivered : null;
  const cost: RoutineCost = {
    periodUsd,
    periodBrl: periodUsd * usdBrl,
    perUnitUsd: perUnit,
    perUnitBrl: perUnit === null ? null : perUnit * usdBrl,
    totalUsd,
    totalBrl: totalUsd * usdBrl,
  };
  const history = routines.history(routine, now).map((point) => {
    const usd = input.costs?.get(routine.id)?.byPeriod.get(point.periodKey);
    return usd ? { ...point, costUsd: usd } : point;
  });
  // Meta: para onde vai no ritmo dos últimos 7 dias ("no ritmo atual fecha em 7 de 10").
  const projection =
    isMeta && routine.status !== "proposta" && routine.status !== "encerrada"
      ? projectGoal({
          routineId: routine.id,
          title: routine.title,
          goal,
          now,
          delivered,
          expected,
          pace,
          paused,
          deliveredAt: routines.entries
            .filter((entry) => entry.routineId === routine.id && entry.stage === "entregue")
            .map((entry) => Date.parse(entry.settledAt ?? entry.at))
            .filter((at) => Number.isFinite(at)),
        })
      : undefined;
  return {
    routine,
    ...(routines.ownerOf(routine) ? { owner: routines.ownerOf(routine)! } : {}),
    periodKey: bounds.key,
    periodStart: bounds.start.toISOString(),
    periodEnd: bounds.end.toISOString(),
    daysLeft: Math.max(0, Math.ceil((bounds.end.getTime() - now.getTime()) / 86_400_000)),
    delivered,
    registered,
    period,
    inFlight: flight.inFlight,
    pending: flight.pending,
    missing: plan ? Math.max(0, goal.target - delivered - flight.inFlight) : 0,
    prepareFactor: goal.prepareFactor,
    preferredDays: goal.preferredDays ?? [],
    stopOnHit: goal.stopOnHit,
    stats: routines.statsFor(routine.id, bounds.key),
    expected,
    pace,
    ...(projection ? { projection } : {}),
    dailyCap: cap ?? null,
    todayCount: today,
    history,
    nextDispatch: nextDispatch(routine, { plan, paused, hasOpen: open !== undefined, cap, today, key: bounds.key, retryAt: isMeta ? backoffRetryAt(routine, tasks, routines.entries, now) : undefined, chaseAt: routine.linkChaseAt, nowMs: now.getTime() }),
    cost,
    openTask: open ? { id: open.id, status: open.status, ...(open.agentId ? { agentId: open.agentId } : {}) } : null,
    next: routine.status === "ativa" && !paused ? nextSlots(routine, now, 3) : [],
    approvedNoLink,
    firstRuns: routines.firstRunsOf ? routines.firstRunsOf(routine, now) : [],
    ...(routine.blocked ? { blocked: routine.blocked } : {}),
  };
}

function nextDispatch(routine: Routine, s: { plan: MetaPlan | undefined; paused: boolean; hasOpen: boolean; cap: number | undefined; today: number; key: string; retryAt: string | undefined; chaseAt: string | undefined; nowMs: number }): RoutineNextDispatch {
  if (routine.status === "proposta") return { state: "sem_cobranca", reason: "Aguardando a sua aprovação no Para você" };
  if (routine.status === "encerrada") return { state: "sem_cobranca", reason: "Arquivada" };
  if (s.paused) return { state: "sem_cobranca", reason: "Pausada" };
  if (routine.blocked) return { state: "sem_cobranca", reason: `${routine.blocked.reason}. O vigia parou: use "Tentar de novo"` };
  const month = routine.period === "month";
  if (routine.type === "acompanhamento" || !s.plan) return s.hasOpen ? { state: "aguardando", reason: "Há uma execução de horário em andamento" } : { state: "aguardando", reason: "Roda nos horários da rotina" };
  if (routine.skipPeriods.includes(s.key)) return { state: "sem_cobranca", reason: month ? "Mês pulado" : "Semana pulada" };
  const plan = s.plan;
  if (plan.hit && !s.hasOpen && plan.action !== "registrar") return { state: "sem_cobranca", reason: `Meta ${month ? "do mês" : "da semana"} batida: para até o próximo período` };
  if (s.hasOpen) return { state: "aguardando", reason: "Há uma tarefa desta rotina em andamento" };
  if (plan.action === "registrar") {
    const chased = s.chaseAt !== undefined && Date.parse(s.chaseAt) + ROUTINE_BACKOFF_MS;
    const wait = s.retryAt ?? (chased && chased > Date.parse(plan.periodStart) && chased > s.nowMs ? new Date(chased).toISOString() : undefined);
    const base = `${plan.approvedNoLink} aprovada(s), falta registrar o link: o vigia cobra só o registro`;
    return wait ? { state: "aguardando", reason: `${base}. Tenta de novo às ${clockOf(wait)}`, retryAt: wait } : { state: "agora", reason: `${base} (na próxima passada do vigia)` };
  }
  if (plan.missing - plan.pendingCover <= 0) return { state: "aguardando", reason: "O que está em preparo já cobre o que falta" };
  if (s.cap !== undefined && s.today >= s.cap) return { state: "aguardando", reason: `Teto diário atingido (${s.today}/${s.cap}): volta amanhã` };
  if (s.retryAt) return { state: "aguardando", reason: `A última tarefa não entregou nada: tenta de novo às ${clockOf(s.retryAt)}`, retryAt: s.retryAt };
  if (plan.action === "cobrar") return { state: "agora", reason: "Atrasada: o próximo lote sai na próxima passada do vigia (até 10 min)" };
  return { state: "aguardando", reason: `No ritmo: o próximo lote sai quando a meta esperada passar de ${plan.committed}` };
}

export function goalVerdict(items: readonly RoutineOverviewItem[]): GoalVerdict {
  const verdict: GoalVerdict = { total: 0, onTrack: 0, ahead: 0, behind: 0, paused: 0, done: 0 };
  for (const { routine, pace } of items) {
    if ((routine.status !== "ativa" && routine.status !== "pausada") || routine.type !== "meta") continue;
    verdict.total += 1;
    if (pace === "no_ritmo") verdict.onTrack += 1;
    else if (pace === "adiantada") verdict.ahead += 1;
    else if (pace === "atrasada") verdict.behind += 1;
    else if (pace === "pausada") verdict.paused += 1;
    else verdict.done += 1;
  }
  return verdict;
}

/** Tudo que a página Rotinas precisa numa chamada (arquivadas ficam de fora). */
export function buildOverview(input: OverviewInput & { routines: Pick<RoutineService, "list"> }): RoutinesOverview {
  const items = input.routines
    .list()
    .filter((routine) => routine.status !== "encerrada")
    .map((routine) => overviewItem(input, routine));
  const bounds = periodBoundsFor(input.now, "week");
  const ended = input.routines
    .list()
    .filter((routine) => routine.status === "encerrada")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20)
    .map((routine) => overviewItem(input, routine));
  return {
    at: input.now.toISOString(),
    periodKey: bounds.key,
    daysLeft: Math.max(0, Math.ceil((bounds.end.getTime() - input.now.getTime()) / 86_400_000)),
    verdict: goalVerdict(items),
    routines: items,
    ...(ended.length > 0 ? { ended } : {}),
  };
}
