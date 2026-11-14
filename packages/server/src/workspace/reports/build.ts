import { dayKeyOf, sumDigests, type MetricsReport, type ReportDelivery, type ReportDigest, type ReportGoal, type ReportSections, type ReportTrigger, type RoutineResult, type StoredReport, type TodayView } from "@cyno/shared";
import type { Delivery } from "../metrics/compute";
import type { Period } from "./period";

/** Quantas entregas cada agente mostra no relatório (o resto entra só na contagem). */
export const REPORT_DELIVERIES_PER_AGENT = 6;
/** Itens de "o que vem a seguir". */
const NEXT_LIMIT = 5;

const iso = (ms: number): string => new Date(ms).toISOString();

/** O resumo somável dos números de um período (veja `reportDigestSchema`). */
export function digestOf(metrics: MetricsReport, goals: readonly ReportGoal[]): ReportDigest {
  const closed = goals.filter((goal) => goal.outcome !== "pulada");
  const peaks = metrics.quota.windows.map((window) => window.percent).filter((value): value is number => value !== null);
  return {
    deliveries: metrics.throughput.value ?? 0,
    spendUsd: metrics.spend.usd,
    deliveryCostUsd: metrics.costPerDelivery.totalUsd,
    costPerDelivery: metrics.costPerDelivery.value,
    cycle: { median: metrics.cycleTime.value, p90: metrics.cycleTime.p90, n: metrics.cycleTime.n },
    approvalWait: { median: metrics.approvalWait.value, p90: metrics.approvalWait.p90, n: metrics.approvalWait.n },
    failure: { hits: metrics.failureRate.hits ?? 0, n: metrics.failureRate.n },
    rejection: { hits: metrics.rejectionRate.hits ?? 0, n: metrics.rejectionRate.n },
    rework: { hits: metrics.rework.hits ?? 0, n: metrics.rework.n },
    edit: { hits: metrics.editRate.hits ?? 0, n: metrics.editRate.n },
    goals: { hit: closed.filter((goal) => goal.outcome === "bateu").length, total: closed.length },
    quotaPeak: peaks.length > 0 ? Math.max(...peaks) : null,
  };
}

/** Tudo o que o relatório do dia ou da semana lê, já em memória (quem junta é o `ReportService`; os testes montam à mão). */
export type PeriodInputs = {
  period: Period;
  now: number;
  workspace: string;
  workspaceName: string;
  /** Congelado (fechou, ou é o horário da cerimônia). */
  final: boolean;
  trigger: ReportTrigger;
  /** `computeMetrics` da janela inteira do período (de `from` a `to`). */
  metrics: MetricsReport;
  /** Só no dia: as métricas do mesmo dia da semana passada. */
  compare?: MetricsReport;
  /** Todas as entregas do workspace (o filtro do período é daqui). */
  deliveries: readonly Delivery[];
  results: readonly RoutineResult[];
  routineTitle: (routineId: string) => string;
  /** id -> nome de todos os agentes. */
  names: Readonly<Record<string, string>>;
  /** "Hoje" e as próximas tarefas: só entram no dia e se o relatório é gerado dentro dele. */
  today?: TodayView;
  nextTasks?: readonly { title: string; project?: string; agent?: string }[];
};

function deliveryRow(delivery: Delivery, names: Readonly<Record<string, string>>): ReportDelivery {
  const agent = delivery.agentId ? names[delivery.agentId] : undefined;
  return {
    title: delivery.title,
    at: iso(delivery.at),
    kind: delivery.url !== undefined || delivery.groupKey.startsWith("rotina:") ? "rotina" : "projeto",
    ...(delivery.agentId ? { agentId: delivery.agentId } : {}),
    ...(agent ? { agent } : {}),
    ...(delivery.projectId ? { projectId: delivery.projectId } : {}),
    ...(delivery.ref ? { ref: delivery.ref } : {}),
    ...(delivery.url ? { url: delivery.url } : {}),
  };
}

/** O que cada agente entregou no período (do que mais entregou ao que menos; empate por nome), mais as entregas sem agente. */
export function agentsSection(deliveries: readonly Delivery[], names: Readonly<Record<string, string>>): Pick<ReportSections, "agents" | "otherDeliveries"> {
  const byAgent = new Map<string, Delivery[]>();
  const other: ReportDelivery[] = [];
  for (const delivery of deliveries) {
    if (!delivery.agentId) other.push(deliveryRow(delivery, names));
    else byAgent.set(delivery.agentId, [...(byAgent.get(delivery.agentId) ?? []), delivery]);
  }
  const agents = [...byAgent].map(([agentId, list]) => ({
    agentId,
    name: names[agentId] ?? agentId,
    count: list.length,
    deliveries: [...list].sort((a, b) => b.at - a.at).slice(0, REPORT_DELIVERIES_PER_AGENT).map((delivery) => deliveryRow(delivery, names)),
  }));
  agents.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR") || a.agentId.localeCompare(b.agentId));
  return { agents, otherDeliveries: other.slice(0, REPORT_DELIVERIES_PER_AGENT) };
}

/** Metas fechadas da semana (as de `RoutineResult` daquele `periodKey`). */
function goalsOf(period: Period, results: readonly RoutineResult[], title: (routineId: string) => string): ReportGoal[] {
  if (period.kind !== "week") return [];
  return results
    .filter((result) => result.periodKey === period.key)
    .map((result) => ({ routineId: result.routineId, title: title(result.routineId), periodKey: result.periodKey, target: result.target, delivered: result.delivered, outcome: result.outcome }))
    .sort((a, b) => a.title.localeCompare(b.title, "pt-BR") || a.routineId.localeCompare(b.routineId));
}

/** O relatório do dia ou da semana: os números são os do `computeMetrics`; aqui só se arruma o que ele não dá pronto. */
export function buildPeriodReport(input: PeriodInputs): StoredReport {
  const { period, now } = input;
  const inPeriod = input.deliveries.filter((delivery) => delivery.at >= period.from && delivery.at < period.to);
  const goals = goalsOf(period, input.results, input.routineTitle);
  const live = now >= period.from && now < period.to;
  const sections: ReportSections = {
    live,
    names: { ...input.names },
    ...agentsSection(inPeriod, input.names),
    goals,
  };
  if (period.kind === "day" && live && input.today) {
    sections.next = {
      routines: input.today.routines.upcoming.slice(0, NEXT_LIMIT).map((slot) => ({ title: slot.title, at: slot.at, ...(slot.label ? { label: slot.label } : {}), ...(slot.agent ? { agent: slot.agent } : {}) })),
      tasks: (input.nextTasks ?? []).slice(0, NEXT_LIMIT).map((task) => ({ title: task.title, ...(task.project ? { project: task.project } : {}), ...(task.agent ? { agent: task.agent } : {}) })),
      agenda: input.today.agenda.slice(0, NEXT_LIMIT).map((event) => ({ title: event.title, start: event.start, end: event.end })),
    };
  }
  if (period.kind === "day" && input.compare) {
    sections.compare = { day: dayKeyOf(period.from - 7 * 24 * 3_600_000 + 3_600_000), deliveries: input.compare.throughput.value ?? 0, spendUsd: input.compare.spend.usd };
  }
  return {
    v: 1,
    kind: period.kind,
    period: period.key,
    workspace: input.workspace,
    workspaceName: input.workspaceName,
    from: iso(period.from),
    to: iso(period.to),
    generatedAt: iso(now),
    final: input.final,
    trigger: input.trigger,
    metrics: input.metrics,
    digest: digestOf(input.metrics, goals),
    sections,
  };
}

/**
 * O mensal soma as semanas GUARDADAS (finais) do mês: cada semana vai para o mês da sua quinta-feira. Semana que falta
 * (workspace novo, servidor desligado) fica em `missing`: o mês diz de quantas semanas saiu.
 */
export function buildMonthReport(input: { period: Period; now: number; workspace: string; workspaceName: string; final: boolean; trigger: ReportTrigger; weeks: readonly StoredReport[]; expected: readonly Period[]; names: Readonly<Record<string, string>> }): StoredReport {
  const have = new Map(input.weeks.map((week) => [week.period, week]));
  const used = input.expected.filter((week) => have.has(week.key)).map((week) => have.get(week.key)!);
  const missing = input.expected.filter((week) => !have.has(week.key)).map((week) => week.key);
  const byAgent = new Map<string, { agentId: string; name: string; count: number; deliveries: ReportDelivery[] }>();
  const other: ReportDelivery[] = [];
  for (const week of used) {
    for (const agent of week.sections.agents) {
      const entry = byAgent.get(agent.agentId) ?? { agentId: agent.agentId, name: agent.name, count: 0, deliveries: [] };
      entry.count += agent.count;
      entry.deliveries.push(...agent.deliveries);
      byAgent.set(agent.agentId, entry);
    }
    other.push(...week.sections.otherDeliveries);
  }
  const agents = [...byAgent.values()]
    .map((agent) => ({ ...agent, deliveries: [...agent.deliveries].sort((a, b) => b.at.localeCompare(a.at)).slice(0, REPORT_DELIVERIES_PER_AGENT) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR") || a.agentId.localeCompare(b.agentId));
  return {
    v: 1,
    kind: "month",
    period: input.period.key,
    workspace: input.workspace,
    workspaceName: input.workspaceName,
    from: iso(input.period.from),
    to: iso(input.period.to),
    generatedAt: iso(input.now),
    final: input.final,
    trigger: input.trigger,
    digest: sumDigests(used.map((week) => week.digest)),
    sections: { live: false, names: { ...input.names }, agents, otherDeliveries: other.slice(0, REPORT_DELIVERIES_PER_AGENT), goals: used.flatMap((week) => week.sections.goals) },
    weeks: used.map((week) => ({ period: week.period, from: week.from, to: week.to, digest: week.digest })),
    missing,
  };
}
