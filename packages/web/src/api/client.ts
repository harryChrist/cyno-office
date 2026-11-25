import type {
  Agent,
  RoutineRun,
  BrowserState,
  BrowserTab,
  ScriptOutputResponse,
  ScriptRun,
  ScriptsState,
  AgentChatResponse,
  AgentTerminalInfo,
  Connector,
  ConnectorImportResponse,
  CreateConnectorBody,
  CreateLibraryConnectorBody,
  CreateLibrarySkillBody,
  ImportLibrarySkillsResponse,
  LibraryConnector,
  OAuthDiscoverBody,
  OAuthDiscoveryResult,
  OAuthFinishBody,
  OAuthStartBody,
  OAuthStartResponse,
  LibraryImportResponse,
  LibrarySkillDetail,
  LibrarySkillView,
  SkillImportResponse,
  UpdateLibrarySkillBody,
  UploadLibrarySkillBody,
  LibraryWorkspaceInfo,
  SetLibraryGrantsBody,
  UpdateLibraryConnectorBody,
  UpdateConnectorBody,
  UploadConnectorIconBody,
  AgentLogResponse,
  AgentUsageResponse,
  ApiErrorBody,
  BrainNoteResponse,
  CalendarEvent,
  CreateCalendarEventBody,
  ListCalendarQuery,
  UpdateCalendarEventBody,
  CreateAgentBody,
  CreateTaskBody,
  MaestroMessageResponse,
  CreateTeamBody,
  CreateWorkspaceBody,
  UpdateWorkspaceAccessBody,
  AddWorkFolderBody,
  UpdateWorkFolderBody,
  StorageResponse,
  EnginesResponse,
  ListBrainsResponse,
  CreateRoomBody,
  CreateForYouTypeBody,
  ForYouAnswer,
  ForYouDecisionBody,
  ForYouItem,
  Plan,
  PlanApprovalRule,
  PlanApprovalSettings,
  Project,
  Pace,
  ReleasePace,
  ProjectModeBody,
  ProjectPriority,
  MediaItem,
  BringMediaBody,
  CreateMediaFolderBody,
  MediaFoldersResponse,
  MoveMediaBody,
  RenameMediaFolderBody,
  UpdateMediaBody,
  ForYouTypeDef,
  UpdateForYouTypeBody,
  OfficeState,
  Task,
  TaskLogResponse,
  Team,
  UpdateAgentBody,
  UpdateBrainSharingBody,
  UpdateFurnitureBody,
  UpdateTeamBody,
  UpdateWorkspaceBody,
  UpdateRoomBody,
  ValidationIssue,
  Room,
  RoomContextResponse,
  RoomDeletionPreview,
  UsageRefreshResponse,
  EngineStatusResponse,
  OneShotAccountBody,
  ProgramAccountInfo,
  ProgramModelsResponse,
  EngineTestResult,
  EngineChoices,
  EngineInstallJob,
  EngineInstallPlan,
  EngineVerifyResult,
  OpenRouterKeyInfo,
  OpenRouterModelsResponse,
  RetentionResponse,
  VersionResponse,
  UpdateRetentionBody,
  Workspace,
  AgentEngine,
  ModelChoice,
  ModelDefaults,
  ModelDefaultsResponse,
  CreateRoutineBody,
  NextSlot,
  TrackedItemChange,
  ManagementSummary,
  Routine,
  RoutineModeBody,
  RoutineDetail,
  TrackedItem,
  TrackedItemsResponse,
  RoutinesOverview,
  UpdateRoutineBody,
} from "@cyno/shared";
import type { AvulsasCleanupBody, AvulsasCleanupPreview, AvulsasCleanupResult, ProjectDeleteResult } from "@cyno/shared";
import type { ForYouArchiveSummary, ForYouBatchResponse, ModelSaving, SprintCreateBody, SprintPatchBody, TaskCreateBody, TaskMoveBody, TaskPatchBody, TaskReassignBody } from "@cyno/shared";
import { TODAY_PATH, type PlatformToday, type TodayView } from "@cyno/shared";
import { ATTENTION_PATH, ATTENTION_PREFS_PATH, type AttentionPrefs, type AttentionPrefsBody, type AttentionResponse } from "@cyno/shared";
import { AGENDA_AVAILABILITY_PATH, AGENDA_CHECK_PATH, AGENDA_PATH, type AgendaEvent, type AgendaResponse, type Availability, type CheckAgendaBody, type CreateAgendaEventBody, type SlotCheck, type UpdateAgendaEventBody } from "@cyno/shared";
import { CONFIRMATIONS_PATH, PROPOSALS_PATH, type Confirmation, type ConfirmationsResponse, type ProposalsResponse, type WorkspaceProposal, CARDS_PATH, CYNO_PATH, SENT_REQUESTS_PATH, WAITING_PATH, type SentRequestsResponse, type Card, type CardsResponse, type CynoMessageResponse, type CynoSnapshot, type CynoState, type WaitingResponse } from "@cyno/shared";
import { JOINT_PATH, type JointsResponse, type JointView } from "@cyno/shared";
import { MURAL_PATH, type MuralEntry, type MuralResponse, type MuralShareBody, type MuralUseResponse } from "@cyno/shared";
import { FREEBUFF_MODELS_REFRESH_PATH, FREEBUFF_SETTINGS_PATH, FREEBUFF_TEST_PATH, type FreebuffSettingsBody } from "@cyno/shared";
import { ENGINE_ACCOUNTS_PATH, engineAccountItemPath, type CreateEngineAccountBody, type EngineAccountResponse, type EngineAccountsResponse, type PatchEngineAccountBody } from "@cyno/shared";
import { ENGINE_STATUS_PATH, OPENROUTER_KEY_PATH, OPENROUTER_MODELS_PATH, engineAccountPath, engineProgramDetectPath, engineProgramModelsPath, engineConfigPath, engineInstallPath, engineInstallPlanPath, engineTestPath, engineVerifyPath, AUTH_LOGOUT_ALL_PATH, AUTH_LOGOUT_PATH, AUTH_PASSWORD_PATH, ENGINE_RETRY_PATH, MODEL_DEFAULTS_PATH, RETENTION_CLEANUP_PATH, RETENTION_PATH, VERSION_CHECK_PATH, VERSION_PATH, VERSION_UPDATE_PATH, ACTIVITY_SYSTEM_PATH, USAGE_REFRESH_PATH, workspaceAccessPath, workFolderPath, workFoldersPath } from "@cyno/shared";
import type { ActivityQueryInput, ActivityResponse, ActivitySummary, ActivitySystemResponse, ChangePasswordBody, SecurityState, TwoFactorEnabled, TwoFactorSetup } from "@cyno/shared";
import { AUTH_2FA_DISABLE_PATH, AUTH_2FA_ENABLE_PATH, AUTH_2FA_SETUP_PATH, AUTH_SECURITY_PATH, AUTH_UNBLOCK_PATH } from "@cyno/shared";
import { boardDataPath, boardExportPath, boardPagePath, boardPath, boardSharePath, boardShareRotatePath, boardsPath, type Board, type BoardShare, type SetBoardShareBody, type UpdateBoardBody } from "@cyno/shared";
import { fileCountPath, fileCreatePath, fileDeletePath, fileListPath, fileRawPath, fileReadPath, fileRenamePath, fileRootsPath, fileSearchPath, fileUploadPath, fileWritePath } from "@cyno/shared";
import type { FileCountResponse, FileCreateBody, FileCreateResponse, FileDeleteBody, FileDeleteResponse, FileListResponse, FileReadResponse, FileRenameBody, FileRenameResponse, FileRootsResponse, FileSearchResponse, FileWriteBody, FileWriteResponse } from "@cyno/shared";
import { fsBrowsePath, type FsBrowseResponse } from "@cyno/shared";
import { scriptDownloadPath, scriptOutputPath, scriptPath, scriptsPath, scriptStopPath } from "@cyno/shared";
import { agentRulesPath, brainOrganizePath, brainRulesPath, type AgentRulesResponse, type BrainOrganizeResponse } from "@cyno/shared";
import { useAuthStore } from "../auth/authStore";
import { useNavStore } from "../store/navStore";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type JsonInit = { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export async function requestJson<T>(path: string, init: JsonInit = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: hasBody
      ? { accept: "application/json", "content-type": "application/json" }
      : { accept: "application/json" },
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    // Sessão caída (ou senha criada com o app aberto): volta para a tela de login.
    if (response.status === 401) useAuthStore.getState().expire();
    const body = (await readJson(response).catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiRequestError(response.status, body?.error ?? `Erro HTTP ${response.status}`, body?.details);
  }
  return (await readJson(response)) as T;
}

/** GET que devolve texto puro (a página HTML de um quadro). */
export async function requestText(path: string): Promise<string> {
  const response = await fetch(path, { headers: { accept: "text/html, text/plain" } });
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().expire();
    const text = await response.text().catch(() => "");
    let message = `Erro HTTP ${response.status}`;
    try {
      message = (JSON.parse(text) as ApiErrorBody).error ?? message;
    } catch {
      // Corpo que não é JSON: fica a mensagem padrão.
    }
    throw new ApiRequestError(response.status, message);
  }
  return response.text();
}

/** GET que devolve um arquivo (o PDF de um quadro); em erro, lê a mensagem do corpo JSON. */
export async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(path);
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().expire();
    const text = await response.text().catch(() => "");
    let message = `Erro HTTP ${response.status}`;
    try {
      message = (JSON.parse(text) as ApiErrorBody).error ?? message;
    } catch {
      // Corpo que não é JSON: fica a mensagem padrão.
    }
    throw new ApiRequestError(response.status, message);
  }
  return response.blob();
}

const segment = encodeURIComponent;

/** `?a=1&b=x,y` a partir de um objeto (ignora vazios; lista vira texto separado por vírgulas). */
function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** Prefixo das rotas do workspace atual (`/api/w/<id>`). */
function wsId(): string {
  const id = useNavStore.getState().workspaceId;
  if (!id) throw new ApiRequestError(0, "Nenhum workspace selecionado");
  return id;
}

function ws(): string {
  return `/api/w/${segment(wsId())}`;
}

/**
 * Chamadas REST. As mutações não aplicam a resposta no store: o estado só muda
 * pelos eventos do WebSocket, que chegam em ordem (evita voltar a um estado antigo).
 * Tudo, menos a lista de workspaces, é do workspace atual (navStore).
 */
/** Corpo do `PATCH /projects/:id`. */
export type ProjectPatch = {
  title?: string;
  priority?: ProjectPriority;
  startAt?: string | null;
  dueAt?: string | null;
  pace?: Pace | null;
  status?: "ativo" | "pausado";
  /** "Isso primeiro": true fixa o projeto no topo da fila, false solta. */
  pinned?: boolean;
  /** Objetivo do projeto (`null` limpa) e "pronto quando…". */
  summary?: string | null;
  doneWhen?: string[];
  /** Ritmo de liberação automática (`null` desliga). */
  releasePace?: ReleasePace | null;
};

/** Corpo do `POST /projects/:id/release`: o que liberar (`all` = o projeto inteiro) e se leva os pré-requisitos junto. */
export type ReleaseBody = { refs?: string[]; all?: boolean; withPrerequisites?: boolean };

/** Resposta das rotas que criam um nó da árvore: o projeto inteiro e o `ref` criado. */
export type ProjectTaskCreated = { project: Project; ref: string };

export const api = {
  /** Senha de acesso: sair deste aparelho, sair de todos e trocar a senha (a primeira senha só pelo comando do servidor). */
  logout: () => requestJson<void>(AUTH_LOGOUT_PATH, { method: "POST" }),
  logoutAll: () => requestJson<void>(AUTH_LOGOUT_ALL_PATH, { method: "POST" }),
  changePassword: (body: ChangePasswordBody) => requestJson<void>(AUTH_PASSWORD_PATH, { method: "POST", body }),
  /** Segurança: 2FA, IPs bloqueados e últimas falhas. */
  getSecurity: () => requestJson<SecurityState>(AUTH_SECURITY_PATH),
  unblockIp: (ip: string) => requestJson<void>(AUTH_UNBLOCK_PATH, { method: "POST", body: { ip } }),
  twoFactorSetup: () => requestJson<TwoFactorSetup>(AUTH_2FA_SETUP_PATH, { method: "POST" }),
  twoFactorEnable: (code: string) => requestJson<TwoFactorEnabled>(AUTH_2FA_ENABLE_PATH, { method: "POST", body: { code } }),
  twoFactorDisable: (body: { password: string; code: string }) => requestJson<void>(AUTH_2FA_DISABLE_PATH, { method: "POST", body }),
  /** O Cyno (o agente da plataforma, fora dos workspaces). */
  getCyno: () => requestJson<CynoSnapshot>(CYNO_PATH),
  sendToCyno: (text: string) => requestJson<CynoMessageResponse>(`${CYNO_PATH}/messages`, { method: "POST", body: { text } }),
  cynoNewConversation: () => requestJson<CynoState>(`${CYNO_PATH}/new-conversation`, { method: "POST" }),
  cynoCards: () => requestJson<CardsResponse>(CARDS_PATH),
  cynoWaiting: () => requestJson<WaitingResponse>(WAITING_PATH),
  cynoRequests: () => requestJson<SentRequestsResponse>(SENT_REQUESTS_PATH),
  /** Confirmações de ações perigosas e propostas de workspace: só o dono decide (a rota exige a sessão). */
  cynoConfirmations: () => requestJson<ConfirmationsResponse>(CONFIRMATIONS_PATH),
  approveConfirmation: (id: string) => requestJson<Confirmation>(`${CONFIRMATIONS_PATH}/${id}/approve`, { method: "POST" }),
  rejectConfirmation: (id: string) => requestJson<Confirmation>(`${CONFIRMATIONS_PATH}/${id}/reject`, { method: "POST" }),
  cynoProposals: () => requestJson<ProposalsResponse>(PROPOSALS_PATH),
  approveProposal: (id: string) => requestJson<WorkspaceProposal>(`${PROPOSALS_PATH}/${id}/approve`, { method: "POST" }),
  rejectProposal: (id: string) => requestJson<WorkspaceProposal>(`${PROPOSALS_PATH}/${id}/reject`, { method: "POST" }),
  /** A cadeia de atenção: os alertas abertos, o "Visto" e as preferências da conta. */
  attention: () => requestJson<AttentionResponse>(ATTENTION_PATH),
  attentionSeen: (key: string) => requestJson<void>(`${ATTENTION_PATH}/${segment(key)}/seen`, { method: "POST" }),
  attentionPrefs: () => requestJson<AttentionPrefs>(ATTENTION_PREFS_PATH),
  saveAttentionPrefs: (body: AttentionPrefsBody) => requestJson<AttentionPrefs>(ATTENTION_PREFS_PATH, { method: "PUT", body }),
  /** Sua agenda (o tempo do dono, uma só para a plataforma): compromissos, camada Postagens, rotinas e disponibilidade. */
  listAgenda: (query: { from?: string; to?: string; routines?: boolean; cancelled?: boolean } = {}) =>
    requestJson<AgendaResponse>(`${AGENDA_PATH}${queryString({ from: query.from, to: query.to, routines: query.routines ? "1" : undefined, cancelled: query.cancelled ? "1" : undefined })}`),
  createAgendaEvent: (body: CreateAgendaEventBody) => requestJson<AgendaEvent>(AGENDA_PATH, { method: "POST", body }),
  updateAgendaEvent: (id: string, body: UpdateAgendaEventBody) => requestJson<AgendaEvent>(`${AGENDA_PATH}/${segment(id)}`, { method: "PATCH", body }),
  cancelAgendaEvent: (id: string) => requestJson<AgendaEvent>(`${AGENDA_PATH}/${segment(id)}`, { method: "DELETE" }),
  checkAgendaSlot: (body: CheckAgendaBody) => requestJson<SlotCheck>(AGENDA_CHECK_PATH, { method: "POST", body }),
  saveAvailability: (body: Availability) => requestJson<Availability>(AGENDA_AVAILABILITY_PATH, { method: "PUT", body }),
  /** Projetos que envolvem mais de um workspace (estado por código) e as ações do dono sobre o conjunto. */
  cynoJoints: () => requestJson<JointsResponse>(JOINT_PATH),
  jointAction: (id: string, action: "pause" | "resume" | "cancel") => requestJson<JointView>(`${JOINT_PATH}/${segment(id)}/${action}`, { method: "POST", ...(action === "cancel" ? { body: {} } : {}) }),
  retryJointPart: (id: string, ref: string) => requestJson<JointView>(`${JOINT_PATH}/${segment(id)}/parts/${segment(ref)}/retry`, { method: "POST" }),
  /** O mural da plataforma: itens ativos, as novidades de cada workspace, e as ações do dono. */
  mural: () => requestJson<MuralResponse>(MURAL_PATH),
  shareToMural: (body: MuralShareBody) => requestJson<MuralEntry>(`${MURAL_PATH}/share`, { method: "POST", body }),
  useFromMural: (id: string, workspace: string) => requestJson<MuralUseResponse>(`${MURAL_PATH}/${segment(id)}/use`, { method: "POST", body: { workspace } }),
  retireFromMural: (id: string) => requestJson<MuralEntry>(`${MURAL_PATH}/${segment(id)}`, { method: "DELETE" }),
  setCardSummary: (workspace: string, summary: string) => requestJson<Card>(`${CARDS_PATH}/${segment(workspace)}`, { method: "PUT", body: { summary } }),
  dismissCardProposal: (workspace: string) => requestJson<Card>(`${CARDS_PATH}/${segment(workspace)}/proposal`, { method: "DELETE" }),
  setCynoModel: (choice: ModelChoice) => requestJson<CynoState>(`${CYNO_PATH}/model`, { method: "PUT", body: { choice } }),
  listWorkspaces: () => requestJson<Workspace[]>("/api/workspaces"),
  createWorkspace: (body: CreateWorkspaceBody) => requestJson<Workspace>("/api/workspaces", { method: "POST", body }),
  renameWorkspace: (id: string, body: UpdateWorkspaceBody) =>
    requestJson<Workspace>(`/api/workspaces/${segment(id)}`, { method: "PATCH", body }),
  deleteWorkspace: (id: string) => requestJson<void>(`/api/workspaces/${segment(id)}`, { method: "DELETE" }),
  /** Modelos padrão do workspace (só valem para o que nascer depois; os agentes existentes não mudam). */
  updateWorkspaceModels: (id: string, models: ModelDefaults) => requestJson<Workspace>(`/api/workspaces/${segment(id)}`, { method: "PATCH", body: { models } }),
  /** Paralelismo da distribuição dos planos do workspace (tarefas rodando no workspace e por agente). */
  updateWorkspaceDispatch: (id: string, dispatch: { maxRunning?: number; perAgent?: number }) =>
    requestJson<Workspace>(`/api/workspaces/${segment(id)}`, { method: "PATCH", body: { dispatch } }),
  /** Regra de aprovação de planos do workspace (e nota quando o Maestro mudou a pedido do dono). */
  getPlanApproval: (workspaceId: string) => requestJson<PlanApprovalSettings>(`/api/w/${segment(workspaceId)}/settings/plan-approval`),
  setPlanApproval: (workspaceId: string, rule: PlanApprovalRule) =>
    requestJson<PlanApprovalSettings>(`/api/w/${segment(workspaceId)}/settings/plan-approval`, { method: "PUT", body: { rule } }),
  /** Cerimônias da Gestão do workspace: horário do resumo do dia e da revisão da semana e o parágrafo de IA (só o que vem muda). */
  updateWorkspaceGestao: (id: string, gestao: { dailyAt?: string | null; weekly?: string; ai?: { daily?: boolean; weekly?: boolean } }) =>
    requestJson<Workspace>(`/api/workspaces/${segment(id)}`, { method: "PATCH", body: { gestao } }),
  /** Manter o terminal do Maestro (Claude Code) sempre rodando: sobe com o server e nunca para por ociosidade. */
  updateWorkspaceMaestro: (id: string, maestro: { keepAlive?: boolean; sessionName?: string }) => requestJson<Workspace>(`/api/workspaces/${segment(id)}`, { method: "PATCH", body: { maestro } }),
  /** Acesso dos agentes do workspace (só os campos enviados mudam; os terminais reiniciam quando livres). */
  updateWorkspaceAccess: (id: string, access: UpdateWorkspaceAccessBody) => requestJson<Workspace>(workspaceAccessPath(id), { method: "PUT", body: access }),
  /** Pastas de trabalho do workspace: cadastrar (o servidor confere o caminho), mudar nome/uso/modo e tirar (nada é apagado do disco). */
  addWorkFolder: (id: string, body: AddWorkFolderBody) => requestJson<Workspace>(workFoldersPath(id), { method: "POST", body }),
  updateWorkFolder: (id: string, folderId: string, body: UpdateWorkFolderBody) => requestJson<Workspace>(workFolderPath(id, folderId), { method: "PATCH", body }),
  removeWorkFolder: (id: string, folderId: string) => requestJson<Workspace>(workFolderPath(id, folderId), { method: "DELETE" }),
  /** Navega pelas pastas do servidor (seletor de pastas no app; lista só diretórios). */
  browseFolders: (dirPath?: string, hidden = false) => requestJson<FsBrowseResponse>(fsBrowsePath(dirPath, hidden)),

  /** Modelos padrão globais (preenchem os padrões de cada workspace novo). */
  getModelDefaults: () => requestJson<ModelDefaultsResponse>(MODEL_DEFAULTS_PATH),
  updateModelDefaults: (defaults: ModelDefaults) => requestJson<ModelDefaultsResponse>(MODEL_DEFAULTS_PATH, { method: "PUT", body: { defaults } }),
  /** "Tentar agora" com um motor sem cota (as tarefas paradas andam; se ainda faltar cota, voltam a esperar). */
  /** Tela Motores: o estado detectado dos cinco motores conhecidos. */
  getEngineStatus: () => requestJson<EngineStatusResponse>(ENGINE_STATUS_PATH),
  /** Contas dos motores (Claude Code e Antigravity): lista (padrão + extras com `loggedIn`), criar, renomear e apagar. */
  listEngineAccounts: () => requestJson<EngineAccountsResponse>(ENGINE_ACCOUNTS_PATH),
  createEngineAccount: (body: CreateEngineAccountBody) => requestJson<EngineAccountResponse>(ENGINE_ACCOUNTS_PATH, { method: "POST", body }),
  renameEngineAccount: (id: string, body: PatchEngineAccountBody) => requestJson<EngineAccountResponse>(engineAccountItemPath(id), { method: "PATCH", body }),
  deleteEngineAccount: (id: string) => requestJson<void>(engineAccountItemPath(id), { method: "DELETE" }),
  /** "Testar": um pedido mínimo ao motor (um por vez; 409 se há outro rodando, 429 se foi há pouco). */
  testEngine: (id: string) => requestJson<{ result: EngineTestResult }>(engineTestPath(id), { method: "POST", body: {} }),
  /** Caminho do executável do motor (null = voltar ao padrão); devolve o estado de todos de novo. */
  setEnginePath: (id: string, path: string | null) => requestJson<EngineStatusResponse>(engineConfigPath(id), { method: "PUT", body: { path } }),
  /** OpenClaw e Hermes: modelo e esforço padrão (null = voltar ao padrão do programa). */
  setEngineChoices: (id: string, body: { model?: string | null; effort?: NonNullable<EngineChoices["effort"]> | null; maxGateways?: number; fence?: boolean }) => requestJson<EngineStatusResponse>(engineConfigPath(id), { method: "PUT", body }),
  /** OpenClaw e Hermes: a forma de conta (chave do painel ou configuração do próprio programa) e o local da configuração. */
  setEngineAccount: (id: string, body: OneShotAccountBody) => requestJson<EngineStatusResponse>(engineAccountPath(id), { method: "PUT", body }),
  /** Lê de novo o que o programa tem ligado (roda só o comando de estado dele; nada de segredo volta). */
  detectEngineProgram: (id: string) => requestJson<{ program: ProgramAccountInfo }>(engineProgramDetectPath(id), { method: "POST", body: {} }),
  /** Os modelos que o próprio programa lista (vazio = digitação livre). */
  getEngineProgramModels: (id: string) => requestJson<ProgramModelsResponse>(engineProgramModelsPath(id)),
  /** Hermes na pasta pessoal: o dono confirma que o Cyno escreva o bloco do MCP no config.yaml. */
  /** A chave do OpenRouter (uma só, dos dois motores): a resposta nunca traz a chave, só "termina em …abcd". */
  getOpenRouterKey: () => requestJson<OpenRouterKeyInfo>(OPENROUTER_KEY_PATH),
  setOpenRouterKey: (key: string) => requestJson<OpenRouterKeyInfo>(OPENROUTER_KEY_PATH, { method: "PUT", body: { key } }),
  removeOpenRouterKey: () => requestJson<OpenRouterKeyInfo>(OPENROUTER_KEY_PATH, { method: "DELETE" }),
  /** Lê a lista pública de modelos do OpenRouter (sob demanda; fica guardada no servidor). */
  /** A lista de modelos guardada no servidor (vazia, `readAt: ""`, se ainda não foi lida). */
  getOpenRouterModels: () => requestJson<OpenRouterModelsResponse>(OPENROUTER_MODELS_PATH),
  refreshOpenRouterModels: () => requestJson<OpenRouterModelsResponse>(OPENROUTER_MODELS_PATH, { method: "POST", body: {} }),
  /** "Verificar": as checagens; com `confirm` roda também o turno de teste de verdade (pode custar num modelo pago). */
  verifyEngine: (id: string, confirm = false) => requestJson<{ result: EngineVerifyResult }>(engineVerifyPath(id), { method: "POST", body: confirm ? { confirm: true } : {} }),
  /** Instalar: o plano (nada roda) e, depois do OK do dono, a instalação (`confirm: true`). */
  getEngineInstallPlan: (id: string) => requestJson<{ plan: EngineInstallPlan }>(engineInstallPlanPath(id), { method: "POST", body: {} }),
  /** O andamento da instalação (rota leve: só o job, sem rodar `--version` dos programas). */
  getEngineInstall: (id: string) => requestJson<{ job: EngineInstallJob | null }>(engineInstallPath(id)),
  installEngine: (id: string) => requestJson<{ job: EngineInstallJob }>(engineInstallPath(id), { method: "POST", body: { confirm: true } }),
  /** Freebuff: o modelo e o esforço da plataforma e o teto de horas abertas (valem para a próxima hora aberta). */
  setFreebuffSettings: (body: FreebuffSettingsBody) => requestJson<EngineStatusResponse>(FREEBUFF_SETTINGS_PATH, { method: "PUT", body }),
  /** Freebuff: abre uma sondagem, lê o `/model` e fecha sem mandar mensagem (não gasta hora). */
  refreshFreebuffModels: () => requestJson<EngineStatusResponse>(FREEBUFF_MODELS_REFRESH_PATH, { method: "POST", body: {} }),
  /** Freebuff: o teste ABRE uma hora (gasta horas do dia): só roda com a confirmação. */
  testFreebuff: () => requestJson<{ result: EngineTestResult }>(FREEBUFF_TEST_PATH, { method: "POST", body: { confirm: true } }),
  retryEngine: (engine: AgentEngine) => requestJson<void>(ENGINE_RETRY_PATH, { method: "POST", body: { engine } }),

  /** Pede ao server uma nova consulta do uso da conta (Claude ou Antigravity; é da conta, não do workspace). */
  refreshUsage: (provider: "claude" | "gemini" = "claude") => requestJson<UsageRefreshResponse>(USAGE_REFRESH_PATH, { method: "POST", body: { provider } }),

  /** Uso relatado por agente deste workspace (turnos e tokens que cada CLI informou) desde `since` (ISO). */
  agentUsage: (since?: string) => requestJson<AgentUsageResponse>(`${ws()}/usage/agents${since ? `?since=${segment(since)}` : ""}`),

  getOffice: () => requestJson<OfficeState>(`${ws()}/office`),

  /** Retenção do histórico em disco (do server, não do workspace): configuração, uso de disco e limpeza. */
  getRetention: () => requestJson<RetentionResponse>(RETENTION_PATH),
  updateRetention: (body: UpdateRetentionBody) => requestJson<RetentionResponse>(RETENTION_PATH, { method: "PATCH", body }),
  cleanupRetention: () => requestJson<RetentionResponse>(RETENTION_CLEANUP_PATH, { method: "POST" }),
  /** Versão instalada e último resultado da verificação de atualização (sem rede no servidor). */
  getVersion: () => requestJson<VersionResponse>(VERSION_PATH),
  /** Verifica agora se há atualização no GitHub. */
  checkVersion: () => requestJson<VersionResponse>(VERSION_CHECK_PATH, { method: "POST" }),
  /** Começa a baixar a atualização (segundo plano); o andamento vem em `update.job` do GET. Nunca reinicia nada. */
  updateVersion: () => requestJson<VersionResponse>(VERSION_UPDATE_PATH, { method: "POST" }),

  /** Atividade do workspace atual (o que foi feito), mais nova primeiro e paginada por `cursor`. */
  activity: (query: ActivityQueryInput = {}) => requestJson<ActivityResponse>(`${ws()}/activity${queryString(query)}`),
  /** Números do período (um dia, ou `from` e `to` AAAA-MM-DD) do workspace atual. */
  activitySummary: (range: { from: string; to: string }) => requestJson<ActivitySummary>(`${ws()}/activity/summary${queryString(range)}`),
  /** Eventos do servidor (subiu, parou, caiu, memória baixa) e a memória do último batimento; não depende do workspace. */
  activitySystem: (query: ActivityQueryInput = {}) => requestJson<ActivitySystemResponse>(`${ACTIVITY_SYSTEM_PATH}${queryString(query)}`),

  /** Motores deste server (CLIs instaladas, versões e modelos); não depende do workspace. */
  listEngines: (refresh = false) => requestJson<EnginesResponse>(`/api/engines${refresh ? "?refresh=1" : ""}`),

  createTask: (body: CreateTaskBody) => requestJson<Task>(`${ws()}/tasks`, { method: "POST", body }),

  /** Fala com o Maestro: conversa (Maestro de CLI) ou, no simulado, o pedido criado. */
  talkToMaestro: (text: string) => requestJson<MaestroMessageResponse>(`${ws()}/maestro/messages`, { method: "POST", body: { text } }),

  /** Fecha um pedido do Maestro (parado): concluir como está ou cancelar (as subtarefas e o plano param). */
  closeRequest: (taskId: string, mode: "concluir" | "cancelar", note?: string) =>
    requestJson<Task>(`${ws()}/tasks/${segment(taskId)}/close`, { method: "POST", body: { mode, ...(note ? { note } : {}) } }),

  /** Planos dos pedidos: aprovar (a distribuição começa), pedir ajuste (vai para o Maestro) ou cancelar (o pedido fecha). */
  listPlans: () => requestJson<Plan[]>(`${ws()}/plans`),
  /** `release`: "all" (padrão) libera tudo ao aprovar; "none" deixa tudo Planejado. */
  approvePlan: (id: string, release: "all" | "none" = "all") => requestJson<Plan>(`${ws()}/plans/${segment(id)}/approve`, { method: "POST", body: { release } }),
  adjustPlan: (id: string, feedback: string) => requestJson<Plan>(`${ws()}/plans/${segment(id)}/adjust`, { method: "POST", body: { feedback } }),
  cancelPlan: (id: string) => requestJson<Plan>(`${ws()}/plans/${segment(id)}/cancel`, { method: "POST" }),

  /**
   * Edita um projeto (Fatia 4 do servidor): título, prioridade, começa em, prazo, ritmo (null tira) e pausar/retomar.
   * Enquanto a rota não existe, responde 404 (a tela mostra "Disponível em breve").
   */
  updateProject: (id: string, patch: ProjectPatch) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(id)}`, { method: "PATCH", body: patch }),

  // ---------- Árvore de tarefas (criar e editar pela tela) ----------
  createProject: (body: { title: string; summary?: string; priority?: ProjectPriority; dueAt?: string; doneWhen?: string[] }) => requestJson<{ project: Project }>(`${ws()}/projects`, { method: "POST", body }),
  createProjectTask: (projectId: string, body: TaskCreateBody) => requestJson<ProjectTaskCreated>(`${ws()}/projects/${segment(projectId)}/tasks`, { method: "POST", body }),
  updateProjectTask: (projectId: string, ref: string, body: TaskPatchBody) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}`, { method: "PATCH", body }),
  /** Passa uma tarefa travada a outro agente e a devolve à fila (409 se uma etapa está rodando: cancele a etapa antes). */
  reassignProjectTask: (projectId: string, ref: string, body: TaskReassignBody) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}/reassign`, { method: "POST", body }),
  moveProjectTask: (projectId: string, ref: string, body: TaskMoveBody) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}/move`, { method: "POST", body }),
  duplicateProjectTask: (projectId: string, ref: string) => requestJson<ProjectTaskCreated>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}/duplicate`, { method: "POST" }),
  /** Libera itens Planejados (módulo = tudo dentro; `withPrerequisites` leva o que eles esperam; `all` = o projeto inteiro). */
  releaseWork: (projectId: string, body: ReleaseBody) => requestJson<{ project: Project } | Project>(`${ws()}/projects/${segment(projectId)}/release`, { method: "POST", body }),
  /** Segura de volta (Planejada) o que ainda não começou. */
  holdWork: (projectId: string, refs: string[]) => requestJson<{ project: Project } | Project>(`${ws()}/projects/${segment(projectId)}/hold`, { method: "POST", body: { refs } }),
  archiveProjectTask: (projectId: string, ref: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}/archive`, { method: "POST" }),
  labelProjectTask: (projectId: string, ref: string, name: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}/label`, { method: "POST", body: { name } }),
  /** Quantas avulsas terminadas dariam para apagar (só leitura); 0 dias = qualquer idade. */
  previewAvulsasCleanup: (olderThanDays: number) => requestJson<AvulsasCleanupPreview>(`${ws()}/projects/avulsas/cleanup${queryString({ olderThanDays })}`),
  /** Apaga de vez as avulsas terminadas mais velhas que `olderThanDays` (e as do arquivo, se pedido). */
  cleanupAvulsas: (body: AvulsasCleanupBody) => requestJson<AvulsasCleanupResult>(`${ws()}/projects/avulsas/cleanup`, { method: "POST", body }),
  /** Reabre um projeto concluído ou cancelado (volta para ativo). */
  reopenProject: (id: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(id)}/reopen`, { method: "POST" }),
  /** Conclui um projeto aberto (409 se houver tarefa em andamento ou esperando você). */
  completeProject: (id: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(id)}/complete`, { method: "POST" }),
  /** Apaga de vez um item (tarefa, subtarefa ou módulo com tudo dentro) de qualquer projeto (409 se houver algo em andamento ou esperando você). */
  deleteTaskNode: (projectId: string, ref: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/tasks/${segment(ref)}`, { method: "DELETE" }),
  /** Apaga um projeto comum de vez, com as tarefas e os logs (409 para o Avulsas e com tarefa rodando). */
  deleteProject: (projectId: string) => requestJson<ProjectDeleteResult>(`${ws()}/projects/${segment(projectId)}`, { method: "DELETE" }),
  convertTaskToProject: (ref: string) => requestJson<{ project: Project }>(`${ws()}/projects/avulsas/tasks/${segment(ref)}/convert`, { method: "POST" }),
  createSprint: (projectId: string, body: SprintCreateBody) => requestJson<{ project: Project; sprintId: string }>(`${ws()}/projects/${segment(projectId)}/sprints`, { method: "POST", body }),
  updateSprint: (projectId: string, sprintId: string, body: SprintPatchBody) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/sprints/${segment(sprintId)}`, { method: "PATCH", body }),
  deleteSprint: (projectId: string, sprintId: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/sprints/${segment(sprintId)}`, { method: "DELETE" }),
  startSprint: (projectId: string, sprintId: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/sprints/${segment(sprintId)}/start`, { method: "POST" }),
  closeSprint: (projectId: string, sprintId: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/sprints/${segment(sprintId)}/close`, { method: "POST" }),
  convertProjectToTask: (projectId: string) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(projectId)}/convert`, { method: "POST" }),

  /** Modo do projeto (só o usuário liga o Automático): ligar com a permissão, voltar para Pede OK ou aceitar/recusar a sugestão. */
  setProjectMode: (id: string, body: ProjectModeBody) => requestJson<{ project: Project }>(`${ws()}/projects/${segment(id)}/mode`, { method: "POST", body }),

  decideApproval: (taskId: string, approved: boolean) =>
    requestJson<unknown>(`${ws()}/tasks/${segment(taskId)}/approval`, { method: "POST", body: { approved } }),

  /** Conversa direta com um agente: nota na tarefa em curso ou conversa (nada vira pedido). */
  chatWithAgent: (agentId: string, text: string) => requestJson<AgentChatResponse>(`${ws()}/agents/${segment(agentId)}/chat`, { method: "POST", body: { text } }),
  /** Liga o terminal de CLI do agente (sobe o processo, retomando a sessão). */
  startTerminal: (agentId: string) => requestJson<AgentTerminalInfo>(`${ws()}/agents/${segment(agentId)}/terminal/start`, { method: "POST" }),
  /** Desliga o terminal (`force`: mesmo no meio de um turno; sem ele, 409 se estiver trabalhando). */
  stopTerminal: (agentId: string, force = false) => requestJson<AgentTerminalInfo>(`${ws()}/agents/${segment(agentId)}/terminal/stop${force ? "?force=1" : ""}`, { method: "POST" }),

  /** Log de trabalho recente do agente (todas as tarefas, as mais novas por último). */
  getAgentLog: (agentId: string, limit?: number) =>
    requestJson<AgentLogResponse>(`${ws()}/agents/${segment(agentId)}/log${limit ? `?limit=${limit}` : ""}`),
  /** Log de uma tarefa (com as threads dos subagentes); `thread` = id do subagente ou "main". */
  getTaskLog: (taskId: string, thread?: string) =>
    requestJson<TaskLogResponse>(`${ws()}/tasks/${segment(taskId)}/log${thread ? `?thread=${segment(thread)}` : ""}`),

  /** Rotinas e metas: visão geral da semana, detalhe, criação direta e edição (só o usuário muda "precisa do meu OK"). */
  getToday: () => requestJson<TodayView>(`${ws()}/today`),
  getPlatformToday: () => requestJson<PlatformToday>(TODAY_PATH),
  getRoutinesOverview: () => requestJson<RoutinesOverview>(`${ws()}/routines/overview`),
  getRoutine: (id: string) => requestJson<RoutineDetail>(`${ws()}/routines/${segment(id)}`),
  createRoutine: (body: CreateRoutineBody) => requestJson<Routine>(`${ws()}/routines`, { method: "POST", body }),
  /** Modo da rotina (só o usuário liga o Automático): ligar, voltar para Pede OK ou aceitar/recusar a sugestão. */
  setRoutineMode: (id: string, body: RoutineModeBody) => requestJson<{ routine: Routine }>(`${ws()}/routines/${segment(id)}/mode`, { method: "POST", body }),
  retryRoutine: (id: string) => requestJson<{ routine: Routine }>(`${ws()}/routines/${segment(id)}/retry`, { method: "POST" }),
  runRoutineSchedule: (id: string, scheduleId: string) => requestJson<{ run: RoutineRun }>(`${ws()}/routines/${segment(id)}/schedules/${segment(scheduleId)}/run`, { method: "POST" }),
  deleteRoutine: (id: string) => requestJson<{ removed: string }>(`${ws()}/routines/${segment(id)}`, { method: "DELETE" }),
  updateRoutine: (id: string, body: UpdateRoutineBody) => requestJson<Routine>(`${ws()}/routines/${segment(id)}`, { method: "PATCH", body }),
  /** Itens acompanhados de um acompanhamento (com histórico), e parar um item (só você retoma). */
  getRoutineItems: (id: string) => requestJson<TrackedItemsResponse>(`${ws()}/routines/${segment(id)}/items`),
  stopRoutineItem: (id: string, itemId: string, reason?: string) => requestJson<{ item: TrackedItem }>(`${ws()}/routines/${segment(id)}/items/${segment(itemId)}/stop`, { method: "POST", body: reason ? { reason } : {} }),
  /** Retoma um item parado (a vida dele conta de novo), corrige um campo ou o status, lista as mudanças recentes e os próximos horários. */
  reopenRoutineItem: (id: string, itemId: string) => requestJson<{ item: TrackedItem }>(`${ws()}/routines/${segment(id)}/items/${segment(itemId)}/reopen`, { method: "POST" }),
  editRoutineItem: (id: string, itemId: string, body: { values?: Record<string, string | number>; status?: string }) => requestJson<{ item: TrackedItem }>(`${ws()}/routines/${segment(id)}/items/${segment(itemId)}`, { method: "PATCH", body }),
  getRoutineChanges: (id: string, hours = 48) => requestJson<{ changes: TrackedItemChange[] }>(`${ws()}/routines/${segment(id)}/changes?hours=${hours}`),
  getRoutineNext: (id: string, count = 5) => requestJson<{ next: NextSlot[] }>(`${ws()}/routines/${segment(id)}/next?count=${count}`),
  getManagementSummary: () => requestJson<ManagementSummary>(`${ws()}/management/summary`),

  listForYou: () => requestJson<ForYouItem[]>(`${ws()}/for-you`),
  /** O arquivo das aprovações decididas há mais tempo que o prazo: o resumo (meses e quantos itens). */
  getForYouArchive: () => requestJson<ForYouArchiveSummary>(`${ws()}/for-you/archive`),
  /** Os itens arquivados de um mês ("AAAA-MM"). */
  getForYouArchiveMonth: (month: string) => requestJson<ForYouItem[]>(`${ws()}/for-you/archive/${segment(month)}`),
  /** Os itens do arquivo de uma tarefa e/ou de um id (para telas de UMA tarefa ou de UM registro). */
  findForYouArchive: (query: { taskId?: string; id?: string }) => {
    const params = new URLSearchParams();
    if (query.taskId) params.set("taskId", query.taskId);
    if (query.id) params.set("id", query.id);
    return requestJson<ForYouItem[]>(`${ws()}/for-you/archive/find?${params.toString()}`);
  },
  /** Aprovar em lote (Gestão): até 20 aprovações de texto do mesmo tipo, sem edição pendente. */
  approveForYouBatch: (ids: readonly string[]) => requestJson<ForYouBatchResponse>(`${ws()}/for-you/batch`, { method: "POST", body: { ids, decision: "aprovado" } }),
  /** Quanto o agente economizaria (ou gastaria a mais) com outro modelo; só estima, nada muda. */
  getModelSaving: (agentId: string, model: string) => requestJson<ModelSaving>(`${ws()}/metrics/model-saving?agentId=${segment(agentId)}&model=${segment(model)}`),
  decideForYou: (id: string, body: ForYouDecisionBody) =>
    requestJson<ForYouItem>(`${ws()}/for-you/${segment(id)}/decision`, { method: "POST", body }),
  /** Rascunho das respostas de um questionário (só grava; não acorda ninguém). */
  saveForYouAnswers: (id: string, answers: Record<string, ForYouAnswer>) =>
    requestJson<ForYouItem>(`${ws()}/for-you/${segment(id)}/answers`, { method: "PATCH", body: { answers } }),
  /** "Enviar respostas": acorda uma vez quem perguntou (o Maestro, ou só a tarefa do agente). */
  submitForYou: (id: string) => requestJson<ForYouItem>(`${ws()}/for-you/${segment(id)}/submit`, { method: "POST" }),
  /** "Descartar": o item vai para Cancelados (motivo opcional); a tarefa que ele segurava segue sem a resposta. */
  cancelForYou: (id: string, reason?: string) =>
    requestJson<ForYouItem>(`${ws()}/for-you/${segment(id)}/cancel`, { method: "POST", body: reason ? { reason } : {} }),
  listForYouTypes: () => requestJson<ForYouTypeDef[]>(`${ws()}/for-you/types`),
  createForYouType: (body: CreateForYouTypeBody) => requestJson<ForYouTypeDef>(`${ws()}/for-you/types`, { method: "POST", body }),
  updateForYouType: (id: string, body: UpdateForYouTypeBody) =>
    requestJson<ForYouTypeDef>(`${ws()}/for-you/types/${segment(id)}`, { method: "PATCH", body }),
  deleteForYouType: (id: string) => requestJson<void>(`${ws()}/for-you/types/${segment(id)}`, { method: "DELETE" }),
  mergeForYouType: (id: string, into: string) =>
    requestJson<ForYouTypeDef>(`${ws()}/for-you/types/${segment(id)}/merge`, { method: "POST", body: { into } }),

  updateBrainSharing: (roomId: string, body: UpdateBrainSharingBody) =>
    requestJson<Room>(`${ws()}/rooms/${segment(roomId)}/brain-sharing`, { method: "PATCH", body }),

  getContext: (roomId: string) => requestJson<RoomContextResponse>(`${ws()}/rooms/${segment(roomId)}/context`),

  listBrains: () => requestJson<ListBrainsResponse>(`${ws()}/brains`),
  getBrainNote: (brainId: string, file: string) =>
    requestJson<BrainNoteResponse>(`${ws()}/brains/${segment(brainId)}/notes/${segment(file)}`),
  /** Regras de um agente (só ele as recebe, em toda tarefa). */
  getAgentRules: (agentId: string) => requestJson<AgentRulesResponse>(`${ws()}${agentRulesPath(agentId)}`),
  setAgentRules: (agentId: string, content: string) => requestJson<AgentRulesResponse>(`${ws()}${agentRulesPath(agentId)}`, { method: "PUT", body: { content } }),
  /** Troca o texto do `_regras.md` do Cérebro. */
  setBrainRules: (brainId: string, content: string) => requestJson<BrainNoteResponse>(`${ws()}${brainRulesPath(brainId)}`, { method: "PUT", body: { content } }),
  /** Pede ao Maestro uma proposta de organização do Cérebro (nada muda até o dono aprovar em Aprovações). */
  organizeBrain: (brainId: string) => requestJson<BrainOrganizeResponse>(`${ws()}${brainOrganizePath(brainId)}`, { method: "POST" }),

  createRoom: (body: CreateRoomBody) => requestJson<Room>(`${ws()}/rooms`, { method: "POST", body }),
  updateRoom: (id: string, body: UpdateRoomBody) => requestJson<Room>(`${ws()}/rooms/${segment(id)}`, { method: "PATCH", body }),
  /** Ajustes manuais dos móveis: grava a lista inteira (vazia = volta ao layout gerado). */
  updateRoomFurniture: (id: string, body: UpdateFurnitureBody) => requestJson<Room>(`${ws()}/rooms/${segment(id)}/furniture`, { method: "PATCH", body }),
  deleteRoom: (id: string) => requestJson<void>(`${ws()}/rooms/${segment(id)}`, { method: "DELETE" }),
  /** O que o DELETE do quarto apagaria (para a confirmação). */
  getRoomDeletionPreview: (id: string) => requestJson<RoomDeletionPreview>(`${ws()}/rooms/${segment(id)}/deletion-preview`),

  createTeam: (body: CreateTeamBody) => requestJson<Team>(`${ws()}/teams`, { method: "POST", body }),
  updateTeam: (id: string, body: UpdateTeamBody) => requestJson<Team>(`${ws()}/teams/${segment(id)}`, { method: "PATCH", body }),
  deleteTeam: (id: string) => requestJson<void>(`${ws()}/teams/${segment(id)}`, { method: "DELETE" }),

  createAgent: (body: CreateAgentBody) => requestJson<Agent>(`${ws()}/agents`, { method: "POST", body }),
  updateAgent: (id: string, body: UpdateAgentBody) => requestJson<Agent>(`${ws()}/agents/${segment(id)}`, { method: "PATCH", body }),
  deleteAgent: (id: string) => requestJson<void>(`${ws()}/agents/${segment(id)}`, { method: "DELETE" }),

  listCalendar: (query: ListCalendarQuery = {}) => {
    const params = new URLSearchParams();
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    const search = params.toString();
    return requestJson<CalendarEvent[]>(`${ws()}/calendar${search ? `?${search}` : ""}`);
  },
  createCalendarEvent: (body: CreateCalendarEventBody) => requestJson<CalendarEvent>(`${ws()}/calendar`, { method: "POST", body }),
  updateCalendarEvent: (id: string, body: UpdateCalendarEventBody) =>
    requestJson<CalendarEvent>(`${ws()}/calendar/${segment(id)}`, { method: "PATCH", body }),
  deleteCalendarEvent: (id: string) => requestJson<void>(`${ws()}/calendar/${segment(id)}`, { method: "DELETE" }),

  /** Conectores (servidores MCP externos) do workspace; as respostas nunca trazem segredos. */
  listConnectors: () => requestJson<Connector[]>(`${ws()}/connectors`),
  createConnector: (body: CreateConnectorBody) => requestJson<Connector>(`${ws()}/connectors`, { method: "POST", body }),
  updateConnector: (id: string, body: UpdateConnectorBody) => requestJson<Connector>(`${ws()}/connectors/${segment(id)}`, { method: "PATCH", body }),
  deleteConnector: (id: string) => requestJson<void>(`${ws()}/connectors/${segment(id)}`, { method: "DELETE" }),
  /** Testa agora (initialize + tools/list) e devolve o conector com o estado novo. */
  testConnector: (id: string) => requestJson<Connector>(`${ws()}/connectors/${segment(id)}/test`, { method: "POST" }),
  uploadConnectorIcon: (id: string, body: UploadConnectorIconBody) => requestJson<Connector>(`${ws()}/connectors/${segment(id)}/icon`, { method: "POST", body }),
  /** Servidores do Claude Code do usuário (lidos do `claude mcp list`, sem segredos). */
  importConnectorsFromClaude: () => requestJson<ConnectorImportResponse>(`${ws()}/connectors/import/claude`),
  /** Conectores do agente (lista inteira). */
  setAgentConnectors: (agentId: string, connectorIds: string[]) => requestJson<Connector[]>(`${ws()}/agents/${segment(agentId)}/connectors`, { method: "PATCH", body: { connectorIds } }),

  /** Biblioteca da plataforma (fora dos workspaces): conectores guardados uma vez e liberados a workspaces e agentes. */
  listLibraryWorkspaces: () => requestJson<LibraryWorkspaceInfo[]>("/api/library/workspaces"),
  listLibraryConnectors: () => requestJson<LibraryConnector[]>("/api/library/connectors"),
  createLibraryConnector: (body: CreateLibraryConnectorBody) => requestJson<LibraryConnector>("/api/library/connectors", { method: "POST", body }),
  updateLibraryConnector: (id: string, body: UpdateLibraryConnectorBody) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}`, { method: "PATCH", body }),
  deleteLibraryConnector: (id: string) => requestJson<void>(`/api/library/connectors/${segment(id)}`, { method: "DELETE" }),
  testLibraryConnector: (id: string) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}/test`, { method: "POST" }),
  /** Liberações nos dois níveis: o mapa inteiro de workspace -> agentes (o que não estiver nele é retirado). */
  setLibraryGrants: (id: string, body: SetLibraryGrantsBody) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}/grants`, { method: "PUT", body }),
  uploadLibraryConnectorIcon: (id: string, body: UploadConnectorIconBody) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}/icon`, { method: "POST", body }),
  getLibraryConnector: (id: string) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}`),
  /** Login OAuth: "Verificar" (só descobre; nada é guardado), começar o login (devolve a URL da tela do serviço) e desconectar. */
  discoverLibraryOAuth: (body: OAuthDiscoverBody) => requestJson<OAuthDiscoveryResult>("/api/library/connectors/oauth/discover", { method: "POST", body }),
  startLibraryOAuth: (id: string, body: OAuthStartBody) => requestJson<OAuthStartResponse>(`/api/library/connectors/${segment(id)}/oauth/start`, { method: "POST", body }),
  finishLibraryOAuth: (id: string, body: OAuthFinishBody) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}/oauth/finish`, { method: "POST", body }),
  disconnectLibraryOAuth: (id: string) => requestJson<LibraryConnector>(`/api/library/connectors/${segment(id)}/oauth/disconnect`, { method: "POST" }),
  importLibraryConnectorsFromClaude: () => requestJson<LibraryImportResponse>("/api/library/connectors/import/claude"),

  /** Skills da Biblioteca: pastas com SKILL.md guardadas na plataforma e liberadas a workspaces e agentes. */
  listLibrarySkills: () => requestJson<LibrarySkillView[]>("/api/library/skills"),
  getLibrarySkill: (id: string) => requestJson<LibrarySkillDetail>(`/api/library/skills/${segment(id)}`),
  createLibrarySkill: (body: CreateLibrarySkillBody) => requestJson<LibrarySkillView>("/api/library/skills", { method: "POST", body }),
  updateLibrarySkill: (id: string, body: UpdateLibrarySkillBody) => requestJson<LibrarySkillView>(`/api/library/skills/${segment(id)}`, { method: "PUT", body }),
  deleteLibrarySkill: (id: string) => requestJson<void>(`/api/library/skills/${segment(id)}`, { method: "DELETE" }),
  restoreLibrarySkill: (id: string) => requestJson<LibrarySkillView>(`/api/library/skills/${segment(id)}/restore`, { method: "POST" }),
  duplicateLibrarySkill: (id: string) => requestJson<LibrarySkillView>(`/api/library/skills/${segment(id)}/duplicate`, { method: "POST" }),
  uploadLibrarySkill: (body: UploadLibrarySkillBody) => requestJson<LibrarySkillView>("/api/library/skills/upload", { method: "POST", body }),
  setLibrarySkillGrants: (id: string, body: SetLibraryGrantsBody) => requestJson<LibrarySkillView>(`/api/library/skills/${segment(id)}/grants`, { method: "PUT", body }),
  /** Skills do computador do dono (só nomes e descrições; nada é copiado até ele marcar). */
  listSkillImportCandidates: () => requestJson<SkillImportResponse>("/api/library/skills/import/candidates"),
  importLibrarySkills: (keys: string[]) => requestJson<ImportLibrarySkillsResponse>("/api/library/skills/import", { method: "POST", body: { keys } }),

  /** Navegador compartilhado do workspace: abas (de quem é cada uma) e abrir/fechar aba do usuário. */
  getBrowser: () => requestJson<BrowserState>(`${ws()}/browser`),
  openBrowserTab: (url?: string) => requestJson<BrowserTab>(`${ws()}/browser/tabs`, { method: "POST", body: url ? { url } : {} }),
  closeBrowserTab: (tabId: string) => requestJson<void>(`${ws()}/browser/tabs/${segment(tabId)}`, { method: "DELETE" }),

  /** Scripts dos agentes: a lista, um script, um pedaço da saída (bruta, por byte) e o botão Parar. */
  listScripts: () => requestJson<ScriptsState>(scriptsPath(wsId())),
  getScript: (id: string) => requestJson<ScriptRun>(scriptPath(wsId(), id)),
  getScriptOutput: (id: string, from = 0) => requestJson<ScriptOutputResponse>(scriptOutputPath(wsId(), id, from)),
  stopScript: (id: string) => requestJson<ScriptRun>(scriptStopPath(wsId(), id), { method: "POST" }),
  /** O endereço do arquivo de texto com a saída inteira (sem cores), para o link "Baixar saída". */
  scriptDownloadUrl: (id: string) => scriptDownloadPath(wsId(), id),

  /** Arquivos do workspace (só leitura): raízes, uma página de uma pasta, um arquivo (com `known`, devolve `unchanged` se nada mudou), busca por nome e o endereço do arquivo em si. */
  getFileRoots: () => requestJson<FileRootsResponse>(fileRootsPath(wsId())),
  listFiles: (root: string, path: string, options: { offset?: number; limit?: number; filter?: string } = {}) => requestJson<FileListResponse>(fileListPath(wsId(), root, path, options)),
  readFile: (root: string, path: string, known?: string, edit = false) => requestJson<FileReadResponse>(fileReadPath(wsId(), root, path, known, edit)),
  searchFiles: (root: string, q: string) => requestJson<FileSearchResponse>(fileSearchPath(wsId(), root, q)),
  fileRawUrl: (root: string, path: string, download = false) => fileRawPath(wsId(), root, path, download),
  /** Alterações (só em pasta de trabalho com escrita): salvar, criar, renomear, apagar, contar o que há numa pasta e enviar. */
  writeFile: (body: FileWriteBody) => requestJson<FileWriteResponse>(fileWritePath(wsId()), { method: "PUT", body }),
  createFile: (body: FileCreateBody) => requestJson<FileCreateResponse>(fileCreatePath(wsId()), { method: "POST", body }),
  renameFile: (body: FileRenameBody) => requestJson<FileRenameResponse>(fileRenamePath(wsId()), { method: "POST", body }),
  deleteFile: (body: FileDeleteBody) => requestJson<FileDeleteResponse>(fileDeletePath(wsId()), { method: "POST", body }),
  countFiles: (root: string, path: string) => requestJson<FileCountResponse>(fileCountPath(wsId(), root, path)),
  uploadFile: (root: string, dir: string, file: File, options: { overwrite?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) => uploadFileToFolder(root, dir, file, options),

  /** Biblioteca de mídia do workspace (mais novas primeiro). */
  listMedia: () => requestJson<MediaItem[]>(`${ws()}/media`),
  updateMedia: (id: string, body: UpdateMediaBody) => requestJson<MediaItem>(`${ws()}/media/${segment(id)}`, { method: "PATCH", body }),
  deleteMedia: (id: string) => requestJson<void>(`${ws()}/media/${segment(id)}`, { method: "DELETE" }),
  /** Só leitura: a biblioteca de OUTRO workspace (a tela de Mídia no escopo "Outro workspace" e "Todos"). */
  listMediaOf: (workspaceId: string) => requestJson<MediaItem[]>(`/api/w/${segment(workspaceId)}/media`),
  /** Quadros do workspace (o mexido por último primeiro): quem cria e atualiza são os agentes. */
  listBoards: () => requestJson<Board[]>(`${ws()}${boardsPath}`),
  updateBoard: (id: string, body: UpdateBoardBody) => requestJson<Board>(`${ws()}${boardPath(id)}`, { method: "PATCH", body }),
  deleteBoard: (id: string) => requestJson<void>(`${ws()}${boardPath(id)}`, { method: "DELETE" }),
  /** A página HTML do quadro (texto) e os dados (JSON, qualquer formato). */
  boardPage: (id: string) => requestText(`${ws()}${boardPagePath(id)}`),
  boardData: (id: string) => requestJson<unknown>(`${ws()}${boardDataPath(id)}`),
  /** Link público do quadro: estado, ligar (ou trocar a validade), trocar o token e desligar. */
  getBoardShare: (id: string) => requestJson<BoardShare>(`${ws()}${boardSharePath(id)}`),
  setBoardShare: (id: string, body: SetBoardShareBody) => requestJson<BoardShare>(`${ws()}${boardSharePath(id)}`, { method: "PUT", body }),
  rotateBoardShare: (id: string) => requestJson<BoardShare>(`${ws()}${boardShareRotatePath(id)}`, { method: "POST" }),
  deleteBoardShare: (id: string) => requestJson<void>(`${ws()}${boardSharePath(id)}`, { method: "DELETE" }),
  /** O quadro em PDF, gerado pelo servidor (pode levar alguns segundos). */
  downloadBoardPdf: (id: string) => requestBlob(`${ws()}${boardExportPath(id, "pdf")}`),
  /** Espaço em disco do workspace e das pastas de trabalho (responde na hora; mede em segundo plano). */
  storageOf: (workspaceId: string) => requestJson<StorageResponse>(`/api/w/${segment(workspaceId)}/storage`),
  refreshStorageOf: (workspaceId: string) => requestJson<StorageResponse>(`/api/w/${segment(workspaceId)}/storage/refresh`, { method: "POST" }),
  /** Os agentes de outro workspace (id e nome), para dizer quem fez cada mídia dele. */
  agentNamesOf: async (workspaceId: string) => (await requestJson<{ agents: Pick<Agent, "id" | "name" | "avatar">[] }>(`/api/w/${segment(workspaceId)}/office`)).agents,
  /** Pastas da biblioteca (caminhos como "Livros/Matemática"; uma pasta vazia também existe). */
  listMediaFolders: async () => (await requestJson<MediaFoldersResponse>(`${ws()}/media/folders`)).folders,
  createMediaFolder: (body: CreateMediaFolderBody) => requestJson<{ folders: string[]; folder: string }>(`${ws()}/media/folders`, { method: "POST", body }),
  renameMediaFolder: (body: RenameMediaFolderBody) => requestJson<{ folders: string[]; folder: string }>(`${ws()}/media/folders`, { method: "PATCH", body }),
  /** Os itens e as subpastas sobem para a pasta de cima; nenhum arquivo é apagado. */
  deleteMediaFolder: (folder: string) => requestJson<{ folders: string[]; folder: string }>(`${ws()}/media/folders?path=${segment(folder)}`, { method: "DELETE" }),
  moveMedia: (body: MoveMediaBody) => requestJson<{ items: MediaItem[]; folders: string[] }>(`${ws()}/media/move`, { method: "POST", body }),
  /** Copia a mídia de outro workspace para o atual. */
  bringMedia: (body: BringMediaBody) => requestJson<MediaItem>(`${ws()}/media/bring`, { method: "POST", body }),
};

/** Endereço do arquivo de uma mídia (aceita Range: o <video> consegue pular); `download` força o download. */
export function mediaFileUrl(workspaceId: string, mediaId: string, download = false): string {
  return `/api/w/${segment(workspaceId)}/media/${segment(mediaId)}/file${download ? "?download=1" : ""}`;
}

/**
 * Envia um arquivo para a biblioteca: o File vai cru no corpo (sem base64), com o mime dele no
 * Content-Type. Usa XMLHttpRequest só para ter o progresso do envio (o fetch não tem).
 */
export function uploadMedia(file: File, options: { onProgress?: (fraction: number) => void; folder?: string } = {}): Promise<MediaItem> {
  return new Promise((resolve, reject) => {
    let url: string;
    try {
      url = `${ws()}/media?fileName=${segment(file.name)}${options.folder ? `&folder=${segment(options.folder)}` : ""}`;
    } catch (error) {
      reject(error);
      return;
    }
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    request.setRequestHeader("accept", "application/json");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    request.onerror = () => reject(new TypeError("Falha de rede"));
    request.onload = () => {
      let body: unknown;
      try {
        body = request.responseText ? JSON.parse(request.responseText) : undefined;
      } catch {
        body = undefined;
      }
      if (request.status >= 200 && request.status < 300) resolve(body as MediaItem);
      else {
        if (request.status === 401) useAuthStore.getState().expire();
        reject(new ApiRequestError(request.status, (body as ApiErrorBody | undefined)?.error ?? `Erro HTTP ${request.status}`));
      }
    };
    request.send(file);
  });
}

/**
 * Envia um arquivo para uma pasta da página "Arquivos": o File vai cru no corpo. XMLHttpRequest só para ter o
 * progresso; `signal` cancela o envio (rejeita com AbortError).
 */
function uploadFileToFolder(root: string, dir: string, file: File, options: { overwrite?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<FileWriteResponse> {
  return new Promise((resolve, reject) => {
    let url: string;
    try {
      url = fileUploadPath(wsId(), root, dir, file.name, options.overwrite === true);
    } catch (error) {
      reject(error);
      return;
    }
    if (options.signal?.aborted) {
      reject(new DOMException("Envio cancelado", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("accept", "application/json");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    request.onerror = () => reject(new TypeError("Falha de rede"));
    request.onabort = () => reject(new DOMException("Envio cancelado", "AbortError"));
    options.signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.onload = () => {
      let body: unknown;
      try {
        body = request.responseText ? JSON.parse(request.responseText) : undefined;
      } catch {
        body = undefined;
      }
      if (request.status >= 200 && request.status < 300) resolve(body as FileWriteResponse);
      else {
        if (request.status === 401) useAuthStore.getState().expire();
        reject(new ApiRequestError(request.status, (body as ApiErrorBody | undefined)?.error ?? `Erro HTTP ${request.status}`));
      }
    };
    request.send(file);
  });
}

/** Endereço do ícone próprio de um conector (`version` muda a cada envio: o navegador não usa o velho). */
export function connectorIconUrl(workspaceId: string, connectorId: string, version: number): string {
  return `/api/w/${segment(workspaceId)}/connectors/${segment(connectorId)}/icon?v=${version}`;
}

/** Ícone próprio de um conector da Biblioteca. */
export function libraryConnectorIconUrl(connectorId: string, version: number): string {
  return `/api/library/connectors/${segment(connectorId)}/icon?v=${version}`;
}

/** Mensagem curta em pt-BR para mostrar na UI. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const detail = error.details[0];
    if (detail) return `${error.message}: ${detail.path ? `${detail.path}: ` : ""}${detail.message}`;
    if (error.status >= 500) return "O servidor teve um problema. Tente de novo.";
    return error.message;
  }
  if (error instanceof TypeError) return "Não foi possível falar com o servidor.";
  return error instanceof Error ? error.message : String(error);
}
