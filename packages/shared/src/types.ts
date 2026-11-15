import type { FurnitureEdit } from "./furniture-edits";
import type { RoomPurpose, RoomSize } from "./room-spec";
/** Modelo de dados do Cyno (compartilhado entre server e web). */

import type { WorkspaceAccess } from "./access";
import type { AgentFolders, WorkFolder } from "./folders";
import type { ModelChoice, ModelDefaults } from "./models";
import type { AgentEffort, AgentEngine } from "./terminal";

/**
 * Nível mais alto: cada workspace (ex.: "LinkedIn", "Instagram") tem o seu escritório
 * (lobby, quartos, times, agentes), as suas tarefas e os seus Cérebros, sem nada em comum
 * com os outros. O id é o slug do nome e nomeia a pasta data/workspaces/<id>/.
 */
export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
  /**
   * Modelos padrão do workspace (preenchidos com os globais quando ele nasce; editáveis): o Maestro
   * de um workspace novo, cada agente novo e o padrão dos subagentes. Só preenchem o que nasce.
   */
  models?: ModelDefaults;
  /** Como o Maestro deste workspace roda (ausente = os padrões; veja MaestroSettings). */
  maestro?: MaestroSettings;
  /** Paralelismo da distribuição dos planos (ausente = os padrões; veja DEFAULT_DISPATCH em projects.ts). */
  dispatch?: { maxRunning?: number; perAgent?: number };
  /** Cerimônias da Gestão: horário do resumo do dia e da revisão da semana, e o parágrafo de IA (ausente = os padrões; veja `gestaoSettings` em reports.ts). */
  gestao?: { dailyAt?: string | null; weekly?: string; ai?: { daily?: boolean; weekly?: boolean } };
  /** Acesso dos agentes (internet, navegador, terminal, domínios). Ausente = os padrões (veja access.ts). */
  access?: WorkspaceAccess;
  /** Pastas de trabalho: pastas reais do computador que os agentes usam (veja folders.ts). Ausente = nenhuma. */
  folders?: WorkFolder[];
};

/**
 * Configurações do Maestro de um workspace. `keepAlive` (padrão: ligado): o terminal do Maestro de
 * Claude Code sobe junto com o server e nunca para por ociosidade (o Remote Control fica sempre
 * disponível); desligado, ele sobe sob demanda e para depois do tempo ocioso. `sessionName`: nome
 * da sessão no Remote Control do Claude Code (ausente ou vazio = "Maestro · <workspace>").
 */
export type MaestroSettings = { keepAlive?: boolean; sessionName?: string };

/** Tamanho máximo do nome da sessão do Remote Control. */
export const MAESTRO_SESSION_NAME_MAX = 80;

/** Nome padrão da sessão do Remote Control do Maestro de um workspace. */
export function defaultMaestroSessionName(workspaceName: string): string {
  return `Maestro · ${workspaceName}`.slice(0, MAESTRO_SESSION_NAME_MAX);
}

/** Nome efetivo da sessão do Remote Control: o escolhido no workspace ou o padrão. */
export function maestroSessionName(settings: MaestroSettings | undefined, workspaceName: string): string {
  const custom = settings?.sessionName?.trim();
  return custom ? custom.slice(0, MAESTRO_SESSION_NAME_MAX) : defaultMaestroSessionName(workspaceName);
}

/** O Maestro fica sempre rodando? (ausente = sim) */
export function maestroKeepAlive(settings: MaestroSettings | undefined): boolean {
  return settings?.keepAlive !== false;
}

/**
 * Tipo de quarto: "team" (padrão, onde ficam os times) ou "maestro" (a Sala do Maestro: todo
 * workspace tem exatamente uma, com o time interno "Gerência" e um único agente, o Maestro).
 */
export type RoomKind = "team" | "maestro";

export type Room = {
  id: string;
  kind: RoomKind;
  name: string;
  theme: string;
  gridPosition: { x: number; y: number };
  /**
   * Compartilhamento do Cérebro (configuração explícita do quarto, independente das portas, que
   * agora são automáticas): lê o Cérebro global? E lê também os Cérebros de quais outros quartos
   * (só leitura, não transitivo e não precisa ser simétrico)?
   */
  readsGlobalBrain: boolean;
  readsBrainsOf: string[];
  /** Tamanho da sala (veja room-spec.ts). Ausente = "auto" (cresce com os times). */
  size?: RoomSize;
  /** Função da sala, que decide os móveis (veja room-spec.ts). Ausente = "geral". */
  purpose?: RoomPurpose;
  /**
   * Semente do layout procedural (decoração, lados, variações). Ausente = derivada do id do quarto,
   * então quartos antigos ficam estáveis. "Gerar outro layout" grava uma semente nova.
   */
  layoutSeed?: number;
  /**
   * Ajustes manuais dos móveis (editor "Editar móveis"), aplicados em ordem por cima do layout
   * gerado. Ausente = só o gerado. Trocar a semente descarta os ajustes (veja furniture-edits.ts).
   */
  furnitureEdits?: FurnitureEdit[];
};

export type Team = {
  id: string;
  roomId: string;
  name: string;
  focus: string;
  /** Líder do time (um dos agentes do time): ganha o lugar de destaque da ilha. Opcional. */
  leadAgentId?: string;
};

export type Avatar = {
  skin: string;
  hair: string;
  hairColor: string;
  shirt: string;
  pants: string;
  accessory?: string;
  /** Peças do motor de cena escolhidas no editor (cabelo, roupa, acessório); por cima dos campos acima. Opcional. */
  cena?: { hairStyle?: string; topStyle?: string; accessory?: string };
};

export type Agent = {
  id: string;
  teamId: string;
  name: string;
  role: string;
  instructions: string;
  avatar: Avatar;
  status: "idle" | "working" | "waiting_approval" | "done";
  /**
   * Motor: ausente ou "mock" = agente simulado; "claude" (e depois "codex", "gemini",
   * "opencode") = terminal de CLI de assinatura de vida longa (veja terminal.ts).
   */
  engine?: AgentEngine;
  /** Modelo da CLI (ex.: "sonnet"). Ausente = o padrão da CLI. */
  model?: string;
  /** Esforço de raciocínio. Ausente = o padrão do server (low). */
  effort?: AgentEffort;
  /**
   * Acesso do agente, só para restringir o que o workspace permite (`Workspace.access`): ausente =
   * segue o workspace; `false` = desligado para ele. Veja effectiveAccess em access.ts.
   * internet: busca na web e leitura de páginas; browser: o navegador compartilhado; terminal: comandos no servidor.
   */
  internet?: boolean;
  browser?: boolean;
  terminal?: boolean;
  /**
   * Ajuste por pasta de trabalho do workspace (id da pasta -> "off" sem acesso | "read" só leitura), só
   * para restringir: ausente = como no workspace. Veja effectiveFolders em folders.ts.
   */
  folders?: AgentFolders;
};

/**
 * Tarefa. Sem atalho de quarto/time, o pedido nasce do Maestro (agentId = Maestro, na Sala do
 * Maestro): ele faz a triagem, cria uma subtarefa (`projectId` = a tarefa dele) para o time
 * escolhido e fecha a tarefa original quando o time entrega.
 */
export type Task = {
  id: string;
  roomId: string;
  teamId: string;
  /** O responsável: o agente que executa (ou o Maestro, na tarefa que ele coordena). */
  agentId?: string;
  /**
   * "request" = o registro do pedido do Maestro (a conversa, não uma tarefa de trabalho): fica
   * escondido das telas de tarefas; quem mostra o andamento é o Projeto de mesmo id.
   */
  role?: "request";
  /** Projeto a que esta tarefa pertence (id do pedido do Maestro que a originou). */
  projectId?: string;
  /** Pedido agrupado na migração dentro de outro projeto (id do projeto-cabeça); só no registro `role: "request"`. */
  mergedInto?: string;
  /**
   * Por que o Maestro mandou para este time (ex.: "pedido fala de 'vídeo' → time Vídeo do quarto
   * Estúdio"), ou por que não conseguiu mandar. Vai na tarefa do Maestro e na subtarefa.
   */
  routeReason?: string;
  prompt: string;
  status: "queued" | "in_progress" | "waiting_approval" | "done" | "failed";
  /**
   * Com `status: "failed"`: "cancelled" = alguém (o usuário, o Maestro, um plano cancelado) parou a
   * tarefa; não foi uma falha do agente e não conta como falha na Gestão, na Atividade nem na tela
   * Trabalho. Ausente = falha de verdade.
   */
  outcome?: "cancelled";
  /**
   * Com `status: "failed"`: onde a falha nasceu (a Gestão separa a falha do agente da falta de cota ou acesso).
   * Ausente em tarefas antigas: a taxa de falha então as conta como falha sem origem conhecida ("aproximado").
   */
  failureKind?: FailureKind;
  result?: string;
  /** Com que motor/modelo/esforço o agente rodou (gravado quando a tarefa começa). */
  ranWith?: ModelChoice;
  /** Tarefa e etapa do Projeto que esta Task executa (veja projects.ts). */
  work?: { projectId: string; ref: string; step: number };
  /** Rotina que gerou esta tarefa (o vigia de rotinas; veja routines.ts). */
  routineId?: string;
  /**
   * Pedido do Maestro esperando o usuário sem item no "Para você" (ex.: o Maestro fez uma pergunta
   * na conversa): o porquê, mostrado na UI. Some quando o pedido anda.
   */
  waiting?: string;
  /**
   * Decisão do usuário já tomada de uma tarefa que soltou a vaga do agente (o `ApprovalDecision` do
   * servidor): fica gravada até a tarefa recomeçar, para um reinício do servidor entre a aprovação e a
   * retomada não perder a decisão (e não pedir a aprovação de novo).
   */
  pendingDecision?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type OfficeState = {
  rooms: Room[];
  teams: Team[];
  agents: Agent[];
  tasks: Task[];
};

export type GridPosition = Room["gridPosition"];
export type AgentStatus = Agent["status"];
export type TaskStatus = Task["status"];

export const ROOM_KINDS = ["team", "maestro"] as const satisfies readonly RoomKind[];

export const AGENT_STATUSES = [
  "idle",
  "working",
  "waiting_approval",
  "done",
] as const satisfies readonly AgentStatus[];

export const TASK_STATUSES = [
  "queued",
  "in_progress",
  "waiting_approval",
  "done",
  "failed",
] as const satisfies readonly TaskStatus[];

/** Onde nasceu a falha de uma tarefa: o agente, o motor (CLI caiu), a cota, o acesso, cancelada por alguém ou outro. */
export const FAILURE_KINDS = ["agente", "motor", "cota", "acesso", "cancelada", "outro"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Tarefas que ainda não terminaram (contam como "pendentes" no roteamento). */
export const ACTIVE_TASK_STATUSES = [
  "queued",
  "in_progress",
  "waiting_approval",
] as const satisfies readonly TaskStatus[];

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Item do calendário de um workspace (o que o usuário planejou fazer). `date` é um dia do
 * calendário (YYYY-MM-DD, sem fuso); `time`/`endTime` são HH:MM. Sem `time` = o dia todo.
 */
export type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  /** Quarto relacionado (opcional; pode ficar apontando para um quarto já excluído). */
  roomId?: string;
  notes?: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
};
