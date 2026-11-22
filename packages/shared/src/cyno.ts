import { z } from "zod";
import type { AgentLogEntry } from "./agent-log";
import { AGENDA_EVENT_TYPES, type AgendaServerEvent } from "./agenda";
import { ATTENTION_EVENT_TYPES, type AttentionServerEvent } from "./attention";
import { MURAL_EVENT_TYPES, type MuralServerEvent } from "./mural";
import { JOINT_EVENT_TYPES, type JointServerEvent } from "./joint";import { MAX_ID_LENGTH } from "./ids";
import { modelChoiceSchema, type EngineBlock, type ModelChoice } from "./models";

/**
 * Cyno, o agente da plataforma: UMA CLI acima de todos os Maestros, sem workspace, com o nome do app.
 * Dorme por padrão e só acorda quando o dono fala (os outros gatilhos vêm nas próximas fatias).
 * Este arquivo declara o que o servidor e a web trocam (estado, chat, eventos) e, já pensando nas
 * fatias seguintes, os tipos de confirmações, propostas de workspace, pedidos enviados e pedidos de
 * ajuda dos Maestros. Os demais (ficha, agenda, mural, projeto conjunto, Hoje) ficam nos arquivos
 * irmãos (`card.ts`, `agenda.ts`, `mural.ts`, `joint.ts`, `today.ts`).
 */

/** Id do "agente" Cyno (pasta, log, histórico de gastos). */
export const CYNO_AGENT_ID = "cyno";
/** Id do workspace sintético dos terminais da plataforma (nunca é um slug válido). */
export const CYNO_PLATFORM_ID = "_platform";
export const CYNO_NAME = "Cyno";
/** Como o gasto do Cyno aparece na página Gastos. */
export const CYNO_USAGE_LABEL = "Cyno · plataforma";

/** Rotas (todas atrás da senha do app). */
export const CYNO_PATH = "/api/cyno";
export const CYNO_WS_PATH = "/api/cyno/ws";

/**
 * Estado do Cyno para a tela: dormindo (sem processo), acordando (subindo a CLI), trabalhando (num
 * turno) ou acordado (de pé, esperando). Nada sobe no boot.
 */
export const CYNO_STATUSES = ["sleeping", "waking", "working", "awake"] as const;
export type CynoStatus = (typeof CYNO_STATUSES)[number];

export const CYNO_STATUS_LABELS: Record<CynoStatus, string> = {
  sleeping: "Dormindo",
  waking: "Acordando…",
  working: "Trabalhando",
  awake: "Acordado",
};

/** Ociosidade padrão antes de dormir (minutos), bem menor que os 15 dos agentes de workspace. */
export const CYNO_IDLE_MINUTES = 10;

export type CynoState = {
  status: CynoStatus;
  /** Motor/modelo/esforço com que a próxima subida (ou a atual) roda. */
  choice: ModelChoice;
  /** Já houve conversa (session.json)? Falso = o Cyno nunca foi acordado. */
  everStarted: boolean;
  /** A próxima mensagem abre uma conversa nova (o dono clicou "Nova conversa"). */
  newConversation: boolean;
  /** Minutos de ociosidade até dormir. */
  idleMinutes: number;
  /** Motor sem cota ou ausente: a mensagem espera (nunca troca de motor sozinho). */
  block?: EngineBlock;
  error?: string;
  updatedAt: string;
};

/** O que `GET /api/cyno` e o primeiro evento do websocket entregam. */
export type CynoSnapshot = { state: CynoState; entries: AgentLogEntry[] };

/** Eventos do websocket do Cyno (`/api/cyno/ws`). */
export type CynoServerEvent =
  | AgendaServerEvent
  | AttentionServerEvent
  | MuralServerEvent
  | JointServerEvent
  | ({ type: "cyno:snapshot" } & CynoSnapshot)
  | { type: "cyno:log"; entry: AgentLogEntry }
  | { type: "cyno:status"; state: CynoState }
  | { type: "cyno:cards"; workspaces: string[] }
  /** Os pedidos enviados aos Maestros mudaram (a lista inteira, pequena, com o estado de cada um). */
  | { type: "cyno:requests"; requests: SentRequestView[] }
  /** As confirmações de ações perigosas mudaram (a lista recente inteira, pequena). */
  | { type: "cyno:confirmations"; confirmations: Confirmation[] }
  /** As propostas de workspace mudaram (a lista recente inteira, pequena). */
  | { type: "cyno:proposals"; proposals: WorkspaceProposal[] };

export const CYNO_EVENT_TYPES = ["cyno:snapshot", "cyno:log", "cyno:status", "cyno:cards", "cyno:requests", "cyno:confirmations", "cyno:proposals", ...AGENDA_EVENT_TYPES, ...ATTENTION_EVENT_TYPES, ...MURAL_EVENT_TYPES, ...JOINT_EVENT_TYPES] as const;

/** Lê uma mensagem do websocket do Cyno; null se não for um evento conhecido. */
export function parseCynoEvent(raw: unknown): CynoServerEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  return typeof type === "string" && (CYNO_EVENT_TYPES as readonly string[]).includes(type) ? (raw as CynoServerEvent) : null;
}

export const CYNO_MESSAGE_MAX = 8000;
/** POST /api/cyno/messages */
export const cynoMessageBodySchema = z.strictObject({ text: z.string().trim().min(1, "A mensagem está vazia").max(CYNO_MESSAGE_MAX) });
export type CynoMessageBody = z.input<typeof cynoMessageBodySchema>;
export type CynoMessageResponse = { id: string };

/** PUT /api/cyno/model (motor, modelo e esforço do Cyno; vale na próxima subida, ou reinicia quando livre). */
export const cynoModelBodySchema = z.strictObject({ choice: modelChoiceSchema });
export type CynoModelBody = z.input<typeof cynoModelBodySchema>;

/** Configurações da plataforma do Cyno (`data/platform/settings.json`). */
export const cynoSettingsSchema = z.object({
  idleMinutes: z.number().int().min(1).max(24 * 60).default(CYNO_IDLE_MINUTES),
  /** Teto de turnos do Cyno por dia (protege a cota); ao passar, o chat avisa. */
  dailyTurnCap: z.number().int().min(1).max(1000).default(40),
  digest: z
    .object({
      enabled: z.boolean().default(false),
      frequency: z.enum(["daily", "weekly"]).default("daily"),
      time: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
      useAi: z.boolean().default(false),
    })
    .default({ enabled: false, frequency: "daily", time: "08:00", useAi: false }),
});
export type CynoSettings = z.output<typeof cynoSettingsSchema>;

/** GET/PATCH /api/cyno/settings (as configurações do Cyno na tela Configurações; atrás da senha). */
export const CYNO_SETTINGS_PATH = "/api/cyno/settings";
export const updateCynoSettingsBodySchema = z.strictObject({
  idleMinutes: z.number().int().min(1).max(24 * 60).optional(),
  dailyTurnCap: z.number().int().min(1).max(1000).optional(),
  digest: z
    .strictObject({
      enabled: z.boolean().optional(),
      frequency: z.enum(["daily", "weekly"]).optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      useAi: z.boolean().optional(),
    })
    .optional(),
});
export type UpdateCynoSettingsBody = z.input<typeof updateCynoSettingsBodySchema>;
export type CynoSettingsResponse = {
  settings: CynoSettings;
  /** Os padrões da plataforma (o que vale sem o dono ter mexido). */
  defaults: CynoSettings;
  /** Turnos do Cyno hoje (horário de Brasília) e o dia a que o número se refere (AAAA-MM-DD). */
  turnsToday: number;
  day: string;
  /** `CYNO_IDLE_MS` no ambiente manda sobre os minutos até dormir (só testes e implantações especiais). */
  idleFromEnv: boolean;
};

/** GET/PUT /api/settings/connectors-stdio: os conectores locais (comando na máquina) estão ligados? */
export const CONNECTORS_STDIO_PATH = "/api/settings/connectors-stdio";
export const updateConnectorsStdioBodySchema = z.strictObject({ enabled: z.boolean() });
export type ConnectorsStdioResponse = {
  enabled: boolean;
  /** De onde vem o valor: o que o dono escolheu na tela ("owner") ou o `CONNECTORS_STDIO` do `.env` ("env"). */
  source: "owner" | "env";
  /** O valor do `.env` (o padrão enquanto o dono não escolher). */
  envDefault: boolean;
};

// ---------- Confirmações (ações perigosas em duas fases; Fatia 4) ----------

/** Ações que SEMPRE pedem o OK do dono, por um clique na tela (o modelo não executa nenhuma sozinho). */
export const DANGEROUS_ACTIONS = [
  "delete_workspace",
  "delete_room",
  "delete_team",
  "delete_agent",
  "install_connector",
  "install_app",
  "run_host_command",
  "set_agent_access",
  "set_workspace_access",
  "set_agent_connectors",
  "set_agent_permissions",
] as const;
export type DangerousAction = (typeof DANGEROUS_ACTIONS)[number];

export const CONFIRMATION_STATUSES = ["pendente", "autorizada", "recusada", "expirada", "executada", "falhou"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const CONFIRMATION_ID_PATTERN = /^C-\d{4,}$/;
/** Validade de uma confirmação pendente. */
export const CONFIRMATION_TTL_MS = 30 * 60_000;
/** No máximo tantas pendentes ao mesmo tempo. */
export const CONFIRMATION_MAX_PENDING = 5;

export const confirmationSchema = z.object({
  id: z.string().regex(CONFIRMATION_ID_PATTERN),
  action: z.enum(DANGEROUS_ACTIONS),
  /** Os parâmetros exatos que serão executados (o clique vale só para estes). */
  params: z.record(z.string(), z.unknown()).default({}),
  paramsHash: z.string().max(128),
  /** Texto montado POR CÓDIGO a partir dos parâmetros. */
  summary: z.string().max(600),
  /** Contagens calculadas ("3 salas, 5 agentes"). */
  impact: z.string().max(600).default(""),
  /** Linhas de detalhe (o que exatamente vai acontecer), recolhidas no cartão. */
  details: z.array(z.string().max(400)).max(30).default([]),
  /** Workspace afetado (nome), quando há um. */
  workspace: z.string().max(120).optional(),
  /** O que o modelo disse, mostrado à parte ("Cyno diz:"). */
  reason: z.string().max(600).default(""),
  status: z.enum(CONFIRMATION_STATUSES).default("pendente"),
  origin: z.enum(["cyno", "biblioteca"]).default("cyno"),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
  result: z.string().max(9000).optional(),
});
export type Confirmation = z.output<typeof confirmationSchema>;

/** Rotas do dono para as confirmações (sessão com a senha; o token MCP nunca chega aqui). */
export const CONFIRMATIONS_PATH = "/api/cyno/confirmations";
export type ConfirmationsResponse = { confirmations: Confirmation[] };

/** Como o dono lê cada ação perigosa (título curto do cartão). */
export const DANGEROUS_ACTION_LABELS: Record<DangerousAction, string> = {
  delete_workspace: "Apagar workspace",
  delete_room: "Apagar sala",
  delete_team: "Apagar time",
  delete_agent: "Apagar agente",
  install_connector: "Cadastrar conector (MCP)",
  install_app: "Instalar app",
  run_host_command: "Rodar comando na máquina",
  set_agent_access: "Mudar acesso de um agente",
  set_workspace_access: "Mudar acesso do workspace",
  set_agent_connectors: "Dar conectores a um agente",
  set_agent_permissions: "Mudar permissões de um agente",
};

/** Limites do `run_host_command` (o servidor corta; nada passa disto). */
export const HOST_COMMAND_LIMITS = { timeoutDefaultSec: 120, timeoutMaxSec: 300, outputChars: 8000, argLength: 4000, args: 60 } as const;

// ---------- Proposta de workspace (cartão com "Criar"; Fatia 4) ----------

export const PROPOSAL_STATUSES = ["proposta", "aprovada", "criando", "criada", "falhou", "recusada"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_ID_PATTERN = /^P-\d{4,}$/;
/** Rotas do dono para as propostas de workspace (Criar / Recusar). */
export const PROPOSALS_PATH = "/api/cyno/proposals";
export type ProposalsResponse = { proposals: WorkspaceProposal[] };

const proposalAgentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Função no time (o que o dono lê no cartão). */
  role: z.string().max(60).default(""),
  engine: z.string().max(20),
  model: z.string().max(80).optional(),
  effort: z.string().max(20).optional(),
  focus: z.string().max(300).default(""),
  connectors: z.array(z.string().max(60)).default([]),
  skills: z.array(z.string().max(60)).default([]),
  access: z.object({ internet: z.boolean().optional(), browser: z.boolean().optional(), terminal: z.boolean().optional() }).optional(),
});

export const workspaceProposalPlanSchema = z.object({
  name: z.string().trim().min(1).max(60),
  summary: z.string().max(280).default(""),
  maestro: z.object({ engine: z.string().max(20), model: z.string().max(80).optional(), effort: z.string().max(20).optional() }).optional(),
  rooms: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        purpose: z.string().max(40).optional(),
        size: z.string().max(20).optional(),
        teams: z.array(z.object({ name: z.string().trim().min(1).max(60), focus: z.string().max(300).default(""), agents: z.array(proposalAgentSchema).default([]) })).default([]),
      }),
    )
    .default([]),
  sites: z.array(z.object({ domain: z.string().max(120), why: z.string().max(300).default("") })).default([]),
  connectors: z.array(z.object({ id: z.string().max(60), why: z.string().max(300).default("") })).default([]),
  routines: z.array(z.record(z.string(), z.unknown())).default([]),
  notes: z.string().max(1000).optional(),
});
export type WorkspaceProposalPlan = z.output<typeof workspaceProposalPlanSchema>;

export const workspaceProposalSchema = z.object({
  id: z.string().regex(PROPOSAL_ID_PATTERN),
  version: z.number().int().min(1).default(1),
  replaces: z.string().regex(PROPOSAL_ID_PATTERN).optional(),
  status: z.enum(PROPOSAL_STATUSES).default("proposta"),
  plan: workspaceProposalPlanSchema,
  progress: z.array(z.object({ step: z.string().max(120), done: z.boolean().default(false), error: z.string().max(300).optional() })).default([]),
  /** Avisos calculados por código ao propor (custo, conector que ainda não existe...). */
  warnings: z.array(z.string().max(300)).default([]),
  /** Por que falhou (a criação foi desfeita). */
  error: z.string().max(600).optional(),
  workspaceId: z.string().max(MAX_ID_LENGTH).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkspaceProposal = z.output<typeof workspaceProposalSchema>;

// ---------- Pedidos enviados aos Maestros e pedidos de ajuda deles (Fatia 3) ----------

/** O Cyno pediu algo ao Maestro de um workspace (vira Projeto `origin:"cyno"` lá). */
export const sentRequestSchema = z.object({
  projectId: z.string().max(80),
  workspace: z.string().max(MAX_ID_LENGTH),
  title: z.string().max(200),
  address: z.string().max(140),
  sentAt: z.iso.datetime(),
  /** Último estado que o servidor já avisou no chat (para avisar só quando muda). */
  notified: z.string().max(30).optional(),
  /** Este pedido é uma parte de um projeto conjunto: o aviso passivo fica por conta do conjunto, não de cada parte. */
  jointId: z.string().max(20).optional(),
});
export type SentRequest = z.output<typeof sentRequestSchema>;

/** Rota da lista de pedidos enviados (com o estado de cada um, calculado por código). */
export const SENT_REQUESTS_PATH = "/api/cyno/requests";

/** Estado de um pedido enviado, como o dono lê: andando, esperando você, concluído... */
export const SENT_REQUEST_STATES = ["enviado", "andando", "esperando_voce", "pausado", "concluido", "falhou", "cancelado"] as const;
export type SentRequestState = (typeof SENT_REQUEST_STATES)[number];

export const SENT_REQUEST_STATE_LABELS: Record<SentRequestState, string> = {
  enviado: "enviado, o Maestro está distribuindo",
  andando: "andando",
  esperando_voce: "esperando você",
  pausado: "pausado",
  concluido: "concluído",
  falhou: "falhou",
  cancelado: "cancelado",
};

/** Um pedido enviado com o estado de agora (calculado por código a partir do projeto; ler não acorda ninguém). */
export type SentRequestView = {
  projectId: string;
  workspace: string;
  workspaceName: string;
  title: string;
  address: string;
  sentAt: string;
  state: SentRequestState;
  /** Progresso na unidade do projeto (`unit`): tarefas, ou módulos de primeiro nível quando o projeto tem módulos (`projectUnitProgress`). */
  tasksDone: number;
  tasksTotal: number;
  /** A unidade de `tasksDone`/`tasksTotal` (ausente = tarefas, como antes). */
  unit?: "modulos" | "tarefas";
  /** Itens do "Para você" ligados ao pedido que esperam o dono. */
  waitingForYou: number;
  /** Etapa atual em texto curto ("Redação · Eco"), quando há. */
  stage?: string;
  /** A sprint em andamento do projeto ("Sprint 2 · day 3 of 7"), quando há. */
  sprint?: string;
  /** Nome da sprint que fechou e cuja entrega espera o OK do dono, quando há. */
  deliveryWaiting?: string;
  dueAt?: string;
  closedAt?: string;
};

export type SentRequestsResponse = { requests: SentRequestView[] };

/** Fim do estado: o pedido não muda mais (concluído, falhou, cancelado). */
export function isSentRequestClosed(state: SentRequestState): boolean {
  return state === "concluido" || state === "falhou" || state === "cancelado";
}

/**
 * Marcas que o servidor grava no log da conversa do Cyno para o chat desenhar cartões e linhas discretas
 * (o log tem um formato só: uma entrada `status` com a marca no começo da mensagem).
 */
const REQUEST_MARK = /^\[\[pedido:([^:\]]+):([^\]]+)\]\]\s*(.*)$/s;
const ASK_MARK = /^\[\[ask\]\]\s*(.*)$/s;

/** `status "started"`: o Cyno enviou um pedido (o chat mostra o cartão ao vivo). */
export function requestMarker(workspace: string, projectId: string, title: string): string {
  return `[[pedido:${workspace}:${projectId}]] ${title.replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

export function parseRequestMarker(message: string): { workspace: string; projectId: string; title: string } | undefined {
  const match = REQUEST_MARK.exec(message);
  return match ? { workspace: match[1]!, projectId: match[2]!, title: match[3] ?? "" } : undefined;
}

/** `status "resumed"`: uma troca `ask_cyno` (pergunta do Maestro ou resposta do Cyno), linha discreta. */
export function askMarker(text: string): string {
  return `[[ask]] ${text.replace(/\s+/g, " ").trim().slice(0, 270)}`;
}

export function parseAskMarker(message: string): string | undefined {
  return ASK_MARK.exec(message)?.[1];
}

/** Limites do `ask_cyno` (no servidor): nada de conversa infinita entre o Maestro e o Cyno. */
export const ASK_LIMITS = {
  /** Perguntas abertas ao mesmo tempo, por workspace. */
  openPerWorkspace: 2,
  /** Perguntas que um workspace pode abrir por hora (abertas ou respondidas: continuar uma conversa conta como outra). */
  perWorkspaceHour: 4,
  /** O mesmo teto somando a plataforma toda. */
  perHour: 12,
  /** Sem resposta depois disto, a pergunta vira `sem_resposta` e o Maestro decide sozinho. */
  expireMs: 60 * 60_000,
  question: 1500,
  context: 1500,
} as const;

/** Limites do `message_agent` e do `send_request` do Cyno (contra laço e gasto). */
export const CYNO_SEND_LIMITS = { messagesPerHour: 10, requestsPerHour: 12 } as const;

export const ASK_KINDS = ["help", "cross_workspace", "schedule", "resource"] as const;
export type AskKind = (typeof ASK_KINDS)[number];
export const ASK_STATUSES = ["aberto", "respondido", "sem_resposta"] as const;
export const ASK_ID_PATTERN = /^A-\d{4,}$/;

/** `ask_cyno`: o Maestro de um workspace pede ajuda ao Cyno (`data/platform/asks.json`). */
export const askRecordSchema = z.object({
  id: z.string().regex(ASK_ID_PATTERN),
  workspace: z.string().max(MAX_ID_LENGTH),
  requestId: z.string().max(80).optional(),
  kind: z.enum(ASK_KINDS).default("help"),
  message: z.string().max(2000),
  status: z.enum(ASK_STATUSES).default("aberto"),
  /** O que o Maestro explicou além da pergunta (o pedido de origem, o que já tentou). */
  context: z.string().max(2000).optional(),
  answer: z.string().max(4000).optional(),
  createdAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().optional(),
});
export type AskRecord = z.output<typeof askRecordSchema>;

// ---------- Cartões no chat (cyno:card) ----------

/** Marcas no log do chat que viram o cartão de confirmação/proposta (o estado vivo vem das listas). */
const CONFIRMATION_MARK = /^\[\[confirmacao:(C-\d{4,})\]\]/;
const PROPOSAL_MARK = /^\[\[proposta:(P-\d{4,})\]\]/;
export const confirmationMarker = (id: string): string => `[[confirmacao:${id}]]`;
export const parseConfirmationMarker = (message: string): string | undefined => CONFIRMATION_MARK.exec(message)?.[1];
export const proposalMarker = (id: string): string => `[[proposta:${id}]]`;
export const parseProposalMarker = (message: string): string | undefined => PROPOSAL_MARK.exec(message)?.[1];

/** Confirmação ainda esperando o dono (e dentro da validade). */
export function isConfirmationPending(confirmation: Pick<Confirmation, "status" | "expiresAt">, now: number): boolean {
  return confirmation.status === "pendente" && Date.parse(confirmation.expiresAt) > now;
}

export type CynoCard =
  | { type: "confirmation"; confirmation: Confirmation }
  | { type: "proposal"; proposal: WorkspaceProposal }
  | { type: "request"; request: SentRequest }
  | { type: "notice"; text: string; tone: "info" | "attention" | "danger" };
