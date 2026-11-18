import os from "node:os";
import path from "node:path";
import websocket from "@fastify/websocket";
import { ENGINE_RETRY_PATH, engineRetryBodySchema, INITIAL_MODEL_DEFAULTS, isActiveTaskStatus, PUSH_OWNER_PRESENT_MS, type EngineInfo, type EnginesResponse, type ModelDefaults, type OneShotEngineId, type RunMode, type ServerEvent } from "@cyno/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { AgendaService } from "./platform/agenda/agenda-service";
import { AttentionService } from "./platform/attention/service";
import { registerAttentionRoutes } from "./routes/attention";
import { registerPushRoutes } from "./routes/push";
import { PushService, PushStore, webPushSender, type PushSender } from "./platform/attention/push";
import { registerBudgetRoutes } from "./routes/budget";
import { registerAwayRoutes } from "./routes/away";
import { AwayService, renderAway } from "./platform/owner/away-service";
import { OwnerStore } from "./platform/owner/owner-store";
import { BudgetWatcher } from "./platform/budget/budget-watcher";
import { registerAgendaRoutes } from "./routes/agenda";
import { MuralService } from "./platform/mural/mural-service";
import { registerMuralRoutes } from "./routes/mural";
import { CynoService } from "./platform/cyno/cyno-service";
import { registerCynoRoutes } from "./routes/cyno";
import { registerPlatformTodayRoute } from "./routes/today";
import { registerPlatformDayStatsRoute } from "./routes/day-stats";
import { registerAuth, type AuthOptions } from "./platform/auth/routes";
import { AuthStore } from "./platform/auth/store";
import { installErrorHandlers } from "./platform/http/errors";
import { registerHealthRoutes } from "./routes/health";
import { registerPublicBoardRoute } from "./routes/board-share";
import { BoardShareStore } from "./workspace/board/share-store";
import { registerVersionRoutes } from "./routes/version";
import { VersionService } from "./platform/version/service";
import type { NpmRunner } from "./platform/version/updater";
import { updateConfigFromEnv } from "./platform/version/checker";
import { REPO_ROOT } from "./config";
import { registerWorkspaceScopedRoutes } from "./routes/scope";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerWsRoute } from "./routes/ws";
import { registerSceneLiveRoute } from "./routes/scene-live";
import { sceneLiveEnabled } from "./workspace/scene-live/service";
import { DEFAULT_MAESTRO_TIMINGS, type MaestroTimings } from "./sim/coordinator";
import { registerMcpRoute } from "./mcp/route";
import { registerUsageRoutes } from "./routes/usage";
import { registerEngineRoutes, type EngineRoutesDeps } from "./routes/engines";
import { EngineSettingsStore } from "./platform/models/engine-settings";
import { registerSettingsRoutes } from "./routes/settings";
import { PlatformSettings } from "./platform/settings/platform-settings";
import { registerSystemActivityRoutes } from "./routes/activity";
import { setActivityLog, type ActivityLog } from "./workspace/activity/log";
import { registerSpendSettingsRoutes } from "./routes/usage-history";
import { RetentionService } from "./platform/retention/retention";
import { McpTokens } from "./mcp/tokens";
import { ModelDefaultsStore } from "./platform/models/defaults-store";
import { defaultProbe, detectEngines, EngineCatalog, type OneShotDetect } from "./engines/terminals/engines";
import { errorMessage } from "./util/text";
import { DEFAULT_TERMINALS_CONFIG, type TerminalsConfig } from "./engines/terminals/manager";
import type { AgentRunner } from "./engines/runner/types";
import { AccountUsagePoller, type AccountUsagePollerOptions } from "./engines/usage/account-poller";
import { AntigravityUsagePoller, type AntigravityUsagePollerOptions } from "./engines/usage/antigravity-poller";
import { EngineAvailability } from "./engines/usage/availability";
import { manicodeDirOf } from "./engines/freebuff/files";
import type { FreebuffRuntime } from "./engines/freebuff/runtime";
import { FreebuffService } from "./engines/freebuff/service";
import { findExecutable } from "./engines/terminals/engine-status";
import { EngineInstaller, type InstallFetch } from "./engines/install/installer";
import type { InstallRecipe } from "./engines/install/recipes";
import { engineDirs } from "./engines/install/recipes";
import { sweepEngineHomes } from "./engines/terminals/engine-homes";
import { GatewaySlots } from "./engines/terminals/gateway-slots";
import { stopAllGateways } from "./engines/terminals/hermes-adapter";
import { OneShotEngines, type OneShotEnginesDeps } from "./engines/terminals/one-shot-engines";
import { readOpenclawBase } from "./engines/terminals/openclaw-adapter";
import { OpenRouterModelsCache, type OpenRouterClientOptions } from "./platform/openrouter/client";
import { OpenRouterKeyStore } from "./platform/openrouter/key-store";
import { SpendSettingsStore } from "./engines/usage/spend-settings";
import { SubscriptionUsageTracker } from "./engines/usage/subscription-usage";
import { loadUsageFile, persistUsage } from "./engines/usage/usage-file";
import { WorkspaceManager } from "./platform/workspaces/manager";
import { platformPaths } from "./store/paths";
import { LibraryService, libraryDirOf, type LibraryServiceOptions } from "./library/library-service";
import { migrateConnectorsToLibrary } from "./library/connectors/migrate";
import { registerLibraryRoutes } from "./routes/library";
import { registerLibraryAppsRoutes } from "./routes/library-apps";
import { AppInstaller, type AppInstallerDeps } from "./library/apps/installer";
import { AppToolRunner } from "./library/apps/tool-runner";
import { APP_CATALOG } from "./library/apps/catalog";
import { loadCustomCatalog } from "./library/apps/catalog/custom";
import { appsPaths } from "./library/apps/paths";
import { realProbe } from "./library/apps/requirements";
import { AppsStore } from "./library/apps/store";
import { defaultExecutors } from "./library/apps/steps";
import { WriteQueue } from "./store/write-queue";
import { activity } from "./workspace/activity/log";
import type { RuntimeOptions } from "./workspace/runtime";

declare module "fastify" {
  interface FastifyInstance {
    /** O Cyno, o agente da plataforma (acima dos workspaces). */
    cyno: CynoService;
    /** "Sua agenda": o tempo do dono, única para a plataforma. */
    agenda: AgendaService;
    /** O mural da plataforma: o que os workspaces compartilham entre si. */
    mural: MuralService;
    /** A cadeia de atenção: os alertas de quando algo espera o dono. */
    attention: AttentionService;
    /** Todos os workspaces (cada um com store, fila, orquestrador e hub próprios). */
    workspaces: WorkspaceManager;
    library: LibraryService;
    /** Instalador dos apps externos da Biblioteca (catálogo, pasta de apps, mini teste). */
    apps: AppInstaller;
    appRunner: AppToolRunner;
    /** Os links públicos dos Quadros (DATA_DIR/board-shares.json). */
    boardShares: BoardShareStore;
    /**
     * Retoma os workspaces (filas, Maestro, terminais das CLIs) uma vez só: o mesmo boot do `bootOn`.
     * O index.ts espera depois do listen para sair com erro se o boot falhar.
     */
    bootWorkspaces: () => Promise<void>;
  }
}

export type AppDeps = {
  /** DATA_DIR já preparado (workspaces.json; veja seedDataDir e migrateLegacyLayout). */
  dataDir: string;
  logger?: FastifyServerOptions["logger"];
  /** Modo simulado (só testes): sem isto, só há agentes e Maestro reais; agente sem motor falha a tarefa com mensagem clara. */
  runner?: AgentRunner;
  doneLingerMs?: number;
  /** Quanto uma tarefa que espera o usuário segura a vaga do agente (padrão 2 min). */
  approvalParkMs?: number;
  /** Padrão: triagem de 1–3 s e revisão de 1 s. */
  maestro?: Partial<MaestroTimings>;
  wsHeartbeatMs?: number;
  /** Intervalo da conferência por relógio da cadeia de atenção (padrão 30 s; testes encurtam). */
  attentionTickMs?: number;
  /** Quem manda o Web Push (o aviso com o site fechado). Os testes passam um falso: nunca falam com um serviço de push de verdade. */
  pushSender?: PushSender;
  /** Espera para juntar uma rajada de alertas num aviso só (padrão 3 s). */
  pushBatchMs?: number;
  now?: () => Date;
  /** Terminais de CLI (agentes reais). Padrão: `claude`, MCP em 127.0.0.1:3068, ocioso 15 min. */
  terminals?: Partial<TerminalsConfig>;
  /**
   * Consulta do uso da CONTA Claude na Anthropic (endpoint não documentado). Padrão: desligada
   * (testes nunca falam com a Anthropic); o index.ts liga com CLAUDE_USAGE_POLL_MS.
   */
  accountUsage?: Omit<AccountUsagePollerOptions, "tracker" | "now" | "log">;
  /**
   * Consulta da cota da conta Google no Antigravity (`agy -p /usage --output-format json`). Padrão:
   * desligada (testes nunca rodam o agy de verdade); o index.ts liga com ANTIGRAVITY_USAGE_POLL_MS.
   */
  antigravityUsage?: Omit<AntigravityUsagePollerOptions, "tracker" | "now" | "log">;
  /** Tela Motores: sondas e testes falsos nos testes (o estado e o "Testar" de verdade são o padrão). */
  /**
   * Freebuff (motor de agente de time, cobrado por hora aberta). Padrão: o executável `freebuff` do PATH (ou de
   * ~/.local/bin) e a pasta de dados `~/.config/manicode` (`FREEBUFF_HOME`). Os testes trocam o executável por
   * uma TUI falsa e o `homeDir`/`manicodeDir` por uma pasta temporária.
   */
  freebuff?: Partial<Omit<FreebuffRuntime, "service">>;
  /**
   * OpenClaw e Hermes (tela Motores): a receita de instalação, o download e o OpenRouter são trocados por falsos nos testes
   * (nada de rede, nada de instalar de verdade); o turno de teste real usa as CLIs falsas dos `terminals`.
   */
  oneShot?: { recipe?: (engine: OneShotEngineId) => InstallRecipe; installFetch?: InstallFetch; openrouter?: OpenRouterClientOptions; turn?: OneShotEnginesDeps["turn"]; turnTimeoutMs?: number; fenceSupport?: OneShotEnginesDeps["fenceSupport"] };
  engineTools?: Partial<Pick<EngineRoutesDeps, "probe" | "pathEnv" | "homeDir" | "testRunner" | "testMinGapMs" | "testTimeoutMs">>;
  /** Detecção dos motores (GET /api/engines). Padrão: `--version` dos binários de `terminals`. */
  detectEngines?: () => Promise<EngineInfo[]>;
  /**
   * Retenção do histórico em disco. `claudeProjectsDir`: onde o Claude Code guarda as conversas
   * (sem ela, nada é apagado lá: o padrão nos testes); `autoRun`: limpa no boot e uma vez por dia
   * (padrão: desligado; o index.ts liga).
   */
  retention?: { claudeProjectsDir?: string; autoRun?: boolean };
  /**
   * Versão do app e aviso de atualização. `autoCheck`: liga a verificação automática (1 min depois da subida e a cada 6 h;
   * padrão: desligada, o index.ts liga conforme `CYNO_UPDATE_CHECK`). `applyEnabled`: liga o botão "Baixar atualização"
   * (padrão: desligado; o index.ts liga conforme `CYNO_UPDATE_APPLY`). Os testes passam `rootDir` (um repositório temporário),
   * `fetch` falso, `runMode` e `npm` (executor falso do `npm install`).
   */
  version?: { rootDir?: string; autoCheck?: boolean; branch?: string; fetch?: typeof fetch; applyEnabled?: boolean; runMode?: RunMode; npm?: NpmRunner };
  /** Conectores (servidores MCP externos): teste automático e clientes falsos nos testes. */
  connectors?: { autoTest?: boolean; gateway?: LibraryServiceOptions["gateway"]; allowStdio?: boolean };
  /** Skills da Biblioteca: onde procurar o `~/.claude` do dono para importar por cópia (padrão: o home do servidor; os testes passam uma pasta falsa). */
  skills?: { homeDir?: string };
  /** Apps externos: catálogo, executores, probe da máquina, exec e fetch falsos nos testes. */
  apps?: Partial<Pick<AppInstallerDeps, "catalog" | "executors" | "probe" | "exec" | "fetch" | "which" | "env">>;
  /** Navegador compartilhado (padrão: ligado, fecha depois de 10 min sem uso). */
  browser?: RuntimeOptions["browser"];
  /** Intervalo do vigia das rotinas em ms (só para teste; padrão 10 min). */
  routineTickMs?: RuntimeOptions["routineTickMs"];
  /**
   * Modelos padrão globais quando DATA_DIR/models.json ainda não existe (padrão: INITIAL_MODEL_DEFAULTS,
   * Claude Opus/Sonnet/Haiku). Os testes passam padrões simulados para não criar agentes reais.
   */
  initialModelDefaults?: ModelDefaults;
  /**
   * Quando os workspaces retomam (filas, Maestro, terminais das CLIs): no `ready` (padrão: testes com
   * app.inject, sem porta) ou depois que a porta abre (`listen`, o index.ts). Com `listen`, as CLIs
   * que sobem no boot já acham o MCP do escritório aceitando conexões.
   */
  bootOn?: "ready" | "listen";
  /**
   * Atividade (DATA_DIR/activity e workspaces/<ws>/activity) que os observadores do server alimentam.
   * Padrão: nenhuma (os testes não gravam); o index.ts liga. As rotas de Atividade leem a pasta de qualquer jeito.
   */
  activity?: ActivityLog;
  /** Ociosidade do Cyno em ms antes de dormir (testes e `CYNO_IDLE_MS`); ausente = 10 min. */
  cynoIdleMs?: number;
  /** Senha de acesso (DATA_DIR/auth.json): pausa após erro e relógio; os testes ajustam. */
  auth?: AuthOptions;
};

/** Monta a aplicação Fastify (sem dar listen) — testável com app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { logger = false, now = () => new Date() } = deps;
  z.config(z.locales.ptBR()); // mensagens de validação em pt-BR
  const app = Fastify({ logger });
  if (deps.activity) setActivityLog(deps.activity);
  await app.register(websocket);
  installErrorHandlers(app);
  // Senha de acesso: o portão (onRequest) vem antes de qualquer rota; sem auth.json o app fica fechado até a configuração inicial (ou aberto com auth.open = CYNO_AUTH=off).
  const authStore = new AuthStore(deps.dataDir, now);
  registerAuth(app, authStore, deps.dataDir, { now: () => now().getTime(), ...deps.auth });

  // Uso da assinatura (da conta): começa com o último valor salvo e grava a cada mudança.
  const usageFile = path.join(deps.dataDir, "usage.json");
  const usage = new SubscriptionUsageTracker(now);
  usage.restore(await loadUsageFile(usageFile));
  const usagePersistence = persistUsage(usage, usageFile, (error) => app.log.warn({ err: error }, "não foi possível gravar usage.json"));
  const accountUsage = deps.accountUsage ? new AccountUsagePoller({ ...deps.accountUsage, tracker: usage, now, log: app.log }) : undefined;
  const antigravityUsage = deps.antigravityUsage ? new AntigravityUsagePoller({ ...deps.antigravityUsage, tracker: usage, now, log: app.log }) : undefined;

  // Cotação USD→BRL da página Gastos (DATA_DIR/spend.json; as rotas de workspace leem pelo decorador).
  const spendSettings = await SpendSettingsStore.load(path.join(deps.dataDir, "spend.json"), app.log);
  app.decorate("spendSettings", spendSettings);
  const modelDefaults = await ModelDefaultsStore.load(path.join(deps.dataDir, "models.json"), deps.initialModelDefaults ?? INITIAL_MODEL_DEFAULTS, app.log);
  const engineSettings = await EngineSettingsStore.load(path.join(deps.dataDir, "platform", "engines.json"), app.log);
  const mcpTokens = new McpTokens();
  // As horas abertas do Freebuff (uma só para todos os workspaces: a hora é da conta) e o estado vai para o uso da assinatura.
  const freebuffService = await FreebuffService.open(path.join(deps.dataDir, "platform", "engine-sessions.json"), {
    now,
    publish: (detail) => usage.reportFreebuff(detail),
    log: app.log,
  });
  usage.reportFreebuff(freebuffService.detail());
  // Modo simulado: só quando o chamador injeta um runner (AGENT_RUNNER=mock; testes, e2e e laboratório).
  const simulated = deps.runner !== undefined;
  const terminals: TerminalsConfig = { ...DEFAULT_TERMINALS_CONFIG, ...deps.terminals };
  // OpenClaw e Hermes: um processo por turno; o modelo vem do OpenRouter, com a chave do painel (só estes dois processos a recebem).
  const openrouterKey = await OpenRouterKeyStore.open(path.join(deps.dataDir, "platform", "openrouter-key.json"));
  const openrouterModels = await OpenRouterModelsCache.open(path.join(deps.dataDir, "platform", "openrouter-models.json"));
  const savedPaths = engineSettings.paths();
  const oneShotDefaults = (engine: OneShotEngineId) => ({
    homeDir: engineDirs(deps.dataDir, engine).root,
    command: (savedPaths as Partial<Record<string, string>>)[engine] ?? engine,
    openrouterKey: () => openrouterKey.get(),
    // A forma de conta é lida a cada turno: trocar no painel vale já no próximo.
    account: () => engineSettings.account(engine),
    // A cerca de arquivos (Landlock): a opção da tela, lida a cada turno. Onde o computador não tem Landlock o adaptador ignora a opção.
    fence: () => engineSettings.fence(engine),
    ...(engineSettings.choices(engine).model ? { defaultModel: engineSettings.choices(engine).model! } : {}),
  });
  terminals.openclaw = { ...oneShotDefaults("openclaw"), ...(engineSettings.choices("openclaw").effort ? { defaultEffort: engineSettings.choices("openclaw").effort! } : {}), onCost: (usd) => void engineSettings.noteSpent("openclaw", usd, now().toISOString()), ...deps.terminals?.openclaw };
  // O teto de gateways do Hermes (cada agente em turno sobe um, ~270 MB): quem passa dele espera vaga. Lido a cada pedido (a tela Motores muda sem reiniciar).
  const hermesSlots = new GatewaySlots(() => engineSettings.maxGateways());
  engineSettings.onMaxGateways = () => hermesSlots.drain();
  terminals.hermes = { ...oneShotDefaults("hermes"), slots: hermesSlots, personalHome: path.join(deps.engineTools?.homeDir ?? os.homedir(), ".hermes"), ...deps.terminals?.hermes };
  terminals.openclawBase = () => readOpenclawBase(engineDirs(deps.dataDir, "openclaw").root);
  const freebuffCommand = deps.freebuff?.command ?? (await findExecutable("freebuff", process.env.PATH ?? "", os.homedir())) ?? "freebuff";
  terminals.freebuff = { manicodeDir: manicodeDirOf(), ...deps.freebuff, command: freebuffCommand, service: freebuffService };
  // OpenClaw e Hermes no seletor de motor (o serviço abre mais abaixo; a detecção só roda depois).
  const oneShotRef: { current?: OneShotEngines } = {};
  const oneShotDetect: OneShotDetect = async (engine) => {
    const status = await oneShotRef.current!.status(engine);
    return { available: status.state !== "not_installed", ...(status.fence?.active ? { fenced: true } : {}), ...(status.version ? { version: status.version } : {}), ...(status.notice ? { reason: status.notice } : {}), models: status.models ?? [] };
  };
  const detect =
    deps.detectEngines ??
    (() =>
      detectEngines(
        {
          claude: { command: terminals.claude.command ?? "claude", prefixArgs: terminals.claude.prefixArgs },
          gemini: { command: terminals.gemini?.command ?? "agy", prefixArgs: terminals.gemini?.prefixArgs },
        },
        undefined,
        { command: terminals.freebuff?.command ?? "freebuff", homeDir: deps.engineTools?.homeDir ?? os.homedir(), ...(deps.engineTools?.pathEnv ? { pathEnv: deps.engineTools.pathEnv } : {}), models: () => freebuffService.models().models },
        oneShotDetect,
      ));
  // Uma detecção nova (ex.: "Detectar de novo" depois de instalar a CLI) pode liberar as filas paradas.
  const engines = new EngineCatalog(async () => {
    // O motor "mock" (simulado) só aparece com o modo simulado ligado (testes).
    const list = (await detect()).filter((info) => simulated || info.engine !== "mock");
    setImmediate(() => availability.notify());
    return list;
  });
  // Cota esgotada ou CLI ausente: os agentes daquele motor esperam (nunca trocam de motor sozinhos).
  const availability: EngineAvailability = new EngineAvailability({ usage, engines: () => engines.known(), now });
  // "Sua agenda": o tempo do dono, uma só para a plataforma inteira (os agentes de todos os workspaces marcam nela).
  const agendaNames = new Map<string, string>();
  const agenda = await AgendaService.openAt(deps.dataDir, now, { workspaceName: (id) => agendaNames.get(id) });
  // O Cyno abre depois dos workspaces: a ponte para o `ask_cyno` dos Maestros lê dele quando alguém pergunta.
  // eslint-disable-next-line prefer-const -- atribuído depois, quando o Cyno abre (as pontes leem pela referência)
  let cynoRef: CynoService | undefined;
  // A Biblioteca da plataforma (conectores): migra os conectores antigos de cada workspace (uma vez) e abre.
  // eslint-disable-next-line prefer-const -- atribuído depois, quando o gerenciador abre
  let managerRef: WorkspaceManager | undefined;
  await migrateConnectorsToLibrary({ dataDir: deps.dataDir, now, log: app.log });
  const platformSettings = await PlatformSettings.open(deps.dataDir);
  const library = await LibraryService.open({
    libraryDir: libraryDirOf(deps.dataDir),
    publishPlatform: (event) => managerRef?.listHub.publish(event),
    claudeList: { command: terminals.claude.command ?? "claude", prefixArgs: terminals.claude.prefixArgs },
    ...(deps.connectors?.autoTest !== undefined ? { autoTest: deps.connectors.autoTest } : {}),
    ...(deps.connectors?.gateway ? { gateway: deps.connectors.gateway } : {}),
    ...(platformSettings.stdioChoice() !== undefined ? { allowStdio: platformSettings.stdioChoice()! } : deps.connectors?.allowStdio !== undefined ? { allowStdio: deps.connectors.allowStdio } : {}),
    ...(deps.skills?.homeDir ? { skillsLocal: { homeDir: deps.skills.homeDir } } : {}),
    log: app.log,
    now,
  });
  const paths = appsPaths(deps.dataDir);
  const curatedCatalog = deps.apps?.catalog ?? APP_CATALOG;
  // O curado (versões fixadas por nós) mais o que o dono acrescentou em custom-catalog.json.
  const catalog = [...curatedCatalog, ...(await loadCustomCatalog(paths.libraryDir, curatedCatalog, (message) => app.log.warn(message)))];
  const appsStore = await AppsStore.open(paths, new WriteQueue());
  // As ferramentas dos apps sem MCP (conector `app`): valida, enfileira (uma por vez por app) e roda sem shell.
  const appRunner = new AppToolRunner({
    paths,
    resolve: (appId) => {
      const installed = appsStore.get(appId);
      const entry = installed ? catalog.find((candidate) => candidate.id === installed.catalogId) : undefined;
      return entry && installed ? { entry, installed: installed.state !== "desinstalando" } : undefined;
    },
    ...(deps.apps?.env ? { env: deps.apps.env } : {}),
    publish: (event) => managerRef?.listHub.publish(event),
    now,
    log: app.log,
  });
  await appRunner.load();
  library.setAppRunner(appRunner);
  const installer = new AppInstaller({
    paths,
    catalog,
    store: appsStore,
    runs: () => appRunner.list(),
    port: library.appPort(),
    probe: deps.apps?.probe ?? realProbe(deps.dataDir, paths.runtimesRoot),
    executors: deps.apps?.executors ?? defaultExecutors,
    ...(deps.apps?.exec ? { exec: deps.apps.exec } : {}),
    ...(deps.apps?.fetch ? { fetch: deps.apps.fetch } : {}),
    ...(deps.apps?.which ? { which: deps.apps.which } : {}),
    ...(deps.apps?.env ? { env: deps.apps.env } : {}),
    publish: (event) => managerRef?.listHub.publish(event),
    record: (action, summary, data) => activity({ category: "sistema", action, actor: "usuario", summary, data }),
    log: app.log,
    now,
  });
  await installer.recover();
  // O mural da plataforma: o que um workspace compartilha para os outros (os workspaces entram por `bind`, depois que o gerenciador abre).
  const mural = await MuralService.openAt(deps.dataDir, now, (error) => app.log.warn({ err: error }, "não foi possível gravar o mural"));
  const retention = new RetentionService({
    dataDir: deps.dataDir,
    claudeProjectsDir: deps.retention?.claudeProjectsDir,
    activeTaskIds: (workspaceId) =>
      new Set(manager.find(workspaceId)?.store.snapshot().tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id) ?? []),
    forgetLogs: (workspaceId, taskIds) => manager.find(workspaceId)?.agentLog.forget(taskIds, []),
    now,
    log: app.log,
  });
  await retention.load();
  // O prazo da lista viva das aprovações mudou: cada workspace carregado varre o arquivo na hora.
  retention.onChange((settings, before) => {
    if (settings.approvalsLiveDays !== before.approvalsLiveDays) void manager.sweepApprovals();
  });
  const manager = await WorkspaceManager.open(deps.dataDir, {
    // O prazo da lista viva das aprovações vem das configurações da plataforma (lido a cada varredura).
    approvalsLiveDays: () => retention.settings().approvalsLiveDays,
    library,
    agenda,
    mural,
    platformLink: () => cynoRef,
    usage,
    availability,
    modelDefaults,
    terminals,
    mcpTokens,
    engines: () => engines.list(),
    ...(deps.runner ? { runner: deps.runner } : {}),
    doneLingerMs: deps.doneLingerMs ?? 5000,
    ...(deps.approvalParkMs !== undefined ? { approvalParkMs: deps.approvalParkMs } : {}),
    maestro: { ...DEFAULT_MAESTRO_TIMINGS, ...deps.maestro },
    ...(deps.browser ? { browser: deps.browser } : {}),
    ...(deps.routineTickMs ? { routineTickMs: deps.routineTickMs } : {}),
    now,
    log: app.log,
  });
  managerRef = manager;
  mural.bind({ workspaceName: (id) => manager.list().find((workspace) => workspace.id === id)?.name, media: (id) => manager.find(id)?.media });
  app.decorate("workspaces", manager);
  app.decorate("mural", mural);
  app.decorate("library", library);
  app.decorate("apps", installer);
  app.decorate("appRunner", appRunner);
  app.decorate("agenda", agenda);
  for (const workspace of manager.list()) agendaNames.set(workspace.id, workspace.name);
  manager.listHub.subscribe((event) => {
    if (event.type === "workspaces:list") {
      agendaNames.clear();
      for (const workspace of event.workspaces) agendaNames.set(workspace.id, workspace.name);
    }
  });
  // A presença do dono (uma só, para todos os navegadores) e o resumo do "enquanto você estava fora".
  const owner = await OwnerStore.load(platformPaths(deps.dataDir).ownerFile);
  const awayHolder: { service?: AwayService } = {};
  // O Cyno nunca sobe no boot: o processo só acorda quando o dono fala.
  const cyno = await CynoService.open({
    platformReports: manager.platformReports,
    awayText: async () => (awayHolder.service ? renderAway(await awayHolder.service.last(), now().getTime()) : "No presence data yet."),
    dataDir: deps.dataDir,
    tokens: mcpTokens,
    terminals,
    usage,
    availability,
    engines: () => engines.list(),
    modelDefaults,
    workspaces: manager,
    agenda,
    mural,
    simulated,
    ...(deps.cynoIdleMs ? { idleMs: deps.cynoIdleMs } : {}),
    log: app.log,
    now,
  });
  cynoRef = cyno;
  app.decorate("cyno", cyno);

  // A cadeia de atenção: assina os workspaces (e o uso das CLIs) e avisa quando algo passa a esperar o dono.
  // Só liga depois do boot dos workspaces (`bootWorkspaces`): o que já esperava entra quieto, sem aviso.
  const attention = await AttentionService.open({
    file: platformPaths(deps.dataDir).attentionFile,
    now,
    log: app.log,
    usage: { subscribe: (listener) => usage.hub.subscribe((event) => listener(event)), snapshot: () => usage.snapshot() },
    subscribeList: (listener) => manager.listHub.subscribe((event) => (event.type === "workspaces:list" ? listener() : undefined)),
    sources: () =>
      manager.list().flatMap((workspace) => {
        const runtime = manager.find(workspace.id);
        if (!runtime) return [];
        return [
          {
            id: workspace.id,
            name: workspace.name,
            subscribe: (listener) => runtime.hub.subscribe((event) => listener(event)),
            read: () => ({
              forYou: runtime.forYou.list(),
              tasks: runtime.store.snapshot().tasks,
              projects: runtime.plans.list(),
              agents: runtime.store.snapshot().agents.map((agent) => ({ id: agent.id, name: agent.name, ...(agent.engine ? { engine: agent.engine } : {}) })),
              terminals: Object.values(runtime.terminals.snapshot()),
            }),
          },
        ];
      }),
    ...(deps.attentionTickMs ? { tickMs: deps.attentionTickMs } : {}),
  });
  app.decorate("attention", attention);

  // O aviso com o site fechado (Web Push): chaves VAPID e aparelhos em data/platform/push.json (0600).
  const pushStore = await PushStore.open(platformPaths(deps.dataDir).pushFile, app.log);
  const push = new PushService({
    store: pushStore,
    attention,
    ownerLooking: () => owner.activeWithin(now().getTime(), PUSH_OWNER_PRESENT_MS),
    send: deps.pushSender ?? webPushSender,
    now,
    log: app.log,
    ...(deps.pushBatchMs !== undefined ? { batchMs: deps.pushBatchMs } : {}),
  });
  push.start();

  const away = new AwayService({
    owner,
    now,
    usdBrl: () => spendSettings.usdBrl(),
    platformUsage: async (fromMs, toMs) => {
      await cyno.usageHistory.idle();
      return cyno.usageHistory.read(fromMs, toMs);
    },
    alerts: () => attention.list(),
    sources: () =>
      manager.list().flatMap((workspace) => {
        const runtime = manager.find(workspace.id);
        if (!runtime) return [];
        return [
          {
            id: workspace.id,
            name: workspace.name,
            read: () => {
              const snapshot = runtime.store.snapshot();
              return {
                tasks: snapshot.tasks,
                items: runtime.forYou.list(),
                projects: runtime.plans.list(),
                agents: snapshot.agents.map((agent) => ({ id: agent.id, name: agent.name })),
              };
            },
            usage: async (fromMs: number, toMs: number) => {
              await runtime.usageHistory.idle();
              return runtime.usageHistory.read(fromMs, toMs);
            },
          },
        ];
      }),
  });
  awayHolder.service = away;

  // O orçamento de consumo (só avisa, nunca trava): soma o gasto equivalente de todos os workspaces e levanta o alerta
  // `budget` da cadeia de atenção em 80% e em 100%, uma vez por degrau e por período.
  const budget = new BudgetWatcher({
    now,
    log: app.log,
    limits: () => spendSettings.budget(),
    usdBrl: () => spendSettings.usdBrl(),
    updatedAt: () => spendSettings.budgetUpdatedAt(),
    attention,
    subscribeList: (listener) => manager.listHub.subscribe((event) => (event.type === "workspaces:list" ? listener() : undefined)),
    sources: () => [
      ...manager.list().flatMap((workspace) => {
        const runtime = manager.find(workspace.id);
        if (!runtime) return [];
        return [
          {
            id: workspace.id,
            subscribe: (listener: (event: ServerEvent) => void) => runtime.hub.subscribe((event) => listener(event)),
            read: async (fromMs: number, toMs: number) => {
              await runtime.usageHistory.idle();
              return runtime.usageHistory.read(fromMs, toMs);
            },
          },
        ];
      }),
      // O gasto do Cyno (a plataforma, fora dos workspaces) também conta no orçamento, uma vez só.
      {
        id: "_cyno",
        read: async (fromMs: number, toMs: number) => {
          await cyno.usageHistory.idle();
          return cyno.usageHistory.read(fromMs, toMs);
        },
      },
    ],
  });


  registerHealthRoutes(app, { sceneLive: sceneLiveEnabled() });
  const versionService = new VersionService({
    startDir: REPO_ROOT,
    ...(deps.version?.rootDir ? { rootDir: deps.version.rootDir } : {}),
    config: { ...updateConfigFromEnv({}), auto: deps.version?.autoCheck === true, ...(deps.version?.branch ? { branch: deps.version.branch } : {}) },
    ...(deps.version?.fetch ? { fetch: deps.version.fetch } : {}),
    applyEnabled: deps.version?.applyEnabled === true,
    ...(deps.version?.runMode ? { runMode: deps.version.runMode } : {}),
    ...(deps.version?.npm ? { npm: deps.version.npm } : {}),
  });
  registerVersionRoutes(app, versionService);
  app.get("/api/engines", async (request): Promise<EnginesResponse> => {
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh;
    return { engines: await engines.list(refresh === "1" || refresh === "true"), simulated };
  });
  // "Tentar agora" com um motor sem cota: as filas paradas andam (se ainda faltar cota, voltam a esperar).
  app.post(ENGINE_RETRY_PATH, async (request, reply) => {
    const { engine } = engineRetryBodySchema.parse(request.body ?? {});
    availability.retry(engine);
    return reply.code(204).send();
  });
  registerWorkspaceRoutes(app, manager);
  // Links públicos dos Quadros: a rota pública fica fora de /api/w/:ws e só ela é aberta no portão da senha.
  app.decorate("boardShares", await BoardShareStore.open(path.join(deps.dataDir, "board-shares.json"), now));
  registerPublicBoardRoute(app, manager, () => app.boardShares, { now: () => now().getTime() });
  registerWorkspaceScopedRoutes(app, manager, now);
  registerLibraryRoutes(app, library);
  registerLibraryAppsRoutes(app, installer, appRunner);
  registerWsRoute(app, manager, { heartbeatMs: deps.wsHeartbeatMs ?? 30_000 });
  // Cena ao vivo (o servidor simula o Escritório): desligada por padrão (CYNO_SCENE_LIVE=1 liga).
  registerSceneLiveRoute(app, manager, { heartbeatMs: deps.wsHeartbeatMs ?? 30_000, enabled: sceneLiveEnabled() });
  registerMcpRoute(app, manager, mcpTokens, cyno);
  registerCynoRoutes(app, cyno, { heartbeatMs: deps.wsHeartbeatMs ?? 30_000, attention });
  registerAttentionRoutes(app, attention, now);
  registerPushRoutes(app, pushStore, push, now);
  registerAgendaRoutes(app, agenda, manager, now);
  registerMuralRoutes(app, mural, manager);
  registerPlatformTodayRoute(app, manager, agenda, now);
  registerPlatformDayStatsRoute(app, manager, now);
  registerUsageRoutes(app, { claude: accountUsage, gemini: antigravityUsage });
  // OpenClaw e Hermes: o passo a passo, o Verificar e a instalação (com confirmação) da tela Motores.
  // eslint-disable-next-line prefer-const -- atribuído logo abaixo (a instalação pede o serviço de volta ao terminar)
  let oneShotEngines: OneShotEngines;
  const engineInstaller = new EngineInstaller({
    lockFile: path.join(deps.dataDir, "platform", "engines", "install.lock"),
    now,
    ...(deps.oneShot?.installFetch ? { fetch: deps.oneShot.installFetch } : {}),
    onChange: (job) => {
      if (job.status !== "running") void oneShotEngines.afterInstall(job.engine).then(() => engines.list(true)).catch(() => undefined);
    },
  });
  const record = (action: string, summary: string, data?: Record<string, unknown>) => activity({ category: "sistema", action, actor: "usuario", summary, ...(data ? { data } : {}) });
  oneShotEngines = new OneShotEngines({
    dataDir: deps.dataDir,
    homeDir: deps.engineTools?.homeDir ?? os.homedir(),
    ...(deps.engineTools?.pathEnv ? { pathEnv: deps.engineTools.pathEnv } : {}),
    now,
    settings: engineSettings,
    key: openrouterKey,
    models: openrouterModels,
    command: (engine) => ({ command: terminals[engine]?.command ?? engine, prefixArgs: terminals[engine]?.prefixArgs }),
    setCommand: (engine, command) => {
      const config = terminals[engine];
      if (config) config.command = command ?? engine;
    },
    applyChoices: (engine, choices) => {
      const config = terminals[engine];
      if (!config) return;
      if (choices.model) config.defaultModel = choices.model;
      else delete config.defaultModel;
      if (engine === "openclaw") {
        if (choices.effort) terminals.openclaw!.defaultEffort = choices.effort;
        else delete terminals.openclaw!.defaultEffort;
      }
    },
    probe: deps.engineTools?.probe ?? defaultProbe,
    ...(deps.oneShot?.openrouter ? { openrouter: deps.oneShot.openrouter } : {}),
    usage: () => usage.snapshot(),
    // O MCP "office" responde? (pede a lista de ferramentas do Cyno com um token de plataforma que vale só para esta checagem)
    mcpCheck: async () => {
      const token = mcpTokens.issue({ workspaceId: "engine-check", agentId: "engine-check", scope: "platform" });
      try {
        const response = await app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
        const tools = (response.json() as { result?: { tools?: unknown[] } }).result?.tools;
        return response.statusCode === 200 && Array.isArray(tools) ? { ok: true, detail: `${tools.length} ferramentas respondidas em ${terminals.mcpUrl}` } : { ok: false, detail: `O MCP respondeu ${response.statusCode}.` };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      } finally {
        mcpTokens.revoke(token);
      }
    },
    installer: engineInstaller,
    gateways: () => ({ max: hermesSlots.limit(), inUse: hermesSlots.inUse(), waiting: hermesSlots.waiting() }),
    ...(deps.oneShot?.recipe ? { recipe: deps.oneShot.recipe } : {}),
    ...(deps.oneShot?.turn ? { turn: deps.oneShot.turn } : {}),
    ...(deps.oneShot?.turnTimeoutMs ? { turnTimeoutMs: deps.oneShot.turnTimeoutMs } : {}),
    ...(deps.oneShot?.fenceSupport ? { fenceSupport: deps.oneShot.fenceSupport } : {}),
    recordTestUsage: (spent) => {
      void cyno.usageHistory.recordTest({ provider: spent.engine, label: `Verificar o motor ${spent.engine === "openclaw" ? "OpenClaw" : "Hermes"}`, model: spent.model, usage: spent.usage, durationMs: spent.durationMs });
    },
    record,
  });
  oneShotRef.current = oneShotEngines;
  // Boot: gateways do Hermes que sobraram de uma queda do servidor anterior (achados pelo caminho das pastas `agent-homes`, nunca pelo nome do processo).
  void stopAllGateways(engineDirs(deps.dataDir, "hermes").root)
    // Pastas de motor de agentes que não existem mais (token do MCP, configuração, sessões): saem depois dos gateways.
    .then(() => sweepEngineHomes({ hermes: engineDirs(deps.dataDir, "hermes").root, openclaw: engineDirs(deps.dataDir, "openclaw").root }))
    .catch(() => undefined);
  // Boot: se o motor foi instalado pelo Cyno (ou fora do PATH), os agentes já passam a usar o caminho achado.
  void Promise.all([oneShotEngines.status("openclaw"), oneShotEngines.status("hermes")]).catch(() => undefined);
  registerEngineRoutes(app, {
    ...(terminals.freebuff ? { freebuff: terminals.freebuff } : {}),
    record,
    oneShot: {
      engines: oneShotEngines,
      key: openrouterKey,
      models: openrouterModels,
      setCommand: (engine, command) => {
        const config = terminals[engine];
        if (config) config.command = command ?? engine;
      },
    },
    terminals,
    settings: engineSettings,
    usage: () => usage.snapshot(),
    redetect: () => engines.list(true),
    dataDir: deps.dataDir,
    now,
    // O "Testar" de um motor gasta tokens da assinatura: entra no histórico de uso da plataforma, marcado como teste.
    recordTestUsage: (spent) => {
      void cyno.usageHistory.recordTest({ provider: spent.engine, label: `Teste do motor ${spent.engine === "claude" ? "Claude Code" : "Antigravity"}`, model: spent.model, usage: spent.usage, durationMs: spent.durationMs });
    },
    ...deps.engineTools,
  }).applySavedPaths();
  registerSettingsRoutes(app, retention, modelDefaults, { settings: platformSettings, library, envDefault: deps.connectors?.allowStdio ?? true });
  registerSystemActivityRoutes(app, deps.dataDir);
  // Entradas do servidor (sem workspace) vão ao vivo para todos os sockets.
  const unsubscribeSystemActivity = deps.activity?.onAppend((entry) => {
    if (!entry.workspaceId) manager.listHub.publish({ type: "activity:appended", entry });
  });
  registerSpendSettingsRoutes(app, spendSettings, now);
  registerBudgetRoutes(app, spendSettings, budget, now);
  registerAwayRoutes(app, owner, away, now);

  let booted: Promise<void> | undefined;
  const bootWorkspaces = () => (booted ??= manager.start().then(async () => {
    attention.start();
    await budget.start();
  }));
  app.decorate("bootWorkspaces", bootWorkspaces);
  // Erro aqui só vai para o log (o Fastify não derruba o listen): o index.ts espera bootWorkspaces e sai.
  if (deps.bootOn === "listen") app.addHook("onListen", bootWorkspaces);
  app.addHook("onReady", async () => {
    if (deps.bootOn !== "listen") await bootWorkspaces();
    accountUsage?.start();
    antigravityUsage?.start();
    if (deps.retention?.autoRun) retention.start();
    if (deps.version?.autoCheck) versionService.start();
  });
  app.addHook("onClose", async () => {
    await engineSettings.flush();
    await retention.stop();
    versionService.stop();
    unsubscribeSystemActivity?.();
    accountUsage?.stop();
    antigravityUsage?.stop();
    await accountUsage?.idle();
    await antigravityUsage?.idle();
    // Boot no meio (listen recém-aberto): termina antes de fechar os workspaces.
    await booted?.catch(() => undefined);
    await budget.close();
    await push.close();
    await attention.close();
    await cyno.close();
    await manager.close();
    // Nenhum gateway do Hermes fica para trás: os agentes em turno saíram com o terminal; aqui saem também os ociosos (esperariam 60 s).
    await stopAllGateways(engineDirs(deps.dataDir, "hermes").root);
    await installer.close();
    // A instalação de motor em curso (e o que ela abriu) sai junto, e a trava é solta.
    await engineInstaller.close();
    await appRunner.close();
    await library.close();
    await agenda.idle();
    await mural.idle();
    availability.close();
    await freebuffService.flush();
    freebuffService.close();
    usagePersistence.stop();
    await usagePersistence.flush();
    await spendSettings.flush();
    await owner.flush();
    await authStore.flush();
  });
  return app;
}
