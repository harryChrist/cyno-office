import {
  AVULSAS_ID,
  DAY_MS,
  dayKeyOf,
  expandAvulsas,
  forYouKind,
  leafRequestId,
  METRICS_MEDIAN_DAYS,
  METRICS_RATE_DAYS,
  METRICS_STALL_MS,
  METRICS_WEEKS,
  engineBlockLabel,
  periodBounds,
  periodKey,
  ROUTINE_TIMEZONE,
  usageProviderLabel,
  usageWindowState,
  type Agent,
  type DispatchSettings,
  type EngineBlock,
  type GoalProjection,
  type ForYouItem,
  type MetricGroup,
  type MetricsGroupBy,
  type MetricsReport,
  type Project,
  type ProjectTask,
  type Routine,
  type RoutineEntry,
  type SubscriptionUsage,
  type Task,
  type UsageRecord,
} from "@cyno/shared";
import { priceRecord } from "../../engines/usage/usage-aggregate";
import { usageLevelOf, usageText, usageWindowLabel } from "../../platform/attention/rules";
import { forecastAll } from "./forecast";
import { editIntensity } from "./similarity";
import { groupBy, median, medianValue, metricValue, nearestRank, rateValue, sortGroups, sum } from "./stats";

/** Tudo que o cálculo lê, já em memória: quem monta é o chamador (o runtime, ou o fixture dos testes). */
export type MetricsSnapshot = {
  agents: readonly (Pick<Agent, "id" | "name"> & { engine?: Agent["engine"] })[];
  /** As `Task`s do escritório (inclui o registro do pedido, `role: "request"`, que o cálculo ignora). */
  tasks: readonly Task[];
  /** Os projetos como estão gravados (com o Avulsas); o cálculo os expande. */
  projects: readonly Project[];
  forYou: readonly ForYouItem[];
  usage: readonly UsageRecord[];
  routines: readonly Pick<Routine, "id" | "title">[];
  entries: readonly RoutineEntry[];
  quota: readonly SubscriptionUsage[];
  dispatch: DispatchSettings;
  /** Quem não roda agora por falta de cota/motor (o runtime consulta a disponibilidade). */
  engineBlocks?: readonly { agentId: string; block: EngineBlock }[];
  /** Projeção das metas do período (o runtime a tira do resumo das rotinas; sem ela, `goals` sai vazio). */
  goals?: readonly GoalProjection[];
};

export type MetricsOptions = {
  /** Início e fim (ms, fim exclusivo) pedidos. Sem eles: 7 dias para taxas e contagens, 28 para medianas. */
  from?: number;
  to?: number;
  /** O relógio vem de fora: nada aqui lê a hora. */
  now: number;
  workspace?: string;
  /** Modo leve (o bloco da página do Cyno): sem a previsão de entrega, o resto igual. */
  light?: boolean;
};

type Range = { from: number; to: number };
const inRange = (at: number, range: Range): boolean => at >= range.from && at < range.to;
const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (text: string | undefined): number => (text ? Date.parse(text) : Number.NaN);
const windowOf = (range: Range) => ({ from: iso(range.from), to: iso(range.to) });
const previous = (range: Range): Range => ({ from: range.from - (range.to - range.from), to: range.from });

// ---------- Entregas ----------

/**
 * `groupKey`/`groupTitle`: o projeto na tela ("avulsas" junta os pedidos simples); `costRoot`: o que o gasto
 * chama de raiz (o id do pedido; nas entregas de rotina, a tarefa da rotina).
 */
export type Delivery = {
  at: number;
  agentId?: string;
  groupKey: string;
  groupTitle: string;
  costRoot: string;
  type: string;
  /** Para os relatórios: o que foi entregue e onde achar (projeto e tarefa, ou o link da rotina). */
  title: string;
  projectId?: string;
  ref?: string;
  url?: string;
};

const isLeaf = (task: ProjectTask): boolean => task.group !== true;

/** A folha foi entregue de verdade: concluída, não pulada. */
const isDelivered = (task: ProjectTask): boolean => task.status === "concluida" && task.skipped !== true && isLeaf(task) && !Number.isNaN(ms(task.finishedAt));

const agentOfTask = (task: ProjectTask): string | undefined => task.steps.at(-1)?.agentId ?? (task.ownerId || undefined);

/**
 * "Entrega" (plano da Gestão, seção 2): (a) tarefa de projeto concluída e não pulada cujo projeto não é de
 * rotina, mais (b) entrada de rotina em `entregue`. A tarefa que uma rotina abriu fica de fora de (a), para
 * a mesma entrega não contar duas vezes.
 */
export function deliveriesOf(snapshot: Pick<MetricsSnapshot, "projects" | "routines" | "entries">): Delivery[] {
  const out: Delivery[] = [];
  for (const project of expandAvulsas(snapshot.projects)) {
    if (project.origin === "rotina" || project.routineRef) continue;
    for (const task of project.tasks) {
      if (!isDelivered(task)) continue;
      const agentId = agentOfTask(task);
      const simple = project.kind === "tarefa";
      out.push({ at: ms(task.finishedAt), ...(agentId ? { agentId } : {}), groupKey: simple ? AVULSAS_ID : project.id, groupTitle: simple ? "Avulsas (tarefas simples)" : project.title, costRoot: project.id, type: task.approvalType ?? "sem tipo", title: task.title, projectId: project.id, ref: task.ref });
    }
  }
  const titles = new Map(snapshot.routines.map((routine) => [routine.id, routine.title]));
  for (const entry of snapshot.entries) {
    if (entry.stage !== "entregue") continue;
    const at = ms(entry.settledAt ?? entry.at);
    if (Number.isNaN(at)) continue;
    out.push({ at, agentId: entry.agentId, groupKey: `rotina:${entry.routineId}`, groupTitle: titles.get(entry.routineId) ?? entry.routineId, costRoot: entry.taskId, type: "rotina", title: entry.note?.trim() || titles.get(entry.routineId) || entry.routineId, ...(entry.url ? { url: entry.url } : {}) });
  }
  return out.sort((a, b) => a.at - b.at || a.groupKey.localeCompare(b.groupKey) || a.costRoot.localeCompare(b.costRoot));
}

// ---------- Ferramentas dos grupos ----------

type Names = (id: string) => string;

/** Grupos de contagem (entregas): valor = contagem no período, `prev` = no anterior. */
function countGroups<T>(items: readonly T[], prevItems: readonly T[], keyOf: (item: T) => string | undefined, label: (key: string) => string): MetricGroup[] {
  const now = groupBy(items.filter((item) => keyOf(item) !== undefined), (item) => keyOf(item)!);
  const before = groupBy(prevItems.filter((item) => keyOf(item) !== undefined), (item) => keyOf(item)!);
  return sortGroups(
    [...now.keys()].map((key) => {
      const count = now.get(key)!.length;
      const prev = before.get(key)?.length ?? 0;
      return { key, label: label(key), ...metricValue({ value: count, n: count, prev, prevN: prev, kind: "relative" }) };
    }),
  );
}

/** Grupos de taxa: `hit` diz se o item conta no numerador. */
function rateGroups<T>(items: readonly T[], prevItems: readonly T[], keyOf: (item: T) => string | undefined, hit: (item: T) => boolean, label: (key: string) => string): MetricGroup[] {
  const now = groupBy(items.filter((item) => keyOf(item) !== undefined), (item) => keyOf(item)!);
  const before = groupBy(prevItems.filter((item) => keyOf(item) !== undefined), (item) => keyOf(item)!);
  return sortGroups(
    [...now.keys()].map((key) => {
      const list = now.get(key)!;
      const prevList = before.get(key) ?? [];
      return { key, label: label(key), ...rateValue(list.filter(hit).length, list.length, prevList.filter(hit).length, prevList.length) };
    }),
  );
}

/** Grupos de mediana. */
function medianGroups<T>(items: readonly T[], prevItems: readonly T[], keyOf: (item: T) => string | undefined, valueOf: (item: T) => number, label: (key: string) => string): MetricGroup[] {
  const now = groupBy(items.filter((item) => keyOf(item) !== undefined), (item) => keyOf(item)!);
  const before = groupBy(prevItems.filter((item) => keyOf(item) !== undefined), (item) => keyOf(item)!);
  return sortGroups(
    [...now.keys()].map((key) => ({
      key,
      label: label(key),
      ...medianValue(now.get(key)!.map(valueOf), (before.get(key) ?? []).map(valueOf)),
    })),
  );
}

// ---------- Semanas ----------

/** Entregas por semana de cada agente (as mesmas semanas de `throughput.weeks`), do que mais entregou ao que menos. */
function agentWeeksOf(deliveries: readonly Delivery[], weeks: readonly { key: string }[], label: Names): MetricsReport["throughput"]["agentWeeks"] {
  const byAgent = new Map<string, Map<string, number>>();
  for (const delivery of deliveries) {
    if (delivery.agentId === undefined) continue;
    const counts = byAgent.get(delivery.agentId) ?? new Map<string, number>();
    const key = periodKey(new Date(delivery.at));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byAgent.set(delivery.agentId, counts);
  }
  return [...byAgent]
    .map(([key, counts]) => ({ key, label: label(key), counts: weeks.map((week) => counts.get(week.key) ?? 0) }))
    .filter((row) => row.counts.some((count) => count > 0))
    .sort((a, b) => sum(b.counts) - sum(a.counts) || a.label.localeCompare(b.label, "pt-BR") || a.key.localeCompare(b.key));
}

/** As `count` semanas (segunda a domingo, São Paulo) que terminam na do instante `end`, da mais antiga à atual. */
function weeksEnding(end: number, count: number): { key: string; start: number }[] {
  const weeks: { key: string; start: number }[] = [];
  let bounds = periodBounds(new Date(end));
  for (let i = 0; i < count; i += 1) {
    weeks.unshift({ key: bounds.key, start: bounds.start.getTime() });
    bounds = periodBounds(new Date(bounds.start.getTime() - 3_600_000));
  }
  return weeks;
}

// ---------- Cota ----------

const WINDOW_LENGTH_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * DAY_MS };
const clockLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayClockLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function quotaOf(snapshot: MetricsSnapshot, now: number): MetricsReport["quota"] {
  const windows: MetricsReport["quota"]["windows"] = [];
  for (const usage of snapshot.quota) {
    for (const window of usage.windows) {
      const state = usageWindowState(window, { updatedAt: usage.updatedAt, ...(usage.fetchedAt ? { fetchedAt: usage.fetchedAt } : {}), ...(usage.stale ? { stale: usage.stale } : {}) }, now);
      if (state.kind === "none") continue;
      const label = usageWindowLabel(window);
      const provider = usageProviderLabel(usage.provider);
      const length = WINDOW_LENGTH_MS[window.id];
      const resets = ms(window.resetsAt);
      let pace: number | null = null;
      if (state.kind === "value" && length !== undefined && !Number.isNaN(resets)) {
        const elapsed = 1 - (resets - now) / length;
        if (elapsed >= 0.05 && elapsed <= 1) pace = Math.round((window.utilization / elapsed) * 100) / 100;
      }
      const resetClock = (at: string): string => {
        const time = new Date(at);
        return `às ${Date.parse(at) - now < 20 * 3_600_000 ? clockLabel.format(time) : dayClockLabel.format(time).replace(",", "")}`;
      };
      windows.push({
        provider,
        id: window.id,
        label,
        state: state.kind,
        percent: state.percent,
        ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        text: state.kind === "renewed" ? `${provider}: ${label} renovada` : usageText(usage, window, usageLevelOf(window), resetClock),
        pace,
        warn: pace !== null && pace > 1.2,
      });
    }
  }
  const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const blocked = (snapshot.engineBlocks ?? []).map(({ agentId, block }) => ({ agentId, name: names.get(agentId) ?? agentId, label: engineBlockLabel(block, now, ROUTINE_TIMEZONE) }));
  return { windows, blocked };
}

// ---------- O cálculo ----------

/**
 * Os indicadores da Gestão, por código: nada de IA e nada de relógio escondido (`now` vem de fora).
 * Cada indicador compara a janela com a anterior do mesmo tamanho. Sem `from`/`to`: 7 dias para taxas e
 * contagens, 28 para medianas.
 */
export function computeMetrics(full: MetricsSnapshot, options: MetricsOptions): MetricsReport {
  // As regras da retrospectiva (kind "regra") esperam o dono, mas não seguram o time nem contam como aprovação ou recusa de trabalho.
  const snapshot: MetricsSnapshot = full.forYou.some((item) => forYouKind(item) === "regra") ? { ...full, forYou: full.forYou.filter((item) => forYouKind(item) !== "regra") } : full;
  const { now } = options;
  const explicit = options.from !== undefined || options.to !== undefined;
  const to = options.to ?? now;
  const rates: Range = explicit ? { from: options.from ?? to - METRICS_MEDIAN_DAYS * DAY_MS, to } : { from: now - METRICS_RATE_DAYS * DAY_MS, to: now };
  const medians: Range = explicit ? rates : { from: now - METRICS_MEDIAN_DAYS * DAY_MS, to: now };
  const prevRates = previous(rates);
  const prevMedians = previous(medians);

  const agentNames = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const agentName: Names = (id) => agentNames.get(id) ?? id;
  const same: Names = (key) => key;

  const projects = expandAvulsas(snapshot.projects);
  const deliveries = deliveriesOf(snapshot);
  const projectTitle = new Map(deliveries.map((delivery) => [delivery.groupKey, delivery.groupTitle]));
  const inRates = deliveries.filter((delivery) => inRange(delivery.at, rates));
  const inPrevRates = deliveries.filter((delivery) => inRange(delivery.at, prevRates));

  // 1. Vazão: contagem por semana de São Paulo, 8 semanas, média móvel de 4.
  const weeks = weeksEnding(Math.max(rates.to - 1, rates.from), METRICS_WEEKS + 3);
  const weekCount = new Map<string, number>();
  for (const delivery of deliveries) {
    const key = periodKey(new Date(delivery.at));
    weekCount.set(key, (weekCount.get(key) ?? 0) + 1);
  }
  const currentKey = weeks.at(-1)!.key;
  const throughputWeeks = weeks.slice(3).map((week, index) => {
    const window = weeks.slice(index, index + 4);
    return { key: week.key, start: dayKeyOf(week.start), count: weekCount.get(week.key) ?? 0, avg4: sum(window.map((w) => weekCount.get(w.key) ?? 0)) / 4, current: week.key === currentKey };
  });
  const throughput: MetricsReport["throughput"] = {
    ...metricValue({ value: inRates.length, n: inRates.length, prev: inPrevRates.length, prevN: inPrevRates.length, kind: "relative" }),
    weeks: throughputWeeks,
    agentWeeks: agentWeeksOf(deliveries, throughputWeeks, agentName),
    byAgent: countGroups(inRates, inPrevRates, (d) => d.agentId, agentName),
    byType: countGroups(inRates, inPrevRates, (d) => d.type, same),
    byProject: countGroups(inRates, inPrevRates, (d) => d.groupKey, (key) => projectTitle.get(key) ?? key),
  };

  // 2. Tempo até entregar: pedido -> entrega, partido em trabalhando e parado (esperando você, fila).
  const waitsOf = (projectId: string): number =>
    sum(
      snapshot.forYou
        .filter((item) => item.projectId === projectId && decidedByOwner(item) && item.decidedAt !== undefined)
        .map((item) => Math.max(0, ms(item.decidedAt) - ms(item.createdAt)))
        .filter((wait) => Number.isFinite(wait)),
    );
  const cycleUnits = (range: Range) =>
    projects
      .filter((project) => project.status === "concluido" && project.origin !== "rotina" && !project.routineRef && project.finishedAt !== undefined && inRange(ms(project.finishedAt), range))
      .map((project) => {
        const cycle = Math.max(0, ms(project.finishedAt) - ms(project.createdAt));
        const working = Math.min(
          cycle,
          sum(project.tasks.filter(isLeaf).flatMap((task) => task.steps.map((step) => (step.startedAt && step.finishedAt ? Math.max(0, ms(step.finishedAt) - ms(step.startedAt)) : 0)))),
        );
        const stopped = cycle - working;
        const waitingYou = Math.min(stopped, waitsOf(project.id));
        // Bloqueios gravados (`blockedSpans`): o parado por motivo é exato nos projetos que os têm.
        const spans = project.tasks.filter(isLeaf).flatMap((task) => task.blockedSpans ?? []);
        const spanMs = (type: string): number => sum(spans.filter((span) => span.type === type).map((span) => Math.max(0, ms(span.until) - ms(span.since))).filter(Number.isFinite));
        const hasSpans = project.tasks.some((task) => (task.blockedSpans ?? []).length > 0);
        const agents = [...new Set(project.tasks.filter(isDelivered).map(agentOfTask).filter((id): id is string => id !== undefined))];
        return { id: project.id, at: ms(project.finishedAt), cycle, working, stopped, waitingYou, queued: stopped - waitingYou, agents, hasSpans, byType: { agente: Math.min(stopped, spanMs("agente")), cota: Math.min(stopped, spanMs("cota")), acesso: Math.min(stopped, spanMs("acesso")) } };
      })
      .filter((unit) => Number.isFinite(unit.cycle));
  const cycles = cycleUnits(medians);
  const prevCycles = cycleUnits(prevMedians);
  const cycleTime: MetricsReport["cycleTime"] = {
    ...medianValue(cycles.map((unit) => unit.cycle), prevCycles.map((unit) => unit.cycle)),
    p90: nearestRank(cycles.map((unit) => unit.cycle), 0.9),
    workingMs: median(cycles.map((unit) => unit.working)),
    stoppedMs: median(cycles.map((unit) => unit.stopped)),
    waitingYouMs: median(cycles.map((unit) => unit.waitingYou)),
    queuedMs: median(cycles.map((unit) => unit.queued)),
    stoppedBy: {
      agente: median(cycles.filter((unit) => unit.hasSpans).map((unit) => unit.byType.agente)),
      cota: median(cycles.filter((unit) => unit.hasSpans).map((unit) => unit.byType.cota)),
      acesso: median(cycles.filter((unit) => unit.hasSpans).map((unit) => unit.byType.acesso)),
    },
    stoppedExact: cycles.length > 0 && cycles.every((unit) => unit.hasSpans),
    weeks: throughputWeeks.map((week) => {
      const units = cycleUnits({ from: Date.parse(`${week.start}T00:00:00Z`) - DAY_MS, to: Date.parse(`${week.start}T00:00:00Z`) + 8 * DAY_MS }).filter((unit) => periodKey(new Date(unit.at)) === week.key);
      return { key: week.key, n: units.length, median: median(units.map((unit) => unit.cycle)), p90: nearestRank(units.map((unit) => unit.cycle), 0.9) };
    }),
    byAgent: medianGroups(
      cycles.flatMap((unit) => unit.agents.map((agentId) => ({ agentId, cycle: unit.cycle }))),
      prevCycles.flatMap((unit) => unit.agents.map((agentId) => ({ agentId, cycle: unit.cycle }))),
      (entry) => entry.agentId,
      (entry) => entry.cycle,
      agentName,
    ),
  };

  // 3. Espera pelo OK: itens decididos e pendentes.
  const waitItems = (range: Range) =>
    snapshot.forYou
      .filter((item) => decidedByOwner(item) && item.decidedAt !== undefined && inRange(ms(item.decidedAt), range))
      .map((item) => ({ item, wait: ms(item.decidedAt) - ms(item.createdAt) }))
      .filter((entry) => Number.isFinite(entry.wait) && entry.wait >= 0);
  const waits = waitItems(medians);
  const prevWaits = waitItems(prevMedians);
  const pending = snapshot.forYou
    .filter((item) => item.status === "pendente")
    .map((item) => ({ id: item.id, type: forYouKind(item) === "aprovacao" ? item.type : forYouKind(item), ...(item.agentId ? { agentId: item.agentId } : {}), ageMs: Math.max(0, now - ms(item.createdAt)) }))
    .filter((item) => Number.isFinite(item.ageMs))
    .sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
  const cycleSum = sum(cycles.map((unit) => unit.cycle));
  const approvalWait: MetricsReport["approvalWait"] = {
    ...medianValue(waits.map((entry) => entry.wait), prevWaits.map((entry) => entry.wait)),
    p90: nearestRank(waits.map((entry) => entry.wait), 0.9),
    weightInCycle: cycleSum > 0 ? sum(cycles.map((unit) => unit.waitingYou)) / cycleSum : null,
    pending: { count: pending.length, over24h: pending.filter((item) => item.ageMs > DAY_MS).length, oldestMs: pending[0]?.ageMs ?? null, items: pending.slice(0, 5) },
    byAgent: medianGroups(waits, prevWaits, (entry) => entry.item.agentId, (entry) => entry.wait, agentName),
    byType: medianGroups(waits, prevWaits, (entry) => typeOfItem(entry.item), (entry) => entry.wait, same),
  };

  // 4. Travados agora (sobre os projetos como estão gravados: a falha do Avulsas também aparece).
  const blockedItems: MetricsReport["blockedNow"]["items"] = [];
  for (const project of snapshot.projects) {
    if (project.status !== "ativo") continue;
    for (const task of project.tasks) {
      if (!isLeaf(task) || task.archived || task.status === "concluida" || task.status === "cancelada" || task.status === "backlog") continue;
      let type: MetricsReport["blockedNow"]["items"][number]["type"] | undefined;
      let since: string | undefined;
      if (task.status === "falhou") {
        type = "falha";
        since = task.finishedAt ?? task.updatedAt;
      } else if (task.blocked) {
        type = task.blocked.type;
        since = task.blocked.since;
      } else if (task.waitingSince && now - ms(task.waitingSince) > METRICS_STALL_MS) {
        type = task.status === "esperando_voce" ? "voce" : "espera";
        since = task.waitingSince;
      }
      if (!type || !since || Number.isNaN(ms(since))) continue;
      const isAvulsa = project.system === "avulsas";
      blockedItems.push({
        projectId: isAvulsa ? leafRequestId(task) : project.id,
        projectTitle: isAvulsa ? task.title : project.title,
        ref: task.ref,
        title: task.title,
        type,
        since,
        ageMs: Math.max(0, now - ms(since)),
        ...(task.ownerId ? { agentId: task.ownerId } : {}),
      });
    }
  }
  blockedItems.sort((a, b) => b.ageMs - a.ageMs || a.projectId.localeCompare(b.projectId) || a.ref.localeCompare(b.ref));
  const blockedByType: Record<string, number> = {};
  for (const item of blockedItems) blockedByType[item.type] = (blockedByType[item.type] ?? 0) + 1;
  const blockedNow = { count: blockedItems.length, byType: blockedByType, items: blockedItems.slice(0, 20) };

  // 5. Falha: tarefas do escritório que terminaram; a cancelada não é falha nem entra na conta.
  const finishedTasks = (range: Range) =>
    snapshot.tasks.filter((task) => task.role !== "request" && (task.status === "done" || (task.status === "failed" && task.outcome !== "cancelled")) && inRange(ms(task.updatedAt), range));
  const ran = finishedTasks(rates);
  const prevRan = finishedTasks(prevRates);
  const failed = (task: Task) => task.status === "failed";
  const modelKey = (task: Task): string => (task.ranWith ? `${task.ranWith.engine} · ${task.ranWith.model ?? "padrão"}` : "desconhecido");
  // Falha do agente: sem as de motor, cota e acesso (as sem origem gravada, de tarefas antigas, contam como do agente: "aproximado").
  const agentFailure = (task: Task) => task.status === "failed" && (task.failureKind === undefined || task.failureKind === "agente");
  const byKind: Record<string, number> = {};
  for (const task of ran.filter(failed)) byKind[task.failureKind ?? "desconhecida"] = (byKind[task.failureKind ?? "desconhecida"] ?? 0) + 1;
  const failureRate: MetricsReport["failureRate"] = {
    ...rateValue(ran.filter(failed).length, ran.length, prevRan.filter(failed).length, prevRan.length),
    agentOnly: rateValue(ran.filter(agentFailure).length, ran.length, prevRan.filter(agentFailure).length, prevRan.length),
    byKind,
    approx: ran.some((task) => failed(task) && task.failureKind === undefined),
    byAgent: rateGroups(ran, prevRan, (task) => task.agentId, agentFailure, agentName),
    byModel: rateGroups(ran, prevRan, modelKey, failed, same),
  };

  // 6. Recusa: só o que o dono decidiu, em aprovação de texto.
  const decisions = (range: Range) => snapshot.forYou.filter((item) => forYouKind(item) === "aprovacao" && (item.status === "aprovado" || item.status === "rejeitado") && item.decidedBy !== "automatico" && item.decidedAt !== undefined && inRange(ms(item.decidedAt), range));
  const decided = decisions(rates);
  const prevDecided = decisions(prevRates);
  const rejected = (item: ForYouItem) => item.status === "rejeitado";
  const rejectionRate: MetricsReport["rejectionRate"] = {
    ...rateValue(decided.filter(rejected).length, decided.length, prevDecided.filter(rejected).length, prevDecided.length),
    byAgent: rateGroups(decided, prevDecided, (item) => item.agentId, rejected, agentName),
    byType: rateGroups(decided, prevDecided, typeOfItem, rejected, same),
  };

  // 7. Refeito a pedido: concluídas com `rework.count > 0`.
  const concluded = (range: Range) =>
    projects
      .flatMap((project) => project.tasks)
      .filter((task) => isDelivered(task) && inRange(ms(task.finishedAt), range));
  const done = concluded(rates);
  const prevDone = concluded(prevRates);
  const reworked = (task: ProjectTask) => (task.rework?.count ?? 0) > 0;
  const rework: MetricsReport["rework"] = {
    ...rateValue(done.filter(reworked).length, done.length, prevDone.filter(reworked).length, prevDone.length),
    avgCount: done.length > 0 ? sum(done.map((task) => task.rework?.count ?? 0)) / done.length : null,
    byAgent: rateGroups(done, prevDone, agentOfTask, reworked, agentName),
  };

  // 8. Edição: quantos aprovados o dono mexeu e quanto trocou (Dice sobre bigramas).
  const approved = decided.filter((item) => item.status === "aprovado");
  const prevApproved = prevDecided.filter((item) => item.status === "aprovado");
  const edited = (item: ForYouItem) => item.editedByUser;
  const intensityOf = (items: readonly ForYouItem[]) => items.filter(edited).map((item) => editIntensity(item.originalText, item.text));
  const intensityGroups = (key: (item: ForYouItem) => string | undefined, label: Names): MetricGroup[] =>
    rateGroups(approved, prevApproved, key, edited, label).map((group) => ({ ...group, intensity: median(intensityOf(approved.filter((item) => key(item) === group.key))) }));
  const editRate: MetricsReport["editRate"] = {
    ...rateValue(approved.filter(edited).length, approved.length, prevApproved.filter(edited).length, prevApproved.length),
    intensity: medianValue(intensityOf(approved), intensityOf(prevApproved)),
    byAgent: intensityGroups((item) => item.agentId, agentName),
    byType: intensityGroups(typeOfItem, same),
  };

  // 9. Custo por entrega (equivalente à API): o custo de cada projeto (ou da tarefa da rotina) é rateado por igual entre
  // TODAS as entregas dele; a janela soma as fatias das entregas que caíram nela. O mesmo dólar nunca aparece em duas janelas.
  const costs = costIndex(snapshot.usage);
  const deliveriesPerRoot = new Map<string, number>();
  for (const delivery of deliveries) deliveriesPerRoot.set(delivery.costRoot, (deliveriesPerRoot.get(delivery.costRoot) ?? 0) + 1);
  const shareOf = (delivery: Delivery): number => (costs.byRoot.get(delivery.costRoot) ?? 0) / (deliveriesPerRoot.get(delivery.costRoot) ?? 1);
  const costOf = (list: readonly Delivery[]): { totalUsd: number; deliveries: number; byProject: Map<string, { usd: number; deliveries: number }>; byAgent: Map<string, number> } => {
    const byProject = new Map<string, { usd: number; deliveries: number }>();
    const byAgent = new Map<string, number>();
    for (const delivery of list) {
      const share = shareOf(delivery);
      const entry = byProject.get(delivery.groupKey) ?? { usd: 0, deliveries: 0 };
      entry.usd += share;
      entry.deliveries += 1;
      byProject.set(delivery.groupKey, entry);
      if (delivery.agentId !== undefined) byAgent.set(delivery.agentId, (byAgent.get(delivery.agentId) ?? 0) + share);
    }
    return { totalUsd: sum([...byProject.values()].map((entry) => entry.usd)), deliveries: list.length, byProject, byAgent };
  };
  const cost = costOf(inRates);
  const prevCost = costOf(inPrevRates);
  const perDelivery = (usd: number, count: number): number | null => (count > 0 ? usd / count : null);
  const costByAgent = sortGroups(
    [...cost.byAgent.keys()].map((agentId) => {
      const n = inRates.filter((delivery) => delivery.agentId === agentId).length;
      const prevN = inPrevRates.filter((delivery) => delivery.agentId === agentId).length;
      return { key: agentId, label: agentName(agentId), ...metricValue({ value: perDelivery(cost.byAgent.get(agentId) ?? 0, n), n, prev: perDelivery(prevCost.byAgent.get(agentId) ?? 0, prevN), prevN, kind: "relative" }) };
    }),
  );
  const costByProject = sortGroups(
    [...cost.byProject].map(([key, entry]) => {
      const before = prevCost.byProject.get(key);
      return { key, label: projectTitle.get(key) ?? key, ...metricValue({ value: perDelivery(entry.usd, entry.deliveries), n: entry.deliveries, prev: before ? perDelivery(before.usd, before.deliveries) : null, prevN: before?.deliveries ?? 0, kind: "relative" }) };
    }),
  );
  const costPerDelivery: MetricsReport["costPerDelivery"] = {
    ...metricValue({ value: perDelivery(cost.totalUsd, cost.deliveries), n: cost.deliveries, prev: perDelivery(prevCost.totalUsd, prevCost.deliveries), prevN: prevCost.deliveries, kind: "relative" }),
    note: "custo dos projetos rateado por entrega (equivalente à API, não o que se paga); não é o gasto da janela",
    totalUsd: cost.totalUsd,
    deliveries: cost.deliveries,
    byAgent: costByAgent,
    byProject: costByProject,
  };

  // 10. Carga por agente, agora.
  const live = snapshot.tasks.filter((task) => task.role !== "request");
  const week = { from: now - 7 * DAY_MS, to: now + 1 };
  const load: MetricsReport["load"] = {
    running: live.filter((task) => task.status === "in_progress").length,
    maxRunning: snapshot.dispatch.maxRunning,
    perAgentLimit: snapshot.dispatch.perAgent,
    queued: live.filter((task) => task.status === "queued").length,
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      doing: live.filter((task) => task.agentId === agent.id && task.status === "in_progress").length,
      queued: live.filter((task) => task.agentId === agent.id && task.status === "queued").length,
      waiting: live.filter((task) => task.agentId === agent.id && task.status === "waiting_approval").length,
      workedMs7d: sum(snapshot.usage.filter((record) => record.agentId === agent.id && inRange(ms(record.at), week)).map((record) => record.durationMs ?? 0)),
    })),
  };

  // 11. Espera na fila (de `a_fazer` até começar), por agente: exata com `queuedAt`; sem ele, desde que a tarefa podia começar.
  const queueSamples = (range: Range) => queueWaits(projects).filter((sample) => inRange(sample.startedAt, range));
  const queueNow = queueSamples(medians);
  const queuePrev = queueSamples(prevMedians);
  const queueWait: MetricsReport["queueWait"] = {
    ...medianValue(queueNow.map((sample) => sample.wait), queuePrev.map((sample) => sample.wait)),
    p90: nearestRank(queueNow.map((sample) => sample.wait), 0.9),
    approx: queueNow.some((sample) => !sample.exact),
    byAgent: medianGroups(queueNow, queuePrev, (sample) => sample.agentId, (sample) => sample.wait, agentName),
  };

  return {
    v: 1,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    now: iso(now),
    timeZone: ROUTINE_TIMEZONE,
    windows: { rates: windowOf(rates), medians: windowOf(medians) },
    prevWindows: { rates: windowOf(prevRates), medians: windowOf(prevMedians) },
    throughput,
    cycleTime,
    approvalWait,
    blockedNow,
    failureRate,
    rejectionRate,
    rework,
    editRate,
    costPerDelivery,
    load,
    queueWait,
    spend: { usd: sum(snapshot.usage.filter((record) => inRange(ms(record.at), rates)).map(costs.of)), prevUsd: sum(snapshot.usage.filter((record) => inRange(ms(record.at), prevRates)).map(costs.of)) },
    quota: quotaOf(snapshot, now),
    forecast: options.light ? { projects: [], text: "previsão desligada (modo leve)" } : forecastAll(snapshot, now),
    goals: goalsOf(snapshot.goals ?? []),
  };
}

// ---------- Auxiliares ----------

/** Metas: a lista e uma frase ("2 de 3 fecham no ritmo atual"). */
function goalsOf(items: readonly GoalProjection[]): MetricsReport["goals"] {
  const open = items.filter((item) => item.delivered < item.target);
  const closing = open.filter((item) => item.closes).length;
  const text = items.length === 0 ? "nenhuma meta ativa" : open.length === 0 ? "todas as metas do período já foram batidas" : `${closing} de ${open.length} metas abertas fecham no ritmo atual`;
  return { items: [...items], text };
}

/** Uma espera na fila: quanto a tarefa ficou em `a_fazer` antes de começar, de quem era e se o dado é exato (`queuedAt`) ou aproximado. */
type QueueSample = { agentId: string; startedAt: number; wait: number; exact: boolean };

function queueWaits(projects: readonly Project[]): QueueSample[] {
  const out: QueueSample[] = [];
  for (const project of projects) {
    for (const task of project.tasks) {
      if (!isLeaf(task) || task.skipped || task.archived) continue;
      const agentId = task.steps[0]?.agentId ?? (task.ownerId || undefined);
      if (!agentId) continue;
      const starts = task.steps.map((step) => ms(step.startedAt)).filter(Number.isFinite).sort((a, b) => a - b);
      if (starts.length === 0 && Number.isFinite(ms(task.startedAt))) starts.push(ms(task.startedAt));
      if (task.queuedAt !== undefined) {
        const queued = ms(task.queuedAt);
        const startedAt = starts.find((start) => start >= queued);
        if (startedAt !== undefined) out.push({ agentId, startedAt, wait: startedAt - queued, exact: true });
        continue;
      }
      // Tarefa antiga: fica na fila desde que a última coisa de que dependia terminou (ou desde a aprovação do projeto).
      const first = starts[0];
      if (first === undefined) continue;
      const deps = task.dependsOn.map((ref) => ms(project.tasks.find((candidate) => candidate.ref === ref)?.finishedAt)).filter(Number.isFinite);
      const eligible = Math.max(ms(project.approvedAt ?? task.meta?.createdAt ?? project.createdAt), ...deps);
      if (Number.isFinite(eligible) && first >= eligible) out.push({ agentId, startedAt: first, wait: first - eligible, exact: false });
    }
  }
  return out;
}

/** Item que o dono decidiu (aprovou, recusou ou respondeu): é a espera dele. O Modo Automático não conta. */
function decidedByOwner(item: ForYouItem): boolean {
  return (item.status === "aprovado" || item.status === "rejeitado" || item.status === "respondido") && item.decidedBy !== "automatico";
}

/** O "tipo" do item: o tipo de aprovação (comentário, post…) ou, nos outros formatos, o formato (plano, rotina…). */
function typeOfItem(item: ForYouItem): string {
  const kind = forYouKind(item);
  return kind === "aprovacao" ? item.type : kind;
}

/** Custo (USD) por registro, repreçado pela tabela de hoje como a página Gastos, e somado por raiz (`rootTaskId`) e por tarefa. */
function costIndex(records: readonly UsageRecord[]): { byRoot: Map<string, number>; of: (record: UsageRecord) => number } {
  const of = (record: UsageRecord): number => {
    if (record.test) return 0;
    const priced = priceRecord(record);
    return priced.suspect ? 0 : (priced.cost.usd ?? 0);
  };
  const byRoot = new Map<string, number>();
  for (const record of records) {
    const usd = of(record);
    if (usd === 0) continue;
    for (const id of new Set([record.rootTaskId, record.taskId].filter((value): value is string => value !== undefined))) byRoot.set(id, (byRoot.get(id) ?? 0) + usd);
  }
  return { byRoot, of };
}

/** Deixa só os grupos pedidos (`group_by`): "none" tira todos; "routine" fica com os de rotina dentro de `byProject`. */
export function pickGroups(report: MetricsReport, groupBy: MetricsGroupBy | undefined): MetricsReport {
  if (groupBy === undefined) return report;
  const keep = {
    agent: groupBy === "agent",
    type: groupBy === "type",
    project: groupBy === "project" || groupBy === "routine",
  };
  const only = (list: MetricGroup[], on: boolean, filter?: (group: MetricGroup) => boolean): MetricGroup[] => (on ? (filter ? list.filter(filter) : list) : []);
  const routineOnly = groupBy === "routine" ? (group: MetricGroup) => group.key.startsWith("rotina:") : undefined;
  const projectOnly = groupBy === "project" ? (group: MetricGroup) => !group.key.startsWith("rotina:") : routineOnly;
  return {
    ...report,
    throughput: { ...report.throughput, agentWeeks: keep.agent ? report.throughput.agentWeeks : [], byAgent: only(report.throughput.byAgent, keep.agent), byType: only(report.throughput.byType, keep.type), byProject: only(report.throughput.byProject, keep.project, projectOnly) },
    cycleTime: { ...report.cycleTime, byAgent: only(report.cycleTime.byAgent, keep.agent) },
    approvalWait: { ...report.approvalWait, byAgent: only(report.approvalWait.byAgent, keep.agent), byType: only(report.approvalWait.byType, keep.type) },
    failureRate: { ...report.failureRate, byAgent: only(report.failureRate.byAgent, keep.agent), byModel: only(report.failureRate.byModel, keep.agent) },
    rejectionRate: { ...report.rejectionRate, byAgent: only(report.rejectionRate.byAgent, keep.agent), byType: only(report.rejectionRate.byType, keep.type) },
    rework: { ...report.rework, byAgent: only(report.rework.byAgent, keep.agent) },
    editRate: { ...report.editRate, byAgent: only(report.editRate.byAgent, keep.agent), byType: only(report.editRate.byType, keep.type) },
    costPerDelivery: { ...report.costPerDelivery, byAgent: only(report.costPerDelivery.byAgent, keep.agent), byProject: only(report.costPerDelivery.byProject, keep.project, projectOnly) },
  };
}
