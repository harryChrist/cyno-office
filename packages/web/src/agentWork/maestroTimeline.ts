import { findMaestroAgent, isActiveTaskStatus, isMaestroAgent, subtasksOf, type OfficeState, type Task } from "@cyno/shared";
import type { TaskProgressMap } from "../store/taskProgress";
import { MAESTRO_ACTIVITY_LABELS, type ActivityEntry, type ActivityKind } from "../ui/activity";
import { agentStatusLabel, truncate, type StatusTone } from "../ui/format";
import type { RequestItem, RequestStage, StepItem, StepState } from "./timelineLogic";

/** Quantos pedidos o painel do Maestro mostra (os mais recentes); o resto fica na página Trabalho. */
export const MAESTRO_HISTORY_LIMIT = 30;

const STAGE: Record<RequestStage, { label: string; tone: StatusTone }> = {
  queued: { label: "Na fila do Maestro", tone: "neutral" },
  triage: { label: "Triando", tone: "busy" },
  routed: { label: "Em andamento", tone: "busy" },
  waiting_you: { label: "Precisa de você", tone: "attention" },
  reviewing: { label: "Revisando a entrega", tone: "busy" },
  done: { label: "Concluído", tone: "success" },
  failed: { label: "Não concluído", tone: "danger" },
};

function stageOf(task: Task, subtask: Task | undefined): { stage: RequestStage; label?: string } {
  if (task.status === "done") return { stage: "done" };
  if (task.status === "failed") return task.outcome === "cancelled" ? { stage: "failed", label: "Cancelado" } : { stage: "failed" };
  if (task.status === "waiting_approval") {
    return { stage: "waiting_you", label: subtask?.status === "waiting_approval" ? (subtask.waiting ?? "Esperando sua aprovação") : (task.waiting ?? undefined) };
  }
  if (task.status === "queued") return { stage: "queued" };
  if (!subtask) return { stage: "triage" };
  if (subtask.status === "done") return { stage: "reviewing" };
  if (subtask.status === "queued") return { stage: "routed", label: "Na fila do time" };
  return { stage: "routed" };
}

/** Um pedido ao Maestro (a tarefa dele) como item da linha do tempo. */
export function requestItem(office: OfficeState, task: Task, progress: TaskProgressMap): RequestItem {
  const subtask = subtasksOf(office.tasks, task.id).at(-1);
  const { stage, label } = stageOf(task, subtask);
  const team = subtask ? office.teams.find((candidate) => candidate.id === subtask.teamId) : undefined;
  const room = subtask ? office.rooms.find((candidate) => candidate.id === subtask.roomId) : undefined;
  const agent = subtask?.agentId ? office.agents.find((candidate) => candidate.id === subtask.agentId) : undefined;
  const agentRoom = agent ? office.teams.find((candidate) => candidate.id === agent.teamId)?.roomId : undefined;
  const live = subtask && isActiveTaskStatus(subtask.status) ? progress[subtask.id] : undefined;
  const own = isActiveTaskStatus(task.status) ? progress[task.id] : undefined;
  const current = live ?? own;
  const finished = stage === "done" || stage === "failed";
  return {
    kind: "request",
    id: task.id,
    at: task.createdAt,
    prompt: task.prompt,
    stage,
    stageLabel: label ?? STAGE[stage].label,
    tone: STAGE[stage].tone,
    reason: subtask?.routeReason ?? task.routeReason,
    team: team ? { id: team.id, name: team.name } : subtask ? { id: subtask.teamId, name: subtask.teamId } : undefined,
    room: room ? { id: room.id, name: room.name } : undefined,
    agent: agent ? { id: agent.id, name: agent.name, roomId: agentRoom } : undefined,
    subtaskId: subtask?.id,
    subtaskStatus: subtask?.status,
    progress: current && !finished ? { value: current.progress, message: current.message } : undefined,
    result: finished ? (task.result ?? subtask?.result) : undefined,
    updatedAt: task.updatedAt,
  };
}

/** Pedidos ao Maestro (tarefas dele, sem as subtarefas), mais antigos primeiro. */
function maestroTasks(office: OfficeState, maestroId: string): Task[] {
  return office.tasks
    .filter((task) => task.agentId === maestroId && task.projectId === undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Histórico de pedidos ao Maestro, como numa conversa: o mais novo embaixo. Só os `limit` mais
 * recentes; `total` diz quantos existem (para o "ver todos em Trabalho").
 */
export function maestroRequests(office: OfficeState, maestroId: string, progress: TaskProgressMap, limit = MAESTRO_HISTORY_LIMIT): { items: RequestItem[]; total: number } {
  const tasks = maestroTasks(office, maestroId);
  return { items: tasks.slice(-limit).map((task) => requestItem(office, task, progress)), total: tasks.length };
}

/** O que o cabeçalho diz de um agente agora: estado, detalhe e progresso. */
export type WorkStatus = {
  label: string;
  tone: StatusTone;
  /** Frase de apoio (a última mensagem de progresso, o pedido em foco…). */
  detail?: string;
  progress?: number;
  /** Quantas tarefas ativas ele tem (o Maestro coordena várias ao mesmo tempo). */
  active: number;
};

/** Estado ao vivo do Maestro: livre, triando, delegando ao time X, revisando, esperando você. */
export function maestroStatus(office: OfficeState, maestroId: string, progress: TaskProgressMap): WorkStatus {
  const active = maestroTasks(office, maestroId).filter((task) => isActiveTaskStatus(task.status));
  // O pedido em foco: o que precisa de você primeiro; senão o mais recente.
  const focus = active.find((task) => task.status === "waiting_approval") ?? active.at(-1);
  if (!focus) return { label: "Livre", tone: "neutral", detail: "Livre para conversar", active: 0 };
  const item = requestItem(office, focus, progress);
  const team = item.team?.name;
  const label =
    item.stage === "routed" && team
      ? `Delegando · time ${team}`
      : item.stage === "reviewing" && team
        ? `Revisando · time ${team}`
        : item.stage === "waiting_you"
          ? "Esperando você"
          : item.stageLabel;
  return {
    label,
    tone: item.tone,
    detail: item.stage === "waiting_you" ? (item.progress?.message ?? item.reason) : (item.progress?.message ?? `“${truncate(item.prompt, 80)}”`),
    progress: item.progress?.value,
    active: active.length,
  };
}

/** Estado de qualquer agente (o Maestro tem o seu; os outros, status + tarefa atual). */
export function agentWorkStatus(office: OfficeState, agentId: string, progress: TaskProgressMap): WorkStatus | null {
  const agent = office.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return null;
  if (isMaestroAgent(office, agent)) return maestroStatus(office, agentId, progress);
  const active = office.tasks.filter((task) => task.agentId === agentId && isActiveTaskStatus(task.status));
  const current = active.find((task) => task.status !== "queued") ?? active[0];
  const live = current ? progress[current.id] : undefined;
  const tone: StatusTone = agent.status === "working" ? "busy" : agent.status === "waiting_approval" ? "attention" : agent.status === "done" ? "success" : "neutral";
  return {
    label: agentStatusLabel(agent, office.tasks),
    tone,
    detail: live?.message ?? (current ? `“${truncate(current.prompt, 80)}”` : undefined),
    progress: live?.progress,
    active: active.length,
  };
}

const STEP_STATE: Record<ActivityKind, StepState> = {
  created: "info",
  started: "running",
  delegated: "info",
  waiting_approval: "attention",
  done: "ok",
  failed: "error",
};

/**
 * "Atividade do Maestro": as transições dele (do feed de atividade) como passos, mais antigos
 * primeiro, e a mensagem de progresso de cada pedido ativo como o passo "em andamento" do fim.
 * Quando o Maestro for um agente de verdade, o stream de trabalho dele substitui esta função.
 */
export function maestroSteps(entries: readonly ActivityEntry[], office: OfficeState, maestroId: string, progress: TaskProgressMap): StepItem[] {
  const teamName = (id: string) => office.teams.find((team) => team.id === id)?.name ?? id;
  const steps: StepItem[] = entries
    .filter((entry) => entry.agentId === maestroId)
    .map((entry) => ({
      kind: "step",
      id: entry.key,
      at: entry.at,
      state: STEP_STATE[entry.kind],
      variant: "event",
      text: `${MAESTRO_ACTIVITY_LABELS[entry.kind]}${entry.kind === "delegated" ? ` ${teamName(entry.teamId)}` : ""}: “${truncate(entry.prompt, 60)}”`,
      detail: entry.detail,
    }));
  steps.sort((a, b) => a.at.localeCompare(b.at));
  const live: StepItem[] = maestroTasks(office, maestroId)
    .filter((task) => isActiveTaskStatus(task.status) && progress[task.id])
    .map((task) => ({
      kind: "step",
      id: `${task.id}:live`,
      at: task.updatedAt,
      state: task.status === "waiting_approval" ? "attention" : "running",
      variant: "progress",
      text: progress[task.id]!.message,
      detail: `“${truncate(task.prompt, 60)}”`,
      progress: progress[task.id]!.progress,
    }));
  return [...steps, ...live];
}

/** O Maestro do escritório (ou undefined antes de carregar). */
export function maestroOf(office: OfficeState | null): { id: string; roomId?: string } | undefined {
  const maestro = office ? findMaestroAgent(office) : undefined;
  if (!office || !maestro) return undefined;
  return { id: maestro.id, roomId: office.teams.find((team) => team.id === maestro.teamId)?.roomId };
}
