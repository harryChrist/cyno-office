import {
  suspectReasonOf,
  USAGE_HISTORY_TIMEZONE,
  type UsageHistoryFlags,
  type UsageSuspectReason,
  type Agent,
  type AgentProvider,
  type Task,
  type UsageHistoryGroup,
  type UsageHistoryGroupBy,
  type UsageHistoryResponse,
  type UsageRecord,
  type UsageStackPart,
  type UsageTaskHistoryResponse,
  type UsageTotals,
  type UsageTurnRow,
} from "@cyno/shared";
import { computeCost, PRICE_TABLE, priceInfo, type Cost, type PriceTable } from "./pricing";
import { taskTitleOf } from "./usage-history";
import { addDays, dayKeyOf, periodOf, startOfDay, type TimeGroupBy } from "./usage-time";

/**
 * Somas do histórico de gastos (funções puras): o custo de cada linha é recalculado com a tabela de
 * preços atual (o `costUsd` gravado é só referência), e os grupos de tempo viram no fuso de São Paulo.
 */

export function emptyTotals(): UsageTotals {
  return {
    turns: 0,
    measuredTurns: 0,
    unmeasuredTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costBrl: 0,
    costByType: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
    unpricedTurns: 0,
    unpricedTokens: 0,
    cacheHitRatio: null,
    durationMs: 0,
  };
}

/** Uma linha com o custo já recalculado. */
export type PricedRecord = { record: UsageRecord; cost: Cost; turns: number; totalTokens: number; suspect?: UsageSuspectReason };

/**
 * O valor do turno é impossível? Vale a marca gravada na hora (campo suspect da linha) e, nas linhas
 * antigas ou importadas, a conta de agora (a guarda é um filtro de leitura: não perde dado).
 */
export function suspectOf(record: UsageRecord, costUsd: number | null): UsageSuspectReason | undefined {
  return record.suspect ?? suspectReasonOf(record.tokens, costUsd);
}

export function priceRecord(record: UsageRecord, table: PriceTable = PRICE_TABLE): PricedRecord {
  const tokens = record.tokens;
  const cost = computeCost(
    { model: record.model, at: record.at, tokens, promptTokens: record.promptTokens, speed: record.speed, webSearches: record.webSearches },
    table,
  );
  const totalTokens = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation : 0;
  const suspect = suspectOf(record, cost.usd);
  return { record, cost, turns: record.turns ?? 1, totalTokens, ...(suspect ? { suspect } : {}) };
}

export function addToTotals(totals: UsageTotals, priced: PricedRecord): void {
  const { record, cost, turns, totalTokens } = priced;
  totals.turns += turns;
  if (record.measured && record.tokens) {
    totals.measuredTurns += turns;
    totals.inputTokens += record.tokens.input;
    totals.outputTokens += record.tokens.output;
    totals.cacheReadTokens += record.tokens.cacheRead;
    totals.cacheCreationTokens += record.tokens.cacheCreation;
    totals.totalTokens += totalTokens;
    if (cost.usd === null) {
      totals.unpricedTurns += turns;
      totals.unpricedTokens += totalTokens;
    } else {
      totals.costUsd += cost.usd;
      const by = totals.costByType;
      by.input += cost.byType.input;
      by.output += cost.byType.output;
      by.cacheRead += cost.byType.cacheRead;
      by.cacheWrite += cost.byType.cacheWrite;
      by.webSearch += cost.byType.webSearch;
    }
  } else {
    totals.unmeasuredTurns += turns;
  }
  totals.durationMs += record.durationMs ?? 0;
}

/** Fecha a soma: cache hit e o BRL pela cotação. */
export function finishTotals(totals: UsageTotals, usdBrl: number): UsageTotals {
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  totals.cacheHitRatio = prompt > 0 ? totals.cacheReadTokens / prompt : null;
  totals.costBrl = totals.costUsd * usdBrl;
  return totals;
}

/** Soma as linhas SEM as de valor impossível (elas aparecem à parte, em flags). */
export function totalsOf(records: readonly PricedRecord[], usdBrl: number): UsageTotals {
  const totals = emptyTotals();
  for (const priced of records) if (!priced.suspect) addToTotals(totals, priced);
  return finishTotals(totals, usdBrl);
}

const PROVIDER_LABELS: Partial<Record<AgentProvider, string>> = { claude: "Claude Code", gemini: "Antigravity" };
const NO_TASK_KEY = "_sem-tarefa";
const NO_TASK_LABEL = "Sem tarefa (conversas e outros)";
const UNKNOWN_MODEL_KEY = "_desconhecido";

export type Lookup = { agents: readonly Agent[]; tasks: readonly Task[] };

/** Nome do agente: o atual, senão o gravado na linha mais recente, senão o id. */
function agentLabel(agentId: string, lookup: Lookup, recorded?: string): string {
  return lookup.agents.find((agent) => agent.id === agentId)?.name ?? recorded ?? agentId;
}

function modelKey(priced: PricedRecord): { key: string; label: string } {
  if (priced.cost.model) return { key: priced.cost.model.id, label: priced.cost.model.label };
  const raw = priced.record.model;
  return raw ? { key: raw, label: `${raw} (sem preço)` } : { key: UNKNOWN_MODEL_KEY, label: "Modelo desconhecido" };
}

function taskKey(record: UsageRecord): string {
  return record.rootTaskId ?? record.taskId ?? NO_TASK_KEY;
}

function taskLabel(key: string, lookup: Lookup, recorded?: string): string {
  if (key === NO_TASK_KEY) return NO_TASK_LABEL;
  const task = lookup.tasks.find((item) => item.id === key);
  return task ? taskTitleOf(task) : (recorded ?? `Tarefa ${key.slice(0, 8)}`);
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function timeLabel(key: string, groupBy: TimeGroupBy): string {
  const [year, month, day] = key.split("-");
  if (groupBy === "month") return `${MONTHS[Number(month) - 1]}/${year}`;
  const short = `${pad(Number(day))}/${pad(Number(month))}`;
  return groupBy === "week" ? `Semana de ${short}` : short;
}

type Bucket = { key: string; label: string; records: PricedRecord[]; extra: Partial<UsageHistoryGroup>; recordedLabel?: string; fallbackLabel?: string };

export type HistoryOptions = {
  fromDay: string;
  toDay: string;
  groupBy: UsageHistoryGroupBy;
  stackBy?: "agent" | "model";
  agentId?: string;
  provider?: AgentProvider;
  usdBrl: number;
  table?: PriceTable;
};

/** As linhas de um intervalo de dias (inclusive) no fuso de São Paulo, já filtradas. */
export function rangeMs(fromDay: string, toDay: string): { fromMs: number; toMs: number } {
  return { fromMs: startOfDay(fromDay), toMs: startOfDay(addDays(toDay, 1)) };
}

/** Monta a resposta de `GET /usage/history` a partir das linhas (de qualquer período: filtra aqui). */
export function aggregateHistory(records: readonly UsageRecord[], options: HistoryOptions, lookup: Lookup): UsageHistoryResponse {
  const table = options.table ?? PRICE_TABLE;
  const { fromMs, toMs } = rangeMs(options.fromDay, options.toDay);
  const priced = records
    .filter((record) => {
      const at = Date.parse(record.at);
      return at >= fromMs && at < toMs && (!options.agentId || record.agentId === options.agentId) && (!options.provider || record.provider === options.provider);
    })
    .map((record) => priceRecord(record, table));

  const buckets = new Map<string, Bucket>();
  const bucket = (key: string, label: string, extra: Partial<UsageHistoryGroup> = {}): Bucket => {
    let found = buckets.get(key);
    if (!found) {
      found = { key, label, records: [], extra };
      buckets.set(key, found);
    }
    return found;
  };

  const groupBy = options.groupBy;
  const isTime = groupBy === "day" || groupBy === "week" || groupBy === "month";
  if (isTime) {
    // Todos os períodos do intervalo, mesmo vazios (o gráfico não pula dias).
    for (let day = options.fromDay; day <= options.toDay; ) {
      const period = periodOf(day, groupBy);
      bucket(period.key, timeLabel(period.key, groupBy), {
        start: new Date(startOfDay(period.firstDay)).toISOString(),
        end: new Date(startOfDay(period.nextDay)).toISOString(),
      });
      day = period.nextDay;
    }
  }
  for (const item of priced) {
    const { record } = item;
    if (isTime) {
      const period = periodOf(dayKeyOf(Date.parse(record.at)), groupBy);
      bucket(period.key, timeLabel(period.key, groupBy)).records.push(item);
    } else if (groupBy === "agent") {
      const found = bucket(record.agentId, record.agentId, { provider: record.provider });
      found.records.push(item);
      found.recordedLabel = record.agentName ?? found.recordedLabel;
    } else if (groupBy === "model") {
      const { key, label } = modelKey(item);
      bucket(key, label, { provider: record.provider }).records.push(item);
    } else if (groupBy === "provider") {
      bucket(record.provider, PROVIDER_LABELS[record.provider] ?? record.provider, { provider: record.provider }).records.push(item);
    } else {
      const key = taskKey(record);
      const found = bucket(key, key);
      found.records.push(item);
      // O título gravado do próprio pedido (se ele sumir do quadro, é o que sobra).
      if (record.taskId === key && record.taskTitle) found.recordedLabel = record.taskTitle;
      else if (record.taskTitle) found.fallbackLabel ??= record.taskTitle;
    }
  }

  const groups: UsageHistoryGroup[] = [...buckets.values()].map((found) => {
    const group: UsageHistoryGroup = { key: found.key, label: found.label, ...found.extra, totals: totalsOf(found.records, options.usdBrl) };
    if (groupBy === "agent") group.label = agentLabel(found.key, lookup, found.recordedLabel);
    if (groupBy === "task") {
      group.label = taskLabel(found.key, lookup, found.recordedLabel ?? found.fallbackLabel);
      const status = lookup.tasks.find((task) => task.id === found.key)?.status;
      if (status) group.taskStatus = status;
      const subtasks = new Set(found.records.map((item) => item.record.taskId).filter((id) => id && id !== found.key));
      group.subtasks = subtasks.size;
    }
    if (isTime && options.stackBy) group.stack = stackOf(found.records, options.stackBy, options.usdBrl, lookup);
    return group;
  });
  if (!isTime) groups.sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.totalTokens - a.totals.totalTokens || b.totals.turns - a.totals.turns);

  return {
    from: options.fromDay,
    to: options.toDay,
    timezone: USAGE_HISTORY_TIMEZONE,
    groupBy,
    ...(options.stackBy ? { stackBy: options.stackBy } : {}),
    usdBrl: options.usdBrl,
    prices: priceInfo(table),
    overall: totalsOf(priced, options.usdBrl),
    groups,
    flags: flagsOf(priced),
  };
}

/** O que ficou de fora dos totais (suspeitas) e o que é estimado (turnos cortados). */
export function flagsOf(priced: readonly PricedRecord[]): UsageHistoryFlags {
  const flags: UsageHistoryFlags = { suspect: { records: 0, tokens: 0, reasons: {} }, partial: { records: 0, tokens: 0, costUsd: 0 } };
  for (const item of priced) {
    if (item.suspect) {
      flags.suspect.records += 1;
      flags.suspect.tokens += item.totalTokens;
      flags.suspect.reasons[item.suspect] = (flags.suspect.reasons[item.suspect] ?? 0) + 1;
      if (!flags.suspect.latestAt || item.record.at > flags.suspect.latestAt) flags.suspect.latestAt = item.record.at;
    } else if (item.record.partial) {
      flags.partial.records += 1;
      flags.partial.tokens += item.totalTokens;
      flags.partial.costUsd += item.cost.usd ?? 0;
    }
  }
  return flags;
}

/** As fatias de um período (por agente ou por modelo), maior custo primeiro. */
function stackOf(records: readonly PricedRecord[], by: "agent" | "model", usdBrl: number, lookup: Lookup): UsageStackPart[] {
  const parts = new Map<string, { label: string; records: PricedRecord[] }>();
  for (const item of records) {
    const { key, label } = by === "agent" ? { key: item.record.agentId, label: agentLabel(item.record.agentId, lookup, item.record.agentName) } : modelKey(item);
    const part = parts.get(key) ?? { label, records: [] };
    part.records.push(item);
    parts.set(key, part);
  }
  return [...parts.entries()]
    .map(([key, part]) => {
      const totals = totalsOf(part.records, usdBrl);
      return { key, label: part.label, costUsd: totals.costUsd, costBrl: totals.costBrl, totalTokens: totals.totalTokens, turns: totals.turns };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
}

/**
 * Detalhe de um pedido (`GET /usage/history/task/:taskId`): todas as linhas em que ele é a tarefa
 * ou o pedido de origem, separadas por tarefa (o pedido e cada subtarefa), por agente e por modelo,
 * mais os últimos 200 turnos. Sem nenhuma linha = undefined.
 */
export function aggregateTask(records: readonly UsageRecord[], taskId: string, usdBrl: number, lookup: Lookup, table: PriceTable = PRICE_TABLE): UsageTaskHistoryResponse | undefined {
  const own = records.filter((record) => record.taskId === taskId || record.rootTaskId === taskId || record.parentTaskId === taskId).map((record) => priceRecord(record, table));
  const task = lookup.tasks.find((item) => item.id === taskId);
  if (own.length === 0 && !task) return undefined;
  const group = <K extends string>(keyOf: (item: PricedRecord) => { key: K; label: string; extra?: Partial<UsageHistoryGroup> }): UsageHistoryGroup[] => {
    const map = new Map<string, { label: string; extra: Partial<UsageHistoryGroup>; records: PricedRecord[] }>();
    for (const item of own) {
      const { key, label, extra = {} } = keyOf(item);
      const found = map.get(key) ?? { label, extra, records: [] };
      found.records.push(item);
      map.set(key, found);
    }
    return [...map.entries()]
      .map(([key, found]) => ({ key, label: found.label, ...found.extra, totals: totalsOf(found.records, usdBrl) }))
      .sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.totalTokens - a.totals.totalTokens);
  };
  const recordedTitle = own.find((item) => item.record.taskId === taskId && item.record.taskTitle)?.record.taskTitle;
  const tasks = group((item) => {
    const id = item.record.taskId ?? taskId;
    const current = lookup.tasks.find((candidate) => candidate.id === id);
    const label = current ? taskTitleOf(current) : (item.record.taskTitle ?? `Tarefa ${id.slice(0, 8)}`);
    return { key: id, label, extra: { provider: item.record.provider, ...(current ? { taskStatus: current.status } : {}) } };
  });
  const agents = group((item) => ({ key: item.record.agentId, label: agentLabel(item.record.agentId, lookup, item.record.agentName), extra: { provider: item.record.provider } }));
  const models = group((item) => ({ ...modelKey(item), extra: { provider: item.record.provider } }));
  const turns: UsageTurnRow[] = [...own]
    .sort((a, b) => Date.parse(b.record.at) - Date.parse(a.record.at))
    .slice(0, 200)
    .map((item) => ({
      at: item.record.at,
      agentId: item.record.agentId,
      agentName: agentLabel(item.record.agentId, lookup, item.record.agentName),
      ...(item.record.model ? { model: item.cost.model?.label ?? item.record.model } : {}),
      ...(item.record.taskId ? { taskId: item.record.taskId } : {}),
      measured: item.record.measured,
      totalTokens: item.totalTokens,
      costUsd: item.cost.usd,
      ...(item.record.durationMs !== undefined ? { durationMs: item.record.durationMs } : {}),
    }));
  return {
    taskId,
    title: task ? taskTitleOf(task) : (recordedTitle ?? `Tarefa ${taskId.slice(0, 8)}`),
    ...(task ? { status: task.status } : {}),
    usdBrl,
    prices: priceInfo(table),
    totals: totalsOf(own, usdBrl),
    tasks,
    agents,
    models,
    turns,
  };
}
