import { type Agent, type DispatchSettings, type EngineBlock, type OfficeState, type Project, type ServerEvent, type Task } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { AgentLogService } from "../agent-log/service";
import type { Brain } from "../brain/brain";
import type { ForYouService } from "../for-you/service";
import type { Orchestrator } from "../office/orchestrator";
import type { AvulsasArchive } from "../../store/avulsas-archive";
import type { StateManager } from "../../store/state-manager";

/** Por que o Maestro é acordado (uma mensagem por motivo, nunca a cada entrega). */
export type ProjectWakeKind = "done" | "failed" | "help" | "stalled" | "adjust" | "handoff";

/**
 * Quem cuida do pedido do plano: o Maestro de CLI ou o simulado (MaestroCoordinator). O plano
 * só avisa; o pedido (status, progresso, log, fechamento) é deles.
 */
export type ProjectHost = {
  /** O pedido espera o usuário (plano para aprovar): waiting_approval com o porquê. */
  awaitUser(requestId: string, why: string): void;
  /** O pedido anda sozinho (plano em execução): in_progress com o progresso. */
  working(requestId: string, message: string, progress: number): void;
  /**
   * Acorda o Maestro com UMA mensagem (fim do plano, falha, pedido de ajuda, parada, ajuste). O
   * texto é montado por `build` só quando a sessão do Maestro consome a mensagem (se ela espera a
   * cota voltar, ou a vez, sai o estado de então, nunca uma foto velha). `plan`: o projeto de agora
   * (cópia), para o Maestro simulado.
   */
  wake(requestId: string, kind: ProjectWakeKind, build: () => string, plan?: () => Project | undefined): void;
  /** O usuário cancelou o plano: o pedido fecha (failed) com o motivo. */
  close(requestId: string, reason: string): void;
};

export type ProjectServiceDeps = {
  /** Id do workspace (para o endereço "workspace/agente" das etapas). */
  workspaceId: string;
  state: StateManager;
  agentLog: AgentLogService;
  orchestrator: Pick<Orchestrator, "enqueue" | "cancelTask" | "retryWaiting">;
  forYou: Pick<ForYouService, "openSpecial" | "close">;
  /** Quem cuida do pedido (undefined = pedido que não é do Maestro). */
  host: (requestId: string) => ProjectHost | undefined;
  /** Arquivo mensal somente leitura do "Avulsas" (folhas finalizadas há mais de 14 dias); sem ele nada é arquivado. */
  archive?: Pick<AvulsasArchive, "find" | "append" | "ofRequest">;
  /** Rotinas: as execuções que apontam para estas Tasks passam a apontar para o projeto (converter avulsa em projeto e o contrário). */
  remapRoutineRuns?: (taskIds: ReadonlySet<string>, projectId: string) => void;
  /** Esperas entre as tentativas de gravar (os testes passam zeros). */
  persistDelaysMs?: readonly number[];
  /** Paralelismo (tarefas rodando no workspace e por agente). */
  settings: () => DispatchSettings;
  /** Motor indisponível (sem cota, CLI ausente): a etapa espera, nada troca de motor. */
  availability?: (agent: Agent) => EngineBlock | undefined;
  /** O agente (de Freebuff) tem uma hora aberta? O agendador dá trabalho primeiro a quem já pagou a hora. */
  holdsHour?: (agent: Agent) => boolean;
  /** Modo Automático das rotinas: libera (ou não) UMA ação de uma tarefa de rotina, contando no teto do dia DA rotina. */
  routineAuto?: (routineId: string, input: { type?: string; host?: string }) => { ok: true; label: string } | { ok: false; note?: string };
  /** Nota do tipo de aprovação do entregável (limite de caracteres) para a última etapa. */
  typeNote?: (typeId: string) => string;
  /** Cérebro (caminho das notas de resultado no resumo do fim). */
  brain?: Pick<Brain, "readHistory">;
  log: Pick<FastifyBaseLogger, "info" | "error">;
  now: () => Date;
  /** Etapa parada por motor indisponível (ou agente que sumiu) há mais disto: o Maestro é avisado. */
  stallMs?: number;
  /** Etapa rodando há mais disto: o Maestro é avisado (uma vez). */
  stepMaxMs?: number;
  /** De quanto em quanto tempo confere as paradas (0 = nunca; os testes chamam checkStalls). */
  checkEveryMs?: number;
};

export const PLAN_STALL_MS = 30 * 60_000;
export const PLAN_STEP_MAX_MS = 60 * 60_000;
export const CHECK_EVERY_MS = 60_000;

/** Tetos dos textos (a tarefa da etapa cabe no limite do prompt; o resumo do fim tem teto total). */
export const TEXT = { prompt: 3900, previous: 1200, dependency: 1200, summaryTotal: 12000, summaryEach: 1500, view: 6000 } as const;

/**
 * O que o agendador e o serviço compartilham: os planos em memória e a infraestrutura
 * (relógio, gravação, log do pedido, progresso). O ProjectService monta e entrega.
 */
export type ProjectContext = {
  readonly plans: Project[];
  readonly deps: ProjectServiceDeps;
  isStopped(): boolean;
  /** Limites de parada, lidos a cada conferência (os testes ajustam no serviço). */
  limits(): { stallMs: number; stepMaxMs: number };
  at(): string;
  /** Grava os projetos que mudaram e publica project:upserted (com novas tentativas e aviso visível se falhar; nunca lança). */
  save(changed: Project[]): Promise<void>;
  /** Grava a lista de tarefas (a etapa nova) com novas tentativas e aviso visível se falhar (nunca lança). */
  commitTasks(tasks: Task[], events: ServerEvent[]): Promise<void>;
  logRequest(request: Task, body: Parameters<AgentLogService["append"]>[1]): void;
  /** Avisa o pedido (host) do progresso do plano em execução. */
  progress(plan: Project): void;
  agentName(state: OfficeState, id: string | undefined): string;
  /** Agora, em ms (relógio injetável dos testes). */
  nowMs(): number;
  /** Milissegundos trabalhados hoje no projeto, já com a parte ainda não gravada pelo relógio de horas. */
  workedToday(project: Project): number;
  /** Tempo médio das tarefas já feitas (urgência extra da ordem); undefined sem amostra. */
  avgTaskMs(): number | undefined;
};

/** Sem os marcadores do agente simulado: eles valem para a etapa onde estão, não para quem só cita o texto. */
export const withoutMockMarkers = (text: string) => text.replace(/\[(aprovar|falhar|plano)\]/g, " ").replace(/[ \t]+/g, " ").trim();

/** Primeira linha do pedido (o título). */
export const requestTitle = (task: Pick<Task, "prompt"> | undefined) => withoutMockMarkers(task?.prompt.split("\n")[0] ?? "");

/** Corta um texto longo preservando as quebras de linha (markdown). */
export function shorten2(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * O ciclo de vida do plano (aprovação, distribuição, avisos ao Maestro) cuida deste projeto? Só
 * quando ele está em aprovação ou foi aprovado. Projeto de tarefa avulsa (delegação sem plano) só
 * espelha as Tasks.
 */
export const hasLifecycle = (project: Pick<Project, "approvedAt" | "status">): boolean => project.approvedAt !== undefined || project.status === "proposto" || project.status === "ajustando";
