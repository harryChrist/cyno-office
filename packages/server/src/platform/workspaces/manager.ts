import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  cleanModelDefaults,
  INITIAL_MODEL_DEFAULTS,
  isSafeId,
  maestroSessionName,
  uniqueSlug,
  WORK_FOLDER_LIMITS,
  withoutUnusedEffort,
  workspaceAccess,
  type AddWorkFolderBody,
  type MaestroSettings,
  type ModelDefaults,
  type NewWorkspaceMaestro,
  type ServerEvent,
  type UpdateWorkFolderBody,
  type WorkFolder,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceResettableField,
  type GestaoOverrides,
  type workspaceAccessInputSchema,
} from "@cyno/shared";
import type { z } from "zod";
import { EventHub } from "../events/hub";
import { HttpError } from "../http/errors";
import { ModelDefaultsStore } from "../models/defaults-store";
import { platformPaths, rootPaths, type RootPaths } from "../../store/paths";
import { PlatformReports } from "../reports/platform-reports";
import { readWorkspaceList, WorkspaceRegistry } from "../../store/workspace-registry";
import { SubscriptionUsageTracker } from "../../engines/usage/subscription-usage";
import { checkWorkFolderPath, FOLDER_ERRORS, newFolderId } from "./folders";
import { emptyOffice, welcomeNotes, writeWorkspaceData } from "./init";
import { WorkspaceRuntime, type RuntimeOptions } from "../../workspace/runtime";
import { activeActivity } from "../../workspace/activity/log";

type GestaoPatch = GestaoOverrides;

/**
 * Id que nunca vira workspace: as pastas especiais de DATA_DIR e as páginas da UI que abrem sem
 * workspace (o endereço `#/configuracoes` não pode ser confundido com um workspace "configuracoes").
 */
export const RESERVED_WORKSPACE_IDS = ["excluidos", "workspaces", "office", "tarefas", "para-voce", "cerebro", "calendario", "configuracoes", "navegador", "gastos", "logs", "midia", "media", "gestao", "cyno", "agenda", "hoje", "biblioteca", "trabalho", "_platform"];

/**
 * Todos os workspaces: a lista (workspaces.json) e um WorkspaceRuntime por workspace, cada um
 * com o seu store, fila, orquestrador e hub. `listHub` publica `workspaces:list` para todos os
 * sockets quando a lista muda.
 */
export class WorkspaceManager {
  readonly listHub = new EventHub();
  /** Uso da assinatura das CLIs (da conta: o mesmo para todos os workspaces). */
  readonly usage: SubscriptionUsageTracker;
  /** Modelos padrão globais (preenchem os padrões de cada workspace novo). */
  readonly modelDefaults: ModelDefaultsStore;
  /** A semana da plataforma (a soma dos workspaces), gerada depois que o último workspace fecha a semana. */
  readonly platformReports: PlatformReports;
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  /** Ids em criação (reservados antes do primeiro await). */
  private readonly creating = new Set<string>();
  private started = false;

  private constructor(
    readonly paths: RootPaths,
    private readonly registry: WorkspaceRegistry,
    private readonly options: RuntimeOptions,
    private readonly now: () => Date,
  ) {
    this.usage = options.usage ?? new SubscriptionUsageTracker(now);
    this.modelDefaults = options.modelDefaults ?? ModelDefaultsStore.inMemory(INITIAL_MODEL_DEFAULTS);
    this.platformReports = new PlatformReports({
      dir: platformPaths(paths.root).reportsDir,
      workspaces: () => this.registry.list().flatMap((ws) => (this.runtimes.has(ws.id) ? [{ id: ws.id, name: ws.name, reports: this.runtimes.get(ws.id)!.reports }] : [])),
      expected: () => this.registry.list().map((ws) => ws.id),
      now,
      log: options.log,
    });
  }

  /**
   * Abre DATA_DIR (precisa já ter workspaces.json; veja seedDataDir e migrateLegacyLayout). A lista
   * pode estar vazia (todos excluídos): o server sobe sem workspace e nada é recriado sozinho.
   */
  static async open(dataDir: string, options: RuntimeOptions): Promise<WorkspaceManager> {
    const paths = rootPaths(dataDir);
    const list = await readWorkspaceList(paths.workspacesFile);
    if (!list) throw new Error(`${paths.workspacesFile} não existe (rode o seed)`);
    // Workspaces de antes dos modelos padrão (ex.: "principal") ganham os globais atuais; os agentes deles não mudam.
    const modelDefaults = options.modelDefaults ?? ModelDefaultsStore.inMemory(INITIAL_MODEL_DEFAULTS);
    const missingModels = list.filter((ws) => !ws.models);
    for (const ws of missingModels) ws.models = modelDefaults.get();
    const registry = new WorkspaceRegistry(paths.workspacesFile, list);
    if (missingModels.length > 0) await registry.commit(registry.list());
    const usage = options.usage ?? new SubscriptionUsageTracker(options.now);
    const platform: { settled?: (workspace: string, period: string) => void } = {};
    const withNames: RuntimeOptions = {
      ...options,
      usage,
      modelDefaults,
      workspaceName: (id) => registry.list().find((ws) => ws.id === id)?.name ?? id,
      workspaceModels: (id) => registry.list().find((ws) => ws.id === id)?.models,
      workspaceMaestro: (id) => registry.list().find((ws) => ws.id === id)?.maestro,
      workspaceDispatch: (id) => registry.list().find((ws) => ws.id === id)?.dispatch,
      workspaceGestao: (id) => registry.list().find((ws) => ws.id === id)?.gestao,
      reportsWeekSettled: (id, period) => platform.settled?.(id, period),
      workspaceAccess: (id) => registry.list().find((ws) => ws.id === id)?.access,
      workspaceFolders: (id) => registry.list().find((ws) => ws.id === id)?.folders,
    };
    const manager = new WorkspaceManager(paths, registry, withNames, options.now);
    platform.settled = (workspace, period) => manager.platformReports.settled(workspace, period);
    for (const ws of list) {
      manager.runtimes.set(ws.id, await WorkspaceRuntime.open(ws.id, paths.workspaceDir(ws.id), withNames));
    }
    return manager;
  }

  list(): Workspace[] {
    return this.registry.list();
  }

  /** Runtime do workspace; 404 se não existir. */
  get(id: string): WorkspaceRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new HttpError(404, `Workspace "${id}" não encontrado`);
    return runtime;
  }

  find(id: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(id);
  }

  /** Boot: retoma as filas de todos os workspaces. */
  async start(): Promise<void> {
    this.started = true;
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.resume()));
  }

  /**
   * Novo workspace: lobby com o Cérebro global (e uma nota inicial), sem quartos nem agentes; os
   * modelos padrão dele nascem dos globais, e o Maestro dele nasce com o padrão `maestro`. Com
   * `maestro`, o Maestro nasce com o nome, a aparência, o motor/modelo/esforço e as instruções
   * escolhidos (o motor escolhido vira também o padrão `maestro` do workspace).
   */
  async create(name: string, maestro?: NewWorkspaceMaestro, access?: WorkspaceAccessInput): Promise<Workspace> {
    const onDisk = await this.folderNames();
    const taken = [...this.registry.list().map((ws) => ws.id), ...this.creating, ...onDisk];
    const id = uniqueSlug(name, taken, RESERVED_WORKSPACE_IDS);
    this.creating.add(id);
    try {
      activeActivity()?.reopenWorkspace(id);
      const dir = this.paths.workspaceDir(id);
      const models = this.modelDefaults.get();
      if (maestro?.choice) models.maestro = withoutUnusedEffort(structuredClone(maestro.choice));
      const profile = maestro ? { name: maestro.name, avatar: maestro.avatar, instructions: maestro.instructions } : undefined;
      await writeWorkspaceData(dir, emptyOffice(), { global: welcomeNotes(name) });
      const runtime = await WorkspaceRuntime.open(id, dir, this.options, { maestro: models.maestro, ...(profile ? { profile } : {}) });
      const sessionName = maestro?.sessionName?.trim();
      const workspace: Workspace = {
        id,
        name,
        createdAt: this.now().toISOString(),
        models,
        ...(sessionName ? { maestro: { sessionName } } : {}),
        ...(access ? { access: mergeAccess(undefined, access) } : {}),
      };
      this.runtimes.set(id, runtime);
      await this.commit([...this.registry.list(), workspace]);
      if (this.started) await runtime.resume();
      return workspace;
    } finally {
      this.creating.delete(id);
    }
  }

  /** Renomeia (o id e a pasta não mudam). */
  rename(id: string, name: string): Promise<Workspace> {
    return this.update(id, { name });
  }

  /**
   * Renomeia e/ou troca os modelos padrão do workspace (só valem para o que nascer depois: os
   * agentes existentes ficam como estão) e as configurações do Maestro. O nome da sessão do Remote
   * Control (`maestro.sessionName`, vazio = o padrão) vale na hora: o terminal vivo do Maestro
   * recebe um `/rename` assim que estiver livre; renomear o workspace muda o nome padrão também.
   */
  async update(
    id: string,
    change: { name?: string; models?: ModelDefaults; maestro?: MaestroSettings; dispatch?: Workspace["dispatch"]; gestao?: GestaoPatch; access?: WorkspaceAccessInput; reset?: readonly WorkspaceResettableField[] },
  ): Promise<Workspace> {
    const runtime = this.get(id);
    const list = this.registry.list();
    const workspace = list.find((ws) => ws.id === id)!;
    const sessionBefore = maestroSessionName(workspace.maestro, workspace.name);
    if (change.name !== undefined) workspace.name = change.name;
    if (change.models !== undefined) workspace.models = cleanModelDefaults(structuredClone(change.models));
    if (change.maestro !== undefined) {
      const merged: MaestroSettings = { ...workspace.maestro };
      if (change.maestro.keepAlive !== undefined) merged.keepAlive = change.maestro.keepAlive;
      if (change.maestro.sessionName !== undefined) merged.sessionName = change.maestro.sessionName;
      const custom = merged.sessionName?.trim();
      if (custom) merged.sessionName = custom;
      else delete merged.sessionName;
      workspace.maestro = merged;
    }
    if (change.dispatch !== undefined) workspace.dispatch = { ...workspace.dispatch, ...change.dispatch };
    if (change.gestao !== undefined) {
      const merged: NonNullable<Workspace["gestao"]> = { ...workspace.gestao };
      if (change.gestao.dailyAt !== undefined) merged.dailyAt = change.gestao.dailyAt;
      if (change.gestao.weekly !== undefined) merged.weekly = change.gestao.weekly.trim().toLowerCase();
      if (change.gestao.ai !== undefined) merged.ai = { ...merged.ai, ...change.gestao.ai };
      workspace.gestao = merged;
    }
    if (change.access !== undefined) workspace.access = mergeAccess(workspace.access, change.access);
    // "Voltar ao padrão": apaga o valor próprio (dispatch e Maestro) ou regrava o padrão (acesso, que é guardado inteiro).
    const reset = new Set(change.reset ?? []);
    const resetOf = (group: string) => [...reset].filter((field) => field.startsWith(`${group}.`)).map((field) => field.slice(group.length + 1));
    for (const key of resetOf("dispatch")) if (workspace.dispatch) delete workspace.dispatch[key as "maxRunning" | "perAgent"];
    if (reset.size > 0 && workspace.dispatch && Object.keys(workspace.dispatch).length === 0) delete workspace.dispatch;
    for (const key of resetOf("gestao")) if (workspace.gestao) delete workspace.gestao[key as "dailyAt" | "weekly" | "ai"];
    if (reset.size > 0 && workspace.gestao && Object.keys(workspace.gestao).length === 0) delete workspace.gestao;
    for (const key of resetOf("maestro")) if (workspace.maestro) delete workspace.maestro[key as "keepAlive" | "sessionName"];
    if (reset.size > 0 && workspace.maestro && Object.keys(workspace.maestro).length === 0) delete workspace.maestro;
    const accessReset = resetOf("access");
    if (accessReset.length > 0 && workspace.access) {
      // Some o valor próprio: quem lê (`workspaceAccess`) completa com o padrão, e a tela volta a dizer "usando o padrão".
      const own: Record<string, unknown> = { ...workspace.access };
      for (const key of accessReset) delete own[key];
      workspace.access = own as unknown as WorkspaceAccess;
    }
    await this.commit(list);
    // Acesso dos agentes mudou: os terminais vivos reiniciam (quando livres) com as ferramentas novas.
    if (change.access !== undefined || accessReset.length > 0) runtime.terminals.syncAll();
    // Limites de paralelo mudaram: a distribuição dos planos confere de novo quem pode começar.
    if (change.dispatch !== undefined || resetOf("dispatch").length > 0) runtime.plans.pump();
    // "Manter o Maestro sempre rodando" mudou: sobe agora ou volta a contar a ociosidade.
    if (change.maestro !== undefined || resetOf("maestro").length > 0) runtime.terminals.refreshMaestro();
    if (maestroSessionName(workspace.maestro, workspace.name) !== sessionBefore) runtime.terminals.renameMaestroSession();
    return workspace;
  }

  /**
   * Pastas de trabalho (veja folders.ts em shared): cadastra uma pasta real do computador. O caminho é conferido
   * (absoluto, existe, é pasta, fora do DATA_DIR, sem duplicata) e gravado já normalizado. Os terminais dos agentes
   * reiniciam quando livres, como numa mudança de acesso.
   */
  async addFolder(id: string, input: AddWorkFolderBody & { mode?: WorkFolder["mode"] }): Promise<Workspace> {
    const runtime = this.get(id);
    const list = this.registry.list();
    const workspace = list.find((ws) => ws.id === id)!;
    const folders = workspace.folders ?? [];
    if (folders.length >= WORK_FOLDER_LIMITS.max) throw new HttpError(400, FOLDER_ERRORS.limit(WORK_FOLDER_LIMITS.max));
    const real = await checkWorkFolderPath(input.path, { dataDir: this.paths.root, existing: folders });
    const purpose = input.purpose?.trim();
    const folder: WorkFolder = { id: newFolderId(input.name, folders.map((item) => item.id)), name: input.name.trim(), path: real, ...(purpose ? { purpose } : {}), mode: input.mode ?? "read" };
    workspace.folders = [...folders, folder];
    await this.commit(list);
    runtime.terminals.syncAll();
    return workspace;
  }

  /** Muda nome, "para que serve" e/ou o modo de uma pasta (o caminho não muda). `purpose` vazio tira o texto. */
  async updateFolder(id: string, folderId: string, change: UpdateWorkFolderBody): Promise<Workspace> {
    const runtime = this.get(id);
    const list = this.registry.list();
    const workspace = list.find((ws) => ws.id === id)!;
    const folder = workspace.folders?.find((item) => item.id === folderId);
    if (!folder) throw new HttpError(404, "Pasta de trabalho não encontrada");
    if (change.name !== undefined) folder.name = change.name.trim();
    if (change.mode !== undefined) folder.mode = change.mode;
    if (change.purpose !== undefined) {
      const purpose = change.purpose.trim();
      if (purpose) folder.purpose = purpose;
      else delete folder.purpose;
    }
    await this.commit(list);
    runtime.terminals.syncAll();
    return workspace;
  }

  /** Tira a pasta do workspace (nada é apagado do disco). Os ajustes que agentes tinham para ela deixam de valer. */
  async removeFolder(id: string, folderId: string): Promise<Workspace> {
    const runtime = this.get(id);
    const list = this.registry.list();
    const workspace = list.find((ws) => ws.id === id)!;
    if (!workspace.folders?.some((item) => item.id === folderId)) throw new HttpError(404, "Pasta de trabalho não encontrada");
    const rest = workspace.folders.filter((item) => item.id !== folderId);
    if (rest.length > 0) workspace.folders = rest;
    else delete workspace.folders;
    await this.commit(list);
    runtime.terminals.syncAll();
    return workspace;
  }

  /** Modelos padrão do workspace (cópia; um workspace sem eles usa os globais). */
  models(id: string): ModelDefaults {
    return structuredClone(this.registry.list().find((ws) => ws.id === id)?.models ?? this.modelDefaults.get());
  }

  /**
   * Exclui o workspace (pode ser o último: o app fica sem workspace até criar outro), só sem
   * tarefas ativas. Os terminais/CLIs dele param e a pasta vai para excluidos/workspaces/<id>-<data>/
   * (nada é apagado do disco).
   */
  async remove(id: string): Promise<void> {
    const runtime = this.get(id);
    const list = this.registry.list();
    if (runtime.hasActiveTasks()) {
      throw new HttpError(409, "O workspace tem tarefas em andamento; espere terminarem para excluir");
    }
    this.runtimes.delete(id);
    await runtime.close();
    // A Biblioteca tira o workspace de todas as liberações (os conectores continuam lá, nos outros).
    await this.options.library.forgetWorkspace(id);
    await this.commit(list.filter((ws) => ws.id !== id));
    // A Atividade (gravação em lote) não pode recriar a pasta depois que ela for movida.
    await activeActivity()?.retireWorkspace(id);
    await mkdir(this.paths.deletedWorkspacesDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    await rename(this.paths.workspaceDir(id), path.join(this.paths.deletedWorkspacesDir, `${id}-${stamp}`));
  }

  /** Para todas as filas e espera as gravações pendentes. */
  async close(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.close()));
    await this.registry.flush();
    await this.modelDefaults.flush();
  }

  private async commit(next: Workspace[]): Promise<void> {
    const saved = this.registry.commit(next);
    const event: ServerEvent = { type: "workspaces:list", workspaces: this.registry.list() };
    this.listHub.publish(event);
    await saved;
  }

  /** Pastas em workspaces/ (inclusive sobras sem registro): um id novo nunca reaproveita uma. */
  private async folderNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths.workspacesDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

/** Campos de acesso que chegam do usuário (já validados e com os domínios normalizados). */
type WorkspaceAccessInput = z.output<typeof workspaceAccessInputSchema>;

/** A política atual (ou os padrões) com o que mudou por cima (só os campos presentes). */
function mergeAccess(current: WorkspaceAccess | undefined, change: WorkspaceAccessInput): WorkspaceAccess {
  const defined = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
  return workspaceAccess({ ...workspaceAccess(current), ...defined });
}
