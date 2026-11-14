import type { Agent, AgentChatStatus, AgentLogBody, EngineBlock, FailureKind, ModelChoice, OfficeState, ServerEvent, Task, WorkspaceAccess } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { AgentLogService } from "../agent-log/service";
import type { Brain } from "../brain/brain";
import type { ApprovalInbox, ForYouService } from "../for-you/service";
import type { Orchestrator } from "../office/orchestrator";
import type { ProjectService } from "../projects/project-service";
import type { StateManager } from "../../store/state-manager";
import type { TerminalManager } from "../../engines/terminals/manager";

export type CliMaestroDeps = {
  state: StateManager;
  agentLog: AgentLogService;
  orchestrator: Pick<Orchestrator, "enqueue"> & Partial<Pick<Orchestrator, "cancelTask">>;
  terminals: Pick<TerminalManager, "get"> & Partial<Pick<TerminalManager, "maestroPty">>;
  /** Abre o item do "Para você" de um pedido de aprovação do Maestro (e os questionários dele). */
  approvals: ApprovalInbox & Partial<Pick<ForYouService, "openSpecial" | "cancelAllFor">>;
  /** Planos dos pedidos: um plano aberto segura o pedido (o fim de um turno não o fecha). */
  plans?: () => Pick<ProjectService, "holds" | "blocksConclusion" | "isPlanStep" | "adopt"> | undefined;
  /** Recalcula o status do agente Maestro (MaestroCoordinator.refreshAgentStatus). */
  refreshStatus: () => void;
  log: Pick<FastifyBaseLogger, "info" | "error">;
  now?: () => Date;
  /** Publica eventos para os clientes do workspace (o estado da entrega das mensagens da conversa, `agent:chat-status`). */
  publish?: (event: ServerEvent) => void;
  /** Cérebro do workspace (o resumo que abre uma conversa nova leva o briefing e o índice dos quartos). */
  brain?: Pick<Brain, "buildContext">;
  /**
   * O motor do Maestro está indisponível (cota esgotada, CLI ausente)? As mensagens esperam aqui e
   * vão sozinhas quando ele voltar (`flushHeld`). Nunca troca de motor.
   */
  availability?: (agent: Agent) => EngineBlock | undefined;
  /** Freebuff: a hora aberta do agente e quantos minutos faltam (o get_team mostra: quem já pagou a hora recebe o trabalho primeiro). */
  engineSession?: (agent: Agent) => { minutesLeft: number } | undefined;
  /** Padrão `agentes` do workspace (o get_team mostra com que modelo um agente novo nasce). */
  agentDefaults?: () => ModelChoice | undefined;
  /** Acesso dos agentes do workspace (o `get_team` mostra o efetivo de cada um). */
  access?: () => WorkspaceAccess | undefined;
  /**
   * Tamanho da conversa (tokens no prompt da última chamada) a partir do qual a próxima mensagem abre
   * uma conversa nova, com um resumo montado aqui (sem chamada paga). 0 = nunca. Padrão: MAESTRO_ROTATE_TOKENS.
   */
  rotateTokens?: number;
};

/** Turno de conversa em curso (sem pedido): o log do dia onde ele vai. */
export type ChatTurn = { logId: string };

/** O que o turno em curso do Maestro sabe (compartilhado entre a sessão, os turnos e a ponte com o "Para você"). */
export type TurnState = {
  /** Pedido do turno em curso. */
  current: string | undefined;
  /** Turno de conversa em curso (sem pedido). */
  chat: ChatTurn | undefined;
  /** Pedidos abertos (`open_request`) no turno em curso, na ordem. */
  openedInTurn: string[];
  /** Pedido do turno em curso quando ele veio do próprio terminal (sem tag): fecha no fim do turno. */
  turnTag: string | undefined;
  /** Pedidos com `complete_request` já chamado: fecham no fim do turno (id -> resposta). */
  readonly concluded: Map<string, string>;
  /** Mensagens na fila do terminal por pedido (ainda sem turno). */
  readonly queued: Map<string, number>;
};

/**
 * O que as partes do Maestro (sessão, turnos, "Para você", planos) pedem emprestado à classe
 * `CliMaestro`: acesso ao estado, ao log e às mudanças de tarefa, sem herança.
 */
export type MaestroCore = {
  readonly deps: CliMaestroDeps;
  readonly turn: TurnState;
  now(): Date;
  isStopped(): boolean;
  owns(state: OfficeState, task: Pick<Task, "agentId" | "projectId">): boolean;
  agentName(state: OfficeState, agentId: string | undefined): string;
  isOpen(taskId: string): boolean;
  /** O pedido aberto que a ferramenta quer (veja `CliMaestro.request`). */
  request(state: OfficeState, id: string | undefined): Task;
  setTask(state: OfficeState, task: Task, change: Partial<Pick<Task, "status" | "result" | "outcome">>, options?: { strict?: boolean }): Promise<void>;
  /** `outcome: "cancelled"`: o pedido foi cancelado (pelo usuário ou pelo Maestro), não falhou. */
  finish(state: OfficeState, task: Task, status: "done" | "failed", result: string, outcome?: "cancelled", kind?: FailureKind): void;
  logEntry(task: Task, body: AgentLogBody): void;
  chatEntry(maestroId: string, body: AgentLogBody): void;
  setProgress(task: Task, progress: number, message: string): void;
  /** Conta em que pé está uma mensagem da CONVERSA (a tag `conversa:<id>`) feita pelo dono; ignora as outras. */
  chatStatus(tag: string | undefined, status: AgentChatStatus["status"], error?: string): void;
  /** Manda uma mensagem (sobre um pedido, ou de conversa) para a sessão do Maestro. */
  push(taskId: string, raw: string | (() => string)): void;
};
