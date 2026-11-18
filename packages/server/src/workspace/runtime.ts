import {
  ACTIVITY_USER,
  agentEngine,
  DAY_MS,
  dispatchSettings,
  METRICS_MEDIAN_DAYS,
  MODEL_SAVING_DAYS,
  gestaoSettings,
  taskRankInput,
  workRank,
  type ReportKind,
  type DispatchSettings,
  type MetricsReport,
  type UsageRecord,
  type ModelSaving,
  expandAvulsas,
  findMaestroAgent,
  freebuffHoldsHour,
  freebuffMinutesLeft,
  isMaestroTask,
  findMaestroRoom,
  isActiveTaskStatus,
  isCliEngine,
  type CalendarEvent,
  type EngineInfo,
  type ForYouItem,
  type ForYouTypeDef,
  type ModelChoice,
  type MaestroSettings,
  type ModelDefaults,
  type Plan,
  type Task,
  type TaskProgressInfo,
  type Workspace,
  maestroKeepAlive,
  maestroSessionName,
  AGENT_USAGE_MAX_AGE_MS,
  type MediaItem,
  type RoutinesData,
  type TrackedItem,
  emptyRoutinesData,
  type SubscriptionUsage,
  type Agent,
  isMaestroAgent,
  effectiveAccess,
  effectiveFolders,
  workspaceAccess,
  type WorkspaceAccess,
  type WorkspaceAccessInput,
  type WorkFolder,
  type TodayView,
  type DayStats,
  workDayStart,
  DEFAULT_USD_BRL,
  dayKeyOf,
} from "@cyno/shared";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { AgentLogService } from "./agent-log/service";
import { Brain } from "./brain/brain";
import { BrowserService, type BrowserLauncher } from "./browser/service";
import { UrlPolicy } from "./browser/url-policy";
import { BrainAccess } from "./brain/access";
import { AgentRules } from "./brain/agent-rules";
import { AgentDiary } from "./brain/diary";
import { CalendarService } from "./calendar/calendar-service";
import { ConnectorsService } from "../library/connectors/service";
import { SkillsService } from "../library/skills/service";
import type { LibraryService } from "../library/library-service";
import { DEFAULT_HUB_JOURNAL, EventHub, type HubJournalOptions } from "../platform/events/hub";
import { ForYouService } from "./for-you/service";
import { ForYouTypesService, migrateForYouTypes } from "./for-you/types-service";
import { CliMaestro } from "./maestro/cli-maestro";
import type { ModelDefaultsStore } from "../platform/models/defaults-store";
import { MaestroCoordinator, type MaestroTimings } from "../sim/coordinator";
import { delegationTypeNote, mentionedForYouType } from "../mcp/approval-type-tool";
import { officeToolsFor, type OfficeToolsDeps } from "../mcp/office-tools";
import type { AgendaService } from "../platform/agenda/agenda-service";
import type { MuralService } from "../platform/mural/mural-service";
import type { McpTool } from "../mcp/protocol";
import type { McpTokens } from "../mcp/tokens";
import { CardSummaryStore } from "./card/summary-store";
import { createServices, type Services } from "./office";
import { ensureMaestro, type MaestroProfile } from "./office/maestro";
import { Orchestrator } from "./office/orchestrator";
import { MediaService } from "./media/media-service";
import { BoardService } from "./board/board-service";
import { proposalText, RoutineService } from "./routines/routine-service";
import { RoutineItemsStore } from "./routines/routine-items";
import { MetaTracker } from "./routines/meta-tracker";
import { RoutineTracking } from "./routines/tracking";
import { RoutineRunner } from "./routines/routine-runner";
import { buildRoutinesToday } from "./routines/today";
import { buildOverview } from "./routines/overview";
import { buildToday } from "./today/today";
import { DayStatsService } from "./day-stats/service";
import { computeMetrics, deliveriesOf, type MetricsSnapshot } from "./metrics/compute";
import { BrainOrganizeService } from "./brain/organize";
import { RetroService } from "./retro/service";
import { RetroStore } from "./retro/store";
import { ReportScheduler } from "./reports/scheduler";
import { ReportService } from "./reports/service";
import { ReportStore } from "./reports/store";
import { modelSaving } from "./metrics/saving";
import { dayStatsDir, StateClock } from "./day-stats/state-clock";
import { timelineDir } from "./timeline/recorder";
import { TimelineService } from "./timeline/service";
import { SceneLiveService, sceneLiveEnabled, sceneLiveIdleMs } from "./scene-live/service";
import { currentStates } from "./day-stats/states";
import { RoutineScheduler } from "./routines/scheduler";
import { SLOT_TICK_MS, SlotClock } from "./routines/slot-clock";
import { routeTask } from "./office/routing";
import { ProjectService, type ProjectServiceDeps } from "./projects/project-service";
import type { AgentRunner } from "../engines/runner/types";
import { StateManager } from "../store/state-manager";
import { taskCostsOf } from "./activity/cost";
import { activeActivity } from "./activity/log";
import { HttpError } from "../platform/http/errors";
import { observeWorkspaceActivity, type ActivityObserver } from "./activity/recorder";
import { DataCleanup } from "../store/cleanup";
import { readCalendarFile, readForYouTypesFile, readMediaFile, readRoutinesFile } from "../store/files";
import { OfficeStore } from "../store/office-store";
import { AvulsasArchive } from "../store/avulsas-archive";
import { AgentChat } from "../engines/terminals/agent-chat";
import { CliAgentRunner, EngineRunner } from "../engines/terminals/cli-runner";
import { TerminalManager, type TerminalsConfig } from "../engines/terminals/manager";
import type { TerminalEvent } from "../engines/terminals/types";
import type { EngineAvailability } from "../engines/usage/availability";
import type { SubscriptionUsageTracker } from "../engines/usage/subscription-usage";
import { UsageHistory, usageDir } from "../engines/usage/usage-history";

/** O que todos os workspaces compartilham (o runner não guarda estado entre tarefas). */
/** O que um workspace pede à plataforma (o Cyno): `ask_cyno`. Joga erro com o motivo quando um limite barra. */
export type PlatformLink = {
  ask(workspaceId: string, input: { question: string; context?: string; requestId?: string }): string;
};

export type RuntimeOptions = {
  /** Runner simulado (motor "mock"), SÓ no modo simulado (testes); sem ele, agente sem motor falha a tarefa. Os de CLI vão para o CliAgentRunner do workspace. */
  runner?: AgentRunner;
  /** Terminais de CLI (agentes reais) e os tokens do servidor MCP "office". */
  terminals: TerminalsConfig;
  mcpTokens: McpTokens;
  /** Uso da assinatura das CLIs (um só para o server: é da conta, não do workspace). */
  usage?: SubscriptionUsageTracker;
  /** Motores indisponíveis (cota esgotada ou CLI ausente): agentes deles esperam na fila. */
  availability?: EngineAvailability;
  /** Nome do workspace (vai nas instruções dos agentes de CLI). */
  workspaceName?: (workspaceId: string) => string;
  /** Modelos padrão globais (o WorkspaceManager cria um em memória se não vier). */
  modelDefaults?: ModelDefaultsStore;
  /** Modelos padrão do workspace (agentes novos, create_agent do Maestro e subagentes das CLIs). */
  workspaceModels?: (workspaceId: string) => ModelDefaults | undefined;
  /** Configurações do Maestro do workspace (manter o terminal dele sempre rodando). */
  workspaceMaestro?: (workspaceId: string) => MaestroSettings | undefined;
  /** Paralelismo da distribuição dos planos do workspace (ausente = os padrões). */
  workspaceDispatch?: (workspaceId: string) => Workspace["dispatch"];
  /** Cerimônias da Gestão do workspace (horário do resumo do dia e da revisão da semana, parágrafo de IA; ausente = os padrões). */
  workspaceGestao?: (workspaceId: string) => Workspace["gestao"];
  /** A semana do workspace foi resolvida (relatório gerado, já existia ou sem movimento): a plataforma soma quando todos resolvem. */
  reportsWeekSettled?: (workspaceId: string, period: string) => void;
  /** Tempos do aviso de "tarefa parada" dos planos (testes). */
  plans?: Pick<ProjectServiceDeps, "stallMs" | "stepMaxMs" | "checkEveryMs">;
  /** Motores detectados (o catálogo do GET /api/engines): o create_agent do Maestro só aceita motor real disponível. */
  engines?: () => Promise<EngineInfo[]>;
  doneLingerMs: number;
  /** Dias que uma aprovação decidida fica na lista viva antes de ir para o arquivo (0 = nunca). Vem das configurações da plataforma; ausente = 7. */
  approvalsLiveDays?: () => number;
  /** Quanto uma tarefa que espera o usuário segura a vaga do agente antes de soltá-la (ausente = 2 min). */
  approvalParkMs?: number;
  /** Quanto o Maestro leva na triagem e na revisão. */
  maestro: MaestroTimings;
  /** Política de acesso dos agentes do workspace (internet, navegador, rede local, domínios…). */
  workspaceAccess?: (workspaceId: string) => WorkspaceAccessInput | undefined;
  /** Pastas de trabalho do workspace (veja folders.ts em shared). */
  workspaceFolders?: (workspaceId: string) => readonly WorkFolder[] | undefined;
  /** Navegador compartilhado (Chromium com perfil por workspace). Ausente = ligado com os padrões. */
  browser?: BrowserConfig;
  /** Intervalo do vigia das rotinas em ms (padrão ROUTINE_TICK_MS = 10 min; só os testes e o app de teste mudam). */
  routineTickMs?: number;
  /** A Biblioteca da plataforma (conectores e, depois, skills e apps): cada workspace enxerga o que foi liberado a ele. */
  library: LibraryService;
  /** Histórico de eventos da reconexão (padrão: DEFAULT_HUB_JOURNAL). */
  eventJournal?: HubJournalOptions;
  /** A ponte para o Cyno (o `ask_cyno` do Maestro); só existe depois que o Cyno abre, por isso é uma função. */
  platformLink?: () => PlatformLink | undefined;
  /** "Sua agenda" (a do dono, única para a plataforma): as ferramentas `agenda_*` dos agentes deste workspace usam ela. */
  agenda?: AgendaService;
  /** O mural da plataforma: as ferramentas `mural_*` dos agentes e o aviso de novidades ao Maestro. */
  mural?: MuralService;
  now: () => Date;
  log: FastifyBaseLogger;
};

/** Navegador compartilhado: ligado, ociosidade, domínios sempre bloqueados e (testes) a rede local e o launcher. */
export type BrowserConfig = {
  enabled?: boolean;
  /** Fecha o Chromium depois de tanto tempo sem uso (padrão: 10 min). */
  idleMs?: number;
  blockedHosts?: readonly string[];
  /** SÓ NOS TESTES: libera endereços locais (a página de teste roda em 127.0.0.1). */
  allowPrivateNetwork?: boolean;
  launch?: BrowserLauncher;
};

/** Ociosidade padrão do navegador compartilhado. */
export const BROWSER_IDLE_MS = 10 * 60_000;

/** De quanto em quanto tempo a lista viva das aprovações é varrida (o que passou do prazo vai para o arquivo). */
const APPROVALS_SWEEP_MS = 60 * 60_000;

/** Quanto esperar, depois de uma tarefa concluída, para o último turno gravar o gasto antes de somar o custo na Atividade. */
const TURN_COST_WAIT_MS = 10_000;

/**
 * Tudo de um workspace em memória: store (office.json/tasks.json/for-you.json), hub de eventos próprio
 * (só os sockets desse workspace o escutam), Cérebros, orquestrador com a sua fila, o Maestro
 * (triagem e delegação), os serviços das rotas e o calendário (calendar.json, gravado pela mesma
 * fila do store) e o log de trabalho dos agentes. Nada aqui enxerga outro workspace.
 */
export class WorkspaceRuntime {
  /** Eventos do workspace, numerados e com histórico (o WebSocket reenvia o que um cliente perdeu). */
  readonly hub: EventHub;
  readonly state: StateManager;
  readonly brain: Brain;
  /** Ferramentas do Cérebro dos agentes (buscar/ler/salvar com as regras de visibilidade). */
  readonly brainAccess: BrainAccess;
  /** Regras de cada agente (`agents/<id>/regras.md`): só ele as recebe, em toda tarefa. */
  readonly agentRules: AgentRules;
  readonly orchestrator: Orchestrator;
  readonly maestro: MaestroCoordinator;
  /** Itens do "Para você" (for-you.json): os pedidos de aprovação dos agentes. */
  readonly forYou: ForYouService;
  /** Tipos do "Para você" (for-you-types.json): criados pelo Maestro, pelos agentes ou pelo usuário. */
  readonly forYouTypes: ForYouTypesService;
  readonly services: Services;
  readonly calendar: CalendarService;
  /** Rotinas e metas (routines.json): livro-razão, provas de execução e o vigia de 10 em 10 minutos. */
  readonly routines: RoutineService;
  private readonly routineScheduler: RoutineScheduler;
  private readonly meta: MetaTracker;
  /** Relógio dos horários das rotinas (cada horário vence e vai direto para o agente dele). */
  private readonly slotClock: SlotClock;
  /** Relatórios da Gestão (resumo do dia, revisão da semana e mensal), congelados em `reports/`. */
  readonly reports: ReportService;
  /** A retrospectiva: padrões das recusas, edições e falhas, e as regras que o dono aprova um a um (`reports/retro/`). */
  readonly retro: RetroService;
  /** "Organizar o Cérebro": o Maestro propõe, o dono aprova e o servidor aplica (`brain/organize.ts`). */
  readonly brainOrganize: BrainOrganizeService;
  private readonly reportClock: ReportScheduler;
  /** Executa um horário de rotina (o relógio e o botão "Rodar agora" usam o mesmo). */
  readonly routineRunner: RoutineRunner;
  /** Itens acompanhados das rotinas (routines/<id>/items.json). */
  readonly routineItems: RoutineItemsStore;
  /** Itens acompanhados em memória, a vida deles e as mudanças de cada execução (R2). */
  readonly tracking: RoutineTracking;
  /** A frase "o que este workspace faz" da ficha (card.json); o resto da ficha é calculado (platform/cards). */
  cardSummary!: CardSummaryStore;
  /** Biblioteca de mídia (media/media.json + media/files/): imagens, vídeos e arquivos dos agentes e do usuário. */
  readonly media: MediaService;
  /** Quadros (boards/): páginas e dados que os agentes montam para o dono olhar (veja board-service.ts). */
  readonly boards: BoardService;
  /** Log de trabalho dos agentes (logs/<taskId>.jsonl, gravado pela mesma fila do store). */
  readonly agentLog: AgentLogService;
  /** Histórico de gastos para sempre (usage/YYYY-MM.jsonl): um registro por turno dos agentes de CLI. */
  readonly usageHistory: UsageHistory;
  /** Terminais de CLI dos agentes reais (um processo de vida longa por agente com motor de CLI). */
  readonly terminals: TerminalManager;
  /** Relógio de estados da diária ("Meu dia"): trechos por estado em baldes de 1 hora (day-stats/AAAA-MM-DD.json). */
  readonly stateClock: StateClock;
  /** O "Rever o dia": grava o que a cena desenha (retrato de 5 em 5 min mais as mudanças) e lê o dia gravado. */
  readonly timeline: TimelineService;
  /** A cena ao vivo (CYNO_SCENE_LIVE=1; senão ausente): o servidor roda a simulação do Escritório enquanto alguém assiste. */
  readonly sceneLive: SceneLiveService | undefined;
  /** Agentes de time com motor de CLI (as ferramentas MCP `submit_result` & cia mexem aqui). */
  readonly cliRunner: CliAgentRunner;
  /** Conversa direta do usuário com um agente de time (nota na tarefa ou conversa numa sessão própria). */
  readonly agentChat: AgentChat;
  /** Maestro com motor de CLI (pedidos vão para a sessão dele em vez da triagem). */
  readonly cliMaestro: CliMaestro;
  /** Planos dos pedidos (plans.json) e a distribuição das tarefas deles. */
  readonly plans: ProjectService;
  /** Apaga do disco o que era de coisas removidas (e as sobras, ao abrir). */
  readonly cleanup: DataCleanup;
  /** Conectores (servidores MCP externos) e o gateway que os mostra aos agentes ligados a eles. */
  readonly connectors: ConnectorsService;
  /** As skills da Biblioteca liberadas a este workspace (entrega aos agentes, cópia na pasta deles, índice no prompt). */
  readonly skills: SkillsService;
  private readonly detachLibrary: () => void;
  private readonly platformLibrary: LibraryService;
  private readonly skillReadLog: Pick<FastifyBaseLogger, "warn">;
  private readonly workspaceLabel: () => string;
  /** Navegador compartilhado (undefined = desligado no server). */
  readonly browser: BrowserService | undefined;
  /** Política de acesso dos agentes (com os padrões aplicados; lida a cada uso). */
  readonly access: () => WorkspaceAccess;
  /** Pastas de trabalho do workspace (os agentes leem delas os arquivos de dados dos Quadros). */
  private readonly workFolders: () => readonly WorkFolder[];
  private readonly simulated: boolean;
  private readonly engines: (() => Promise<EngineInfo[]>) | undefined;
  /** Uso da assinatura e disponibilidade dos motores (o get_usage do Maestro). */
  private stopping = false;
  /** Varredura do arquivo das aprovações: a cada hora (veja `startApprovalsSweep`). */
  private approvalsTimer: NodeJS.Timeout | undefined;
  private readonly log: FastifyBaseLogger;
  private readonly usageInfo: Pick<RuntimeOptions, "usage" | "availability" | "now">;
  /** O limite de trabalho em paralelo de agora (as Configurações podem mudar, por isso é uma leitura). */
  private readonly dispatchNow: () => DispatchSettings;
  private readonly platformLink: RuntimeOptions["platformLink"];
  private readonly agendaDeps: OfficeToolsDeps["agenda"];
  private readonly muralDeps: OfficeToolsDeps["mural"];
  /** Modelos padrão deste workspace (agentes novos e subagentes). */
  readonly models: () => ModelDefaults | undefined;
  private readonly unsubscribeTerminals: () => void;
  /** Atividade: observador do barramento e empurrão ao vivo das entradas novas (só com a Atividade ligada). */
  private readonly activityObserver: ActivityObserver | undefined;
  private readonly unsubscribeActivity: (() => void) | undefined;
  /** Esperas do custo de uma tarefa concluída (o último turno grava o gasto um pouco depois): o desligamento as solta. */
  private readonly costWaits = new Set<() => void>();
  private readonly unsubscribeAvailability: () => void;
  /** Terminais parando (agente removido): a limpeza da pasta espera o processo sair. */
  private readonly disposals = new Map<string, Promise<void>>();

  private constructor(
    readonly id: string,
    readonly store: OfficeStore,
    calendarItems: CalendarEvent[],
    forYouTypes: ForYouTypeDef[],
    options: RuntimeOptions,
    plans: Plan[] = [],
    routinesData?: RoutinesData,
    mediaItems: MediaItem[] = [],
    trackedItems: { items: ReadonlyMap<string, TrackedItem[]>; unavailable: ReadonlySet<string> } = { items: new Map(), unavailable: new Set() },
  ) {
    this.hub = new EventHub({ journal: options.eventJournal ?? DEFAULT_HUB_JOURNAL });
    this.state = new StateManager(store, this.hub);
    this.engines = options.engines;
    this.simulated = options.runner !== undefined;
    this.usageInfo = { usage: options.usage, availability: options.availability, now: options.now };
    this.dispatchNow = () => dispatchSettings(options.workspaceDispatch?.(id));
    this.agendaDeps = options.agenda ? { service: options.agenda, workspaceId: id, now: options.now, ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}) } : undefined;
    this.muralDeps = options.mural ? { service: options.mural, workspaceId: id, workspaceName: (workspaceId) => options.workspaceName?.(workspaceId) } : undefined;
    this.models = () => options.workspaceModels?.(id);
    this.platformLink = options.platformLink;
    this.agentRules = new AgentRules((agentId) => store.paths.agentDir(agentId), options.now);
    this.brain = new Brain({ paths: store.paths, rooms: () => store.snapshot().rooms, readAgentRules: async (agentId) => (await this.agentRules.read(agentId)).content, now: options.now });
    this.brainAccess = new BrainAccess({ brain: this.brain, rooms: () => store.snapshot().rooms, now: options.now, agentRules: this.agentRules, agents: () => store.snapshot().agents });
    const log = options.log.child({ workspace: id });
    this.log = log;
    this.agentLog = new AgentLogService({
      paths: store.paths,
      queue: store.queue,
      publish: (event) => this.state.publish(event),
      tasks: () => store.snapshot().tasks,
      log,
      now: options.now,
    });
    this.usageHistory = new UsageHistory({
      dir: usageDir(store.paths.root),
      queue: store.queue,
      agents: () => store.snapshot().agents,
      tasks: () => store.snapshot().tasks,
      log,
      now: options.now,
    });
    this.terminals = new TerminalManager({
      workspaceId: id,
      workspaceName: () => options.workspaceName?.(id) ?? id,
      approvalTypes: () => this.forYouTypes.list().map((type) => ({ id: type.id, name: type.name })),
      paths: store.paths,
      state: this.state,
      publish: (event) => this.state.publish(event),
      tokens: options.mcpTokens,
      usage: options.usage,
      subagentDefaults: () => options.workspaceModels?.(id)?.subagentes,
      maestroKeepAlive: () => maestroKeepAlive(options.workspaceMaestro?.(id)),
      maestroSessionName: () => maestroSessionName(options.workspaceMaestro?.(id), options.workspaceName?.(id) ?? id),
      access: () => workspaceAccess(options.workspaceAccess?.(id)),
      folders: () => options.workspaceFolders?.(id) ?? [],
      browserFor: (agent) => this.browser !== undefined && effectiveAccess(this.access(), agent).browser,
      skillsFor: (agentId) => this.skills.forAgent(agentId),
      onTerminalEvent: (agentId, provider, event) => {
        this.usageHistory.observe(agentId, provider, event);
        this.noteSkillRead(agentId, event);
      },
      config: options.terminals,
      log,
      now: options.now,
    });
    // "Por agente" do uso: recarrega as últimas 24 h do histórico em disco (reiniciar não zera; bate com Gastos).
    void this.usageHistory
      .read(options.now().getTime() - AGENT_USAGE_MAX_AGE_MS)
      .then((records) => this.terminals.agentUsage.seed(records))
      .catch((error: unknown) => log.warn({ err: error }, "não foi possível recarregar o uso por agente do histórico"));
    this.media = new MediaService(mediaItems, {
      dir: store.paths.mediaDir,
      file: store.paths.mediaFile,
      filesDir: store.paths.mediaFilesDir,
      queue: store.queue,
      publish: (event) => this.state.publish(event),
      log,
      now: options.now,
    });
    this.boards = new BoardService({
      dir: store.paths.boardsDir,
      file: store.paths.boardsFile,
      boardDir: store.paths.boardDir,
      queue: store.queue,
      publish: (event) => this.state.publish(event),
      log,
      now: options.now,
    });
    this.cliRunner = new CliAgentRunner(this.terminals);
    // Tarefa que acaba com o cartão ainda pendente: o cartão não fica órfão (aprovar depois não faria nada).
    this.cliRunner.onApprovalAbandoned = (_agentId, taskId) => {
      // Desligando o server: o cartão pendente sobrevive ao reinício (a tarefa retoma na decisão).
      if (this.stopping) return;
      // Vaga solta pelo tempo de espera (`park`): o agente saiu, mas a tarefa e os cartões continuam esperando o usuário.
      if (this.orchestrator.isParked(taskId)) return;
      void this.forYou
        .cancelAllFor(new Set([taskId]), { by: "agente", reason: "A tarefa terminou antes da decisão" })
        .catch((error: unknown) => log.warn({ err: error, taskId }, "não foi possível fechar o cartão da tarefa encerrada"));
    };
    this.access = () => workspaceAccess(options.workspaceAccess?.(id));
    this.workFolders = () => options.workspaceFolders?.(id) ?? [];
    this.browser =
      options.browser?.enabled === false
        ? undefined
        : new BrowserService({
            profileDir: path.join(store.paths.root, "browser", "profile"),
            workspaceId: id,
            policy: new UrlPolicy({ access: () => this.access(), blockedHosts: options.browser?.blockedHosts, allowPrivateNetwork: options.browser?.allowPrivateNetwork }),
            idleMs: options.browser?.idleMs ?? BROWSER_IDLE_MS,
            approvalsRequired: () => this.access().approveSensitiveActions,
            ownerName: (owner) => this.state.read().agents.find((agent) => agent.id === owner)?.name ?? owner,
            publish: (event) => this.state.publish(event),
            // Rotina "sem OK": o clique só passa se a tarefa que o agente roda é de uma rotina que o usuário liberou.
            routineGrant: (owner, host, label, kind) => this.routines.grant(this.runningTask(owner)?.routineId, host, label, kind),
            // Modo Automático: o clique passa se a tarefa é de um projeto em Automático cujo tipo de ação e site estão liberados.
            autoGrant: (owner, host, _label, kind) => {
              const task = this.runningTask(owner);
              if (kind !== "click" || !task?.work) return null;
              // O tipo da tarefa do projeto; na tarefa avulsa, o `approval_type` que o Maestro pôs no pedido do agente.
              const type = this.plans.typeOf(task) ?? mentionedForYouType(this.forYouTypes.list(), task.prompt);
              if (!type) return null;
              const verdict = this.plans.autoReserve(task, { type, host });
              return verdict.ok ? { allowed: true, projectId: verdict.projectId, usage: verdict.label } : null;
            },
            onExecuted: (event) => {
              const task = this.runningTask(event.owner);
              activeActivity()?.record({
                workspaceId: id,
                category: "publicacao",
                action: "executada",
                actor: event.owner,
                summary: `${this.state.read().agents.find((agent) => agent.id === event.owner)?.name ?? event.owner} executou “${event.label}” em ${event.host}${event.usage ? ` sozinho (Automático · ${event.usage})` : ""}`,
                refs: { ...(task ? { taskId: task.id } : {}), ...(task?.work && event.via === "automatico" ? { planId: task.work.projectId } : {}), ...(event.routineId ?? task?.routineId ? { routineId: event.routineId ?? task?.routineId } : {}), ...(event.url ? { url: event.url } : {}) },
                data: { host: event.host, label: event.label, actionKind: event.actionKind, via: event.via, ...(event.usage ? { usage: event.usage } : {}) },
              });
              // A prova de execução das rotinas só conta o que passou por elas (o Automático tem a linha própria na Atividade).
              if (event.via !== "automatico") this.routines.noteExecution({ ...(event.routineId ?? task?.routineId ? { routineId: event.routineId ?? task?.routineId } : {}), host: event.host, label: event.label, actionKind: event.actionKind, ...(task ? { taskId: task.id } : {}), agentId: event.owner, via: event.via });
            },
            now: options.now,
            log,
            ...(options.browser?.launch ? { launch: options.browser.launch } : {}),
          });
    this.agentChat = new AgentChat({ state: this.state, terminals: this.terminals, runner: this.cliRunner, agentLog: this.agentLog, log, now: options.now, simulated: options.runner !== undefined, publish: (event) => this.hub.publish(event) });
    // Nota que chegou depois da entrega: vira conversa com o agente (não se perde nem entra na próxima tarefa).
    this.cliRunner.onLateNotes = (agentId, taskId, notes) => void this.agentChat.lateNotes(agentId, taskId, notes);
    this.platformLibrary = options.library;
    this.skillReadLog = log;
    this.workspaceLabel = () => options.workspaceName?.(id) ?? id;
    this.detachLibrary = options.library.attach(id, {
      name: () => options.workspaceName?.(id) ?? id,
      agents: () => {
        const state = this.state.read();
        return state.agents.map((agent) => ({ id: agent.id, name: agent.name, avatar: agent.avatar, maestro: isMaestroAgent(state, agent) }));
      },
      publish: (event) => this.state.publish(event),
      skillsChanged: () => this.skills.changed(),
      // Ferramentas de apps (conector `app`): rodam na pasta do agente e a saída vai para a Mídia deste workspace.
      appRun: { agentDir: (agentId) => store.paths.agentDir(agentId), currentTask: (agentId) => this.runningTask(agentId), media: this.media },
    });
    this.skills = new SkillsService(options.library, {
      workspaceId: id,
      agents: () => this.state.read().agents,
      terminal: (agentId) => this.terminals.find(agentId),
      agentDir: (agentId) => store.paths.agentDir(agentId),
      log,
    });
    this.connectors = new ConnectorsService(options.library, {
      workspaceId: id,
      agents: () => this.state.read().agents,
      terminal: (agentId) => this.terminals.find(agentId),
      claudeList: { command: options.terminals.claude.command ?? "claude", prefixArgs: options.terminals.claude.prefixArgs },
      log,
    });
    this.forYouTypes = new ForYouTypesService(forYouTypes, {
      file: store.paths.forYouTypesFile,
      queue: store.queue,
      state: this.state,
      log,
      now: options.now,
    });
    this.forYou = new ForYouService({
      state: this.state,
      log,
      now: options.now,
      // O prazo da lista viva é configuração da plataforma (Configurações > Histórico); o getter é lido a cada varredura.
      ...(options.approvalsLiveDays ? { liveDays: options.approvalsLiveDays } : {}),
      holdLive: () => this.meta.holdsApproved(),
      types: this.forYouTypes,
      media: { linkForYou: (ids, forYouId) => this.media.linkForYou(ids, forYouId), approve: (ids) => this.media.approve(ids) },
      // Aprovação pedida pelo Maestro de CLI volta para ele; as outras, para o orquestrador.
      decideTask: (taskId, decision) =>
        this.cliMaestro.ownsId(taskId) ? this.cliMaestro.decide(taskId, decision) : this.orchestrator.approve(taskId, decision),
      decidePlan: (item, decision) => this.plans.decideItem(item, decision),
      decideSprint: (item, decision) => this.plans.decideSprintItem(item, decision),
      // Modo Automático: o projeto da tarefa decide sozinho os tipos que o usuário liberou (dentro do teto do dia).
      autoReserve: (task, type) => this.plans.autoReserve(task, { type }),
      // Meta com preparo: o servidor conta (entregue + aprovado) e nunca aprova além do alvo; o resto das opções é dispensado.
      routineMeta: {
        standing: (task) => this.meta.standing(task),
        opened: (task, items) => this.meta.opened(task, items),
        counted: (task, delta) => this.meta.counted(task, delta),
      },
      onAutoDecided: (item, _task, label) => {
        const agent = this.state.read().agents.find((candidate) => candidate.id === item.agentId)?.name ?? item.agentId;
        const typeName = this.forYouTypes.list().find((type) => type.id === item.type)?.name ?? item.type;
        const what = item.where ?? item.title ?? item.why ?? typeName;
        activeActivity()?.record({
          workspaceId: id,
          category: "aprovacao",
          action: "aprovada-automatico",
          actor: item.agentId,
          summary: `${agent} seguiu sozinho com ${typeName.toLowerCase()}: ${what.slice(0, 90)} (Automático · ${label})`,
          refs: { forYouId: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.projectId ? { planId: item.projectId } : {}) },
          data: { type: item.type, decidedBy: "automatico", usage: label },
        });
      },
      onBatchApproved: (items) => {
        const typeName = this.forYouTypes.list().find((type) => type.id === items[0]!.type)?.name ?? items[0]!.type;
        activeActivity()?.record({
          workspaceId: id,
          category: "aprovacao",
          action: "aprovado-em-lote",
          actor: ACTIVITY_USER,
          summary: `Você aprovou ${items.length} ${items.length === 1 ? "item" : "itens"} de ${typeName.toLowerCase()} em lote`,
          data: { type: items[0]!.type, ids: items.map((item) => item.id), batch: true },
        });
      },
      maestroAnswers: (item, answers) => this.cliMaestro.answers(item, answers),
      // Cartão "regra" da retrospectiva: o clique do dono grava a nota no Cérebro (aprovar) ou esconde o padrão por 8 semanas (recusar).
      decideRule: (item, decision) => this.retro.decide(item, decision),
      // Cartão "organizacao": o clique do dono aplica as ações marcadas (nada é apagado: vai para o histórico do Cérebro).
      decideOrganize: (item, decision) => this.brainOrganize.decide(item, decision),
      decideRoutine: async (item, decision) => {
        this.routines.decide(item, decision);
        // "Ajustar" no cartão de rotina: o texto do usuário volta para o Maestro (que propõe de novo).
        const routine = item.routine;
        if (decision.status === "respondido" && decision.response && routine && (routine.mode === "criar" || routine.mode === "alterar")) {
          const text = [
            routine.mode === "criar"
              ? `O usuário pediu ajustes na proposta de rotina ${routine.routineId} (“${routine.title}”), que foi descartada: “${decision.response}”.`
              : `O usuário pediu ajustes na mudança proposta para a rotina ${routine.routineId} (“${routine.title}”): “${decision.response}”.`,
            routine.view ? `A proposta era:\n${proposalText(routine.view)}` : "",
            routine.mode === "criar" ? "Mande a versão corrigida com routine_propose (vira um cartão novo) e termine o turno." : "Mande a mudança corrigida com routine_update_propose e termine o turno.",
          ]
            .filter(Boolean)
            .join("\n\n");
          try {
            this.cliMaestro.converse(text);
          } catch (error) {
            log.warn({ err: error, routineId: routine.routineId }, "não foi possível avisar o Maestro do ajuste da rotina");
          }
        }
      },
      // Item cancelado: os do Maestro de CLI ficam com ele (sem acordá-lo); a tarefa de um agente segue sem a resposta.
      holdsItem: (item) => this.cliMaestro.holdsItem(item.id),
      registerRework: (task, input) => this.plans.registerRework(task, input),
      reworkCount: (task) => this.plans.reworkCount(task),
      release: async (item, cancel, waitingTaskId, decision) => {
        if (item.kind === "rotina") return this.routines.itemCancelled(item);
        const state = this.state.read();
        if (this.cliMaestro.enabled(state) && item.agentId === findMaestroAgent(state)?.id) return this.cliMaestro.itemCancelled(item, cancel);
        if (waitingTaskId) await this.orchestrator.approve(waitingTaskId, decision ?? { approved: true, cancelled: cancel });
      },
    });
    this.orchestrator = new Orchestrator({
      state: this.state,
      brain: this.brain,
      runner: new EngineRunner(options.runner, this.cliRunner),
      approvals: this.forYou,
      agentLog: this.agentLog,
      diary: new AgentDiary((agentId) => store.paths.agentDir(agentId)),
      log,
      doneLingerMs: options.doneLingerMs,
      ...(options.approvalParkMs !== undefined ? { approvalParkMs: options.approvalParkMs } : {}),
      now: options.now,
      availability: (agent) => options.availability?.block(agentEngine(agent), agent.model, { agentId: agent.id, workspaceId: id }),
      // Ordem da fila (workRank) e admissão (pausa, ritmo) vêm do ProjectService, criado logo depois.
      scheduling: {
        rank: (task) => this.plans.rankOf(task),
        admit: (task) => this.plans.admit(task),
        avgTaskMs: () => this.plans.averageTaskMs(),
        onEngineBlock: (task, block, agent) => this.plans.markEngineBlock(task, block, agent.name),
      },
    });
    this.cliMaestro = new CliMaestro({
      state: this.state,
      agentLog: this.agentLog,
      orchestrator: this.orchestrator,
      terminals: this.terminals,
      approvals: this.forYou,
      plans: () => this.plans,
      refreshStatus: () => void this.maestro.refreshAgentStatus(),
      log,
      now: options.now,
      publish: (event) => this.hub.publish(event),
      brain: this.brain,
      availability: (agent) => options.availability?.block(agentEngine(agent), agent.model, { agentId: agent.id, workspaceId: id }),
      engineSession: (agent) => {
        if (agentEngine(agent) !== "freebuff") return undefined;
        const minutesLeft = freebuffMinutesLeft(options.usage?.get("freebuff")?.freebuff, { agentId: agent.id, workspaceId: id }, options.now().getTime());
        return minutesLeft === undefined ? undefined : { minutesLeft };
      },
      agentDefaults: () => options.workspaceModels?.(id)?.agentes,
      access: () => workspaceAccess(options.workspaceAccess?.(id)),
      ...(options.terminals.maestroRotateTokens !== undefined ? { rotateTokens: options.terminals.maestroRotateTokens } : {}),
    });
    // O que há de novo no mural da plataforma entra na próxima mensagem que o Maestro de fato receber (nenhuma chamada só para avisar).
    if (options.mural) {
      const mural = options.mural;
      this.cliMaestro.addMessageExtra(() => mural.takeNews(id));
    }
    // Um motor voltou (cota zerou, uso novo): as filas paradas andam e o Maestro recebe o que esperava.
    this.unsubscribeAvailability =
      options.availability?.onChange(() => {
        this.orchestrator.retryWaiting();
        this.cliMaestro.flushHeld();
        this.plans.pump();
      }) ?? (() => undefined);
    this.maestro = new MaestroCoordinator({
      state: this.state,
      hub: this.hub,
      brain: this.brain,
      agentLog: this.agentLog,
      orchestrator: this.orchestrator,
      decideTask: (taskId, approved) => this.forYou.decideTask(taskId, approved),
      log,
      timings: options.maestro,
      doneLingerMs: options.doneLingerMs,
      now: options.now,
      cli: this.cliMaestro,
      plans: () => this.plans,
      simulated: options.runner !== undefined,
    });
    this.plans = new ProjectService(plans, {
      workspaceId: id,
      state: this.state,
      agentLog: this.agentLog,
      orchestrator: this.orchestrator,
      forYou: this.forYou,
      // O pedido é do Maestro de CLI ou do simulado (o coordenador).
      host: (requestId) => {
        const state = this.state.read();
        const request = state.tasks.find((task) => task.id === requestId);
        if (!request || !isMaestroTask(state, request)) return undefined;
        return this.cliMaestro.owns(state, request) ? this.cliMaestro : this.maestro;
      },
      settings: () => dispatchSettings(options.workspaceDispatch?.(id)),
      availability: (agent) => options.availability?.block(agentEngine(agent), agent.model, { agentId: agent.id, workspaceId: id }),
      holdsHour: (agent) => agentEngine(agent) === "freebuff" && freebuffHoldsHour(options.usage?.get("freebuff")?.freebuff, { agentId: agent.id, workspaceId: id }, options.now().getTime()),
      typeNote: (typeId) => delegationTypeNote(this.forYouTypes.list(), typeId),
      brain: this.brain,
      archive: new AvulsasArchive(store.paths.projectsArchiveDir),
      // Modo Automático das rotinas: o teto do dia é da rotina (soma das execuções), não de cada projeto de execução.
      routineAuto: (routineId, input) => this.routines.autoReserve(routineId, input),
      remapRoutineRuns: (taskIds, projectId) => void this.routines.remapRunProject(taskIds, projectId),
      log,
      now: options.now,
      ...options.plans,
    });
    // Um ouvinte só para os agentes de CLI: agente removido (ou quarto, em cascata) = terminal
    // parado; motor trocado = terminal antigo sai; subtarefas dos pedidos do Maestro de CLI.
    this.unsubscribeTerminals = this.hub.subscribe((event) => {
      if (event.type === "agent:deleted") {
        void this.disposeTerminal(event.id);
        void this.browser?.closeOwner(event.id);
      }
      else if (event.type === "agent:upserted") {
        this.terminals.sync(event.agent);
        // O Maestro virou Claude Code (ou mudou de modelo): o terminal interativo sobe (se for o caso).
        if (event.agent.id === findMaestroAgent(this.state.read())?.id) {
          queueMicrotask(() => {
            this.terminals.refreshMaestro();
            this.cliMaestro.attach();
          });
        }
      }
      else if (event.type === "task:upserted") this.routines.onTaskUpdate(event.task);
      // Diária: o relógio de estados relê o estado das tarefas quando algo que o muda acontece (um ouvinte só, por causa do hub).
      if (event.type === "task:upserted" || event.type === "project:upserted" || event.type === "project:deleted" || event.type === "agent:terminal" || event.type === "agent:deleted") this.stateClock.observe();
      // "Rever o dia": o gravador marca que mudou e guarda o que só o log sabe (o mesmo ouvinte, sem outra assinatura).
      this.timeline.observe(event);
      // Cena ao vivo: o mesmo ouvinte (a ordem não importa); sem ninguém assistindo só guarda o que o log sabe.
      this.sceneLive?.observe(event);
      this.cliMaestro.handleEvent(event);
      this.plans.handleEvent(event);
      this.connectors.handleEvent(event);
      this.skills.handleEvent(event);
    });
    this.calendar = new CalendarService(calendarItems, {
      file: store.paths.calendarFile,
      queue: store.queue,
      hub: this.hub,
      rooms: () => this.state.read().rooms,
      now: options.now,
    });
    this.routines = new RoutineService(routinesData ?? emptyRoutinesData(), {
      workspaceId: id,
      file: store.paths.routinesFile,
      queue: store.queue,
      publish: (event) => this.state.publish(event),
      afterRetry: () => void setTimeout(() => void this.routineScheduler?.tick().catch(() => undefined), 0).unref(),
      owners: {
        agent: (agentId) => this.state.read().agents.find((agent) => agent.id === agentId),
        team: (teamId) => this.state.read().teams.find((team) => team.id === teamId),
      },
      // A proposta vira um cartão "rotina" do Maestro no Para você.
      openCard: (payload) => {
        const state = this.state.read();
        const maestro = findMaestroAgent(state);
        const room = findMaestroRoom(state);
        if (!maestro || !room) return undefined;
        return this.forYou.openSpecial({
          kind: "rotina",
          agentId: maestro.id,
          roomId: room.id,
          title: payload.mode === "criar" ? `Rotina: ${payload.title}` : payload.mode === "alterar" ? `Mudança na rotina “${payload.title}”` : payload.mode === "revisar" ? `Rotina parada: “${payload.title}”` : `Baixar a meta de “${payload.title}”?`,
          why: payload.reason ?? (payload.type === "acompanhamento" ? `Acompanhamento feito por ${payload.owner}` : `${payload.target} ${payload.unit}(s) por ${payload.period === "month" ? "mês" : "semana"} em ${payload.site}, feito por ${payload.owner}`),
          text: payload.instruction || payload.title,
          routine: payload,
        });
      },
      log,
      now: options.now,
    });
    this.meta = new MetaTracker({ routines: this.routines, state: { read: () => this.state.read(), readForYou: () => this.state.readForYou() }, forYou: this.forYou, now: options.now, log });
    this.routineScheduler = new RoutineScheduler({
      routines: this.routines,
      meta: this.meta,
      state: this.state,
      pickAgent: (routine) => this.routineAgent(routine.agentId, routine.teamId),
      blocked: (agent) => options.availability?.block(agentEngine(agent), agent.model, { agentId: agent.id, workspaceId: id }),
      createTask: async (routine, agent, prompt, period) =>
        (await this.plans.startRoutineTask({ routineId: routine.id, routineTitle: routine.title, mode: routine.mode, period, agentId: agent.id, title: `Cobrança ${period}`, prompt })).task,
      wake: (input) => {
        if (!this.cliMaestro.enabled()) return false;
        try {
          this.cliMaestro.openServerRequest({ title: input.title, message: input.message, origin: input.origin });
          return true;
        } catch (error) {
          log.warn({ err: error }, "não foi possível acordar o Maestro para a rotina");
          return false;
        }
      },
      log,
      now: options.now,
      ...(options.routineTickMs ? { everyMs: options.routineTickMs } : {}),
    });
    this.routineItems = new RoutineItemsStore({ fileOf: store.paths.routineItemsFile, queue: store.queue, log });
    this.tracking = new RoutineTracking({ routines: this.routines, store: this.routineItems, initial: trackedItems.items, unavailable: trackedItems.unavailable, publish: (event) => this.state.publish(event), log, now: options.now });
    this.routines.setChangeSource((routineId, taskId) => this.tracking.changesOf(routineId, taskId));
    this.routineRunner = new RoutineRunner({
      routines: this.routines,
      meta: this.meta,
      tracking: this.tracking,
      state: this.state,
      workspaceId: id,
      pickAgent: (routine) => this.routineAgent(routine.agentId, routine.teamId),
      startTask: (input) => this.plans.startRoutineTask(input),
      log,
      now: options.now,
    });
    this.slotClock = new SlotClock({
      routines: this.routines,
      tracking: this.tracking,
      runner: this.routineRunner,
      log,
      now: options.now,
      everyMs: Math.min(options.routineTickMs ?? SLOT_TICK_MS, SLOT_TICK_MS),
    });
    this.reports = new ReportService({
      workspaceId: id,
      workspaceName: () => options.workspaceName?.(id) ?? id,
      store: new ReportStore(store.paths.reportsDir, log),
      now: options.now,
      settings: () => gestaoSettings(options.workspaceGestao?.(id)),
      metrics: (window) => this.metrics(window),
      deliveries: () => deliveriesOf({ projects: this.plans.list(), routines: this.routines.list(), entries: this.routines.entries }),
      results: () => this.routines.results(),
      routineTitle: (routineId) => this.routines.list().find((routine) => routine.id === routineId)?.title ?? routineId,
      // Nomes dos agentes por id e, com o prefixo "tipo:", o nome de cada tipo de aprovação (o relatório mostra "Comentário", não "comentario").
      names: () => Object.fromEntries([...this.state.read().agents.map((agent): [string, string] => [agent.id, agent.name]), ...this.forYouTypes.list().map((type): [string, string] => [`tipo:${type.id}`, type.name])]),
      today: () => this.today(),
      nextTasks: () => this.nextTasksForReport(),
      ai: (input) => this.reportParagraph(input),
      log,
    });
    this.retro = new RetroService({
      workspaceId: id,
      workspaceName: () => options.workspaceName?.(id) ?? id,
      store: new RetroStore(path.join(store.paths.reportsDir, "retro")),
      now: options.now,
      snapshot: async (sinceMs) => {
        const state = this.state.read();
        const types = this.forYouTypes.list();
        return { agents: state.agents, tasks: state.tasks, projects: this.plans.list(), forYou: await this.forYou.listSince(sinceMs), typeName: (type) => types.find((candidate) => candidate.id === type)?.name ?? type };
      },
      forYou: this.forYou,
      brain: this.brain,
      agentRules: this.agentRules,
      roomOfAgent: (agentId) => {
        const state = this.state.read();
        const agent = state.agents.find((candidate) => candidate.id === agentId);
        return state.teams.find((team) => team.id === agent?.teamId)?.roomId;
      },
      roomExists: (roomId) => this.state.read().rooms.some((room) => room.id === roomId),
      maestro: {
        available: () => this.cliMaestro.enabled(),
        model: () => {
          const maestro = findMaestroAgent(this.state.read());
          return maestro?.model ?? this.models()?.maestro.model;
        },
        ask: ({ title, message }) => this.cliMaestro.openServerRequest({ title, origin: "Retrospectiva da Gestão (o dono pediu as regras)", message }),
      },
      subscribe: (listener) => this.hub.subscribe(listener),
      log,
    });
    this.brainOrganize = new BrainOrganizeService({
      brain: this.brain,
      agentRules: this.agentRules,
      agents: () => {
        const state = this.state.read();
        return state.agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, roomId: state.teams.find((team) => team.id === agent.teamId)?.roomId }));
      },
      forYou: this.forYou,
      maestro: {
        available: () => this.cliMaestro.enabled(),
        agentId: () => findMaestroAgent(this.state.read())?.id,
        roomId: () => findMaestroRoom(this.state.read())?.id,
        ask: ({ title, message }) => this.cliMaestro.openServerRequest({ title, origin: "Cérebro (o dono pediu para organizar)", message }),
      },
      subscribe: (listener) => this.hub.subscribe(listener),
      log,
    });
    this.reportClock = new ReportScheduler({
      reports: this.reports,
      retro: this.retro,
      settings: () => options.workspaceGestao?.(id),
      now: options.now,
      log,
      weekSettled: (period) => options.reportsWeekSettled?.(id, period),
    });
    this.cleanup = new DataCleanup({
      paths: store.paths,
      queue: store.queue,
      log,
      // O agent:deleted já mandou parar: espera essa parada (ou para agora, se não houve).
      stopTerminal: (agentId) => this.disposals.get(agentId) ?? this.disposeTerminal(agentId),
      forgetLogs: (taskIds, agentIds) => this.agentLog.forget(taskIds, agentIds),
      removeEngineData: (agentId) => this.terminals.removeEngineData(agentId),
    });
    this.services = createServices({
      state: this.state,
      brain: this.brain,
      orchestrator: this.orchestrator,
      maestro: this.maestro,
      forYou: this.forYou,
      calendar: this.calendar,
      cleanup: this.cleanup,
      now: options.now,
      simulated: options.runner !== undefined,
      agentDefaults: () => this.models()?.agentes,
    });
    // Atividade: o que foi feito neste workspace (tarefas, aprovações, rotinas, mídia, planos, agentes), ao vivo pelo hub.
    const activityLog = activeActivity();
    if (activityLog) {
      this.activityObserver = observeWorkspaceActivity({
        workspaceId: id,
        hub: this.hub,
        snapshot: () => ({
          tasks: store.snapshot().tasks,
          forYou: store.forYouSnapshot(),
          agents: store.snapshot().agents,
          media: this.media.list(),
          plans: this.plans.list(),
          routines: this.routines.list(),
          entries: this.routines.entries,
        }),
        cost: async (task) => {
          // Agente simulado não tem gasto: sem espera.
          const owner = store.snapshot().agents.find((candidate) => candidate.id === task.agentId);
          if (!owner || !isCliEngine(agentEngine(owner))) return undefined;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.costWaits.delete(done);
              resolve();
            };
            const timer = setTimeout(done, TURN_COST_WAIT_MS);
            timer.unref?.();
            this.costWaits.add(done);
          });
          await this.usageHistory.idle();
          return taskCostsOf(await this.usageHistory.read(Date.parse(task.createdAt) - 3_600_000)).get(task.id);
        },
      });
      this.unsubscribeActivity = activityLog.onAppend((entry) => {
        if (entry.workspaceId === id) this.hub.publish({ type: "activity:appended", entry });
      });
    }
    // Diária: o relógio de estados (observa pelo ouvinte do hub acima; a ordem dos eventos não importa: ele relê o estado).
    this.stateClock = new StateClock({
      dir: dayStatsDir(store.paths.root),
      queue: store.queue,
      states: () => currentStates({ tasks: this.state.read().tasks, projects: this.plans.list(), terminals: this.terminals.snapshot() }),
      names: () => ({
        agents: new Map(this.state.read().agents.map((agent) => [agent.id, agent.name])),
        projects: new Map(this.plans.list().map((project) => [project.id, project.title])),
        sprints: new Map(this.plans.list().flatMap((project) => (project.sprints ?? []).map((sprint): [string, string] => [`${project.id}:${sprint.id}`, sprint.name]))),
      }),
      now: () => options.now().getTime(),
      log,
    });
    // Os dados do Cyno de que a cena depende: os mesmos para o gravador da linha do tempo e para a cena ao vivo.
    const sceneSource = () => ({
      office: this.state.read(),
      terminals: this.terminals.snapshot(),
      forYou: this.forYou.list(),
      projects: this.plans.list(),
      progress: this.progressSnapshot(),
      block: (agent: Agent) => options.availability?.block(agentEngine(agent), agent.model, { agentId: agent.id, workspaceId: id }),
    });
    this.timeline = new TimelineService({
      dir: timelineDir(store.paths.root),
      enabled: process.env.CYNO_TIMELINE !== "0",
      source: sceneSource,
      now: () => options.now().getTime(),
      log,
    });
    this.sceneLive = sceneLiveEnabled()
      ? new SceneLiveService({ workspaceId: id, workspaceName: () => options.workspaceName?.(id) ?? id, source: sceneSource, now: () => options.now().getTime(), idleMs: sceneLiveIdleMs(), log })
      : undefined;
  }

  /** Para o terminal do agente e revoga o token; a promessa fica guardada até o processo parar. */
  private disposeTerminal(agentId: string): Promise<void> {
    const running = this.disposals.get(agentId);
    if (running) return running;
    const disposal = this.terminals.dispose(agentId).finally(() => this.disposals.delete(agentId));
    this.disposals.set(agentId, disposal);
    return disposal;
  }

  /**
   * Abre a pasta de dados do workspace (precisa já ter office.json). Workspace sem a Sala do
   * Maestro (novo ou de antes dela existir) ganha a sala, o time "Gerência" e o Maestro.
   */
  static async open(
    id: string,
    dir: string,
    options: RuntimeOptions,
    { maestro, profile }: { maestro?: ModelChoice; profile?: MaestroProfile } = {},
  ): Promise<WorkspaceRuntime> {
    const store = await OfficeStore.open(dir);
    // Tipos do "Para você": sem arquivo (ou com tipo faltando), registra os que valem e grava.
    const types = migrateForYouTypes(await readForYouTypesFile(store.paths.forYouTypesFile), store.forYouSnapshot(), id, options.now().toISOString());
    const plans = store.projectsSnapshot();
    const routinesData = await readRoutinesFile(store.paths.routinesFile);
    const mediaItems = await readMediaFile(store.paths.mediaFile);
    // Itens acompanhados: lidos uma vez; arquivo estragado não é regravado (a rotina fica sem itens até alguém arrumar).
    const itemsStore = new RoutineItemsStore({ fileOf: store.paths.routineItemsFile, queue: store.queue, log: options.log });
    const trackedItems = { items: new Map<string, TrackedItem[]>(), unavailable: new Set<string>() };
    for (const routine of routinesData?.routines ?? []) {
      if (routine.type !== "acompanhamento") continue;
      try {
        trackedItems.items.set(routine.id, await itemsStore.list(routine.id));
      } catch (error) {
        trackedItems.unavailable.add(routine.id);
        options.log.error({ err: error, routineId: routine.id }, "itens da rotina ilegíveis: o arquivo não será regravado");
      }
    }
    const runtime = new WorkspaceRuntime(id, store, await readCalendarFile(store.paths.calendarFile), types.types, options, plans, routinesData, mediaItems, trackedItems);
    await runtime.boards.load();
    if (types.changed) await runtime.forYouTypes.save();
    runtime.cardSummary = await CardSummaryStore.open({ file: store.paths.cardFile, queue: store.queue, now: options.now, log: options.log });
    // Cérebro em camadas: resultados datados vão para historico/ e cada Cérebro ganha os fixos que faltam (move, nunca apaga).
    const migration = await runtime.brain.migrate();
    if (migration.moved.length + migration.created.length > 0) {
      options.log.info({ workspace: id, moved: migration.moved.length, created: migration.created }, "Cérebro migrado para camadas (fixos + notas + histórico)");
    }
    const { rooms, teams, agents, tasks } = runtime.store.snapshot();
    const ensured = ensureMaestro({ office: { rooms, teams, agents }, tasks, takenRoomIds: await runtime.brain.brainIds(), ...(maestro ? { maestro } : {}), ...(profile ? { profile } : {}) });
    if (ensured.changed) {
      await runtime.store.commitOffice(ensured.office);
      const room = findMaestroRoom(ensured.office);
      if (room) await runtime.brain.ensureBrain(room.id);
    }
    // Sobras de quartos, agentes e tarefas que já não existem (ex.: removidos antes da cascata).
    const live = runtime.store.snapshot();
    await runtime.cleanup.removeOrphans({
      roomIds: live.rooms.map((room) => room.id),
      agentIds: live.agents.map((agent) => agent.id),
      taskIds: live.tasks.map((task) => task.id),
    });
    return runtime;
  }

  /**
   * Boot: retoma a fila do orquestrador, cria o item do "Para você" das aprovações antigas que
   * não têm e depois retoma as tarefas do Maestro.
   */
  async resume(): Promise<void> {
    // Ferramentas/subagentes que ficaram "running" no log por causa do restart fecham como interrompidos.
    await this.agentLog.closeInterrupted(this.state.read().tasks.filter((task) => task.status === "in_progress" || task.status === "waiting_approval").map((task) => task.id));
    await this.orchestrator.resume();
    this.forYou.backfill();
    // Aprovações decididas há mais que o prazo saem da lista viva já no boot e depois a cada hora.
    await this.startApprovalsSweep();
    this.maestro.resume();
    this.plans.resume();
    // Diária: abre o relógio de estados (os trechos que estavam abertos antes do reinício não viram tempo).
    this.stateClock.start();
    this.timeline.start();
    // Vigia das rotinas: a primeira passada vem 10 min depois (nada de repor horários perdidos no boot).
    this.routineScheduler.start();
    // Relógio dos horários: já no boot recupera o último horário recente de cada um (até 2 h) e marca os antigos como pulados.
    this.slotClock.start();
    // Relatórios: o horário do resumo do dia e da revisão da semana (só código; nunca acorda o Maestro).
    this.reportClock.start();
    // Maestro no terminal interativo com "manter sempre rodando": sobe já, na mesma conversa (--resume).
    this.terminals.refreshMaestro();
    this.cliMaestro.attach();
    // Horas do Freebuff ainda abertas (o servidor reiniciou): volta na mesma conversa e na mesma hora (--continue).
    this.terminals.resumeHours();
  }

  /** Varredura do arquivo de aprovações agora (boot, a cada hora e quando o prazo muda). Nunca rejeita: a falha vai para o log. */
  sweepApprovals(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    return this.forYou.sweep().catch((error: unknown) => {
      this.log.error({ err: error }, "falha ao arquivar as aprovações antigas");
      return 0;
    });
  }

  /** A primeira varredura roda (e espera) no boot; depois, um timer sem segurar o processo. */
  private async startApprovalsSweep(): Promise<void> {
    if (!this.approvalsTimer) {
      this.approvalsTimer = setInterval(() => void this.sweepApprovals(), APPROVALS_SWEEP_MS);
      this.approvalsTimer.unref();
    }
    await this.sweepApprovals();
  }

  /** Último progresso de cada tarefa ativa (agentes e Maestro), para o office:snapshot. */
  progressSnapshot(): Record<string, TaskProgressInfo> {
    return { ...this.orchestrator.progressSnapshot(), ...this.maestro.progressSnapshot() };
  }

  /**
   * O painel "Hoje" deste workspace (só código, sem IA). `ownerAgenda` junta os compromissos que o dono
   * marcou sem workspace; a plataforma desliga para não repetir em cada bloco.
   */
  today(options: { ownerAgenda?: boolean } = {}): TodayView {
    const now = this.now();
    const start = workDayStart(now.getTime());
    const events = (this.agendaDeps?.service.list({ from: start, to: start + 24 * 3_600_000 }) ?? []).filter((event) => event.workspace === this.id || (event.workspace === undefined && options.ownerAgenda !== false));
    return buildToday({
      workspaceId: this.id,
      ...(this.agendaDeps?.workspaceName ? { workspaceName: this.agendaDeps.workspaceName(this.id) ?? this.id } : {}),
      now,
      state: this.state.read(),
      progress: this.progressSnapshot(),
      // Um pedido simples volta como projeto kind "tarefa" (o Avulsas é só como ele é guardado).
      projects: expandAvulsas(this.plans.list()),
      routines: buildRoutinesToday({ workspaceId: this.id, routines: this.routines, tracking: this.tracking, state: this.state, now, forYou: this.forYou.list() }),
      routineList: this.routines.list(),
      forYou: this.forYou.list(),
      agenda: events,
      media: this.media.list({ limit: 200 }),
    });
  }

  /**
   * As métricas da Gestão (vazão, tempo até entregar, espera pelo OK, recusa, custo por entrega…) deste
   * workspace: só leitura, por código. `from`/`to` em ms (fim exclusivo); sem eles, 7 dias (taxas) e 28 (medianas).
   */
  async metrics(options: { from?: number; to?: number } = {}): Promise<MetricsReport> {
    const now = this.now().getTime();
    const to = options.to ?? now;
    // Lê o gasto de antes da janela anterior: o custo de um projeto entregue agora pode ter começado semanas atrás.
    const span = options.from !== undefined ? to - options.from : METRICS_MEDIAN_DAYS * DAY_MS;
    const earliest = to - 2 * Math.max(span, METRICS_MEDIAN_DAYS * DAY_MS) - 30 * DAY_MS;
    await this.usageHistory.idle();
    // As aprovações decididas antes do prazo da lista viva estão no arquivo: a janela (e a anterior a ela) lê de lá também.
    const forYou = await this.forYou.listSince(earliest);
    return computeMetrics(this.metricsSnapshot(await this.usageHistory.read(earliest, to + 1), { forYou }), { now, workspace: this.id, ...(options.from !== undefined ? { from: options.from } : {}), ...(options.to !== undefined ? { to: options.to } : {}) });
  }

  /**
   * Tudo que o `computeMetrics` lê, tirado dos serviços na hora. A aba Gestão, as ferramentas e o bloco da página do Cyno usam este
   * mesmo retrato (o bloco, com `light`: sem a projeção das metas, que ele não usa).
   */
  metricsSnapshot(usage: readonly UsageRecord[] = [], options: { light?: boolean; forYou?: ForYouItem[] } = {}): MetricsSnapshot {
    const state = this.state.read();
    const engineBlocks = state.agents.flatMap((agent) => {
      const block = this.engineBlockOf(agent);
      return block ? [{ agentId: agent.id, block }] : [];
    });
    return {
      agents: state.agents,
      tasks: state.tasks,
      projects: this.plans.list(),
      forYou: options.forYou ?? this.forYou.list(),
      usage,
      routines: this.routines.list(),
      entries: this.routines.entries,
      quota: this.quotaSnapshot(),
      dispatch: this.dispatchNow(),
      engineBlocks,
      // As metas do período: a projeção sai do mesmo resumo que a tela Rotinas e metas lê.
      goals: options.light ? [] : buildOverview({ routines: this.routines, state: this.state, now: this.now(), forYou: this.forYou.list() }).routines.flatMap((item) => (item.projection ? [item.projection] : [])),
    };
  }

  /** O gasto desde `fromMs` (para o bloco da página do Cyno). */
  async usageSince(fromMs: number): Promise<UsageRecord[]> {
    await this.usageHistory.idle();
    return this.usageHistory.read(fromMs, this.now().getTime() + 1);
  }

  /** As próximas tarefas pela ordem de urgência (o "o que vem a seguir" do resumo do dia). */
  private nextTasksForReport(): { title: string; project?: string; agent?: string }[] {
    const now = this.now().getTime();
    const names = new Map(this.state.read().agents.map((agent) => [agent.id, agent.name]));
    const rows: { title: string; project: string; agent?: string; rank: ReturnType<typeof taskRankInput> }[] = [];
    for (const project of expandAvulsas(this.plans.list())) {
      if (project.status !== "ativo" || project.origin === "rotina") continue;
      project.tasks.forEach((task, index) => {
        if (task.group === true || (task.status !== "a_fazer" && task.status !== "backlog")) return;
        const agentId = task.steps[0]?.agentId ?? (task.ownerId || undefined);
        rows.push({ title: task.title, project: project.kind === "projeto" ? project.title : "Avulsas", ...(agentId && names.get(agentId) ? { agent: names.get(agentId)! } : {}), rank: taskRankInput(project, task, index) });
      });
    }
    return workRank(rows.map((row) => ({ ...row, ...row.rank })), now).slice(0, 5).map(({ title, project, agent }) => ({ title, project, ...(agent ? { agent } : {}) }));
  }

  /**
   * O parágrafo de IA do relatório (só chamado com a chave ligada em Configurações): abre um pedido ao Maestro com os números
   * já calculados, pedindo UM parágrafo sem refazer conta, e espera a resposta dele (`complete_request`). Sem Maestro de CLI,
   * ou sem resposta em 20 minutos, devolve undefined e o relatório fica só com os números.
   */
  private reportParagraph(input: { kind: ReportKind; period: string; markdown: string }): Promise<string | undefined> {
    if (!this.cliMaestro.enabled()) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let taskId: string | undefined;
      const done = (text: string | undefined) => {
        unsubscribe();
        clearTimeout(timer);
        resolve(text);
      };
      const unsubscribe = this.hub.subscribe((event) => {
        if (event.type !== "task:upserted" || event.task.id !== taskId) return;
        if (event.task.status === "done") done(event.task.result?.trim() || undefined);
        else if (event.task.status === "failed") done(undefined);
      });
      const timer = setTimeout(() => done(undefined), 20 * 60_000);
      timer.unref();
      const label = { day: "do dia", week: "da semana", month: "do mês" }[input.kind];
      try {
        const task = this.cliMaestro.openServerRequest({
          title: `Parágrafo do relatório ${label} (${input.period})`,
          origin: "Relatório da Gestão (o dono ligou o parágrafo de IA em Configurações)",
          message: [
            `Escreva UM parágrafo curto (no máximo 3 frases, em português) para o dono, dizendo o que mudou no relatório ${label} abaixo.`,
            "Os números já foram calculados pelo servidor: NÃO recalcule, NÃO pesquise na Atividade e NÃO chame outras ferramentas. Use só os números do texto, cite o n quando houver poucos dados e não invente causas.",
            "Responda chamando `complete_request` com o parágrafo e mais nada (sem título, sem lista).",
            "",
            input.markdown,
          ].join("\n"),
        });
        taskId = task.id;
      } catch (error) {
        this.skillReadLog.warn({ err: error }, "não foi possível pedir o parágrafo do relatório ao Maestro");
        done(undefined);
      }
    });
  }

  /**
   * Quanto custaria no modelo `model` o que o agente usou nos últimos 14 dias (a economia por semana, equivalente à API), com a
   * recusa dele nas últimas 4 semanas. Só leitura: a troca é pelo `PATCH /agents/:id`. 404 se o agente não existe.
   */
  async modelSaving(agentId: string, model: string): Promise<ModelSaving> {
    const agent = this.state.read().agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new HttpError(404, `Agente "${agentId}" não encontrado`);
    const now = this.now().getTime();
    await this.usageHistory.idle();
    const records = await this.usageHistory.read(now - MODEL_SAVING_DAYS * DAY_MS, now + 1);
    const report = await this.metrics({ from: now - 28 * DAY_MS, to: now });
    const group = report.rejectionRate.byAgent.find((entry) => entry.key === agentId);
    return modelSaving({
      agent: { id: agent.id, name: agent.name, model: agent.model },
      model,
      records,
      now,
      rejection: { rate: group && group.n > 0 ? group.value : null, n: group?.n ?? 0 },
      quotaProviders: new Set(this.quotaSnapshot().map((usage) => usage.provider)),
    });
  }

  /** A diária deste workspace ("Meu dia"): `day` = "AAAA-MM-DD" (padrão hoje). Só leitura, por código. */
  dayStats(day: string | undefined, options: { usdBrl?: number; compare?: boolean } = {}): Promise<DayStats> {
    return this.dayStatsService(options.usdBrl).day(day ?? dayKeyOf(this.now().getTime()), { compare: options.compare !== false });
  }

  /** O serviço da diária (as rotas pedem com a cotação do dólar da instalação). */
  dayStatsService(usdBrl?: number): DayStatsService {
    return new DayStatsService({
      clock: this.stateClock,
      tasks: () => this.state.read().tasks,
      projects: () => this.plans.list(),
      agents: () => this.state.read().agents,
      forYou: (sinceMs) => this.forYou.listSince(sinceMs),
      usage: (from, to) => this.usageHistory.read(from, to),
      usdBrl: () => usdBrl ?? DEFAULT_USD_BRL,
      now: () => this.now().getTime(),
    });
  }

  /** Ferramentas MCP do agente dono do token (Maestro ou agente de time), mais as dos conectores ligados a ele. */
  officeTools(agentId: string): McpTool[] {
    return [...this.ownOfficeTools(agentId), ...this.connectors.toolsFor(agentId)];
  }

  private ownOfficeTools(agentId: string): McpTool[] {
    return officeToolsFor(agentId, {
      state: this.state,
      maestro: this.cliMaestro,
      runner: this.cliRunner,
      forYouTypes: this.forYouTypes,
      forYou: this.forYou,
      structure: { services: this.services, simulated: this.simulated, engines: this.engines, agentDefaults: () => this.models()?.agentes, access: this.access },
      brain: this.brainAccess,
      teamNote: () => [this.connectors.teamNote(), this.skills.teamNote(), this.cardSummary.get().summary ? "" : "Workspace card: the sentence 'what this workspace does' is empty. Write it with set_workspace_summary(text) so the platform agent knows what this workspace is for."].filter(Boolean).join("\n\n"),
      cardSummary: this.cardSummary,
      ...(this.platformLink
        ? {
            cyno: {
              ask: (input) => {
                const link = this.platformLink?.();
                if (!link) throw new Error("The Cyno is not available right now");
                return link.ask(this.id, input);
              },
            },
          }
        : {}),
      plans: this.plans,
      today: () => this.today(),
      dayStats: { dayStats: (day) => this.dayStats(day), now: () => this.now() },
      metrics: { metrics: (window) => this.metrics(window), now: () => this.now() },
      reports: { ensure: (kind, period) => this.reports.ensure(kind, period, "mcp"), retro: this.retro },
      retro: { propose: (input) => this.retro.proposeRule(input) },
      brainOrganize: { propose: (input) => this.brainOrganize.propose(input) },
      ...(this.agendaDeps ? { agenda: this.agendaDeps } : {}),
      ...(this.muralDeps ? { mural: this.muralDeps } : {}),
      routines: { routines: this.routines, tracking: this.tracking, workspaceId: this.id, now: this.usageInfo.now, forYou: () => this.forYou.list() },
      media: {
        media: this.media,
        agentDir: (id) => this.store.paths.agentDir(id),
        currentTask: (id) => this.runningTask(id),
        ...(this.browser ? { render: (input) => this.browser!.renderHtml(input) } : {}),
        ffmpeg: () => this.ffmpegPath(),
      },
      board: {
        boards: this.boards,
        agentDir: (id) => this.store.paths.agentDir(id),
        readableFolders: (id) => effectiveFolders(this.workFolders(), this.state.read().agents.find((agent) => agent.id === id)).map((folder) => folder.path),
      },
      manage: {
        services: this.services,
        access: this.access,
        connectors: this.connectors,
        skills: this.skills,
        forYouTypes: this.forYouTypes,
        terminals: this.terminals,
        chat: this.agentChat,
        agentLog: this.agentLog,
        plans: this.plans,
        calendar: this.calendar,
        engines: this.engines,
        helpAnswered: (agentId, text) => {
          if (this.cliRunner.isWaitingHelp(agentId)) void this.agentChat.send(agentId, text).catch(() => undefined);
        },
        agentUsage: () => this.terminals.agentUsage.summary(),
        ...(this.usageInfo.usage ? { usage: () => this.usageInfo.usage!.snapshot() } : {}),
        ...(this.usageInfo.availability ? { availability: (engine) => this.usageInfo.availability!.block(engine) } : {}),
        now: this.usageInfo.now,
      },
      ...(this.browser ? { browser: { browser: this.browser, access: () => this.access(), approve: (agentId, question, onApproved, onDropped) => this.approveBrowserAction(agentId, question, onApproved, onDropped), media: { library: this.media, currentTask: (id) => this.runningTask(id) } } } : {}),
    });
  }

  /** O agente leu `skills/<id>/SKILL.md` (uma skill que ele recebeu): soma no uso e registra na Atividade. */
  private noteSkillRead(agentId: string, event: TerminalEvent): void {
    if (event.type !== "tool_use" || !event.input) return;
    const match = /(?:^|[\\/])skills[\\/]([a-z0-9][a-z0-9-]*)[\\/]SKILL\.md\b/.exec(JSON.stringify(event.input).replace(/\\\\/g, "/"));
    if (!match) return;
    const skillId = match[1]!;
    if (!this.skills.forAgent(agentId).some((skill) => skill.id === skillId)) return;
    const state = this.state.read();
    const name = state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    void this.platformLibrary.skills.recordRead(skillId, name, this.workspaceLabel()).catch((error: unknown) => this.skillReadLog.warn({ err: error, skillId }, "não foi possível registrar a leitura da skill"));
  }

  /** Ação sensível do navegador: o pedido de aprovação vai pelo Maestro (pedido aberto) ou pela tarefa do agente. */
  private approveBrowserAction(agentId: string, question: string, onApproved: () => void, onDropped: () => void): string {
    const state = this.state.read();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (agent && isMaestroAgent(state, agent)) return this.cliMaestro.requestApproval({ question, onApproved });
    return this.cliRunner.requestApproval(agentId, question, undefined, onApproved, undefined, onDropped);
  }

  /** Agora (o relógio do runtime; os testes trocam). */
  now(): Date {
    return this.usageInfo.now();
  }

  /** Tarefa que o agente de time está rodando agora (undefined = nenhuma, ou não é agente de time). */
  /** ffmpeg que a plataforma baixou (data/platform/runtimes/ffmpeg), se já estiver instalado: serve aos quadros de vídeo da prévia. */
  private ffmpegPath(): string | undefined {
    const bin = path.join(this.store.paths.root, "..", "..", "platform", "runtimes", "ffmpeg", "bin", "ffmpeg");
    return existsSync(bin) ? bin : undefined;
  }

  private runningTask(agentId: string): Task | undefined {
    if (!this.cliRunner.hasActive(agentId)) return undefined;
    const taskId = this.cliRunner.currentTaskId(agentId);
    return this.state.read().tasks.find((task) => task.id === taskId);
  }

  /** Agente que executa uma rotina: o dono, ou o escolhido pelo roteamento no time dela. */
  /**
   * Apaga uma rotina encerrada (ou em proposta) com os itens e o histórico; os cartões que ainda esperavam
   * nela são cancelados e os projetos/tarefas já executados ficam. 409 se ainda está viva.
   */
  async removeRoutine(id: string): Promise<void> {
    const routine = this.routines.find(id);
    if (!routine) throw new HttpError(404, `Rotina "${id}" não encontrada`);
    if (routine.status !== "encerrada" && routine.status !== "proposta") throw new HttpError(409, "Só dá para apagar uma rotina encerrada ou em proposta: encerre antes");
    for (const item of this.forYou.list()) {
      if (item.routineId === id && item.status === "pendente") await this.forYou.cancel(item.id, { by: "servidor", reason: "Rotina apagada" }).catch(() => undefined);
    }
    this.routines.remove(id);
    this.tracking.forget(id);
    await this.routineItems.remove(id);
  }

  private routineAgent(agentId: string | undefined, teamId: string | undefined): Agent | undefined {
    const state = this.state.read();
    if (agentId) return state.agents.find((agent) => agent.id === agentId);
    const team = state.teams.find((candidate) => candidate.id === teamId);
    if (!team) return undefined;
    try {
      return state.agents.find((agent) => agent.id === routeTask(state, { roomId: team.roomId, teamId: team.id }));
    } catch {
      return undefined;
    }
  }

  /** Uso atual da assinatura de cada CLI (a página Gestão). */
  quotaSnapshot(): SubscriptionUsage[] {
    return this.usageInfo.usage?.snapshot() ?? [];
  }

  /** O motor do agente está sem cota ou CLI? (a página Gestão) */
  engineBlockOf(agent: Agent): ReturnType<NonNullable<RuntimeOptions["availability"]>["block"]> {
    return this.usageInfo.availability?.block(agentEngine(agent), agent.model, { agentId: agent.id, workspaceId: this.id });
  }

  /** Alguma tarefa em andamento (queued, in_progress ou waiting_approval)? */
  hasActiveTasks(): boolean {
    return this.store.snapshot().tasks.some((task) => isActiveTaskStatus(task.status));
  }

  /** Para o orquestrador e os terminais de CLI e espera as gravações pendentes. */
  async close(): Promise<void> {
    if (this.approvalsTimer) clearInterval(this.approvalsTimer);
    this.approvalsTimer = undefined;
    this.routineScheduler.stop();
    this.slotClock.stop();
    this.reportClock.stop();
    this.plans.stop();
    this.stopping = true;
    this.maestro.stop();
    this.orchestrator.stop();
    await this.stateClock.stop();
    this.timeline.stop();
    this.sceneLive?.dispose();
    this.unsubscribeTerminals();
    this.agentChat.close();
    this.unsubscribeAvailability();
    await this.terminals.closeAll();
    await this.connectors.close();
    this.detachLibrary();
    await this.browser?.close();
    await this.store.flush();
    // Atividade: o que ainda espera o custo é gravado agora (sem a espera), depois para de observar.
    for (const release of [...this.costWaits]) release();
    await this.activityObserver?.drain();
    this.activityObserver?.();
    this.unsubscribeActivity?.();
  }
}
