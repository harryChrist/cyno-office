import { activeSprint, assigneesOf, leavesOf, sprintDay, sprintDayOf, sprintProgress, sprintsInOrder, flowStatusOf, type Project, type ProjectTask, type ProjectTaskStatus, type Sprint } from "@cyno/shared";

/**
 * A aba Sprints: as sprints em faixas na ordem, com as tarefas de cada uma, e a linha do tempo simples (blocos
 * proporcionais às datas, marcador de hoje). Funções puras: o React só desenha o que sai daqui.
 */

/** "Sprint 2 · Busca" -> "Sprint 2" (o nome curto que cabe num selo). */
export const shortSprintName = (name: string): string => name.split(" · ")[0]!.trim() || name;

export const SPRINT_STATUS_LABEL: Record<Sprint["status"], string> = {
  planejada: "Planejada",
  ativa: "Ativa",
  fechando: "Fechando",
  fechada: "Fechada",
};

/** "08/11–14/11" (dia no fuso do trabalho). */
export const sprintRange = (sprint: Pick<Sprint, "startAt" | "endAt">): string => `${sprintDay(sprint.startAt)}–${sprintDay(sprint.endAt)}`;

/**
 * As datas da sprint para o cabeçalho. Fechada antes do fim previsto: "planejada até 17/11 · fechada em 11/11"
 * (o fim planejado nunca é reescrito); no mais, "08/11–14/11".
 */
export function sprintDates(sprint: Pick<Sprint, "startAt" | "endAt" | "closedAt" | "status">): string {
  if (closedEarly(sprint)) return `planejada até ${sprintDay(sprint.endAt)} · fechada em ${sprintDay(sprint.closedAt!)}`;
  return sprintRange(sprint);
}

/** Fechou antes do fim planejado (em outro dia)? */
export function closedEarly(sprint: Pick<Sprint, "endAt" | "closedAt" | "status">): boolean {
  if ((sprint.status !== "fechando" && sprint.status !== "fechada") || !sprint.closedAt) return false;
  const closed = Date.parse(sprint.closedAt);
  const end = Date.parse(sprint.endAt);
  return !Number.isNaN(closed) && !Number.isNaN(end) && closed < end && sprintDay(sprint.closedAt) !== sprintDay(sprint.endAt);
}

/** O que a entrega mostra ao lado de "fechou em …": o intervalo, ou só "planejada até 17/11" quando fechou cedo. */
export const sprintPlanned = (sprint: Pick<Sprint, "startAt" | "endAt" | "closedAt" | "status">): string => (closedEarly(sprint) ? `planejada até ${sprintDay(sprint.endAt)}` : sprintRange(sprint));

export type LaneTask = {
  task: ProjectTask;
  status: ProjectTaskStatus;
  assignees: string[];
  /** "Front-End › Tela de login": o caminho acima da tarefa (vazio se está direto no projeto). */
  path: string;
  /** Veio da sprint anterior (selo). */
  carried: string | null;
};

export type SprintLane = {
  kind: "sprint";
  sprint: Sprint;
  progress: { done: number; total: number; skipped: number };
  /** "dia 3 de 7" (só na ativa). */
  day: { day: number; days: number } | null;
  tasks: LaneTask[];
  /** Quantas tarefas saíram dela para a seguinte ou para "sem sprint" (as fechadas mostram). */
  carriedOut: number;
  /** A carga por agente: as tarefas que ainda não terminaram, por responsável ("Sol 3 · Crivo 2"). */
  load: AgentLoad[];
};

/** `agentId` vazio = as tarefas sem responsável. */
export type AgentLoad = { agentId: string; count: number };

/** Quantas tarefas abertas (que ainda não terminaram) cada agente tem entre as dadas, a maior carga primeiro. Tarefa com vários responsáveis conta para cada um. */
export function loadByAgent(project: Pick<Project, "tasks">, tasks: readonly ProjectTask[]): AgentLoad[] {
  const visible = { tasks: project.tasks.filter((candidate) => !candidate.archived) };
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === "concluida" || task.status === "cancelada") continue;
    const who = assigneesOf(visible, task, Number.POSITIVE_INFINITY);
    for (const id of who.length > 0 ? who : [""]) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count || (a.agentId === "" ? 1 : b.agentId === "" ? -1 : a.agentId.localeCompare(b.agentId)));
}

/** "Sol 3 · Crivo 2 · Eco 1" (o texto da faixa); `name` traduz o id do agente. Sem carga = "". */
export function loadText(load: readonly AgentLoad[], name: (agentId: string) => string): string {
  return load.map((entry) => `${entry.agentId === "" ? "Sem responsável" : name(entry.agentId)} ${entry.count}`).join(" · ");
}

export type LooseLane = { kind: "loose"; tasks: LaneTask[] };

export type SprintLanes = { lanes: SprintLane[]; loose: LooseLane };

function laneTask(project: Pick<Project, "tasks" | "sprints">, task: ProjectTask): LaneTask {
  const visible = { tasks: project.tasks.filter((candidate) => !candidate.archived) };
  const byRef = new Map(visible.tasks.map((candidate) => [candidate.ref, candidate]));
  const path: string[] = [];
  for (let parent = task.parent ? byRef.get(task.parent) : undefined, guard = 0; parent && guard < 4; parent = parent.parent ? byRef.get(parent.parent) : undefined, guard += 1) path.unshift(parent.title);
  const from = task.carriedFrom ? project.sprints?.find((sprint) => sprint.id === task.carriedFrom) : undefined;
  return {
    task,
    status: flowStatusOf(visible, task),
    assignees: assigneesOf(visible, task, 3),
    path: path.join(" › "),
    carried: task.carriedFrom ? (from ? shortSprintName(from.name) : "uma sprint anterior") : null,
  };
}

/** As faixas, na ordem das sprints, mais a de "Sem sprint" (as folhas que não estão em nenhuma). */
export function buildSprintLanes(project: Project, now: number): SprintLanes {
  const visible = { tasks: project.tasks.filter((task) => !task.archived) };
  const leaves = leavesOf(visible);
  const ids = new Set((project.sprints ?? []).map((sprint) => sprint.id));
  const lanes = sprintsInOrder(project).map<SprintLane>((sprint) => ({
    kind: "sprint",
    sprint,
    progress: sprintProgress(visible, sprint.id),
    day: sprint.status === "ativa" ? sprintDayOf(sprint, now) : null,
    tasks: leaves.filter((task) => task.sprintId === sprint.id).map((task) => laneTask(project, task)),
    carriedOut: leaves.filter((task) => task.carriedFrom === sprint.id && task.sprintId !== sprint.id).length,
    load: loadByAgent(project, leaves.filter((task) => task.sprintId === sprint.id)),
  }));
  const loose: LooseLane = { kind: "loose", tasks: leaves.filter((task) => !task.sprintId || !ids.has(task.sprintId)).map((task) => laneTask(project, task)) };
  return { lanes, loose };
}

export type TimelineBlock = { id: string; label: string; name: string; status: Sprint["status"]; left: number; width: number; range: string; progress: { done: number; total: number } };
export type Timeline = { blocks: TimelineBlock[]; today: number | null; from: string; to: string };

const DAY = 86_400_000;

/** Linha do tempo: cada sprint um bloco com posição e largura em % do intervalo todo; `today` = o marcador (null fora do intervalo). */
export function buildTimeline(project: Pick<Project, "sprints"> & Partial<Pick<Project, "tasks">>, now: number): Timeline | null {
  const sprints = sprintsInOrder(project).filter((sprint) => !Number.isNaN(Date.parse(sprint.startAt)) && !Number.isNaN(Date.parse(sprint.endAt)));
  if (sprints.length === 0) return null;
  const starts = sprints.map((sprint) => Date.parse(sprint.startAt));
  const ends = sprints.map((sprint) => Date.parse(sprint.endAt));
  const from = Math.min(...starts);
  const to = Math.max(...ends, from + DAY);
  const span = to - from;
  const pct = (ms: number) => ((ms - from) / span) * 100;
  const blocks = sprints.map<TimelineBlock>((sprint) => {
    const left = Math.max(0, pct(Date.parse(sprint.startAt)));
    const width = Math.max(4, pct(Date.parse(sprint.endAt)) - left);
    return { id: sprint.id, label: sprint.id, name: sprint.name, status: sprint.status, left, width: Math.min(width, 100 - left), range: sprintDates(sprint), progress: sprintProgress({ tasks: (project.tasks ?? []).filter((task) => !task.archived) }, sprint.id) };
  });
  return { blocks, today: now >= from && now <= to ? pct(now) : null, from: sprintDay(new Date(from).toISOString()), to: sprintDay(new Date(to).toISOString()) };
}

/** A sprint ativa e a dica para a linha do projeto na entrada ("Sprint 2 · até 18/11"). */
export function currentSprintLabel(project: Pick<Project, "sprints">): string | undefined {
  const sprint = activeSprint(project);
  return sprint ? `${shortSprintName(sprint.name)} · até ${sprintDay(sprint.endAt)}` : undefined;
}

/** A nota da folha que espera a sprint começar ("Começa em 18/11"); undefined se não espera. */
export function startsInLabel(project: Pick<Project, "sprints">, task: Pick<ProjectTask, "sprintId" | "status">): string | undefined {
  if (task.status !== "backlog" && task.status !== "a_fazer") return undefined;
  const sprint = task.sprintId ? project.sprints?.find((candidate) => candidate.id === task.sprintId) : undefined;
  return sprint?.status === "planejada" ? `Começa em ${sprintDay(sprint.startAt)}` : undefined;
}

/** Nome do `carriedFrom` para o selo ("veio da Sprint 1"). */
export function carriedLabel(project: Pick<Project, "sprints">, task: Pick<ProjectTask, "carriedFrom" | "status">): string | undefined {
  if (!task.carriedFrom || task.status === "concluida" || task.status === "cancelada") return undefined;
  const from = project.sprints?.find((sprint) => sprint.id === task.carriedFrom);
  return `veio da ${from ? shortSprintName(from.name) : "sprint anterior"}`;
}

/** Sprints que ainda aceitam tarefa (planejada e ativa), na ordem. */
export const openSprints = (project: Pick<Project, "sprints">): Sprint[] => sprintsInOrder(project).filter((sprint) => sprint.status === "planejada" || sprint.status === "ativa");

/** Tarefas abertas (que ainda não terminaram) fora de toda sprint: o que "Pôr as tarefas soltas nesta sprint" levaria. */
export function looseOpenCount(project: Pick<Project, "tasks" | "sprints">): number {
  const ids = new Set((project.sprints ?? []).map((sprint) => sprint.id));
  return leavesOf({ tasks: project.tasks.filter((task) => !task.archived) }).filter((task) => (!task.sprintId || !ids.has(task.sprintId)) && task.status !== "concluida" && task.status !== "cancelada").length;
}
