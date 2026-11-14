import type { AgendaKind } from "./agenda";
import type { BlockedType, ProjectStatus } from "./projects";
import type { PaceStatus, RoutineRunOutcome } from "./routines";

/**
 * Painel "Hoje" (substitui o "Status das tarefas"): uma só visão, calculada no servidor por código
 * (sem IA), do que está rolando hoje (dia de America/Sao_Paulo) em um workspace, ou em todos
 * (`PlatformToday`). O painel da web e a ferramenta MCP `get_today` leem os mesmos dados.
 */
export type TodayRoutineRun = { routineId: string; title: string; at: string; summary?: string };
export type TodayUpcoming = { routineId: string; title: string; at: string };

/** Agora: uma tarefa fazendo (ou na fila). */
export type TodayNow = {
  taskId: string;
  title: string;
  agent?: string;
  agentId?: string;
  /** 0..1, o último progresso que o agente informou. */
  progress?: number;
  /** Última mensagem de progresso. */
  message?: string;
  /** Desde quando está fazendo (ISO). */
  since: string;
  /** Na fila (ainda não começou). */
  queued: boolean;
  projectId?: string;
  projectTitle?: string;
  routineId?: string;
};

/** Um projeto que anda hoje: etapa atual N/M, o próximo passo, bloqueio, prazo e horas. */
export type TodayProject = {
  id: string;
  title: string;
  status: ProjectStatus;
  /** Etapa atual: N de M tarefas (as concluídas contam; a atual é a N). */
  stage?: { index: number; total: number; title: string; agent?: string };
  /** O próximo passo (outro passo da mesma tarefa ou a próxima tarefa). */
  next?: string;
  blocked?: { type: BlockedType | "falha"; note: string };
  /** Prazo atrasado ou em menos de 24 h. */
  atRisk?: boolean;
  /** Nome da sprint que fechou e cujo resumo de entrega espera o OK do dono. */
  deliveryWaiting?: string;
  dueAt?: string;
  /** Milissegundos trabalhados hoje e o limite por dia, se tiver ritmo. */
  workedMs: number;
  limitMs?: number;
  /** O projeto andou hoje (horas trabalhadas ou mexido). */
  movedToday: boolean;
};

export type TodayRoutineRan = TodayRoutineRun & { scheduleLabel?: string; agent?: string; outcome: Exclude<RoutineRunOutcome, "rodando" | "pulada">; endedAt?: string };
export type TodayRoutineRunning = { routineId: string; title: string; scheduleLabel?: string; startedAt: string; agent?: string; taskId?: string };
export type TodayRoutineUpcoming = TodayUpcoming & { label: string; agent?: string };
export type TodayRoutineSkipped = { routineId: string; title: string; at: string; scheduleLabel?: string; reason: string };

export type TodayChange = { routineId: string; title: string; item: string; from?: string; to: string; text: string; at: string; alert?: boolean };
export type TodayGoal = { routineId: string; title: string; done: number; target: number; period: "week" | "month"; pace: PaceStatus; blocked?: string };

/** Um compromisso de hoje da "Sua agenda" (o tempo do dono). */
export type TodayAgendaItem = { id: string; title: string; start: string; end: string; kind: AgendaKind; workspace?: string; workspaceName?: string; link?: string; location?: string };

export type TodayWaitingItem = { id: string; title: string; type: string; agent?: string; at: string; workspace?: string; workspaceName?: string };
export type TodayWaiting = { count: number; /** Os mais antigos (até 3). */ oldest: TodayWaitingItem[] };

/** Uma entrega de hoje, com o destino do link (projeto ou mídia). */
export type TodayDone = {
  kind: "projeto" | "etapa" | "tarefa" | "midia";
  id: string;
  title: string;
  at: string;
  projectId?: string;
  projectTitle?: string;
  mediaId?: string;
  /** A manchete da entrega (1ª frase do resultado) e o resumo, quando o resultado tem os dois (`headlineAndSummary`). */
  headline?: string;
  summary?: string;
};

export type TodayView = {
  workspace: string;
  workspaceName?: string;
  /** Dia local (AAAA-MM-DD, America/Sao_Paulo). */
  day: string;
  now: TodayNow[];
  projects: TodayProject[];
  routines: { ran: TodayRoutineRan[]; running: TodayRoutineRunning[]; upcoming: TodayRoutineUpcoming[]; skipped: TodayRoutineSkipped[] };
  changes: TodayChange[];
  goals: TodayGoal[];
  agenda: TodayAgendaItem[];
  waiting: TodayWaiting;
  /** == waiting.count (compatibilidade). */
  waitingForYou: number;
  done: TodayDone[];
  at: string;
};

/** A plataforma inteira: um `TodayView` por workspace, mais os compromissos do dono (de todos) e o total esperando. */
export type PlatformToday = {
  day: string;
  at: string;
  workspaces: TodayView[];
  agenda: TodayAgendaItem[];
  waiting: TodayWaiting;
};

/** Rotas. */
export const TODAY_PATH = "/api/today";
export const workspaceTodayPath = (workspace: string): string => `/api/w/${encodeURIComponent(workspace)}/today`;

/** Nada para mostrar no dia (o painel recolhe tudo num texto só). */
export function isTodayEmpty(view: TodayView): boolean {
  return (
    view.now.length === 0 &&
    view.projects.length === 0 &&
    view.routines.ran.length === 0 &&
    view.routines.running.length === 0 &&
    view.routines.upcoming.length === 0 &&
    view.routines.skipped.length === 0 &&
    view.changes.length === 0 &&
    view.goals.length === 0 &&
    view.agenda.length === 0 &&
    view.waiting.count === 0 &&
    view.done.length === 0
  );
}
