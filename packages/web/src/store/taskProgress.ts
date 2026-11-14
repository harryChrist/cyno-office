import type { OfficeState, ServerEvent, Task, TaskProgressInfo } from "@cyno/shared";

export type TaskProgress = TaskProgressInfo;

/** Último progresso conhecido de cada tarefa ativa, por id da tarefa. */
export type TaskProgressMap = Readonly<Record<string, TaskProgress>>;

export const EMPTY_PROGRESS: TaskProgressMap = Object.freeze({});

/** Tarefas que podem ter progresso: em andamento ou pausadas esperando aprovação. */
export function isActiveTask(task: Pick<Task, "status">): boolean {
  return task.status === "in_progress" || task.status === "waiting_approval";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function omit(progress: TaskProgressMap, shouldDrop: (taskId: string) => boolean): TaskProgressMap {
  const ids = Object.keys(progress);
  const kept = ids.filter((id) => !shouldDrop(id));
  if (kept.length === ids.length) return progress;
  return Object.fromEntries(kept.map((id) => [id, progress[id]!]));
}

function isProgressEntry(value: unknown): value is TaskProgress {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.agentId === "string" && typeof entry.progress === "number" && typeof entry.message === "string";
}

/** Progresso que veio no snapshot (o server é a fonte), só das tarefas ativas e bem formado. */
function fromSnapshot(sent: unknown, active: ReadonlySet<string>): Record<string, TaskProgress> {
  const out: Record<string, TaskProgress> = {};
  if (typeof sent !== "object" || sent === null) return out;
  for (const [taskId, entry] of Object.entries(sent)) {
    if (!active.has(taskId) || !isProgressEntry(entry)) continue;
    out[taskId] = { agentId: entry.agentId, progress: clamp01(entry.progress), message: entry.message };
  }
  return out;
}

/**
 * Reducer puro do progresso. `office` é o estado ANTES do evento (no snapshot, o novo).
 * Progresso de tarefa que já terminou é descartado; tarefa desconhecida é aceita
 * (o task:upserted pode chegar depois) e o próximo snapshot limpa o que sobrar.
 * O snapshot do WebSocket traz o último progresso de cada tarefa ativa (`progress`): ele
 * substitui o mapa (hidrata depois de recarregar a página). Sem o campo, mantém o que há.
 */
export function applyTaskProgress(
  progress: TaskProgressMap,
  event: ServerEvent,
  office: OfficeState,
): TaskProgressMap {
  switch (event.type) {
    case "office:snapshot": {
      const active = new Set(event.office.tasks.filter(isActiveTask).map((task) => task.id));
      if (event.progress === undefined) return omit(progress, (taskId) => !active.has(taskId));
      const sent = fromSnapshot(event.progress, active);
      return Object.keys(sent).length === 0 && Object.keys(progress).length === 0 ? progress : sent;
    }
    case "task:progress": {
      const task = office.tasks.find((current) => current.id === event.taskId);
      if (task && !isActiveTask(task)) return progress;
      const entry = { agentId: event.agentId, progress: clamp01(event.progress), message: event.message };
      return { ...progress, [event.taskId]: entry };
    }
    case "task:upserted":
      return isActiveTask(event.task) ? progress : omit(progress, (taskId) => taskId === event.task.id);
    case "room:deleted": {
      const removed = new Set(office.tasks.filter((task) => task.roomId === event.id).map((task) => task.id));
      return omit(progress, (taskId) => removed.has(taskId));
    }
    default:
      return progress;
  }
}
