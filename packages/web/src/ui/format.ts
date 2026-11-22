import { describeModelChoice, isActiveTaskStatus, isChatQuestion, isCliEngine, type AgentStatus, type RoomDeletionPreview, type Task, type TaskStatus } from "@cyno/shared";

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "ocioso",
  working: "trabalhando",
  waiting_approval: "aguardando aprovação",
  done: "concluiu",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "na fila",
  in_progress: "em andamento",
  waiting_approval: "aguardando aprovação",
  done: "concluída",
  failed: "falhou",
};

/** Pedido que só espera uma resposta sua na conversa: não há nada para aprovar. */
export const AWAITING_REPLY_LABEL = "esperando sua resposta";

/** Rótulo da tarefa: pergunta na conversa não é "aguardando aprovação". */
export function taskStatusLabel(task: Pick<Task, "status" | "waiting">): string {
  return isChatQuestion(task) ? AWAITING_REPLY_LABEL : TASK_STATUS_LABELS[task.status];
}

/** Rótulo do agente: "aguardando aprovação" só quando alguma tarefa dele pede aprovação de verdade. */
export function agentStatusLabel(agent: Pick<AgentStatusHolder, "id" | "status">, tasks: readonly Task[]): string {
  if (agent.status !== "waiting_approval") return AGENT_STATUS_LABELS[agent.status];
  const waiting = tasks.filter((task) => task.agentId === agent.id && isActiveTaskStatus(task.status) && task.status === "waiting_approval");
  return waiting.length > 0 && waiting.every(isChatQuestion) ? AWAITING_REPLY_LABEL : AGENT_STATUS_LABELS.waiting_approval;
}

type AgentStatusHolder = { id: string; status: AgentStatus };

export type StatusTone = "neutral" | "busy" | "attention" | "success" | "danger";

/** Cor do selo de status (mesma linguagem visual para agente e tarefa). */
export function statusTone(status: AgentStatus | TaskStatus): StatusTone {
  switch (status) {
    case "working":
    case "in_progress":
      return "busy";
    case "waiting_approval":
      return "attention";
    case "done":
      return "success";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function toDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Os formatadores se criam uma vez só: `toLocaleTimeString` com opções monta um novo a cada chamada, e o
// terminal do agente formata um horário por linha (milhares, numa conversa longa).
const TIME_FORMAT = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const DAY_FORMAT = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** "14:03" a partir de um ISO; devolve o texto original se não for data. */
export function formatTime(iso: string): string {
  const date = toDate(iso);
  return date ? TIME_FORMAT.format(date) : iso;
}

/** "07/11 14:03" (dia/mês e hora); o ano só aparece se não for o ano de `now`. */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const date = toDate(iso);
  if (!date) return iso;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = (sameYear ? DAY_FORMAT : DAY_YEAR_FORMAT).format(date);
  return `${day} ${formatTime(iso)}`;
}

/** "agora", "há 5 min", "há 2 h" ou a data, para o feed. */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const date = toDate(iso);
  if (!date) return iso;
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return formatDateTime(iso, now);
}

export function percent(progress: number): string {
  const value = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return `${Math.round(value * 100)}%`;
}

export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * O que some junto com o quarto, em texto ("2 times", "5 agentes", "12 tarefas (1 ativa)"…),
 * só o que tem pelo menos um.
 */
export function roomDeletionParts(preview: RoomDeletionPreview): string[] {
  const tasks =
    preview.tasks > 0
      ? `${countLabel(preview.tasks, "tarefa", "tarefas")}${preview.activeTasks > 0 ? ` (${countLabel(preview.activeTasks, "ativa", "ativas")})` : ""}`
      : "";
  const parts = [
    preview.teams > 0 ? countLabel(preview.teams, "time", "times") : "",
    preview.agents > 0 ? countLabel(preview.agents, "agente", "agentes") : "",
    tasks,
    preview.brainNotes > 0 ? countLabel(preview.brainNotes, "nota do Cérebro", "notas do Cérebro") : "",
    preview.forYouItems > 0 ? countLabel(preview.forYouItems, "aprovação em Aprovações", "aprovações em Aprovações") : "",
    preview.calendarEvents > 0 ? countLabel(preview.calendarEvents, "evento do calendário", "eventos do calendário") : "",
    preview.logs > 0 ? countLabel(preview.logs, "log de trabalho", "logs de trabalho") : "",
  ];
  return parts.filter(Boolean);
}

/** Corta o texto em `max` caracteres (contando o "…"), sem quebrar no meio de espaço. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "Claude Code · sonnet · médio": com que motor/modelo a tarefa rodou (null = simulado ou ainda não começou). */
export function ranWithLabel(task: Pick<Task, "ranWith">): string | null {
  return task.ranWith && isCliEngine(task.ranWith.engine) ? describeModelChoice(task.ranWith) : null;
}
