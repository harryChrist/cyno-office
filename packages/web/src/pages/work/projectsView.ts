import { assigneesOf, childrenOf, compareWork, isAvulsas, isProjectOpen, projectProgress, type ForYouItem, type Project, type ProjectPriority } from "@cyno/shared";
import { currentSprintLabel } from "./sprintsView";
import { awaitingUser, deadlineOf, projectState, type Deadline, type StateInfo } from "./workView";

/**
 * A entrada de "Projetos e tarefas": só os projetos, em três grupos (Em progresso, Na fila, Concluídos), e o
 * "Avulsas" como projeto fixo no fim. Uma linha por projeto, sem tarefa misturada. Função pura.
 */

export type ProjectGroupId = "progresso" | "fila" | "concluidos";

export const PROJECT_GROUP_TITLES: Record<ProjectGroupId, string> = { progresso: "Em progresso", fila: "Na fila", concluidos: "Concluídos" };

/** Quantos avatares a linha mostra antes do "+N". */
export const ENTRY_AGENTS_SHOWN = 3;

export type ProjectEntry = {
  project: Project;
  group: ProjectGroupId | "avulsas";
  state: StateInfo;
  /** Folhas concluídas e total (sem canceladas nem puladas). */
  progress: { done: number; total: number };
  /** Agentes envolvidos (até 3) e quantos passam disso. */
  agents: string[];
  moreAgents: number;
  deadline: Deadline | null;
  priority: ProjectPriority;
  /** Quanto espera o dono (aprovações, perguntas, plano). */
  waiting: number;
  /** Só no Avulsas: quantas tarefas abertas. */
  open: number;
  /** O prazo está atrasado ou vence em menos de 24 h. */
  risk: boolean;
  /** Projeto pausado (selo). */
  paused: boolean;
  /** A sprint em andamento ("Sprint 2 · até 18/11"), quando há. */
  sprint?: string;
};

export type ProjectGroups = {
  progresso: ProjectEntry[];
  fila: ProjectEntry[];
  concluidos: ProjectEntry[];
  /** O projeto fixo (só quando já tem alguma tarefa). */
  avulsas: ProjectEntry | null;
};

/** Em qual grupo o projeto fica: ativo e pausado = progresso; esperando aprovação ou sendo refeito = fila; terminado = concluídos. */
export function groupOf(project: Project): ProjectGroupId {
  if (!isProjectOpen(project)) return "concluidos";
  if (project.status === "proposto" || project.status === "ajustando") return "fila";
  // Casca de pedido (Cyno) que o Maestro ainda não montou: espera na fila.
  if (project.kind === "tarefa" && project.tasks.length === 0) return "fila";
  return "progresso";
}

const FINISHED = new Set(["concluida", "cancelada", "falhou"]);

function entryOf(project: Project, group: ProjectEntry["group"], waiting: number, now: number): ProjectEntry {
  const live = { tasks: project.tasks.filter((task) => !task.archived) };
  const roots = childrenOf(live);
  const agents: string[] = [];
  for (const root of roots) for (const id of assigneesOf(live, root, Number.POSITIVE_INFINITY)) if (!agents.includes(id)) agents.push(id);
  const { done, total } = projectProgress(live);
  const deadline = group === "avulsas" ? null : deadlineOf(project, now);
  return {
    project,
    group,
    state: projectState(project),
    progress: { done, total },
    agents: agents.slice(0, ENTRY_AGENTS_SHOWN),
    moreAgents: Math.max(0, agents.length - ENTRY_AGENTS_SHOWN),
    deadline,
    priority: project.priority,
    waiting,
    open: live.tasks.filter((task) => !FINISHED.has(task.status) && !task.group && !live.tasks.some((child) => child.parent === task.ref)).length,
    risk: deadline?.risk ?? false,
    paused: project.status === "pausado",
    ...(currentSprintLabel(project) ? { sprint: currentSprintLabel(project)! } : {}),
  };
}

/** Agrupa os projetos para a entrada: cada grupo na ordem de urgência (concluídos: o mais recente primeiro). */
export function buildProjectGroups(projects: readonly Project[], forYou: readonly ForYouItem[] | null | undefined, now: number): ProjectGroups {
  const awaiting = awaitingUser(projects, forYou);
  const groups: ProjectGroups = { progresso: [], fila: [], concluidos: [], avulsas: null };
  for (const project of projects) {
    const waiting = awaiting.byProject.get(project.id) ?? 0;
    if (isAvulsas(project)) {
      // Fica oculto até a primeira tarefa.
      if (project.tasks.some((task) => !task.archived)) groups.avulsas = entryOf(project, "avulsas", waiting, now);
      continue;
    }
    const group = groupOf(project);
    groups[group].push(entryOf(project, group, waiting, now));
  }
  const byUrgency = (a: ProjectEntry, b: ProjectEntry) => compareWork(a.project, b.project, now);
  groups.progresso.sort(byUrgency);
  groups.fila.sort(byUrgency);
  groups.concluidos.sort((a, b) => (b.project.finishedAt ?? b.project.updatedAt).localeCompare(a.project.finishedAt ?? a.project.updatedAt));
  return groups;
}

/** Filtro "prazo em risco" (o resumo da Gestão abre assim). */
export function onlyAtRisk(groups: ProjectGroups): ProjectGroups {
  const keep = (entries: ProjectEntry[]) => entries.filter((entry) => entry.risk);
  return { progresso: keep(groups.progresso), fila: keep(groups.fila), concluidos: [], avulsas: null };
}

/** "Nenhuma aberta" / "1 aberta" / "7 abertas" (o contador do Avulsas). */
export function openText(count: number): string {
  return count <= 0 ? "Nenhuma aberta" : count === 1 ? "1 aberta" : `${count} abertas`;
}

/** "2 esperando você" / "1 esperando você" / "". */
export function waitingText(count: number): string {
  return count <= 0 ? "" : `${count} esperando você`;
}

/** Chave do localStorage com os grupos abertos da entrada. */
export const GROUPS_KEY = "cyno:projects-groups";

/** Grupos abertos por padrão: Em progresso e Na fila abertos, Concluídos recolhido. */
export const DEFAULT_OPEN_GROUPS: readonly ProjectGroupId[] = ["progresso", "fila"];

export function readOpenGroups(): Set<ProjectGroupId> {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return new Set(DEFAULT_OPEN_GROUPS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_OPEN_GROUPS);
    return new Set(parsed.filter((item): item is ProjectGroupId => item === "progresso" || item === "fila" || item === "concluidos"));
  } catch {
    return new Set(DEFAULT_OPEN_GROUPS);
  }
}

export function writeOpenGroups(groups: ReadonlySet<ProjectGroupId>): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // Sem armazenamento: só não lembra.
  }
}
