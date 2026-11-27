import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_LOG_LIMITS,
  conversationLogId,
  CYNO_AGENT_ID,
  CYNO_IDLE_MINUTES,
  CYNO_NAME,
  CYNO_PLATFORM_ID,
  CYNO_USAGE_LABEL,
  cynoChoiceOf,
  cynoSettingsSchema,
  describeModelChoice,
  expandAvulsas,
  engineBlockLabel,
  MAESTRO_AVATAR,
  type Agent,
  type AgentLogBody,
  type AskRecord,
  type AgentEngine,
  type Card,
  type PlatformReport,
  type JointProject,
  type JointView,
  type WaitingItem,
  type Workspace,
  type AgentUsageResponse,
  type AgentUsageTally,
  type CynoServerEvent,
  type CynoSettings,
  type CynoSettingsResponse,
  type UpdateCynoSettingsBody,
  type CynoSnapshot,
  type SentRequestView,
  type CynoState,
  type CynoStatus,
  type EngineBlock,
  type EngineInfo,
  type ModelChoice,
  type OfficeState,
  type ServerEvent,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { terminalLogBridge } from "../../engines/terminals/log-bridge";
import { ConversationSession, type ConversationHooks } from "../../engines/terminals/conversation-session";
import { TerminalManager, type TerminalsConfig } from "../../engines/terminals/manager";
import type { TerminalAgent, TerminalEvent } from "../../engines/terminals/types";
import type { EngineAvailability } from "../../engines/usage/availability";
import type { SubscriptionUsageTracker } from "../../engines/usage/subscription-usage";
import { UsageHistory } from "../../engines/usage/usage-history";
import { runnerLogHooks } from "../../workspace/agent-log/hooks";
import { AgentLogService } from "../../workspace/agent-log/service";
import { agendaTools } from "../../mcp/agenda-tools";
import { cynoMuralTools } from "../../mcp/mural-tools";
import type { MuralService } from "../mural/mural-service";
import { platformTools } from "../../mcp/cyno/platform-tools";
import type { AgendaService } from "../agenda/agenda-service";
import { usageReport } from "../../mcp/usage-report";
import type { McpTool } from "../../mcp/protocol";
import type { McpTokens } from "../../mcp/tokens";
import { writeJsonAtomic } from "../../store/atomic-write";
import { platformPaths, type PlatformPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";
import { dayKeyOf, zonedParts } from "../../engines/usage/usage-time";
import type { FactsMap } from "../cards/compact";
import { errorMessage } from "../../util/text";
import { HttpError } from "../http/errors";
import type { ModelDefaultsStore } from "../models/defaults-store";
import type { WorkspaceManager } from "../workspaces/manager";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import type { SummaryWrite } from "../../workspace/card/summary-store";
import { CardIndex, pendingWithAgents, type CardSource } from "../cards/card-index";
import { platformTodayOf } from "../today/platform-today";
import { platformDayStatsOf } from "../day-stats/platform-day-stats";
import { dayOrError } from "../../mcp/day-stats-tools";
import { metricsText } from "../../mcp/metrics-tools";
import { reportText, type ReportInput } from "../../mcp/report-tools";
import { renderPlatformReportMarkdown, renderPlatformReportText, type PlatformReports } from "../reports/platform-reports";
import { renderDayStats, renderPlatformDayStats } from "../../workspace/day-stats/text";
import { renderPlatformToday, renderToday } from "../../workspace/today/today-text";
import { activity } from "../../workspace/activity/log";
import { cynoStructureTools } from "../../mcp/cyno/structure-tools";
import { maestroToolBridge, scopedGetTeam, scopedStructureTools } from "../../mcp/cyno/scoped";
import { CynoStructure } from "./cyno-structure";
import { CYNO_ACCESS, cynoPrompt } from "./cyno-prompt";
import { CynoRequests } from "./cyno-requests";
import { JointCoordinator } from "./joint-coordinator";
import { jointTools } from "../../mcp/cyno/joint-tools";

/** Etiqueta das mensagens de conversa do dono (a mesma do Maestro: o histórico de gastos conta como "chat"). */
const CHAT_TAG_PREFIX = "chat:";
/** Etiqueta das mensagens de pergunta de um Maestro (`ask:A-0001`). */
const ASK_TAG_PREFIX = "ask:";
/** Arquivo (na pasta do Cyno) que lembra o pedido de "Nova conversa" até a próxima mensagem sair (sobrevive a um reinício). */
const NEW_CONVERSATION_FLAG = "nova-conversa.json";
/** Quantas entradas do log o snapshot entrega (as mais recentes). */
const SNAPSHOT_ENTRIES = Math.min(AGENT_LOG_LIMITS.perAgent, 600);

export type CynoServiceDeps = {
  /** DATA_DIR (o Cyno vive em `data/platform/`). */
  dataDir: string;
  tokens: McpTokens;
  terminals: TerminalsConfig;
  usage?: SubscriptionUsageTracker;
  availability?: EngineAvailability;
  engines?: () => Promise<EngineInfo[]>;
  modelDefaults: ModelDefaultsStore;
  workspaces: Pick<WorkspaceManager, "list" | "find" | "listHub" | "create" | "remove" | "update" | "rename" | "models">;
  /** Modo simulado ligado (só testes): libera o motor "mock" nas ferramentas de estrutura. */
  simulated?: boolean;
  /** Variáveis de ambiente do `run_host_command` (testes); ausente = as do processo, já sem chaves de API. */
  hostEnv?: NodeJS.ProcessEnv;
  /** As ações perigosas do Cyno pedem OK num cartão? Padrão: sim (ver `CynoStructureHost.requireApproval`). */
  requireApproval?: boolean;
  /** "Sua agenda": as ferramentas `agenda_*` do Cyno e os eventos ao vivo dela pelo websocket do Cyno. */
  agenda?: AgendaService;
  /** O mural da plataforma: as ferramentas `mural_*` do Cyno, os avisos passivos e os eventos ao vivo. */
  mural?: MuralService;
  /** `get_away_summary`: o resumo do "enquanto você estava fora" em texto (mesma conta do cartão). */
  awayText?: () => Promise<string>;
  /** A semana da plataforma (`get_report` com `scope: "platform"`); ausente = só os relatórios de cada workspace. */
  platformReports?: Pick<PlatformReports, "ensure">;
  /** Ociosidade em ms antes de dormir (testes e `CYNO_IDLE_MS`); ausente = `settings.idleMinutes`. */
  idleMs?: number;
  /** Debounce do recálculo das fichas em ms (testes); ausente = 2 s. */
  cardDebounceMs?: number;
  log: FastifyBaseLogger;
  now: () => Date;
};

/**
 * O Cyno, o agente da plataforma: uma CLI (headless) sem workspace, na pasta `data/platform/cyno/`,
 * montada com as mesmas peças do Maestro (`TerminalManager`, `ConversationSession`), com servidor MCP
 * (escopo "platform"), chat e gastos próprios.
 *
 * - NUNCA sobe no boot: a primeira mensagem do dono acorda; ocioso por `idleMinutes` o processo para
 *   (a conversa continua em `session.json`) e a próxima mensagem retoma a MESMA conversa.
 * - NUNCA limpa nem renova a conversa sozinho: só o botão "Nova conversa" (`newConversation`).
 * - O que ele faz (ferramentas, narração, resposta) vai para o log da conversa do dia (formato do log
 *   dos agentes, `logs/conversa-cyno-AAAAMMDD.jsonl`) e ao vivo para o websocket `/api/cyno/ws`.
 * - Sem Bash embutido, sem subagentes, config isolada (nunca herda `~/.claude` nem `~/.gemini`).
 */
export class CynoService {
  readonly paths: PlatformPaths;
  /** Histórico de gastos do Cyno (a página Gastos soma isto como "Cyno · plataforma"). */
  readonly usageHistory: UsageHistory;
  private readonly queue = new WriteQueue();
  private readonly agentLog: AgentLogService;
  private readonly terminals: TerminalManager;
  private readonly session: ConversationSession;
  /** As fichas dos workspaces (por código, sem IA): o digest, o delta e a página inicial. */
  readonly cards: CardIndex;
  /** Pedidos enviados aos Maestros, perguntas dos Maestros (`ask_cyno`) e os avisos passivos. */
  private requests!: CynoRequests;
  /** Projetos que envolvem mais de um workspace: uma parte em cada um, liberadas por código. */
  private joints!: JointCoordinator;
  /** Montar e mudar workspaces: propostas, ações perigosas em duas fases e `run_host_command`. */
  private structure!: CynoStructure;
  private offCards: (() => void) | undefined;
  private offAgenda: (() => void) | undefined;
  private offMural: (() => void) | undefined;
  private readonly listeners = new Set<(event: CynoServerEvent) => void>();
  private readonly log: FastifyBaseLogger;
  private bridge: ReturnType<typeof terminalLogBridge> | undefined;
  private closed = false;
  private offAvailability: (() => void) | undefined;
  private lastStatus = "";
  /** A configuração viva do terminal (o manager lê `idleMs` a cada subida: mudar aqui vale na próxima). */
  private readonly terminalConfig: TerminalsConfig;
  /** Turnos do Cyno no dia (horário de Brasília); `settings.dailyTurnCap` é o teto. */
  private turns = { day: "", count: 0 };
  private digestTimer: NodeJS.Timeout | undefined;
  private lastDigestKey = "";

  private constructor(
    private readonly deps: CynoServiceDeps,
    private settings: CynoSettings,
  ) {
    this.log = deps.log.child({ cyno: true });
    this.paths = platformPaths(deps.dataDir);
    this.terminalConfig = { ...deps.terminals, idleMs: deps.idleMs ?? settings.idleMinutes * 60_000, maestroPty: undefined };
    this.agentLog = new AgentLogService({
      paths: { logsDir: this.paths.logsDir, taskLogFile: (logId) => this.paths.logFile(logId) },
      queue: this.queue,
      publish: (event) => this.onLogEvent(event),
      tasks: () => [],
      log: this.log,
      now: deps.now,
    });
    this.usageHistory = new UsageHistory({
      dir: this.paths.usageDir,
      queue: this.queue,
      agents: () => [{ ...this.agent(), name: CYNO_USAGE_LABEL }],
      tasks: () => [],
      log: this.log,
      now: deps.now,
    });
    this.terminals = new TerminalManager({
      workspaceId: CYNO_PLATFORM_ID,
      workspaceName: () => "plataforma",
      paths: { agentDir: () => this.paths.cynoDir },
      state: { read: () => this.office() },
      publish: (event) => this.onTerminalPublish(event),
      tokens: deps.tokens,
      ...(deps.usage ? { usage: deps.usage } : {}),
      access: () => CYNO_ACCESS,
      promptFor: (agent) => cynoPrompt(agent),
      subagents: false,
      scope: "platform",
      onTerminalEvent: (agentId, provider, event) => this.usageHistory.observe(agentId, provider, event),
      // Ocioso por tanto tempo = o processo para; a próxima mensagem retoma a conversa.
      config: this.terminalConfig,
      log: this.log,
      now: deps.now,
    });
    this.session = new ConversationSession(this.hooks());
    this.cards = new CardIndex({
      sources: () => this.sources(),
      subscribeList: (listener) => deps.workspaces.listHub.subscribe((event) => (event.type === "workspaces:list" ? listener() : undefined)),
      now: deps.now,
      ...(deps.cardDebounceMs !== undefined ? { debounceMs: deps.cardDebounceMs } : {}),
      // O cursor do delta vai para o disco: depois de um reinício, a próxima mensagem leva o que mudou na queda.
      onSeen: (seen) => void this.queue.enqueue(() => writeJsonAtomic(this.paths.cardsSeenFile, seen)).catch((error: unknown) => this.log.error({ err: error }, "falha ao gravar o cursor das fichas")),
    });
    this.offCards = this.cards.subscribe((workspaces) => this.emit({ type: "cyno:cards", workspaces }));
    this.offAgenda = deps.agenda?.subscribe((event) => this.emit(event));
    this.offMural = deps.mural?.subscribe(() => this.emit({ type: "mural:changed" }));
  }

  /** Abre o serviço: lê as configurações e o pedido de "Nova conversa" que ficou pendente. Não sobe nenhum processo. */
  static async open(deps: CynoServiceDeps): Promise<CynoService> {
    const paths = platformPaths(deps.dataDir);
    let settings = cynoSettingsSchema.parse({});
    try {
      const parsed = cynoSettingsSchema.safeParse(JSON.parse(await readFile(paths.settingsFile, "utf8")));
      if (parsed.success) settings = parsed.data;
    } catch {
      // Sem arquivo (ou quebrado): os padrões.
    }
    const service = new CynoService(deps, settings);
    try {
      const seen = JSON.parse(await readFile(paths.cardsSeenFile, "utf8")) as unknown;
      if (seen && typeof seen === "object" && !Array.isArray(seen)) service.cards.restoreSeen(seen as FactsMap);
    } catch {
      // Sem cursor gravado: o primeiro delta só marca o ponto de partida.
    }
    try {
      const turns = JSON.parse(await readFile(paths.turnsFile, "utf8")) as { day?: unknown; count?: unknown };
      if (typeof turns.day === "string" && typeof turns.count === "number") service.turns = { day: turns.day, count: turns.count };
    } catch {
      // Sem contagem gravada: zero hoje.
    }
    service.requests = await CynoRequests.open(
      {
        workspaces: deps.workspaces,
        now: deps.now,
        log: service.log,
        chat: (body) => service.chat(body),
        emit: (event) => service.emit(event),
        wake: (tag, build) => service.wakeFor(tag, build),
        // Os pedidos foram recalculados: os projetos conjuntos conferem as partes (por código, ninguém acorda).
        onChange: () => service.joints?.refresh(),
      },
      { requests: paths.requestsFile, asks: paths.asksFile },
      service.queue,
    );
    service.joints = await JointCoordinator.open({
      workspaces: deps.workspaces,
      requests: service.requests,
      dir: paths.jointDir,
      queue: service.queue,
      now: deps.now,
      log: service.log,
      chat: (body) => service.chat(body),
      emit: (event) => service.emit(event),
    });
    // Conjuntos que ficaram a meio caminho (reinício): confere já o que mudou enquanto o servidor estava fora.
    service.joints.refresh();
    service.structure = await CynoStructure.open(
      {
        workspaces: deps.workspaces,
        engines: async () => (await deps.engines?.()) ?? [],
        simulated: deps.simulated === true,
        paths,
        now: deps.now,
        log: service.log,
        ...(deps.hostEnv ? { env: deps.hostEnv } : {}),
        ...(deps.requireApproval !== undefined ? { requireApproval: deps.requireApproval } : {}),
        chat: (body) => service.chat(body),
        emit: (event) => service.emit(event),
        wake: (tag, build) => service.wakeFor(tag, build),
        record: (input) => activity(input),
      },
      service.queue,
    );
    if (await service.pendingNewConversation()) service.session.startNewConversation();
    service.startDigestTimer();
    // Cota que voltou (ou "Tentar agora"): as mensagens que esperavam seguem.
    service.offAvailability = deps.availability?.onChange(() => {
      service.session.flushHeld();
      service.emitStatus();
    });
    return service;
  }

  // ---------- Estado ----------

  /** Escolha de motor/modelo/esforço atual (dos modelos padrão globais). */
  choice(): ModelChoice {
    return cynoChoiceOf(this.deps.modelDefaults.get());
  }

  state(): CynoState {
    const info = this.terminals.snapshot()[CYNO_AGENT_ID];
    const status = statusOf(info?.status);
    const block = this.session.blocked();
    return {
      status,
      choice: this.choice(),
      everStarted: info?.everStarted === true,
      newConversation: this.session.newConversationDue,
      idleMinutes: Math.max(1, Math.round((this.deps.idleMs ?? this.settings.idleMinutes * 60_000) / 60_000)) || CYNO_IDLE_MINUTES,
      ...(block ? { block } : {}),
      ...(info?.error && status === "sleeping" ? { error: info.error } : {}),
      updatedAt: this.deps.now().toISOString(),
    };
  }

  async snapshot(): Promise<CynoSnapshot> {
    return { state: this.state(), entries: await this.agentLog.recentForAgent(CYNO_AGENT_ID, SNAPSHOT_ENTRIES) };
  }

  /** Eventos ao vivo (o websocket assina; o snapshot vem à parte). */
  subscribe(listener: (event: CynoServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- Configurações do Cyno ----------

  /** Configurações atuais, os padrões e o consumo de turnos de hoje (a tela Configurações). */
  settingsView(): CynoSettingsResponse {
    const day = this.today();
    return { settings: structuredClone(this.settings), defaults: cynoSettingsSchema.parse({}), turnsToday: this.turns.day === day ? this.turns.count : 0, day, idleFromEnv: this.deps.idleMs !== undefined };
  }

  /** Grava (só os campos presentes) e aplica: o sono vale na próxima subida, o teto e o resumo valem já. */
  async updateSettings(patch: UpdateCynoSettingsBody): Promise<CynoSettingsResponse> {
    const { digest, ...rest } = patch;
    const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
    const next = cynoSettingsSchema.parse({ ...this.settings, ...defined(rest), digest: { ...this.settings.digest, ...defined(digest ?? {}) } });
    this.settings = next;
    if (this.deps.idleMs === undefined) this.terminalConfig.idleMs = next.idleMinutes * 60_000;
    await this.queue.enqueue(() => writeJsonAtomic(this.paths.settingsFile, next));
    this.emitStatus();
    return this.settingsView();
  }

  private today(): string {
    return dayKeyOf(this.deps.now().getTime());
  }

  /** Mensagem clara quando o teto de turnos do dia já foi atingido (undefined = pode seguir). */
  private turnCapMessage(): string | undefined {
    if (this.turns.day !== this.today() || this.turns.count < this.settings.dailyTurnCap) return undefined;
    return `O Cyno chegou ao teto de ${this.settings.dailyTurnCap} turnos de hoje (protege a cota da sua assinatura). Ele volta amanhã; para liberar agora, aumente o teto em Configurações > Cyno.`;
  }

  private countTurn(): void {
    const day = this.today();
    this.turns = this.turns.day === day ? { day, count: this.turns.count + 1 } : { day, count: 1 };
    const snapshot = { ...this.turns };
    void this.queue.enqueue(() => writeJsonAtomic(this.paths.turnsFile, snapshot)).catch(() => undefined);
  }

  /**
   * Resumo opcional (desligado por padrão): na hora marcada (Brasília) o chat ganha uma entrada com o
   * digest das fichas, montada por código, sem acordar o Cyno nem gastar turno. Semanal = segundas.
   */
  private startDigestTimer(): void {
    this.digestTimer = setInterval(() => this.maybePostDigest(), 30_000);
    this.digestTimer.unref();
  }

  /** Posta o resumo se está na hora e ainda não saiu hoje (público para os testes). */
  maybePostDigest(): boolean {
    const { enabled, frequency, time } = this.settings.digest;
    if (!enabled || this.closed) return false;
    const parts = zonedParts(this.deps.now().getTime());
    const [hh, mm] = time.split(":").map(Number);
    if (parts.hour * 60 + parts.minute < hh! * 60 + mm!) return false;
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    if (frequency === "weekly" && weekday !== 1) return false;
    const key = this.today();
    if (this.lastDigestKey === key) return false;
    this.lastDigestKey = key;
    this.chat({ kind: "text", text: `Resumo ${frequency === "weekly" ? "da semana" : "do dia"}\n\n${this.cards.digest()}` });
    return true;
  }

  // ---------- Ações do dono ----------

  /**
   * O dono fala com o Cyno: a fala entra no chat e a mensagem vai para a sessão (acorda o processo se
   * ele dorme). Devolve o id da mensagem. Sem terminal (motor simulado ou sem adaptador), 409.
   */
  send(text: string): string {
    const body = text.trim();
    if (!body) throw new HttpError(400, "A mensagem está vazia");
    if (this.closed) throw new HttpError(409, "O Cyno está desligando");
    const capped = this.turnCapMessage();
    if (capped) {
      this.chat({ kind: "chat", from: "user", text: body, via: "painel" });
      this.chat({ kind: "status", status: "waiting", message: capped });
      throw new HttpError(429, capped);
    }
    try {
      this.session.terminal();
    } catch (error) {
      throw new HttpError(409, `O Cyno não pode acordar com este motor: ${errorMessage(error)}`);
    }
    const id = randomUUID();
    this.countTurn();
    this.chat({ kind: "chat", from: "user", text: body, via: "painel" });
    const fresh = this.session.newConversationDue;
    // O texto sai só na hora de ir (depois do digest, se a conversa é nova): leva o que mudou nas fichas desde a última vez.
    this.session.push(`${CHAT_TAG_PREFIX}${id}`, () => withCardChanges(body, [...this.cards.delta(), ...this.requests.takeNotices(), ...this.structure.takeNotices(), ...(this.deps.mural?.takeNotices() ?? []), ...this.joints.takeNotices()]));
    if (fresh) void this.setPendingNewConversation(false);
    this.emitStatus();
    return id;
  }

  /** Acorda o Cyno por outro motivo que a fala do dono (um Maestro perguntou). Lança se ele não pode acordar. */
  private wakeFor(tag: string, build: () => string): void {
    if (this.closed) throw new Error("The Cyno is shutting down");
    const capped = this.turnCapMessage();
    if (capped) {
      this.chat({ kind: "status", status: "waiting", message: capped });
      throw new Error(`The Cyno reached today's turn limit (${this.settings.dailyTurnCap}); the owner can raise it in Settings. Try again tomorrow.`);
    }
    this.session.terminal();
    this.countTurn();
    this.session.push(tag, build);
    this.emitStatus();
  }

  /** O que um workspace pede ao Cyno (`ask_cyno` do Maestro): grava a pergunta e acorda o Cyno com ela. */
  ask(workspaceId: string, input: { question: string; context?: string; requestId?: string }): string {
    return this.requests.ask(workspaceId, input);
  }

  /** Os pedidos de ajuda dos Maestros (`asks.json`), do mais antigo ao mais novo. */
  askList(): AskRecord[] {
    return structuredClone(this.requests.asks.list());
  }

  /** `GET /api/cyno/requests`: os pedidos enviados com o estado de cada um (por código). */
  requestViews(): SentRequestView[] {
    return this.requests.views_();
  }

  /** Botão "Nova conversa": a próxima mensagem abre uma sessão limpa (o histórico do chat na tela continua). */
  async newConversation(): Promise<CynoState> {
    if (this.closed) throw new HttpError(409, "O Cyno está desligando");
    this.session.startNewConversation();
    await this.setPendingNewConversation(true);
    this.chat({ kind: "status", status: "resumed", message: "Nova conversa: o Cyno começa do zero na próxima mensagem" });
    this.emitStatus();
    return this.state();
  }

  /**
   * Troca o motor/modelo/esforço (vale nos modelos padrão globais). O processo vivo reinicia quando
   * estiver livre; trocar de motor abre uma conversa nova (cada CLI guarda a sua).
   */
  async setChoice(choice: ModelChoice): Promise<CynoState> {
    const before = this.choice();
    const defaults = this.deps.modelDefaults.get();
    await this.deps.modelDefaults.set({ ...defaults, cyno: structuredClone(choice) });
    this.terminals.sync(this.agent());
    if (before.engine !== choice.engine) {
      this.chat({ kind: "status", status: "resumed", message: `Motor trocado para ${describeModelChoice(choice)}: cada CLI guarda a própria conversa, então o Cyno recomeça do zero neste motor` });
      this.session.forgetHistory();
    } else if (before.model !== choice.model || before.effort !== choice.effort) {
      this.chat({ kind: "status", status: "resumed", message: `Modelo trocado para ${describeModelChoice(choice)}: vale na próxima vez que ele acordar` });
    }
    this.emitStatus();
    return this.state();
  }

  // ---------- MCP ----------

  /** Ferramentas do Cyno (token de escopo "platform"). */
  tools(): McpTool[] {
    const agenda = this.deps.agenda ? agendaTools({ agenda: this.deps.agenda, actor: { kind: "cyno" }, now: this.deps.now, workspaceName: (id) => this.deps.workspaces.list().find((workspace) => workspace.id === id)?.name }) : [];
    const mural = this.deps.mural ? cynoMuralTools({ mural: this.deps.mural, workspaces: () => this.deps.workspaces.list().map((workspace) => ({ id: workspace.id, name: workspace.name })), workspaceName: (id) => this.deps.workspaces.list().find((workspace) => workspace.id === id)?.name }) : [];
    return [...this.platformToolList(), ...agenda, ...mural, ...this.jointToolList(), ...this.structureToolList()];
  }

  /** Projetos conjuntos: criar (uma parte por workspace), ler o estado por código e cancelar. */
  private jointToolList(): McpTool[] {
    return jointTools({
      create: (input) => {
        const { joint, duplicate } = this.joints.create(input);
        return { id: joint.id, title: joint.title, duplicate, parts: joint.parts.map((part) => ({ ref: part.ref, workspace: part.workspace, title: part.title, started: part.status !== "esperando", dependsOn: part.dependsOn })) };
      },
      status: (id) => this.joints.statusText(id),
      cancel: async (id, reason) => {
        const joint = await this.cancelJoint(id, reason);
        return `Joint project ${joint.id} cancelled. Tell the owner in one sentence.`;
      },
    });
  }

  /** `GET /api/cyno/joints`: os projetos conjuntos com o estado de cada parte (por código). */
  jointViews(): JointView[] {
    return this.joints.views();
  }

  cancelJoint(id: string, reason: string): Promise<JointProject> {
    return this.joints.cancel(id, reason);
  }

  setJointPaused(id: string, paused: boolean): Promise<JointProject> {
    return this.joints.setPaused(id, paused);
  }

  retryJointPart(id: string, ref: string): Promise<JointProject> {
    return this.joints.retry(id, ref);
  }

  /** Estrutura: as do Maestro com `workspace`, as só do Cyno e as perigosas (que apenas registram o pedido de OK). */
  private structureToolList(): McpTool[] {
    const host = { workspaces: this.deps.workspaces, simulated: this.deps.simulated === true };
    const scoped = scopedStructureTools(host);
    return [...scoped.tools, scoped.roomOptions, scopedGetTeam(host), ...maestroToolBridge(host), ...cynoStructureTools(this.structure.toolDeps())];
  }

  // ---------- Confirmações e propostas (rotas do dono) ----------

  confirmations() {
    return this.structure.listConfirmations();
  }

  approveConfirmation(id: string) {
    return this.structure.approve(id);
  }

  rejectConfirmation(id: string) {
    return this.structure.reject(id);
  }

  proposals() {
    return this.structure.listProposals();
  }

  approveProposal(id: string) {
    return this.structure.approveProposal(id);
  }

  rejectProposal(id: string) {
    return this.structure.rejectProposal(id);
  }

  private platformToolList(): McpTool[] {
    return platformTools({
      cards: () => this.cards.cards(),
      waiting: () => this.waiting(),
      setSummary: async (workspace, text) => (await this.writeSummary(workspace, text, "cyno")).stored,
      usageReport: () => this.usageText(),
      today: (workspace) => this.todayText(workspace),
      dayStats: (input) => this.dayStatsText(input),
      metrics: (input) => this.metricsTextOf(input),
      report: (input) => this.reportTextOf(input),
      ...(this.deps.awayText ? { away: this.deps.awayText } : {}),
      requests: this.requests.toolDeps(),
    });
  }

  /** O texto do `get_day_stats` (a plataforma somada ou um workspace); só leitura, calculado por código. */
  private async dayStatsText(input: { day?: string; workspace?: string }): Promise<string | undefined> {
    const checked = dayOrError(input.day, this.deps.now());
    if ("error" in checked) throw new Error(checked.error.text);
    if (input.workspace) {
      const runtime = this.deps.workspaces.find(input.workspace);
      if (!runtime) return undefined;
      const name = this.deps.workspaces.list().find((workspace) => workspace.id === input.workspace)?.name;
      return renderDayStats(await runtime.dayStats(checked.day), { workspace: input.workspace, ...(name ? { workspaceName: name } : {}) });
    }
    return renderPlatformDayStats(await platformDayStatsOf(this.deps.workspaces, checked.day));
  }

  /** O texto do `get_metrics`: um workspace (completo) ou todos (um bloco curto cada); só leitura, calculado por código. */
  private async metricsTextOf(input: Parameters<typeof metricsText>[1] & { workspace?: string }): Promise<string | undefined> {
    const { workspace, ...rest } = input;
    const now = this.deps.now();
    const nameOf = (id: string) => this.deps.workspaces.list().find((item) => item.id === id)?.name ?? id;
    if (workspace) {
      const runtime = this.deps.workspaces.find(workspace);
      return runtime ? metricsText((window) => runtime.metrics(window), rest, now, { workspaceName: nameOf(workspace) }) : undefined;
    }
    const blocks: string[] = [];
    for (const item of this.deps.workspaces.list()) {
      const runtime = this.deps.workspaces.find(item.id);
      if (runtime) blocks.push(await metricsText((window) => runtime.metrics(window), { group_by: "none", ...rest }, now, { workspaceName: item.name, defaultMetrics: ["throughput", "approval_wait", "blocked", "rejection"] }));
    }
    return blocks.join("\n\n");
  }

  /** O texto do `get_report`: o relatório congelado de um workspace, ou a semana da plataforma; só leitura (gera o que falta de um período fechado). */
  private async reportTextOf(input: ReportInput & { workspace?: string; scope: "workspace" | "platform" }): Promise<string | undefined> {
    if (input.scope === "platform") {
      if (!this.deps.platformReports) throw new Error("The platform report is not available here.");
      const report = await this.deps.platformReports.ensure(input.period);
      if (!report) throw new Error(`"${input.period}" is not a closed week yet (use "latest" or a week like "2026-W46").`);
      return input.format === "markdown" ? renderPlatformReportMarkdown(report) : renderPlatformReportText(report);
    }
    const runtime = input.workspace ? this.deps.workspaces.find(input.workspace) : undefined;
    if (!runtime) return undefined;
    return reportText((kind, period) => runtime.reports.ensure(kind, period, "mcp"), input, runtime.retro);
  }

  /** O texto do `get_today` (a plataforma ou um workspace); só leitura, calculado por código. */
  private todayText(workspace?: string): string | undefined {
    const now = this.deps.now();
    if (workspace) {
      const runtime = this.deps.workspaces.find(workspace);
      return runtime ? renderToday(runtime.today()) : undefined;
    }
    return renderPlatformToday(platformTodayOf(this.deps.workspaces, this.deps.agenda ?? { list: () => [] }, now));
  }

  // ---------- Fichas ----------

  /** Os workspaces como o índice das fichas os enxerga. */
  private sources(): CardSource[] {
    return this.deps.workspaces.list().flatMap((workspace) => {
      const runtime = this.deps.workspaces.find(workspace.id);
      return runtime ? [this.sourceOf(workspace, runtime)] : [];
    });
  }

  private sourceOf(workspace: Workspace, runtime: WorkspaceRuntime): CardSource {
    return {
      id: workspace.id,
      name: workspace.name,
      subscribe: (listener) => runtime.hub.subscribe((event) => listener(event)),
      onSummaryChange: (listener) => runtime.cardSummary.onChange(listener),
      read: () => ({
        summary: runtime.cardSummary.get(),
        office: runtime.store.snapshot(),
        terminals: runtime.terminals.snapshot(),
        access: runtime.access(),
        connectors: runtime.connectors.list(),
        routines: runtime.routines.list(),
        projects: expandAvulsas(runtime.plans.list()),
        forYou: runtime.forYou.list(),
        engineBlocked: (engine) => this.deps.availability?.block(engine as AgentEngine) !== undefined,
        usage: this.deps.usage?.snapshot() ?? [],
        turns5h: runtime.terminals.agentUsage.summary().agents.reduce((total, agent) => total + agent.turns, 0),
        // Os números da Gestão (bloco da página do Cyno): o mesmo `computeMetrics` da aba, em modo leve.
        metrics: runtime.metricsSnapshot([], { light: true }),
      }),
      usage: (fromMs) => runtime.usageSince(fromMs),
    };
  }

  /** A semana da plataforma (a guardada, ou montada agora se a semana já fechou); undefined = ainda não fechou ou o relatório da plataforma não existe aqui. */
  platformReport(period: string | undefined): Promise<PlatformReport | undefined> {
    return this.deps.platformReports?.ensure(period) ?? Promise.resolve(undefined);
  }

  /** `GET /api/cyno/cards`. */
  cardList(): Card[] {
    return this.cards.cards();
  }

  /** `GET /api/cyno/waiting`: o "Esperando você" de todos os workspaces, do mais antigo ao mais novo. */
  waiting(): WaitingItem[] {
    const items = this.cards.waiting((id) => {
      const runtime = this.deps.workspaces.find(id);
      if (!runtime) return [];
      const agents = runtime.store.snapshot().agents;
      return pendingWithAgents(runtime.forYou.list(), (agentId) => agents.find((agent) => agent.id === agentId)?.name);
    });
    // Projeto conjunto travado (uma parte falhou ou foi cancelada): o dono decide, então aparece aqui também.
    return [...items, ...this.joints.waitingItems()].sort((a, b) => a.at.localeCompare(b.at));
  }

  private summaryStore(workspace: string) {
    const runtime = this.deps.workspaces.find(workspace);
    if (!runtime) throw new HttpError(404, "Workspace não encontrado");
    return runtime.cardSummary;
  }

  /** Escreve a frase da ficha (o dono sempre; o Cyno vira sugestão sobre a frase do dono). */
  async writeSummary(workspace: string, text: string, by: "dono" | "cyno"): Promise<SummaryWrite> {
    try {
      return await this.summaryStore(workspace).write(text, by);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, errorMessage(error));
    }
  }

  /** O dono descarta a sugestão de frase de uma IA. */
  dismissSummaryProposal(workspace: string): Promise<unknown> {
    return this.summaryStore(workspace).dismissProposal();
  }

  /** O texto do `get_usage`: cota por motor, e quem mais gastou (todos os workspaces e o próprio Cyno). */
  private async usageText(): Promise<string> {
    const names = new Map<string, string>();
    const agents: AgentUsageTally[] = [];
    let since = this.terminals.agentUsage.summary().since;
    const add = (summary: AgentUsageResponse, prefix: string, nameOf: (agentId: string) => string) => {
      if (summary.since < since) since = summary.since;
      for (const tally of summary.agents) {
        const id = `${prefix}${tally.agentId}`;
        names.set(id, nameOf(tally.agentId));
        agents.push({ ...tally, agentId: id });
      }
    };
    add(this.terminals.agentUsage.summary(), "", () => CYNO_USAGE_LABEL);
    for (const workspace of this.deps.workspaces.list()) {
      const runtime = this.deps.workspaces.find(workspace.id);
      if (!runtime) continue;
      const office = runtime.store.snapshot();
      add(runtime.terminals.agentUsage.summary(), `${workspace.id}/`, (agentId) => `${workspace.name} · ${office.agents.find((agent) => agent.id === agentId)?.name ?? agentId}`);
    }
    agents.sort((a, b) => b.inputTokens + b.outputTokens + b.cacheCreationTokens - (a.inputTokens + a.outputTokens + a.cacheCreationTokens) || b.turns - a.turns);
    return usageReport({
      usages: this.deps.usage?.snapshot() ?? [],
      engines: (await this.deps.engines?.()) ?? [],
      availability: this.deps.availability ? (engine) => this.deps.availability!.block(engine) : undefined,
      agentUsage: { since, agents },
      names,
      now: this.deps.now().getTime(),
    });
  }

  // ---------- Ciclo de vida ----------

  /** Desliga: para o processo (com calma), espera as gravações pendentes. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offAvailability?.();
    this.offCards?.();
    this.offAgenda?.();
    this.offMural?.();
    clearInterval(this.digestTimer);
    this.cards.close();
    this.requests.close();
    this.joints.close();
    this.structure.close();
    this.session.detach();
    this.bridge?.close("Servidor desligando");
    this.bridge = undefined;
    await this.terminals.closeAll();
    await this.queue.idle();
    this.listeners.clear();
  }

  // ---------- Infra ----------

  /** O "agente" Cyno (sem workspace): o motor/modelo/esforço vêm dos modelos padrão; nunca terminal nem navegador. */
  private agent(): Agent {
    const choice = this.choice();
    return {
      id: CYNO_AGENT_ID,
      teamId: CYNO_AGENT_ID,
      name: CYNO_NAME,
      role: "Agente da plataforma",
      instructions: "",
      avatar: { ...MAESTRO_AVATAR },
      status: "idle",
      engine: choice.engine,
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
      internet: true,
      browser: false,
      terminal: false,
    };
  }

  /** O escritório sintético do gerenciador de terminais: um agente, sem salas (então nunca é PTY nem Maestro). */
  private office(): OfficeState {
    return { rooms: [], teams: [], agents: [this.agent()], tasks: [] };
  }

  private chat(body: AgentLogBody): void {
    this.agentLog.append({ taskId: conversationLogId(CYNO_AGENT_ID, this.deps.now()), agentId: CYNO_AGENT_ID }, body);
  }

  private emit(event: CynoServerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Publica o estado se mudou (a tela mostra dormindo/acordando/trabalhando ao vivo). */
  private emitStatus(): void {
    if (this.closed) return;
    const state = this.state();
    const key = JSON.stringify({ ...state, updatedAt: undefined });
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.emit({ type: "cyno:status", state });
  }

  private onLogEvent(event: ServerEvent): void {
    if (event.type === "agent:log") this.emit({ type: "cyno:log", entry: event.entry });
  }

  private onTerminalPublish(event: ServerEvent): void {
    if (event.type === "agent:terminal") this.emitStatus();
  }

  private onTerminalEvent(_id: string, terminal: TerminalAgent, event: TerminalEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "turn_start": {
        this.bridge?.close("Turno encerrado");
        const logId = conversationLogId(CYNO_AGENT_ID, this.deps.now());
        this.bridge = terminalLogBridge(runnerLogHooks(this.agentLog, { taskId: logId, agentId: CYNO_AGENT_ID, provider: terminal.provider }, () => !this.closed));
        this.emitStatus();
        return;
      }
      case "turn_end": {
        this.bridge?.close("Turno encerrado");
        this.bridge = undefined;
        this.session.trackSize(event.contextTokens);
        const text = event.result.trim();
        // Turno de uma pergunta de Maestro (`ask_cyno`): a resposta vai ao Maestro e ao chat como linha discreta, sem balão.
        if (event.tag?.startsWith(ASK_TAG_PREFIX)) this.requests.settleAskTurn(event.tag.slice(ASK_TAG_PREFIX.length), event.ok, text);
        else if (event.ok && text) this.chat({ kind: "chat", from: "agent", text });
        else if (!event.ok) {
          const block = this.session.blocked();
          const message = block ? `Cyno ${engineBlockLabel(block, this.deps.now().getTime())}: a resposta foi interrompida` : `O Cyno não respondeu: ${text.slice(0, 200) || "erro na CLI"}`;
          this.chat({ kind: "status", status: "failed", message });
        }
        this.emitStatus();
        return;
      }
      case "dropped":
        // A mensagem não chegou (terminal parou ou desistiu de subir): a próxima confere a conversa de novo.
        this.session.forgetHistory();
        this.chat({ kind: "status", status: "failed", message: `A mensagem não chegou ao Cyno: ${event.reason}` });
        return;
      default:
        this.bridge?.handle(event);
    }
  }

  /** Os ganchos da sessão de conversa: o terminal do Cyno, o aviso quando a cota acaba e a conversa nova sem resumo. */
  private hooks(): ConversationHooks {
    return {
      label: "Cyno",
      sessionKeyPrefix: "cyno",
      log: this.log,
      isStopped: () => this.closed,
      locate: () => ({ id: CYNO_AGENT_ID, terminal: this.terminals.get(CYNO_AGENT_ID) }),
      onTerminalEvent: (id, terminal, event) => this.onTerminalEvent(id, terminal, event),
      blocked: (): EngineBlock | undefined => {
        const choice = this.choice();
        // Freebuff: quem já tem a hora aberta (o próprio Cyno) nunca espera por ela.
        return this.deps.availability?.block(choice.engine, choice.model, { agentId: CYNO_AGENT_ID, workspaceId: CYNO_PLATFORM_ID });
      },
      // Nunca renova sozinho: só o botão "Nova conversa".
      rotateTokens: () => 0,
      // O que abre uma conversa nova (a primeira de todas ou "Nova conversa"): o digest das fichas, por código.
      primer: async () => withOpenRequests(this.cards.digest(), this.requests.openLines()),
      framePrimer: (primer, message) => `${frameDigest(primer)}\n\n---\n\n${message}`,
      // "Nova conversa" começa do zero, só com o digest das fichas (nada da conversa antiga).
      seed: (_tag, primer) => (primer ? frameDigest(primer) : ""),
      onUnavailable: (_tag, error) => this.chat({ kind: "status", status: "failed", message: `O terminal do Cyno não está disponível: ${errorMessage(error)}` }),
      onHold: (_tag, first, block) => {
        if (first) this.chat({ kind: "status", status: "waiting", message: `Cyno ${engineBlockLabel(block, this.deps.now().getTime())}: a mensagem espera` });
        this.emitStatus();
      },
      onResume: () => {
        this.chat({ kind: "status", status: "resumed", message: "O motor do Cyno voltou: a mensagem seguiu" });
        return true;
      },
    };
  }

  private flagFile(): string {
    return path.join(this.paths.cynoDir, NEW_CONVERSATION_FLAG);
  }

  private async pendingNewConversation(): Promise<boolean> {
    try {
      return (JSON.parse(await readFile(this.flagFile(), "utf8")) as { pending?: unknown }).pending === true;
    } catch {
      return false;
    }
  }

  private async setPendingNewConversation(pending: boolean): Promise<void> {
    try {
      if (pending) {
        await mkdir(this.paths.cynoDir, { recursive: true });
        await writeJsonAtomic(this.flagFile(), { pending: true, at: this.deps.now().toISOString() });
      } else {
        await rm(this.flagFile(), { force: true });
      }
    } catch (error) {
      this.log.warn({ err: error }, "não foi possível gravar o pedido de nova conversa do Cyno");
    }
  }
}

function statusOf(status: string | undefined): CynoStatus {
  switch (status) {
    case "starting":
      return "waking";
    case "busy":
      return "working";
    case "idle":
      return "awake";
    default:
      return "sleeping";
  }
}

/** O cabeçalho do digest que abre uma conversa (montado por código; o Cyno detalha com `get_workspace_card`). */
function frameDigest(digest: string): string {
  return `[Platform context, built by code with no AI. The cards of the workspaces right now; for the full card use get_workspace_card.]\n${digest}`;
}

/** O digest das fichas com os pedidos que o Cyno enviou e ainda estão abertos (abre uma conversa nova). */
function withOpenRequests(digest: string, lines: string[]): string {
  return lines.length === 0 ? digest : `${digest}\n\n## Requests you sent that are still open\n${lines.join("\n")}`;
}

/** A mensagem do dono com o que mudou nas fichas desde a última vez (nada mudou, nada vai). */
export function withCardChanges(message: string, changes: string[]): string {
  return changes.length === 0 ? message : `${message}\n\n(Workspace changes since your last message, by code: ${changes.join(" | ")})`;
}
