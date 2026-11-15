import path from "node:path";
import {
  ACTIVITY_SYSTEM,
  ACTIVITY_USER,
  GMAIL_MCP_URL,
  type Connector,
  type ConnectorIconMime,
  type CreateLibraryConnectorBody,
  type LibraryConnector,
  type LibraryGrants,
  type LibraryGrantsInput,
  type LibraryImportResponse,
  type LibrarySkillDetail,
  type LibrarySkillView,
  type LibraryUse,
  type LibraryUseAgent,
  type LibraryWorkspaceInfo,
  type ServerEvent,
  type UpdateLibraryConnectorBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../platform/http/errors";
import type { McpTool } from "../mcp/protocol";
import { platformPaths } from "../store/paths";
import { WriteQueue } from "../store/write-queue";
import { activity } from "../workspace/activity/log";
import { ConnectorGateway, type AppToolsPort, type ConnectorGatewayDeps } from "./connectors/gateway";
import type { AppToolRunner } from "./apps/tool-runner";
import type { MediaService } from "../workspace/media/media-service";
import { claudeImportCandidates, type ClaudeMcpListOptions } from "./connectors/import-claude";
import { OAuthManager } from "./connectors/oauth/manager";
import type { StoredOAuth } from "./connectors/oauth/stored";
import { ConnectorRegistry, type RegistryChange } from "./connectors/registry";
import { SkillLibrary, type SkillChange } from "./skills/skill-library";
import { librarySkillPaths, type StoredSkill } from "./skills/store";
import { skillBudgetWarnings } from "@cyno/shared";
import { skillIndexTokens } from "./skills/agent-skills";
import type { AppConnectorInput, AppLibraryPort, MiniTestResult } from "./apps/installer";
import { libraryConnectorPaths, publicLibraryConnector, readConnectorsFile, workspaceConnector, type ConnectorPaths, type StoredConnector } from "./connectors/store";

/** O que a Biblioteca precisa saber de um workspace aberto (quem ele é, quem trabalha nele e como avisá-lo). */
export type WorkspaceContext = {
  name: () => string;
  /** Agentes do workspace (Maestro incluído), para o "quem usa" e para validar as liberações. */
  agents: () => LibraryUseAgent[];
  /** O hub do workspace: os eventos `connector:*` dele vão por aqui. */
  publish: (event: ServerEvent) => void;
  /** As skills liberadas a este workspace (ou a algum agente dele) mudaram: o workspace sincroniza as pastas e reinicia os ociosos. */
  skillsChanged?: () => void;
  /** O que uma ferramenta de app precisa do workspace: a pasta do agente, a tarefa em curso e a Mídia (a saída do app vai para lá). */
  appRun?: {
    agentDir: (agentId: string) => string;
    currentTask: (agentId: string) => { id: string; projectId?: string } | undefined;
    media: Pick<MediaService, "importFile">;
  };
};

export type LibraryServiceOptions = {
  /** Pasta onde a Biblioteca mora (`<data>/platform/library`). */
  libraryDir: string;
  /** Eventos da plataforma (`library:*`): vão para todos os sockets. */
  publishPlatform: (event: ServerEvent) => void;
  /** `claude mcp list` para importar (comando do Claude Code configurado no server). */
  claudeList: ClaudeMcpListOptions;
  /** Testa a conexão sozinho ao criar/mudar (padrão: sim). */
  autoTest?: boolean;
  gateway?: Partial<Pick<ConnectorGatewayDeps, "createClient" | "fetch" | "spawn" | "env" | "stdioIdleMs">>;
  /**
   * Conectores stdio rodam um comando nesta máquina: só com isso ligado (CONNECTORS_STDIO=1). Padrão
   * aqui: liberado (os testes usam); o server real passa a config.
   */
  allowStdio?: boolean;
  /** Onde procurar o `~/.claude` do dono para importar skills (padrão: o home do servidor; os testes passam uma pasta falsa). */
  skillsLocal?: { homeDir?: string };
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now: () => Date;
};

/** `<data>/platform/library` a partir da raiz de dados. */
export const libraryDirOf = (dataDir: string) => path.join(platformPaths(dataDir).root, "library");

/**
 * A Biblioteca da plataforma (por enquanto, os conectores). Guarda cada conector uma vez
 * (ConnectorRegistry), tem um gateway só (um cliente por conector, compartilhado entre os
 * workspaces), sabe quem recebeu o quê (`grants`) e avisa: `library:*` para todos, `connector:*`
 * para cada workspace afetado e uma linha na Atividade da plataforma para cada liberação, retirada
 * ou remoção. Cada workspace fala com ela por uma visão (`ConnectorsService`, em ./connectors/service).
 */
export class LibraryService {
  readonly registry: ConnectorRegistry;
  readonly gateway: ConnectorGateway;
  /** Login OAuth dos conectores HTTP (tokens ficam no registro, 0600). */
  readonly oauth: OAuthManager;
  readonly paths: ConnectorPaths;
  /** As skills da plataforma (pasta própria em `skills/`, liberação igual à dos conectores). */
  skills!: SkillLibrary;
  private readonly workspaces = new Map<string, WorkspaceContext>();
  private appRunner: AppToolRunner | undefined;

  private constructor(
    records: StoredConnector[],
    private readonly options: LibraryServiceOptions,
  ) {
    this.paths = libraryConnectorPaths(options.libraryDir);
    this.registry = new ConnectorRegistry(records, {
      paths: this.paths,
      queue: new WriteQueue(),
      onChange: (change) => this.handleChange(change),
      workspaceExists: (workspaceId) => this.workspaces.has(workspaceId),
      agentExists: (workspaceId, agentId) => this.workspaces.get(workspaceId)?.agents().some((agent) => agent.id === agentId) ?? false,
      log: options.log,
      now: options.now,
    });
    this.oauth = new OAuthManager({
      store: this.registry,
      fetch: options.gateway?.fetch,
      now: options.now,
      log: options.log,
      onConnected: (id) => {
        const record = this.registry.record(id);
        if (record) this.record("conector-entrou", ACTIVITY_USER, `Conector ${record.name}: entrou com a conta (OAuth)`, record);
        void this.gateway.invalidate(id).then(() => this.autoTest(id));
      },
    });
    this.gateway = new ConnectorGateway({
      oauth: this.oauth,
      registry: this.registry,
      paths: this.paths,
      publish: (workspaceId, event) => this.workspaces.get(workspaceId)?.publish(event),
      log: options.log,
      now: options.now,
      allowStdio: options.allowStdio ?? true,
      appTools: () => this.appToolsPort(),
      ...options.gateway,
    });
  }

  static async open(options: LibraryServiceOptions): Promise<LibraryService> {
    const records = await readConnectorsFile(libraryConnectorPaths(options.libraryDir).file);
    const library = new LibraryService(records, options);
    library.skills = await SkillLibrary.open({
      paths: librarySkillPaths(options.libraryDir),
      queue: new WriteQueue(),
      workspaceExists: (workspaceId) => library.workspaces.has(workspaceId),
      agentExists: (workspaceId, agentId) => library.workspaces.get(workspaceId)?.agents().some((agent) => agent.id === agentId) ?? false,
      workspaceName: (workspaceId) => library.workspaces.get(workspaceId)?.name() ?? workspaceId,
      agentName: (workspaceId, agentId) => library.workspaces.get(workspaceId)?.agents().find((agent) => agent.id === agentId)?.name ?? agentId,
      onChange: (change) => library.handleSkillChange(change),
      ...(options.skillsLocal ? { local: options.skillsLocal } : {}),
      log: options.log,
      now: options.now,
    });
    return library;
  }

  /** Liga o executor das ferramentas de app (criado junto do instalador, depois da Biblioteca). */
  setAppRunner(runner: AppToolRunner): void {
    this.appRunner = runner;
  }

  private appToolsPort(): AppToolsPort | undefined {
    const runner = this.appRunner;
    if (!runner) return undefined;
    return {
      tools: (appId) => runner.toolsOfApp(appId),
      run: async (appId, tool, args, caller) => {
        if (!caller) return runner.run(appId, tool, args, { root: runner.appDir(appId) });
        const context = this.workspaces.get(caller.workspaceId);
        const run = context?.appRun;
        if (!context || !run) return { text: "This workspace cannot run app tools right now.", isError: true };
        const agent = context.agents().find((candidate) => candidate.id === caller.agentId);
        const agentDir = run.agentDir(caller.agentId);
        return runner.run(appId, tool, args, {
          root: agentDir,
          who: { workspaceId: caller.workspaceId, workspaceName: context.name(), agentId: caller.agentId, agentName: agent?.name ?? caller.agentId },
          registerMedia: async (file, info) => {
            const task = run.currentTask(caller.agentId);
            const item = await run.media.importFile(agentDir, file, {
              title: info.title,
              createdBy: caller.agentId,
              origin: "app",
              where: `app:${info.appId}`,
              note: info.note,
              ...(task ? { taskId: task.id, rootTaskId: task.projectId ?? task.id } : {}),
            });
            return { id: item.id, title: item.title };
          },
        });
      },
    };
  }

  /** Um workspace abriu: a Biblioteca passa a conhecê-lo (nomes, agentes, canal de eventos). Devolve o "soltar". */
  attach(workspaceId: string, context: WorkspaceContext): () => void {
    this.workspaces.set(workspaceId, context);
    return () => {
      if (this.workspaces.get(workspaceId) === context) this.workspaces.delete(workspaceId);
    };
  }

  // ---------- Leitura ----------

  list(): LibraryConnector[] {
    return this.registry.all().map((record) => this.publicOf(record));
  }

  get(id: string): LibraryConnector {
    return this.publicOf(this.registry.get(id));
  }

  /** Os conectores liberados a um workspace, na forma de sempre (`agentIds` = os agentes dele). */
  workspaceList(workspaceId: string): Connector[] {
    return this.registry.grantedTo(workspaceId).map((record) => workspaceConnector(record, workspaceId));
  }

  workspaceGet(workspaceId: string, id: string): Connector {
    const record = this.registry.get(id);
    if (!(workspaceId in record.grants)) throw new HttpError(404, `Conector "${id}" não encontrado`);
    return workspaceConnector(record, workspaceId);
  }

  toolsFor(workspaceId: string, agentId: string): McpTool[] {
    return this.gateway.toolsFor(workspaceId, agentId);
  }

  /** Os workspaces abertos e os agentes de cada um (para a janela de liberar). */
  directory(): LibraryWorkspaceInfo[] {
    return [...this.workspaces.entries()].map(([id, context]) => ({ id, name: context.name(), agents: this.agentsOf(context) }));
  }

  private agentsOf(context: WorkspaceContext): LibraryUseAgent[] {
    return [...context.agents()].sort((a, b) => Number(b.maestro) - Number(a.maestro) || a.name.localeCompare(b.name, "pt-BR"));
  }

  importFromClaude(): Promise<LibraryImportResponse> {
    return claudeImportCandidates(this.options.claudeList, this.registry.all());
  }

  // ---------- Escrita ----------

  async create(body: CreateLibraryConnectorBody, actor: string = ACTIVITY_USER): Promise<LibraryConnector> {
    if (body.kind === "stdio") this.assertStdioAllowed();
    const { auth, ...rest } = body;
    if (body.builtin && (body.kind !== "http" || auth?.mode !== "oauth")) throw new HttpError(400, "O modo embutido só vale para conector HTTP com login OAuth.");
    let oauth: StoredOAuth | undefined;
    if (auth?.mode === "oauth") {
      if (body.builtin) {
        // Gmail pela API: sem servidor MCP para descobrir; o login é o do Google.
        if (body.kind !== "http") throw new HttpError(400, "O modo embutido só vale para conector HTTP.");
        oauth = await this.oauth.buildGmailApi(auth);
      } else {
        if (body.kind !== "http" || !body.url) throw new HttpError(400, "O login OAuth só vale para conector HTTP com URL.");
        oauth = await this.oauth.build(body.url, auth);
      }
    }
    const record = await this.registry.create({ ...rest, ...(oauth ? { oauth } : {}) });
    this.record("conector-criado", actor, `Conector ${record.name} adicionado à Biblioteca`, record);
    if (record.enabled) this.autoTest(record.id);
    this.noteGrants(record, {}, actor);
    return this.publicOf(record);
  }

  async update(id: string, body: UpdateLibraryConnectorBody): Promise<LibraryConnector> {
    const current = this.registry.get(id);
    if (current.kind === "stdio" && (body.enabled === true || "command" in body || "args" in body)) this.assertStdioAllowed();
    const { auth, ...rest } = body;
    // Primeiro a descoberta (pode recusar) e só depois grava: falhar não deixa o conector pela metade.
    let nextOAuth: { value: StoredOAuth | undefined } | undefined;
    // Trocar de cliente (API do Gmail <-> servidor MCP oficial) mantém o login: o OAuth guardado só é remendado (endereço do recurso e lista de permissões).
    let base = current.oauth;
    if (rest.builtin !== undefined) {
      if (current.kind !== "http") throw new HttpError(400, "O modo embutido só vale para conector HTTP.");
      if (rest.builtin === "gmail-api" && !current.builtin) {
        if (!current.oauth) throw new HttpError(400, "A API do Gmail precisa do login com a conta (OAuth).");
        const found = this.oauth.gmailApiFor(current.oauth);
        if (!found) throw new HttpError(400, "A API do Gmail só vale com o login do Google.");
        base = this.oauth.rebase(current.oauth, found);
        nextOAuth = { value: base };
      } else if (rest.builtin === null && current.builtin && current.oauth) {
        base = this.oauth.rebase(current.oauth, await this.oauth.tryDiscover(rest.url ?? GMAIL_MCP_URL));
        nextOAuth = { value: base };
      }
    }
    const builtinAfter = rest.builtin === undefined ? current.builtin : (rest.builtin ?? undefined);
    if (auth) {
      if (current.kind !== "http") throw new HttpError(400, "O login OAuth só vale para conector HTTP.");
      if (auth.mode === "static") {
        if (builtinAfter) throw new HttpError(400, "A API do Gmail precisa do login com a conta (OAuth).");
        nextOAuth = current.oauth ? { value: undefined } : undefined;
      } else nextOAuth = { value: builtinAfter ? await this.oauth.buildGmailApi(auth, base) : await this.oauth.build(rest.url ?? current.url ?? "", auth, base) };
    } else if (!builtinAfter && rest.url && rest.url !== current.url && current.oauth && rest.builtin === undefined) {
      // URL nova num conector OAuth: descobre de novo; se o servidor novo não anuncia OAuth, o OAuth antigo fica como está.
      nextOAuth = await this.oauth.build(rest.url, { mode: "oauth" }, current.oauth).then(
        (value) => ({ value }),
        () => undefined,
      );
    }
    let { record, change } = await this.registry.update(id, rest);
    if (nextOAuth) {
      record = (await this.registry.setOAuth(id, nextOAuth.value)) ?? record;
      change = { connectionChanged: true };
    }
    if (change.connectionChanged) {
      await this.gateway.invalidate(id);
      if (record.enabled) this.autoTest(id);
    }
    return this.publicOf(record);
  }

  // ---------- Login OAuth ----------

  /** Só descobre (nada é guardado): o formulário ("Verificar") mostra escopos e se o cadastro é automático. */
  discoverOAuth(url: string) {
    return this.oauth.discover(url);
  }

  /** O mesmo para o corpo da rota: a URL, o conector (se for "gmail-api", o login do Google) ou o modo embutido. */
  discoverOAuthFor(body: { url?: string; connectorId?: string; builtin?: "gmail-api" }) {
    if (body.builtin || (body.connectorId && this.registry.get(body.connectorId).builtin)) return this.oauth.discoverGmailApi();
    return this.oauth.discover(body.url ?? this.urlOf(body.connectorId!));
  }

  /** A URL guardada de um conector HTTP (só o servidor a conhece inteira; a API mostra mascarada). */
  urlOf(id: string): string {
    const record = this.registry.get(id);
    if (record.kind !== "http" || !record.url) throw new HttpError(400, "O login OAuth só vale para conector HTTP.");
    return record.url;
  }

  startOAuth(id: string, origin: string) {
    return this.oauth.start(id, origin);
  }

  /** Termina o login com o endereço colado pelo dono; devolve o conector atualizado. */
  async finishOAuth(id: string, callbackUrl: string): Promise<LibraryConnector> {
    await this.oauth.finish(id, callbackUrl);
    return this.get(id);
  }

  /** O retorno do login (rota `/api/library/oauth/callback`): termina o fluxo ou lança `OAuthCallbackError`. */
  completeOAuth(query: Parameters<OAuthManager["complete"]>[0]) {
    return this.oauth.complete(query);
  }

  async disconnectOAuth(id: string): Promise<LibraryConnector> {
    const record = this.registry.get(id);
    await this.oauth.disconnect(id);
    this.record("conector-desconectado", ACTIVITY_USER, `Conector ${record.name}: desconectado da conta (OAuth)`, record);
    await this.gateway.invalidate(id);
    if (record.enabled) await this.gateway.test(id);
    return this.get(id);
  }

  /** Exclusão pedida por uma pessoa (aba Conectores): o conector de um app só sai desinstalando o app. */
  async removeByUser(id: string, actor: string = ACTIVITY_USER): Promise<void> {
    const record = this.registry.get(id);
    if (record.origin === "app" || record.appId) throw new HttpError(409, "Este conector pertence a um app: desinstale o app na aba Apps");
    await this.remove(id, actor);
  }

  async remove(id: string, actor: string = ACTIVITY_USER): Promise<void> {
    const removed = await this.registry.remove(id);
    await this.gateway.invalidate(id);
    this.record("conector-removido", actor, `Conector ${removed.name} removido da Biblioteca (estava em ${Object.keys(removed.grants).length} workspace${Object.keys(removed.grants).length === 1 ? "" : "s"})`, removed);
  }

  async test(id: string): Promise<LibraryConnector> {
    this.registry.get(id); // 404 se não existe
    const record = (await this.gateway.test(id)) ?? this.registry.get(id);
    return this.publicOf(record);
  }

  /** Libera (ou retira) nos dois níveis: o mapa inteiro de workspace -> agentes. */
  async setGrants(id: string, grants: LibraryGrantsInput, actor: string = ACTIVITY_USER): Promise<LibraryConnector> {
    const { record, before } = await this.registry.setGrants(id, grants);
    this.noteGrants(record, before, actor);
    return this.publicOf(record);
  }

  /** Libera a um workspace (e a estes agentes). Usado pela visão do workspace (compatibilidade). */
  async grantWorkspace(id: string, workspaceId: string, agentIds?: readonly string[], actor: string = ACTIVITY_USER): Promise<LibraryConnector> {
    const before = this.registry.get(id).grants;
    const record = await this.registry.grantWorkspace(id, workspaceId, agentIds);
    this.noteGrants(record, before, actor);
    return this.publicOf(record);
  }

  async revokeWorkspace(id: string, workspaceId: string, actor: string = ACTIVITY_USER): Promise<void> {
    const before = this.registry.get(id).grants;
    const record = await this.registry.revokeWorkspace(id, workspaceId);
    this.noteGrants(record, before, actor);
  }

  /**
   * O que o instalador de apps usa da Biblioteca: criar o conector do app (sem liberação a ninguém),
   * remover tudo dele (processos, conector e liberações) e o mini teste de verdade.
   */
  appPort(): AppLibraryPort {
    return {
      stdioAllowed: () => this.options.allowStdio ?? true,
      upsertAppConnector: (input) => this.upsertAppConnector(input),
      removeAppConnectors: (appId) => this.removeAppConnectors(appId),
      setConnectorEnabled: async (id, enabled) => {
        if (!this.registry.record(id)) return;
        await this.update(id, { enabled });
      },
      connectorExists: (id) => Boolean(this.registry.record(id)),
      registerAppSkill: async (appId, appPath, dir, requires) => (await this.skills.registerAppSkill(appId, appPath, dir, requires ? { requires } : {})).id,
      removeAppSkills: (appId) => this.skills.removeAppSkills(appId),
      stopApp: async (appId) => {
        await this.appRunner?.stopApp(appId);
      },
      miniTest: (id, test, expectTools) => this.miniTest(id, test, expectTools),
    };
  }

  private async upsertAppConnector(input: AppConnectorInput): Promise<string> {
    const existing = this.registry.findByApp(input.appId)[0];
    if (existing) {
      await this.registry.updateApp(existing.id, { description: input.description, ...(input.command ? { command: input.command } : {}), ...(input.args ? { args: input.args } : {}), env: input.env, warnings: input.warnings, ...(input.limits ? { limits: input.limits } : {}) });
      await this.gateway.invalidate(existing.id);
      return existing.id;
    }
    if (input.kind === "app") {
      const created = await this.registry.createApp({ name: input.name, description: input.description, appId: input.appId, warnings: input.warnings });
      this.record("conector-criado", ACTIVITY_USER, `Conector ${created.name} criado pelo app ${input.appId} (sem liberação a ninguém)`, created, { appId: input.appId });
      return created.id;
    }
    const record = await this.registry.create({ name: input.name, kind: "stdio", command: input.command!, args: input.args ?? [], env: input.env, description: input.description, origin: "app", appId: input.appId, warnings: input.warnings, ...(input.limits ? { limits: input.limits } : {}), enabled: true });
    this.record("conector-criado", ACTIVITY_USER, `Conector ${record.name} criado pelo app ${input.appId} (sem liberação a ninguém)`, record, { appId: input.appId });
    return record.id;
  }

  /** Remove os conectores do app (para o processo, tira as liberações junto) e devolve os ids. */
  private async removeAppConnectors(appId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const record of this.registry.findByApp(appId)) {
      await this.remove(record.id);
      ids.push(record.id);
    }
    return ids;
  }

  /** Mini teste: sobe o MCP, lista as ferramentas, confere as esperadas, chama a do teste e confere a resposta. */
  private async miniTest(id: string, test: { tool: string; args: Record<string, unknown>; expect: { contains?: string; matches?: string; notEmpty?: boolean } }, expectTools: readonly string[]): Promise<MiniTestResult> {
    const started = Date.now();
    const fail = (detail: string): MiniTestResult => ({ ok: false, tool: test.tool, detail, ms: Date.now() - started });
    const record = await this.gateway.test(id);
    if (!record) return fail("o conector não existe mais");
    if (record.status.state !== "connected") return fail(`o MCP não conectou: ${record.status.reason ?? record.status.state}`);
    const names = record.status.tools.map((tool) => tool.name);
    const missing = expectTools.filter((name) => !names.includes(name));
    if (missing.length > 0) return fail(`faltam ferramentas no MCP: ${missing.join(", ")} (veio: ${names.join(", ") || "nenhuma"})`);
    let result: { text: string; isError: boolean };
    try {
      result = await this.gateway.callSystem(id, test.tool, test.args);
    } catch (error) {
      return fail(`a chamada de ${test.tool} falhou: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.isError) return fail(`${test.tool} devolveu erro: ${result.text.slice(0, 200)}`);
    const { contains, matches, notEmpty } = test.expect;
    if (contains !== undefined && !result.text.includes(contains)) return fail(`a resposta de ${test.tool} não tem "${contains}": ${result.text.slice(0, 160)}`);
    if (matches !== undefined && !new RegExp(matches).test(result.text)) return fail(`a resposta de ${test.tool} não tem o formato esperado: ${result.text.slice(0, 160)}`);
    if (notEmpty && result.text.trim() === "") return fail(`${test.tool} devolveu vazio`);
    const oneLine = result.text.replace(/\s+/g, " ").trim();
    return { ok: true, tool: test.tool, detail: `${names.length} ferramenta${names.length === 1 ? "" : "s"} no MCP; ${test.tool} devolveu: ${oneLine.slice(0, 200)}`, ms: Date.now() - started };
  }

  /** Os conectores de um agente num workspace (lista inteira); só os liberados ao workspace. */
  async setAgentConnectors(workspaceId: string, agentId: string, connectorIds: readonly string[], actor: string = ACTIVITY_USER): Promise<Connector[]> {
    const before = new Map(this.registry.all().map((record) => [record.id, record.grants] as const));
    const now = await this.registry.setAgentConnectors(workspaceId, agentId, connectorIds);
    for (const record of this.registry.all()) if (before.has(record.id)) this.noteGrants(record, before.get(record.id)!, actor);
    return now.map((record) => workspaceConnector(record, workspaceId));
  }

  async forgetAgent(workspaceId: string, agentId: string): Promise<void> {
    await this.registry.forgetAgent(workspaceId, agentId);
    await this.skills.forgetAgent(workspaceId, agentId);
  }

  async forgetWorkspace(workspaceId: string): Promise<void> {
    this.workspaces.delete(workspaceId);
    await this.registry.forgetWorkspace(workspaceId);
    await this.skills.forgetWorkspace(workspaceId);
  }

  async setIcon(id: string, mime: ConnectorIconMime, bytes: Buffer): Promise<LibraryConnector> {
    return this.publicOf(await this.registry.setIcon(id, mime, bytes));
  }

  readIcon(id: string) {
    return this.registry.readIcon(id);
  }

  autoTest(id: string): void {
    if (this.options.autoTest === false) return;
    void this.gateway.test(id).catch((error: unknown) => this.options.log.warn({ err: error, connectorId: id }, "teste automático do conector falhou"));
  }

  async close(): Promise<void> {
    await this.gateway.closeAll();
    await this.registry.save();
    await this.skills.save();
  }

  // ---------- Skills (a visão da API) ----------

  skillList(): LibrarySkillView[] {
    return this.skills.all().map((record) => this.skillView(record));
  }

  skillGet(id: string): LibrarySkillView {
    return this.skillView(this.skills.get(id));
  }

  async skillDetail(id: string): Promise<LibrarySkillDetail> {
    const { record, content, files } = await this.skills.detail(id);
    return { ...this.skillView(record), content, fileList: files };
  }

  /** O registro com "quem usa", o custo do índice e os avisos. */
  skillView(record: StoredSkill): LibrarySkillView {
    const { previousVersion, ...rest } = record;
    return {
      ...rest,
      indexTokens: skillIndexTokens(record),
      hasPrevious: previousVersion !== undefined,
      ...(previousVersion !== undefined ? { previousVersion } : {}),
      uses: this.usesOf(record.grants),
    };
  }

  /** Avisos de limite de UM agente (mais de 12 skills ou índice acima de ~6 mil tokens). */
  agentSkillWarnings(workspaceId: string, agentId: string): string[] {
    return skillBudgetWarnings(this.skills.attachedTo(workspaceId, agentId).map((record) => ({ indexTokens: skillIndexTokens(record) })));
  }

  /** Mudou uma skill: a Biblioteca (todos os sockets) e os workspaces afetados (sincronizam as pastas dos agentes). */
  private handleSkillChange(change: SkillChange): void {
    if (change.kind === "deleted") {
      this.options.publishPlatform({ type: "library:skill-deleted", id: change.id });
      for (const workspaceId of change.notify) this.workspaces.get(workspaceId)?.skillsChanged?.();
      return;
    }
    this.options.publishPlatform({ type: "library:skill-upserted", item: this.skillView(change.record) });
    for (const workspaceId of new Set([...change.notify, ...change.dropped])) this.workspaces.get(workspaceId)?.skillsChanged?.();
  }

  // ---------- Infra ----------

  /** Liga ou desliga os conectores locais (stdio) agora, sem reiniciar (escolha do dono na tela). */
  setAllowStdio(allowed: boolean): void {
    this.options.allowStdio = allowed;
    this.gateway.setAllowStdio(allowed);
  }

  /** Os conectores locais estão ligados agora? */
  stdioAllowed(): boolean {
    return this.options.allowStdio ?? true;
  }

  private assertStdioAllowed(): void {
    if (this.options.allowStdio ?? true) return;
    throw new HttpError(403, "Conectores stdio (comando local) estão desligados neste servidor. Para liberar, suba o server com CONNECTORS_STDIO=1 (só numa rede em que você confia).");
  }

  /** Quem usa: cada workspace liberado com os agentes dele (nome e avatar vêm do escritório do workspace). */
  private usesOf(grants: LibraryGrants): LibraryUse[] {
    return Object.entries(grants)
      .map(([workspaceId, grant]) => {
        const context = this.workspaces.get(workspaceId);
        const known = context?.agents() ?? [];
        const agents = grant.agentIds.map((id) => known.find((agent) => agent.id === id)).filter((agent): agent is LibraryUseAgent => Boolean(agent));
        // Maestro primeiro, depois por nome.
        agents.sort((a, b) => Number(b.maestro) - Number(a.maestro) || a.name.localeCompare(b.name, "pt-BR"));
        return { workspaceId, workspaceName: context?.name() ?? workspaceId, agents };
      })
      .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName, "pt-BR"));
  }

  private publicOf(record: StoredConnector): LibraryConnector {
    return publicLibraryConnector(record, this.usesOf(record.grants));
  }

  /** Mudança no cadastro: Biblioteca (todos), workspaces afetados (a forma de sempre). */
  private handleChange(change: RegistryChange): void {
    if (change.kind === "deleted") {
      this.options.publishPlatform({ type: "library:deleted", kind: "connector", id: change.id });
      for (const workspaceId of change.notify) this.workspaces.get(workspaceId)?.publish({ type: "connector:deleted", id: change.id });
      return;
    }
    this.options.publishPlatform({ type: "library:upserted", kind: "connector", item: this.publicOf(change.record) });
    for (const workspaceId of change.notify) this.workspaces.get(workspaceId)?.publish({ type: "connector:upserted", connector: workspaceConnector(change.record, workspaceId) });
    for (const workspaceId of change.dropped) this.workspaces.get(workspaceId)?.publish({ type: "connector:deleted", id: change.record.id });
  }

  /** Atividade da plataforma: liberado, retirado e agentes que entraram ou saíram, por workspace. */
  private noteGrants(record: StoredConnector, before: LibraryGrants, actor: string): void {
    const nameOf = (workspaceId: string) => this.workspaces.get(workspaceId)?.name() ?? workspaceId;
    const agentName = (workspaceId: string, agentId: string) => this.workspaces.get(workspaceId)?.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
    const after = record.grants;
    for (const workspaceId of Object.keys(after)) {
      const was = before[workspaceId];
      const now = after[workspaceId]!;
      if (!was) {
        this.record("conector-liberado", actor, `Conector ${record.name} liberado para o workspace ${nameOf(workspaceId)}${now.agentIds.length > 0 ? ` (agentes: ${now.agentIds.map((id) => agentName(workspaceId, id)).join(", ")})` : ""}`, record, { workspace: workspaceId, agentIds: now.agentIds });
        continue;
      }
      const added = now.agentIds.filter((id) => !was.agentIds.includes(id));
      const removed = was.agentIds.filter((id) => !now.agentIds.includes(id));
      if (added.length > 0) this.record("conector-entregue", actor, `Conector ${record.name} entregue a ${added.map((id) => agentName(workspaceId, id)).join(", ")} (workspace ${nameOf(workspaceId)})`, record, { workspace: workspaceId, agentIds: added });
      if (removed.length > 0) this.record("conector-tirado-do-agente", actor, `Conector ${record.name} tirado de ${removed.map((id) => agentName(workspaceId, id)).join(", ")} (workspace ${nameOf(workspaceId)})`, record, { workspace: workspaceId, agentIds: removed });
    }
    for (const workspaceId of Object.keys(before)) {
      if (workspaceId in after) continue;
      this.record("conector-retirado", actor, `Conector ${record.name} retirado do workspace ${nameOf(workspaceId)}`, record, { workspace: workspaceId });
    }
  }

  private record(action: string, actor: string, summary: string, record: Pick<StoredConnector, "id" | "name">, data: Record<string, unknown> = {}): void {
    activity({ category: "sistema", action, actor: actor || ACTIVITY_SYSTEM, summary, data: { connectorId: record.id, ...data } });
  }
}
