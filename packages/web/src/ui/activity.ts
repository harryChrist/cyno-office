import type { Task, TaskStatus } from "@cyno/shared";
import { create } from "zustand";
import { useOfficeStore } from "../store/officeStore";

/**
 * created = criada e já atribuída (a um agente, ou ao Maestro quando é um pedido do usuário);
 * delegated = o Maestro mandou o pedido para um time (a subtarefa apareceu).
 */
export type ActivityKind = "created" | "started" | "delegated" | "waiting_approval" | "done" | "failed";

export type ActivityEntry = {
  /** `${taskId}:${kind}`: a mesma transição nunca entra duas vezes. */
  key: string;
  kind: ActivityKind;
  taskId: string;
  agentId?: string;
  roomId: string;
  teamId: string;
  prompt: string;
  /** Na delegação: o motivo da escolha do time (routeReason). */
  detail?: string;
  at: string;
};

export const ACTIVITY_LIMIT = 40;

const KIND_BY_STATUS: Record<TaskStatus, ActivityKind> = {
  queued: "created",
  in_progress: "started",
  waiting_approval: "waiting_approval",
  done: "done",
  failed: "failed",
};

/**
 * Ordem no ciclo de vida: desempata entradas com o mesmo horário (a mais adiantada fica em cima).
 * A delegação tem o horário da subtarefa e fica logo abaixo do "recebeu" dela.
 */
const KIND_RANK: Record<ActivityKind, number> = { delegated: -1, created: 0, started: 1, waiting_approval: 2, done: 3, failed: 3 };

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  created: "recebeu",
  started: "começou",
  delegated: "delegou",
  waiting_approval: "pede aprovação",
  done: "concluiu",
  failed: "falhou em",
};

/** As mesmas etapas, contadas do ponto de vista do Maestro (triagem, delegação, revisão). */
export const MAESTRO_ACTIVITY_LABELS: Record<ActivityKind, string> = {
  created: "recebeu o pedido",
  started: "está analisando",
  delegated: "mandou para o time",
  waiting_approval: "precisa de você em",
  done: "revisou e concluiu",
  failed: "não concluiu",
};

/** "recebeu" é datado pela criação da tarefa; as demais transições, pela última mudança. */
function entryFor(task: Task, kind: ActivityKind): ActivityEntry {
  return {
    key: `${task.id}:${kind}`,
    kind,
    taskId: task.id,
    agentId: task.agentId,
    roomId: task.roomId,
    teamId: task.teamId,
    prompt: task.prompt,
    at: kind === "created" ? task.createdAt : task.updatedAt,
  };
}

/** O Maestro mandou a tarefa `parent` para o time da `subtask` (datado pela criação da subtarefa). */
function delegationEntry(subtask: Task, parent: Task | undefined): ActivityEntry {
  return {
    key: `${subtask.projectId}:delegated:${subtask.id}`,
    kind: "delegated",
    taskId: subtask.projectId!,
    agentId: parent?.agentId,
    roomId: subtask.roomId,
    teamId: subtask.teamId,
    prompt: parent?.prompt ?? subtask.prompt,
    detail: subtask.routeReason ?? parent?.routeReason,
    at: subtask.createdAt,
  };
}

function newestFirst(a: ActivityEntry, b: ActivityEntry): number {
  return b.at.localeCompare(a.at) || KIND_RANK[b.kind] - KIND_RANK[a.kind];
}

/**
 * Feed reconstruído só a partir das tarefas (ao abrir ou recarregar a página): "recebeu" em
 * `createdAt` e o status atual em `updatedAt`. As transições do meio (ex.: "começou" de uma tarefa
 * já concluída) não têm horário guardado e ficam de fora. Mais novas primeiro, até o limite.
 */
export function rebuildActivity(tasks: readonly Task[], limit = ACTIVITY_LIMIT): ActivityEntry[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const delegated = new Set(tasks.flatMap((task) => (task.projectId === undefined ? [] : [task.projectId])));
  const entries = tasks.flatMap((task) => {
    const created = entryFor(task, "created");
    // Tarefa do Maestro já delegada e em andamento: a delegação conta a história (o "começou" ficaria fora de ordem).
    const quiet = task.status === "queued" || (task.status === "in_progress" && delegated.has(task.id));
    const own = quiet ? [created] : [created, entryFor(task, KIND_BY_STATUS[task.status])];
    return task.projectId === undefined ? own : [delegationEntry(task, byId.get(task.projectId)), ...own];
  });
  return entries.sort(newestFirst).slice(0, limit);
}

/**
 * Entradas novas do feed comparando as tarefas antes/depois de um evento.
 * Sem `prev` (primeiro estado), o feed é reconstruído das tarefas (`rebuildActivity`).
 * Uma tarefa nova que já chega adiantada (ex.: snapshot após reconectar) gera "created" e o status atual.
 * Uma subtarefa nova gera também a delegação do Maestro na tarefa original.
 */
export function diffTaskActivity(prev: readonly Task[] | null, next: readonly Task[]): ActivityEntry[] {
  if (!prev) return rebuildActivity(next);
  const before = new Map(prev.map((task) => [task.id, task.status]));
  const out: ActivityEntry[] = [];
  for (const task of next) {
    const old = before.get(task.id);
    if (old === task.status) continue;
    if (old === undefined && task.projectId !== undefined) out.push(delegationEntry(task, next.find((t) => t.id === task.projectId)));
    if (old === undefined && task.status !== "queued") out.push(entryFor(task, "created"));
    out.push(entryFor(task, KIND_BY_STATUS[task.status]));
  }
  return out;
}

/** Junta as novas no topo (mais novas primeiro), sem repetir chave, até o limite. */
export function mergeActivity(current: readonly ActivityEntry[], incoming: readonly ActivityEntry[], limit = ACTIVITY_LIMIT): ActivityEntry[] {
  if (incoming.length === 0) return current as ActivityEntry[];
  const seen = new Set(current.map((entry) => entry.key));
  const fresh = incoming.filter((entry) => !seen.has(entry.key) && (seen.add(entry.key), true));
  if (fresh.length === 0) return current as ActivityEntry[];
  const ordered = [...fresh].sort(newestFirst);
  return [...ordered, ...current].slice(0, limit);
}

type ActivityState = { entries: ActivityEntry[] };

export const useActivityStore = create<ActivityState>()(() => ({ entries: [] }));

/** Passa a registrar no feed as mudanças de tarefa do officeStore. Devolve o "desligar". */
export function startActivityTracking(): () => void {
  const push = (prev: readonly Task[] | null, next: readonly Task[]) => {
    const incoming = diffTaskActivity(prev, next);
    const { entries } = useActivityStore.getState();
    const merged = mergeActivity(entries, incoming);
    if (merged !== entries) useActivityStore.setState({ entries: merged });
  };
  const initial = useOfficeStore.getState().office;
  if (initial && useActivityStore.getState().entries.length === 0) push(null, initial.tasks);
  return useOfficeStore.subscribe((state, prev) => {
    const next = state.office?.tasks;
    const before = prev.office?.tasks ?? null;
    if (!next || next === before) return;
    push(before, next);
  });
}
