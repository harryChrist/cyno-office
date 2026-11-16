import type { AgentLogEntry, AgentLogThread } from "./agent-log";

/** Threads de subagentes (na ordem em que começaram), a partir das entradas `subagent`. */
export function threadsOf(entries: readonly AgentLogEntry[]): AgentLogThread[] {
  const threads = new Map<string, AgentLogThread>();
  for (const entry of entries) {
    if (entry.kind !== "subagent") continue;
    if (entry.phase === "started") {
      threads.set(entry.subagentId, { id: entry.subagentId, label: entry.label, goal: entry.goal, status: "running", startedAt: entry.at, ...(entry.model ? { model: entry.model } : {}) });
    } else {
      const thread = threads.get(entry.subagentId);
      if (thread) threads.set(entry.subagentId, { ...thread, status: entry.status, finishedAt: entry.at });
      // Sem o "started" (saiu do limite de memória): a thread aparece mesmo assim.
      else threads.set(entry.subagentId, { id: entry.subagentId, label: entry.label, goal: "", status: entry.status, startedAt: entry.at, finishedAt: entry.at });
    }
  }
  return [...threads.values()];
}

/** Uma tarefa que aparece no log do agente. */
export type LogTask = {
  taskId: string;
  firstAt: string;
  lastAt: string;
  /** Ainda sem status final (done/failed/canceled) do próprio agente. */
  open: boolean;
  /** Subagentes rodando agora nesta tarefa. */
  activeSubagents: number;
  entries: number;
};

const FINAL_STATUSES = new Set(["done", "failed", "canceled"]);

function isFinal(entry: AgentLogEntry): boolean {
  return entry.kind === "status" && entry.thread === undefined && FINAL_STATUSES.has(entry.status);
}

/** As tarefas do log (a mais antiga primeiro), com o que está aberto e quantos subagentes rodam. */
export function tasksOf(entries: readonly AgentLogEntry[]): LogTask[] {
  const byTask = new Map<string, AgentLogEntry[]>();
  for (const entry of entries) {
    const list = byTask.get(entry.taskId);
    if (list) list.push(entry);
    else byTask.set(entry.taskId, [entry]);
  }
  return [...byTask.entries()].map(([taskId, list]) => {
    const open = !list.some(isFinal);
    return {
      taskId,
      firstAt: list[0]!.at,
      lastAt: list.at(-1)!.at,
      open,
      activeSubagents: open ? threadsOf(list).filter((thread) => thread.status === "running").length : 0,
      entries: list.length,
    };
  });
}
