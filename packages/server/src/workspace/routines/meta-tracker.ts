import {
  approvedInPeriod,
  approvedWithoutLink,
  dailyCapOf,
  deliveredCount,
  goalOf,
  isActiveTaskStatus,
  metaFlight,
  planMeta,
  periodKeyFor,
  type ForYouItem,
  type MetaFlight,
  type MetaPlan,
  type OfficeState,
  type PeriodStats,
  type Routine,
  type Task,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { DISMISSED_REASON } from "../for-you/service";
import type { RoutineService } from "./routine-service";

type ForYouCancel = { cancel(id: string, input: { by: "servidor"; reason?: string }): Promise<unknown> };

export type MetaTrackerDeps = {
  routines: Pick<RoutineService, "entries" | "todayCount" | "find" | "bumpStats" | "logDecision">;
  state: { read(): OfficeState; readForYou(): ForYouItem[] };
  /** Cancela um cartão pendente (ForYouService.cancel). */
  forYou: ForYouCancel;
  now: () => Date;
  log: Pick<FastifyBaseLogger, "warn">;
};

/**
 * As contas da Meta v2 sobre o que existe agora: tarefas abertas, cartões de aprovação (as opções) e
 * links registrados. Entrega ao vigia o plano (`plan`), ao "Para você" a posição da meta (`standing`,
 * para nunca aprovar além do alvo) e ao histórico do período os contadores (preparadas, aprovadas,
 * dispensadas). Também varre e dispensa as opções que sobraram quando a meta fecha (`dismissLeftovers`).
 */
export class MetaTracker {
  constructor(private readonly deps: MetaTrackerDeps) {}

  /** Em andamento na rotina agora: aprovadas esperando entrega, opções esperando OK, tarefa aberta. */
  flight(routine: Routine, now: Date = this.deps.now()): MetaFlight {
    return metaFlight({
      routineId: routine.id,
      tasks: this.deps.state.read().tasks,
      items: this.deps.state.readForYou(),
      entries: this.deps.routines.entries,
      periodKey: periodKeyFor(now, routine.period),
    });
  }

  /** Aprovadas (tarefa já terminada) sem link registrado no período atual: não contam como entregues. */
  approvedNoLink(routine: Routine, now: Date = this.deps.now()): number {
    return approvedWithoutLink({
      routineId: routine.id,
      period: routine.period,
      periodKey: periodKeyFor(now, routine.period),
      tasks: this.deps.state.read().tasks,
      items: this.deps.state.readForYou(),
      entries: this.deps.routines.entries,
    });
  }

  /** Linhas curtas dos cartões aprovados do período (para a cobrança só do registro dos links). */
  approvedLines(routine: Routine, now: Date = this.deps.now(), limit = 10): string[] {
    const key = periodKeyFor(now, routine.period);
    const done = new Set(this.deps.state.read().tasks.filter((task) => task.routineId === routine.id && task.status === "done").map((task) => task.id));
    return this.deps.state
      .readForYou()
      .filter((item) => item.status === "aprovado" && item.taskId !== undefined && done.has(item.taskId) && (item.kind === undefined || item.kind === "aprovacao") && approvedInPeriod(item, routine.period, key))
      .slice(-limit)
      .map((item) => `- ${item.id}: ${[item.where, item.to, item.title].filter(Boolean).join(" / ") || "item"} | ${item.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }

  /**
   * O teste "esta aprovação ainda conta na Meta?" (a lista viva a guarda mesmo decidida há tempo): aprovação de tarefa de rotina que
   * ainda roda, ou decidida dentro do período atual (que pode ser o mês). A varredura do arquivo respeita isso.
   */
  holdsApproved(now: Date = this.deps.now()): (item: ForYouItem) => boolean {
    const tasks = new Map(this.deps.state.read().tasks.map((task) => [task.id, task]));
    return (item) => {
      if (item.status !== "aprovado" || item.taskId === undefined || (item.kind !== undefined && item.kind !== "aprovacao")) return false;
      const task = tasks.get(item.taskId);
      const routine = task?.routineId ? this.deps.routines.find(task.routineId) : undefined;
      if (!task || !routine) return false;
      return isActiveTaskStatus(task.status) || approvedInPeriod(item, routine.period, periodKeyFor(now, routine.period));
    };
  }

  /** Entregues no período atual da meta. */
  delivered(routine: Routine, now: Date = this.deps.now()): number {
    return deliveredCount(this.deps.routines.entries, routine.id, periodKeyFor(now, routine.period));
  }

  /** O plano da Meta agora (o vigia e os lembretes de horário). `force` ignora o ritmo (nunca o teto da meta). */
  plan(routine: Routine, now: Date = this.deps.now(), options: { force?: boolean } = {}): MetaPlan {
    const flight = this.flight(routine, now);
    const cap = dailyCapOf(routine);
    const dailyLeft = cap === undefined ? Number.POSITIVE_INFINITY : cap - this.deps.routines.todayCount(routine.id, now);
    return planMeta({
      goal: goalOf(routine),
      now,
      delivered: this.delivered(routine, now),
      inFlight: flight.inFlight,
      pending: flight.pending,
      taskOpen: flight.taskOpen,
      dailyLeft,
      approvedNoLink: this.approvedNoLink(routine, now),
      ...(options.force ? { force: true } : {}),
    });
  }

  private metaOf(task: Task): Routine | undefined {
    if (!task.routineId) return undefined;
    const routine = this.deps.routines.find(task.routineId);
    return routine && routine.type === "meta" ? routine : undefined;
  }

  /** Posição da meta de uma tarefa de Meta (entregue + aprovado contra o alvo); undefined = a tarefa não é de uma Meta. */
  standing(task: Task): { committed: number; target: number; stopOnHit: boolean } | undefined {
    const routine = this.metaOf(task);
    if (!routine) return undefined;
    const now = this.deps.now();
    const flight = this.flight(routine, now);
    const goal = goalOf(routine);
    return { committed: this.delivered(routine, now) + flight.inFlight, target: goal.target, stopOnHit: goal.stopOnHit };
  }

  /** Cartões de aprovação abertos por uma tarefa da Meta: contam como opções preparadas. */
  opened(task: Task, items: readonly ForYouItem[]): void {
    const routine = this.metaOf(task);
    if (!routine) return;
    const count = items.filter((item) => item.kind === undefined || item.kind === "aprovacao").length;
    if (count > 0) this.deps.routines.bumpStats(routine.id, periodKeyFor(this.deps.now(), routine.period), { prepared: count });
  }

  counted(task: Task, delta: Partial<PeriodStats>): void {
    const routine = this.metaOf(task);
    if (routine) this.deps.routines.bumpStats(routine.id, periodKeyFor(this.deps.now(), routine.period), delta);
  }

  /**
   * Meta batida: cancela, sem IA, as opções que ainda esperam OK nas tarefas abertas da rotina
   * ("Dispensado: meta batida"). A tarefa que esperava por elas segue só com o que foi aprovado.
   * Devolve quantas foram dispensadas.
   */
  async dismissLeftovers(routine: Routine): Promise<number> {
    const flight = this.flight(routine);
    if (flight.pending === 0) return 0;
    const open = new Set(flight.openTaskIds);
    const leftovers = this.deps.state.readForYou().filter((item) => item.status === "pendente" && item.taskId !== undefined && open.has(item.taskId) && (item.kind === undefined || item.kind === "aprovacao"));
    let dismissed = 0;
    for (const item of leftovers) {
      try {
        await this.deps.forYou.cancel(item.id, { by: "servidor", reason: DISMISSED_REASON });
        dismissed += 1;
      } catch (error) {
        this.deps.log.warn({ err: error, itemId: item.id }, "meta: não foi possível dispensar uma opção que sobrou");
      }
    }
    if (dismissed > 0) {
      this.deps.routines.bumpStats(routine.id, periodKeyFor(this.deps.now(), routine.period), { dismissed });
      this.deps.routines.logDecision(routine.id, { kind: "closed", reason: `meta batida: ${dismissed} opção(ões) dispensada(s) sem acordar a IA` });
    }
    return dismissed;
  }
}
