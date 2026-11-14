import { isActiveTaskStatus, type ServerEvent, type Task } from "@cyno/shared";

export const CANCEL_REASONS = {
  agent: "Cancelada: o agente foi removido",
  team: "Cancelada: o time foi removido",
  room: "Cancelada: a sala foi removida",
} as const;

export function hasActiveTasks(tasks: Task[], belongs: (task: Task) => boolean): boolean {
  return tasks.some((task) => belongs(task) && isActiveTaskStatus(task.status));
}

/** Marca como failed as tarefas ativas que `belongs` seleciona (muta) e devolve os eventos. */
export function failActiveTasks(
  tasks: Task[],
  belongs: (task: Task) => boolean,
  reason: string,
  at: string,
): ServerEvent[] {
  const events: ServerEvent[] = [];
  for (const task of tasks) {
    if (!belongs(task) || !isActiveTaskStatus(task.status)) continue;
    Object.assign(task, { status: "failed", outcome: "cancelled", failureKind: "cancelada", result: reason, updatedAt: at });
    events.push({ type: "task:upserted", task });
  }
  return events;
}
