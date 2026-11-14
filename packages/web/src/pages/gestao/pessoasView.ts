import { METRICS_MIN_SAMPLES, type MetricGroup, type MetricsReport } from "@cyno/shared";
import { arrowOf, formatSpan, formatUsd, isLowThroughput, missingText, NO_VALUE, rateCell, weeklyThroughput, type Arrow, type RateCell } from "./metricsFormat";

/**
 * A aba Pessoas: uma linha por agente com o que rende e o que falha. Funções puras do `MetricsReport` de 28 dias
 * (a tela pede essa janela); nada aqui lê o relógio. As regras de n < 5, de seta e de contagem no lugar de taxa
 * vêm de `metricsFormat.ts`.
 */

export type Person = { id: string; name: string; /** "Claude · claude-sonnet-5-5": o motor e o modelo do agente. */ engine: string };

export const PEOPLE_SORT_KEYS = ["name", "now", "deliveries", "cycle", "rejected", "rework", "edited", "failed", "cost"] as const;
export type PeopleSortKey = (typeof PEOPLE_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const PEOPLE_COLUMNS: Record<PeopleSortKey, { label: string; hint: string; /** Primeira vez que se clica: do maior ao menor? */ firstDir: SortDir }> = {
  name: { label: "Agente", hint: "Ordenar pelo nome", firstDir: "asc" },
  now: { label: "Agora", hint: "Ordenar pelo que está fazendo agora", firstDir: "desc" },
  deliveries: { label: "Entregas (4 semanas)", hint: "Ordenar pelas entregas das últimas 4 semanas", firstDir: "desc" },
  cycle: { label: "Tempo até entregar", hint: "Ordenar pelo tempo até entregar", firstDir: "asc" },
  rejected: { label: "Recusado", hint: "Ordenar pelo quanto você recusa", firstDir: "desc" },
  rework: { label: "Refeito a pedido", hint: "Ordenar pelo quanto é refeito a pedido", firstDir: "desc" },
  edited: { label: "Você editou", hint: "Ordenar pelo quanto você edita os textos", firstDir: "desc" },
  failed: { label: "Falhou", hint: "Ordenar pelas falhas", firstDir: "desc" },
  cost: { label: "Custo por entrega (rateado)", hint: "Ordenar pelo custo por entrega: custo dos projetos rateado por entrega (equivalente), não é o gasto da semana", firstDir: "asc" },
};

export type ValueCell = { text: string; note?: string; arrow: Arrow | null; known: boolean; sort: number | null };

export type PersonRow = {
  id: string;
  name: string;
  engine: string;
  now: { doing: number; queued: number; waiting: number; text: string; busy: boolean; /** "sem cota, volta às 15h" quando o motor está parado. */ blocked?: string };
  deliveries: { total: number; weeks: number[]; max: number };
  cycle: ValueCell;
  rejected: RateCell;
  rework: RateCell;
  edited: RateCell & { /** "trocando cerca de 40%" */ intensity?: string };
  failed: RateCell;
  cost: ValueCell;
  /** O valor de cada coluna para ordenar (null = sem número; vai sempre para o fim). */
  sort: Record<PeopleSortKey, number | string | null>;
};

const find = (groups: readonly MetricGroup[], id: string): MetricGroup | undefined => groups.find((group) => group.key === id);

const UNITS = {
  deliveries: { one: "entrega", many: "entregas" },
  decisions: { one: "decisão", many: "decisões" },
  tasks: { one: "tarefa", many: "tarefas" },
  texts: { one: "texto aprovado", many: "textos aprovados" },
};

/** Uma coluna que não é taxa (tempo e custo): "—" e quantos faltam, ou o valor com a seta. */
function valueCell(group: MetricGroup | undefined, render: (value: number) => string, describe: (value: number, prev: number) => string, unit: { one: string; many: string }): ValueCell {
  if (!group || group.n === 0) return { text: NO_VALUE, note: `sem ${unit.many} no período`, arrow: null, known: false, sort: null };
  if (group.n < METRICS_MIN_SAMPLES || group.value === null) return { text: NO_VALUE, note: missingText(group.n, unit), arrow: null, known: false, sort: null };
  return { text: render(group.value), arrow: arrowOf(group, describe), known: true, sort: group.value };
}

const NONE_GROUP = (key: string): MetricGroup => ({ key, label: key, value: null, n: 0, prev: null, prevN: 0, fewData: true });

/** Uma linha por pessoa: junta o que a rota traz por agente. */
export function personRows(report: MetricsReport, people: readonly Person[]): PersonRow[] {
  const lowVolume = isLowThroughput(weeklyThroughput(report.throughput.value ?? 0, report.windows.rates));
  const blockedBy = new Map(report.quota.blocked.map((entry) => [entry.agentId, entry.label]));
  return people.map((person) => {
    const load = report.load.agents.find((agent) => agent.id === person.id);
    const doing = load?.doing ?? 0;
    const queued = load?.queued ?? 0;
    const waiting = load?.waiting ?? 0;
    const nowParts = [doing > 0 ? `fazendo ${doing}` : "", queued > 0 ? `fila ${queued}` : "", waiting > 0 ? `esperando ${waiting}` : ""].filter(Boolean);
    const weeks = (report.throughput.agentWeeks.find((row) => row.key === person.id)?.counts ?? []).slice(-4);
    const padded = weeks.length === 4 ? weeks : [...Array<number>(4 - weeks.length).fill(0), ...weeks];
    const total = padded.reduce((sum, count) => sum + count, 0);
    const rejected = rateCell(find(report.rejectionRate.byAgent, person.id) ?? NONE_GROUP(person.id), { lowVolume, unit: UNITS.decisions });
    const rework = rateCell(find(report.rework.byAgent, person.id) ?? NONE_GROUP(person.id), { lowVolume, unit: UNITS.tasks });
    const failed = rateCell(find(report.failureRate.byAgent, person.id) ?? NONE_GROUP(person.id), { lowVolume, unit: UNITS.tasks });
    const editGroup = find(report.editRate.byAgent, person.id);
    const edited = rateCell(editGroup ?? NONE_GROUP(person.id), { lowVolume, unit: UNITS.texts });
    const intensity = edited.known && !lowVolume && editGroup?.intensity !== undefined && editGroup.intensity !== null && (editGroup.hits ?? 0) > 0 && Math.round(editGroup.intensity * 100) >= 1 ? `trocando cerca de ${Math.round(editGroup.intensity * 100)}%` : undefined;
    const cycle = valueCell(find(report.cycleTime.byAgent, person.id), formatSpan, (value, prev) => `era ${formatSpan(prev)}, agora ${formatSpan(value)}`, UNITS.deliveries);
    const cost = valueCell(find(report.costPerDelivery.byAgent, person.id), formatUsd, (value, prev) => `era ${formatUsd(prev)}, agora ${formatUsd(value)}`, UNITS.deliveries);
    const blocked = blockedBy.get(person.id);
    return {
      id: person.id,
      name: person.name,
      engine: person.engine,
      now: { doing, queued, waiting, text: nowParts.length > 0 ? nowParts.join(" · ") : "livre", busy: nowParts.length > 0, ...(blocked ? { blocked } : {}) },
      deliveries: { total, weeks: padded, max: Math.max(1, ...padded) },
      cycle,
      rejected,
      rework,
      edited: { ...edited, ...(intensity ? { intensity } : {}) },
      failed,
      cost,
      sort: { name: person.name, now: doing * 100 + queued * 10 + waiting, deliveries: total, cycle: cycle.sort, rejected: rejected.sort, rework: rework.sort, edited: edited.sort, failed: failed.sort, cost: cost.sort },
    };
  });
}

/** Ordena pela coluna; quem não tem número (traço) vai sempre para o fim, na subida e na descida; empate pelo nome. */
export function sortPeople(rows: readonly PersonRow[], key: PeopleSortKey, dir: SortDir): PersonRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a.sort[key];
    const y = b.sort[key];
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    if (x !== null && y !== null && x !== y) {
      if (typeof x === "string" && typeof y === "string") return sign * x.localeCompare(y, "pt-BR");
      return sign * ((x as number) - (y as number));
    }
    return a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id);
  });
}

/** Clicar na coluna: a mesma coluna inverte; outra começa na direção natural dela. */
export function nextSort(current: { key: PeopleSortKey; dir: SortDir }, key: PeopleSortKey): { key: PeopleSortKey; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: PEOPLE_COLUMNS[key].firstDir };
}

export const DEFAULT_SORT: { key: PeopleSortKey; dir: SortDir } = { key: "deliveries", dir: "desc" };

// ---------- Carga agora ----------

export type LoadRow = { id: string; name: string; doing: number; queued: number; waiting: number; total: number; /** Frações (0 a 1) da barra mais longa. */ widths: { doing: number; queued: number; waiting: number }; text: string };
export type LoadView = { rows: LoadRow[]; max: number; anyLoad: boolean };

/** As barras empilhadas de carga (fazendo, fila, esperando); a mais longa fecha a escala. */
export function loadBars(report: MetricsReport, people: readonly Person[]): LoadView {
  const raw = people.map((person) => {
    const load = report.load.agents.find((agent) => agent.id === person.id);
    return { id: person.id, name: person.name, doing: load?.doing ?? 0, queued: load?.queued ?? 0, waiting: load?.waiting ?? 0 };
  });
  const max = Math.max(1, ...raw.map((row) => row.doing + row.queued + row.waiting));
  const rows = raw
    .map((row) => {
      const total = row.doing + row.queued + row.waiting;
      const parts = [row.doing > 0 ? `fazendo ${row.doing}` : "", row.queued > 0 ? `fila ${row.queued}` : "", row.waiting > 0 ? `esperando ${row.waiting}` : ""].filter(Boolean);
      return { ...row, total, widths: { doing: row.doing / max, queued: row.queued / max, waiting: row.waiting / max }, text: parts.length > 0 ? parts.join(" · ") : "livre" };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id));
  return { rows, max, anyLoad: rows.some((row) => row.total > 0) };
}

// ---------- Quem mais é recusado, por tipo ----------

export type RefusalRow = { type: string; label: string; cell: RateCell; n: number };

/** Os tipos de item ordenados pela taxa de recusa (os com traço vão para o fim). */
export function refusalByType(report: MetricsReport, typeName: (type: string) => string, limit = 6): RefusalRow[] {
  const lowVolume = isLowThroughput(weeklyThroughput(report.throughput.value ?? 0, report.windows.rates));
  return report.rejectionRate.byType
    .map((group) => ({ type: group.key, label: typeName(group.key), n: group.n, cell: rateCell(group, { lowVolume, unit: UNITS.decisions }) }))
    .sort((a, b) => (b.cell.sort ?? -1) - (a.cell.sort ?? -1) || b.n - a.n || a.label.localeCompare(b.label, "pt-BR"))
    .slice(0, limit);
}

// ---------- Cabeçalho e estados vazios ----------

/** "agora 2 de 3 rodando · por agente 1 · fila de 4". */
export function parallelText(report: MetricsReport): string {
  const { running, maxRunning, perAgentLimit, queued } = report.load;
  return `agora ${running} de ${maxRunning} rodando · por agente ${perAgentLimit} · ${queued === 0 ? "fila vazia" : `fila de ${queued}`}`;
}

export type PeopleEmpty = { title: string; text: string };

/** O que a tela diz quando não há o que mostrar (nunca em branco). */
export function peopleEmpty(report: MetricsReport, people: readonly Person[]): PeopleEmpty | null {
  if (people.length === 0) return { title: "Nenhum agente neste workspace", text: "Crie um agente no Escritório para acompanhar o que ele entrega." };
  if (report.throughput.agentWeeks.length === 0 && report.throughput.n === 0) return { title: "Sem entregas ainda", text: "Os números por agente aparecem depois das primeiras tarefas concluídas." };
  return null;
}
