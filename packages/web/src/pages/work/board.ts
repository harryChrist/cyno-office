import type { Task } from "@cyno/shared";
import type { ActivityEntry, ActivityKind } from "../../ui/activity";
import { TASK_STATUS_LABELS } from "../../ui/format";

/** Rótulo do status de uma Task, com o próprio id como reserva para status que o web ainda não conhece. */
export function statusLabel(status: string): string {
  return (TASK_STATUS_LABELS as Record<string, string | undefined>)[status] ?? status.replace(/_/g, " ");
}

/**
 * Ligação com o Maestro: `projectId` (tarefa pai) e `routeReason` (por que foi para este time).
 * Os campos ainda podem não existir no tipo `Task`, então são lidos de forma solta e só valem
 * se forem texto não vazio. Quando entrarem no tipo, isto continua funcionando igual.
 * TODO: quando `projectId`/`routeReason` existirem em `Task`, ler direto do tipo (sem o cast).
 */
export type MaestroLink = { projectId?: string; routeReason?: string };

export function maestroLink(task: Task): MaestroLink {
  const loose = task as unknown as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  return { projectId: text(loose.projectId), routeReason: text(loose.routeReason) };
}

/** Mensagem de erro de uma tarefa que falhou: campo `error`, se existir, senão o `result`. */
export function taskError(task: Task): string | undefined {
  const loose = task as unknown as Record<string, unknown>;
  if (typeof loose.error === "string" && loose.error.trim() !== "") return loose.error;
  return task.status === "failed" ? task.result : undefined;
}

/** O registro do pedido do Maestro (`role: "request"`) não é tarefa de trabalho: o quadro não o lista (o projeto mostra o andamento). */
export const isRequestRecord = (task: Pick<Task, "role">): boolean => task.role === "request";

// ---------- Histórico ----------

export const HISTORY_LABELS: Record<ActivityKind, string> = {
  created: "Criada",
  started: "Começou",
  delegated: "Maestro mandou para o time",
  waiting_approval: "Pediu aprovação",
  done: "Concluída",
  failed: "Falhou",
};

const HISTORY_RANK: Record<ActivityKind, number> = { created: 0, started: 1, delegated: 1, waiting_approval: 2, done: 3, failed: 3 };

const isKnownKind = (kind: unknown): kind is ActivityKind => typeof kind === "string" && kind in HISTORY_RANK;

const KIND_BY_STATUS: Partial<Record<string, ActivityKind>> = {
  in_progress: "started",
  waiting_approval: "waiting_approval",
  done: "done",
  failed: "failed",
};

export type HistoryStep = { key: string; kind: ActivityKind; at: string };

/**
 * Histórico de status de uma tarefa, do mais antigo para o mais novo. Junta o que o feed de
 * atividade viu acontecer ao vivo (`entries`) com o que dá para tirar da própria tarefa:
 * a criação (`createdAt`) e o status atual (`updatedAt`). Cada transição aparece uma vez.
 */
export function statusHistory(task: Task, entries: readonly ActivityEntry[]): HistoryStep[] {
  const steps = new Map<string, HistoryStep>();
  const add = (kind: ActivityKind, at: string) => {
    const key = `${task.id}:${kind}`;
    if (!steps.has(key)) steps.set(key, { key, kind, at });
  };
  add("created", task.createdAt);
  for (const entry of entries) {
    if (entry.taskId === task.id && isKnownKind(entry.kind)) add(entry.kind, entry.at);
  }
  const current = KIND_BY_STATUS[task.status];
  if (current) add(current, task.updatedAt);
  return [...steps.values()].sort((a, b) => a.at.localeCompare(b.at) || HISTORY_RANK[a.kind] - HISTORY_RANK[b.kind]);
}
