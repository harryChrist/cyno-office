import { assigneesOf, AVULSAS_ID, isAvulsas, leavesOf, PRIORITY_RANK, type Project, type ProjectPriority, type ProjectTask, type ProjectTaskStatus, type Sprint } from "@cyno/shared";
import { shortSprintName } from "./sprintsView";
import { dueOf, TREE_STATUS_LABEL, type DueInfo } from "./taskTreeView";
import { visibleWindow } from "./visibleWindow";

/**
 * "Todas as tarefas": a lista plana das folhas de todos os projetos do workspace (inclusive as do Avulsas), com
 * filtros, agrupamento e ordem que vivem no endereço. Funções puras: o React só desenha o que sai daqui.
 */

export type SprintKind = "ativa" | "futura" | "fechada" | "sem";

export type TaskEntry = {
  key: string;
  project: Project;
  task: ProjectTask;
  /** "Projeto › Módulo" (o caminho acima da tarefa). */
  path: string;
  status: ProjectTaskStatus;
  /** Todos os responsáveis (o primeiro é o dono da tarefa). */
  assignees: string[];
  sprint: Sprint | undefined;
  sprintKind: SprintKind;
  due: DueInfo | null;
  late: boolean;
  waiting: boolean;
  finished: boolean;
};

const FINISHED = new Set<ProjectTaskStatus>(["concluida", "cancelada"]);

/** As folhas (não arquivadas) de todos os projetos, uma entrada por tarefa. */
export function collectEntries(projects: readonly Project[], now: number): TaskEntry[] {
  const out: TaskEntry[] = [];
  for (const project of projects) {
    const live = { tasks: project.tasks.filter((task) => !task.archived) };
    const byRef = new Map(live.tasks.map((task) => [task.ref, task]));
    const sprints = new Map((project.sprints ?? []).map((sprint) => [sprint.id, sprint]));
    for (const task of leavesOf(live)) {
      const titles: string[] = [];
      for (let parent = task.parent ? byRef.get(task.parent) : undefined, guard = 0; parent && guard < 4; parent = parent.parent ? byRef.get(parent.parent) : undefined, guard += 1) titles.unshift(parent.title);
      const sprint = task.sprintId ? sprints.get(task.sprintId) : undefined;
      const sprintKind: SprintKind = !sprint ? "sem" : sprint.status === "ativa" ? "ativa" : sprint.status === "planejada" ? "futura" : "fechada";
      const due = dueOf(live, task, task.status, now);
      const finished = FINISHED.has(task.status);
      out.push({
        key: `${project.id}:${task.ref}`,
        project,
        task,
        path: [project.title, ...titles].join(" › "),
        status: task.status,
        assignees: assigneesOf(live, task, Number.POSITIVE_INFINITY),
        sprint,
        sprintKind,
        due,
        late: !finished && task.dueAt !== undefined && Date.parse(task.dueAt) < now,
        waiting: task.status === "esperando_voce",
        finished,
      });
    }
  }
  return out;
}

// ---------- Filtros (e o endereço) ----------

export const GROUP_BYS = ["nada", "projeto", "agente", "estado", "sprint"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const SORT_BYS = ["prioridade", "data", "atualizacao"] as const;
export type SortBy = (typeof SORT_BYS)[number];

export const GROUP_LABELS: Record<GroupBy, string> = { nada: "Nada", projeto: "Projeto", agente: "Agente", estado: "Estado", sprint: "Sprint" };
export const SORT_LABELS: Record<SortBy, string> = { prioridade: "Prioridade", data: "Data", atualizacao: "Atualização" };

export const ALL = "todos";
export const NO_AGENT = "sem";

export type TaskFilters = {
  q: string;
  project: string;
  agent: string;
  status: string;
  /** "todos" | "ativa" | "futura" | "sem" */
  sprint: string;
  priority: string;
  waiting: boolean;
  late: boolean;
  /** Mostra as concluídas e as canceladas (escondidas por padrão). */
  showDone: boolean;
  group: GroupBy;
  sort: SortBy;
};

export const NO_TASK_FILTERS: TaskFilters = { q: "", project: ALL, agent: ALL, status: ALL, sprint: ALL, priority: ALL, waiting: false, late: false, showDone: false, group: "nada", sort: "prioridade" };

export type FilterKey = "project" | "agent" | "status" | "sprint" | "priority";
export const FILTER_KEYS: readonly FilterKey[] = ["project", "agent", "status", "sprint", "priority"];
export const FILTER_LABELS: Record<FilterKey, string> = { project: "Projeto", agent: "Agente", status: "Estado", sprint: "Sprint", priority: "Prioridade" };
const PARAM: Record<FilterKey, string> = { project: "projeto", agent: "agente", status: "estado", sprint: "sprint", priority: "prio" };

const STATUSES = Object.keys(TREE_STATUS_LABEL);
const SPRINT_VALUES = ["ativa", "futura", "sem"];
const PRIORITIES = ["alta", "normal", "baixa"];

/** Lê os filtros do endereço (`projeto=x&agente=y&sprint=ativa…`); o que for inválido volta ao padrão. */
export function parseTaskFilters(query: string): TaskFilters {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  const pick = (name: string, valid?: readonly string[]): string => {
    const value = params.get(name) ?? ALL;
    if (value === "") return ALL;
    return valid && !valid.includes(value) ? ALL : value;
  };
  const group = params.get("agrupar") as GroupBy | null;
  const sort = params.get("ordem") as SortBy | null;
  return {
    q: params.get("q") ?? "",
    project: pick(PARAM.project),
    agent: pick(PARAM.agent),
    status: pick(PARAM.status, STATUSES),
    sprint: pick(PARAM.sprint, SPRINT_VALUES),
    priority: pick(PARAM.priority, PRIORITIES),
    waiting: params.get("espera") === "1",
    late: params.get("atrasadas") === "1",
    showDone: params.get("concluidas") === "1",
    group: group && (GROUP_BYS as readonly string[]).includes(group) ? group : "nada",
    sort: sort && (SORT_BYS as readonly string[]).includes(sort) ? sort : "prioridade",
  };
}

/** Escreve os filtros para o endereço: só o que difere do padrão (sem nada ligado, a string vazia). */
export function serializeTaskFilters(filters: TaskFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q);
  for (const key of FILTER_KEYS) if (filters[key] !== ALL) params.set(PARAM[key], filters[key]);
  if (filters.waiting) params.set("espera", "1");
  if (filters.late) params.set("atrasadas", "1");
  if (filters.showDone) params.set("concluidas", "1");
  if (filters.group !== "nada") params.set("agrupar", filters.group);
  if (filters.sort !== "prioridade") params.set("ordem", filters.sort);
  return params.toString();
}

/** Quantos filtros (de menu, atalhos e busca) estão ligados; o agrupar e o ordenar não contam. */
export function activeCount(filters: TaskFilters): number {
  return FILTER_KEYS.filter((key) => filters[key] !== ALL).length + (filters.waiting ? 1 : 0) + (filters.late ? 1 : 0) + (filters.q.trim() ? 1 : 0);
}

const normalize = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Aplica os filtros; `skip` deixa um menu de fora (para contar as opções dele). */
export function filterEntries(entries: readonly TaskEntry[], filters: TaskFilters, nameOf: (agentId: string) => string = (id) => id, skip?: FilterKey): TaskEntry[] {
  const q = normalize(filters.q.trim());
  return entries.filter((entry) => {
    if (!filters.showDone && entry.finished && !(filters.status === "concluida" || filters.status === "cancelada") && skip !== "status") return false;
    if (skip !== "project" && filters.project !== ALL && entry.project.id !== filters.project) return false;
    if (skip !== "agent" && filters.agent !== ALL && !(filters.agent === NO_AGENT ? entry.assignees.length === 0 : entry.assignees.includes(filters.agent))) return false;
    if (skip !== "status" && filters.status !== ALL && entry.status !== filters.status) return false;
    if (skip !== "sprint" && filters.sprint !== ALL && entry.sprintKind !== filters.sprint) return false;
    if (skip !== "priority" && filters.priority !== ALL && entry.task.priority !== filters.priority) return false;
    if (filters.waiting && !entry.waiting) return false;
    if (filters.late && !entry.late) return false;
    if (q) {
      const hay = normalize([entry.task.title, entry.path, entry.task.ref, ...entry.assignees.map(nameOf)].join(" "));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export type Option = { value: string; label: string; count: number };

/** As opções de um menu (a primeira é "Todos"): cada valor com a contagem de tarefas que ele deixaria na lista. */
export function facetOptions(entries: readonly TaskEntry[], filters: TaskFilters, key: FilterKey, nameOf: (agentId: string) => string): Option[] {
  const pool = filterEntries(entries, filters, nameOf, key);
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  const bump = (value: string, label: string) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    labels.set(value, label);
  };
  for (const entry of pool) {
    if (key === "project") bump(entry.project.id, isAvulsas(entry.project) ? "Avulsas" : entry.project.title);
    else if (key === "agent") {
      if (entry.assignees.length === 0) bump(NO_AGENT, "Sem responsável");
      for (const id of entry.assignees) bump(id, nameOf(id));
    } else if (key === "status") bump(entry.status, TREE_STATUS_LABEL[entry.status]);
    else if (key === "sprint") bump(entry.sprintKind, SPRINT_OPTION_LABEL[entry.sprintKind]);
    else bump(entry.task.priority, PRIORITY_OPTION_LABEL[entry.task.priority]);
  }
  // O valor escolhido continua na lista mesmo com zero tarefas (dá para desligar).
  const chosen = filters[key];
  if (chosen !== ALL && !counts.has(chosen)) {
    counts.set(chosen, 0);
    labels.set(chosen, key === "status" ? (TREE_STATUS_LABEL[chosen as ProjectTaskStatus] ?? chosen) : key === "sprint" ? (SPRINT_OPTION_LABEL[chosen as SprintKind] ?? chosen) : key === "priority" ? (PRIORITY_OPTION_LABEL[chosen as ProjectPriority] ?? chosen) : key === "agent" ? (chosen === NO_AGENT ? "Sem responsável" : nameOf(chosen)) : chosen);
  }
  const order = (value: string): number => (key === "status" ? STATUSES.indexOf(value) : key === "priority" ? PRIORITIES.indexOf(value) : key === "sprint" ? SPRINT_VALUES.indexOf(value) : 0);
  const rows = [...counts].map(([value, count]) => ({ value, label: labels.get(value)!, count }));
  rows.sort((a, b) => (key === "project" || key === "agent" ? (a.value === NO_AGENT ? 1 : b.value === NO_AGENT ? -1 : a.label.localeCompare(b.label, "pt-BR")) : order(a.value) - order(b.value)));
  return [{ value: ALL, label: "Todos", count: pool.length }, ...rows];
}

const SPRINT_OPTION_LABEL: Record<SprintKind, string> = { ativa: "Sprint ativa", futura: "Sprint futura", sem: "Sem sprint", fechada: "Sprint fechada" };
const PRIORITY_OPTION_LABEL: Record<ProjectPriority, string> = { alta: "Alta", normal: "Normal", baixa: "Baixa" };

/** Um menu só vale com mais de uma opção para escolher (ou já ligado, para dar para desligar). */
export const useful = (options: readonly Option[], value: string): boolean => options.length > 2 || value !== ALL;

// ---------- Ordem e grupos ----------

const dueTime = (entry: TaskEntry): number => (entry.task.dueAt ? Date.parse(entry.task.dueAt) || Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY);

export function sortEntries(entries: readonly TaskEntry[], sort: SortBy): TaskEntry[] {
  const byUpdate = (a: TaskEntry, b: TaskEntry) => b.task.updatedAt.localeCompare(a.task.updatedAt);
  const byDue = (a: TaskEntry, b: TaskEntry) => dueTime(a) - dueTime(b);
  const compare =
    sort === "prioridade"
      ? (a: TaskEntry, b: TaskEntry) => PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority] || byDue(a, b) || byUpdate(a, b)
      : sort === "data"
        ? (a: TaskEntry, b: TaskEntry) => byDue(a, b) || PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority] || byUpdate(a, b)
        : (a: TaskEntry, b: TaskEntry) => byUpdate(a, b);
  return [...entries].sort((a, b) => compare(a, b) || a.key.localeCompare(b.key));
}

export type TaskGroup = { key: string; label: string; entries: TaskEntry[] };

const STATE_ORDER: ProjectTaskStatus[] = ["esperando_voce", "em_andamento", "a_fazer", "backlog", "falhou", "concluida", "cancelada"];
const SPRINT_ORDER: Record<SprintKind, number> = { ativa: 0, futura: 1, fechada: 2, sem: 3 };

/** Agrupa as entradas (já filtradas) e ordena cada grupo; `nada` devolve um grupo só, sem rótulo. */
export function groupEntries(entries: readonly TaskEntry[], group: GroupBy, sort: SortBy, nameOf: (agentId: string) => string): TaskGroup[] {
  const sorted = sortEntries(entries, sort);
  if (group === "nada") return sorted.length === 0 ? [] : [{ key: "all", label: "", entries: sorted }];
  const buckets = new Map<string, { label: string; rank: number; entries: TaskEntry[] }>();
  for (const entry of sorted) {
    let key: string;
    let label: string;
    let rank: number;
    if (group === "projeto") {
      key = entry.project.id;
      label = isAvulsas(entry.project) ? "Avulsas" : entry.project.title;
      rank = entry.project.id === AVULSAS_ID ? 1 : 0;
    } else if (group === "agente") {
      const first = entry.assignees[0];
      key = first ?? NO_AGENT;
      label = first ? nameOf(first) : "Sem responsável";
      rank = first ? 0 : 1;
    } else if (group === "estado") {
      key = entry.status;
      label = TREE_STATUS_LABEL[entry.status];
      rank = STATE_ORDER.indexOf(entry.status);
    } else {
      key = entry.sprint ? `${entry.project.id}/${entry.sprint.id}` : "sem";
      label = entry.sprint ? `${shortSprintName(entry.sprint.name)} · ${isAvulsas(entry.project) ? "Avulsas" : entry.project.title}` : "Sem sprint";
      rank = SPRINT_ORDER[entry.sprintKind];
    }
    const bucket = buckets.get(key) ?? { label, rank, entries: [] };
    bucket.entries.push(entry);
    buckets.set(key, bucket);
  }
  return [...buckets]
    .sort(([, a], [, b]) => a.rank - b.rank || a.label.localeCompare(b.label, "pt-BR"))
    .map(([key, bucket]) => ({ key, label: bucket.label, entries: bucket.entries }));
}

// ---------- Janela de rolagem ----------

export type FlatItem = { kind: "head"; key: string; label: string; count: number } | { kind: "row"; key: string; entry: TaskEntry };

export function flatten(groups: readonly TaskGroup[]): FlatItem[] {
  const out: FlatItem[] = [];
  for (const group of groups) {
    if (group.label) out.push({ kind: "head", key: `h:${group.key}`, label: group.label, count: group.entries.length });
    for (const entry of group.entries) out.push({ kind: "row", key: entry.key, entry });
  }
  return out;
}

export { visibleWindow };

/** Quais itens estão à vista: `top` e `height` são a rolagem e a altura da janela; `overscan` itens a mais de cada lado. Alturas fixas por tipo. */
export function visibleRange(items: readonly FlatItem[], heights: { head: number; row: number }, top: number, height: number, overscan = 6): { start: number; end: number; total: number; offset: number } {
  return visibleWindow(items, (item) => (item.kind === "head" ? heights.head : heights.row), top, height, overscan);
}
