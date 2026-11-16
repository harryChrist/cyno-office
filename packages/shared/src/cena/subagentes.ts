import type { AgentLogEntry, AgentLogThread } from "../index";
import { tasksOf, threadsOf } from "../agent-log-threads";

/** Subagentes rodando agora nas tarefas abertas do agente (as que ainda não têm status final no log). */
export function runningSubagents(entries: readonly AgentLogEntry[]): AgentLogThread[] {
  const open = new Set(tasksOf(entries).filter((task) => task.open).map((task) => task.taskId));
  if (open.size === 0) return [];
  return threadsOf(entries.filter((entry) => open.has(entry.taskId))).filter((thread) => thread.status === "running");
}
