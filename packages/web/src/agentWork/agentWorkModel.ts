import { isActiveTaskStatus, isConversationLogId, type AgentLogEntry, type OfficeState, type TaskStatus } from "@cyno/shared";
import { tasksOf } from "../store/agentLog";
import { truncate } from "../ui/format";

/** Uma tarefa que dá para escolher na tela de trabalho do agente. */
export type TaskOption = {
  id: string;
  label: string;
  /** Ainda em andamento (tarefa ativa ou log sem status final). */
  current: boolean;
  status?: TaskStatus;
  at: string;
};

/** Quantas tarefas o seletor mostra (as mais recentes). */
export const TASK_OPTIONS_LIMIT = 40;

/** Peso para escolher a tarefa "atual": em andamento > esperando > log aberto > na fila. */
function currentRank(option: TaskOption, openLog: boolean): number {
  if (option.status === "in_progress") return 0;
  if (option.status === "waiting_approval") return 1;
  if (openLog) return 2;
  return 3;
}

/**
 * As tarefas do agente (do escritório e do log), as mais novas primeiro. Uma tarefa que só existe
 * no log (ex.: já saiu do escritório) entra com um rótulo genérico.
 */
export function taskOptions(office: OfficeState | null, agentId: string, entries: readonly AgentLogEntry[], limit = TASK_OPTIONS_LIMIT): TaskOption[] {
  const logTasks = new Map(tasksOf(entries.filter((entry) => entry.agentId === agentId)).map((task) => [task.taskId, task]));
  const options = new Map<string, TaskOption>();
  for (const task of office?.tasks ?? []) {
    if (task.agentId !== agentId) continue;
    options.set(task.id, {
      id: task.id,
      label: truncate(task.prompt.replace(/\s+/g, " ").trim(), 64),
      current: isActiveTaskStatus(task.status),
      status: task.status,
      at: task.createdAt,
    });
  }
  for (const task of logTasks.values()) {
    if (options.has(task.taskId)) continue;
    const day = isConversationLogId(task.taskId) ? task.taskId.slice(-8) : undefined;
    const label = day ? `Conversa de ${day.slice(6, 8)}/${day.slice(4, 6)}` : `Tarefa ${task.taskId.slice(0, 8)}`;
    options.set(task.taskId, { id: task.taskId, label, current: task.open, at: task.firstAt });
  }
  return [...options.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
}

/** A tarefa que a tela abre: a atual (em andamento primeiro), senão a mais recente. */
export function defaultTaskId(options: readonly TaskOption[], entries: readonly AgentLogEntry[]): string | undefined {
  const openLog = new Set(tasksOf(entries).filter((task) => task.open).map((task) => task.taskId));
  const current = options.filter((option) => option.current);
  if (current.length > 0) {
    // Estável: entre as de mesmo peso, a mais nova (as opções já vêm das mais novas para as antigas).
    return [...current].sort((a, b) => currentRank(a, openLog.has(a.id)) - currentRank(b, openLog.has(b.id)))[0]!.id;
  }
  return options[0]?.id;
}
