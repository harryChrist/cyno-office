import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVITY_USER,
  type AppCard,
  type AppRun,
  type AppRuntimeInfo,
  type AppsListing,
  type AppTest,
  type CatalogApp,
  type InstallAppBody,
  type InstallJob,
  type InstallJobKind,
  type InstallPhase,
  type InstallPlan,
  type LibraryApp,
  type RecipeStep,
  type ServerEvent,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { checkRequirements, platformSupported, type MachineProbe } from "./requirements";
import { isInside, resolveInside, type AppsPaths } from "./paths";
import { RUNTIMES, platformKey } from "./runtimes";
import { stageSkill } from "./skill-stage";
import { AppsStore } from "./store";
import { appEnvironment, DEFAULT_STEP_TIMEOUT_SEC, describeStep, downloadsOfStep, NeedsOwnerError, phaseOfStep, realExec, stepEnvironment, type ExecFn, type StepContext, type StepExecutors } from "./steps";

/** O que a Biblioteca oferece ao instalador (o `LibraryService` implementa; os testes trocam por um falso). */
export type AppConnectorInput = {
  appId: string;
  /** `app`: sem processo; as ferramentas da receita rodam pelo AppToolRunner. */
  kind: "stdio" | "app";
  name: string;
  description: string;
  /** Caminho absoluto do comando (dentro da pasta do app) e argumentos (só stdio). */
  command?: string;
  args?: string[];
  env: Record<string, string>;
  warnings: string[];
  limits?: { idleSec: number; startSec: number; callSec: number };
};
export type MiniTestResult = { ok: boolean; tool: string; detail: string; ms: number };
export interface AppLibraryPort {
  /** Conectores locais (stdio) ligados neste servidor? */
  stdioAllowed(): boolean;
  /** Cria o conector do app (sem liberação a ninguém) ou atualiza o que já existe; devolve o id. */
  upsertAppConnector(input: AppConnectorInput): Promise<string>;
  /** Para os processos, remove os conectores do app e as liberações; devolve os ids removidos. */
  removeAppConnectors(appId: string): Promise<string[]>;
  setConnectorEnabled(connectorId: string, enabled: boolean): Promise<void>;
  connectorExists(connectorId: string): boolean;
  /** Guarda na Biblioteca uma cópia (só leitura) da skill que o app entrega; devolve o id. */
  registerAppSkill(appId: string, appPath: string, dir: string, requires?: string[]): Promise<string>;
  /** Remove as skills do app (e as liberações delas); devolve os ids. */
  removeAppSkills(appId: string): Promise<string[]>;
  /** Cancela as execuções do app (na fila e rodando) antes de apagar a pasta. */
  stopApp(appId: string): Promise<void>;
  /** Sobe o MCP, lista as ferramentas, confere as esperadas e chama a do teste. */
  miniTest(connectorId: string, test: AppTest, expectTools: string[]): Promise<MiniTestResult>;
}

export type AppInstallerDeps = {
  paths: AppsPaths;
  catalog: CatalogApp[];
  store: AppsStore;
  port: AppLibraryPort;
  probe: MachineProbe;
  executors: StepExecutors;
  exec?: ExecFn;
  fetch?: typeof fetch;
  which?: (bin: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  publish: (event: ServerEvent) => void;
  /** Execuções recentes das ferramentas dos apps (a fila e a última execução na aba Apps). */
  runs?: () => AppRun[];
  /** Linha na Atividade da plataforma. */
  record: (action: string, summary: string, data: Record<string, unknown>) => void;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now: () => Date;
};

class Cancelled extends Error {
  constructor() {
    super("cancelado");
  }
}

type Running = { controller: AbortController; promise: Promise<void>; jobId: string; kind: InstallJobKind };

const REGISTER_LABEL = "Registrar o conector na Biblioteca";
const SKILLS_LABEL = "Registrar as skills do app na Biblioteca";
const TEST_LABEL = "Mini teste: subir o MCP e chamar uma ferramenta";

/** Tamanho de uma pasta em bytes (sem seguir links; arquivo com vários links duros conta uma vez, como o `du`). */
export async function dirSize(dir: string, seen: Set<string> = new Set()): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full, seen);
    else {
      try {
        const info = await lstat(full);
        if (info.nlink > 1) {
          const key = `${info.dev}:${info.ino}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        total += info.size;
      } catch {
        // sumiu no meio
      }
    }
  }
  return total;
}

/**
 * O instalador de apps externos. A receita do catálogo é fixada e executada POR CÓDIGO (sem IA, sem
 * shell): cada passo é um `execFile` com argumentos, dentro de `data/platform/apps/<id>/` ou dos
 * runtimes compartilhados. O clique em "Instalar" (depois do plano) é o OK do dono. Fluxo:
 * checando -> baixando/construindo (passos) -> registrando (conector sem liberação) -> testando (mini
 * teste de verdade) -> pronto. Falhou: dá para retomar do passo que parou. Precisa de sudo: o job
 * espera o dono ("precisa-do-dono") e mostra o comando; o código nunca roda sudo. Cancelar apaga tudo.
 */
export class AppInstaller {
  private readonly running = new Map<string, Running>();
  private chain: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly exec: ExecFn;
  private readonly fetchFn: typeof fetch;
  private readonly which: (bin: string) => string | undefined;

  constructor(private readonly deps: AppInstallerDeps) {
    this.exec = deps.exec ?? realExec;
    this.fetchFn = deps.fetch ?? fetch;
    this.which = deps.which ?? ((bin) => deps.probe.which(bin));
  }

  // ---------- Leitura ----------

  private entry(catalogId: string): CatalogApp {
    const entry = this.deps.catalog.find((candidate) => candidate.id === catalogId);
    if (!entry) throw new HttpError(404, `App "${catalogId}" não está no catálogo`);
    return entry;
  }

  async listing(): Promise<AppsListing> {
    const cards: AppCard[] = this.deps.catalog.map((entry) => {
      const app = this.deps.store.get(entry.id);
      const job = app?.jobId ? this.deps.store.job(app.jobId) : undefined;
      const update = app && app.state === "instalado" && entry.status === "disponivel" && app.recipeVersion !== undefined && app.recipeVersion !== entry.recipeVersion ? { from: app.version, to: entry.version.ref } : undefined;
      return { entry, ...(app ? { app } : {}), requirements: checkRequirements(entry, this.deps.probe), ...(job ? { job } : {}), ...(update ? { update } : {}) };
    });
    return { stdioAllowed: this.deps.port.stdioAllowed(), cards, runtimes: await this.collectRuntimes(), runs: this.deps.runs?.() ?? [] };
  }

  /** O plano que o dono vê antes do OK: tudo montado por código a partir da receita e da máquina. */
  plan(catalogId: string): InstallPlan {
    const entry = this.entry(catalogId);
    const requirements = checkRequirements(entry, this.deps.probe);
    const blockers: string[] = [];
    const stdioAllowed = this.deps.port.stdioAllowed();
    if (entry.status !== "disponivel") blockers.push(entry.pending ?? "Este app ainda não tem receita de instalação.");
    if (entry.status === "disponivel") {
      if (!stdioAllowed) blockers.push("Os conectores locais estão desligados neste servidor. Suba o servidor com CONNECTORS_STDIO=1 para instalar apps.");
      if (!platformSupported(this.deps.probe)) blockers.push(`O instalador ainda não sabe baixar os runtimes para este sistema (${platformKey(this.deps.probe.platform, this.deps.probe.arch)}).`);
      for (const result of requirements) if (result.status === "falta" && !result.sudoHint) blockers.push(`${result.label}: ${result.found ?? "não atende"}.`);
      const platformName = platformKey(this.deps.probe.platform, this.deps.probe.arch);
      for (const step of entry.recipe) if (step.run === "download-runtime" && !RUNTIMES[step.runtime].targets[platformName]) blockers.push(`Não há ${RUNTIMES[step.runtime].id} para este sistema (${platformName}).`);
    }
    const platform = platformKey(this.deps.probe.platform, this.deps.probe.arch);
    const seen = new Set<string>();
    const downloads = entry.recipe
      .flatMap((step) => downloadsOfStep(step, platform))
      .filter((item) => (seen.has(item.from + item.what) ? false : (seen.add(item.from + item.what), true)));
    const connector = entry.provides.connector;
    const toolCount = connector?.kind === "app" ? (connector.tools ?? []).length : (connector?.expectTools.length ?? 0);
    const tools = toolCount > 0 ? `${toolCount} ferramenta${toolCount === 1 ? "" : "s"}` : "ferramentas";
    const skillCount = (entry.provides.skills ?? []).length;
    return {
      appId: entry.id,
      name: entry.name,
      repo: entry.repo,
      version: entry.version.ref,
      summary: entry.summary,
      license: entry.license,
      warnings: entry.warnings,
      requirements,
      downloads,
      steps: this.stepLabels(entry),
      diskMB: entry.resources.diskMB,
      ramMB: entry.resources.ramMB,
      ...(entry.resources.note ? { note: entry.resources.note } : {}),
      provides: connector ? `1 conector (${tools})${skillCount > 0 ? ` e ${skillCount} skill${skillCount === 1 ? "" : "s"}` : ""}. Nada é liberado a ninguém: depois de instalar, você escolhe quais workspaces e agentes recebem.` : "nada",
      stdioAllowed,
      canInstall: blockers.length === 0,
      blockers,
    };
  }

  runtimes(): Promise<AppRuntimeInfo[]> {
    return this.collectRuntimes();
  }

  async log(jobId: string): Promise<string> {
    if (!this.deps.store.job(jobId)) throw new HttpError(404, `Job "${jobId}" não encontrado`);
    return this.deps.store.readLog(jobId);
  }

  // ---------- Instalar ----------

  async install(catalogId: string, body: InstallAppBody = {}): Promise<{ app: LibraryApp; job: InstallJob }> {
    const entry = this.entry(catalogId);
    if (entry.status !== "disponivel") throw new HttpError(409, entry.pending ?? "Este app ainda não tem receita de instalação.");
    const existing = this.deps.store.get(entry.id);
    if (existing) throw new HttpError(409, `${entry.name} já está instalado (use Retomar, Atualizar ou Desinstalar).`);
    const plan = this.plan(catalogId);
    if (!plan.canInstall) throw new HttpError(plan.stdioAllowed ? 409 : 403, plan.blockers[0]!);
    if (entry.license.mustAccept && !body.acceptLicense) throw new HttpError(400, "Esta licença exige o aceite: marque \"Li o aviso\" para instalar.");
    const now = this.deps.now().toISOString();
    const app: LibraryApp = {
      id: entry.id,
      catalogId: entry.id,
      name: entry.name,
      version: entry.version.ref,
      dir: `apps/${entry.id}`,
      state: "instalando",
      requires: plan.requirements.map((r) => ({ kind: r.kind, spec: r.spec, ok: r.status !== "falta", ...(r.found ? { found: r.found } : {}), ...(r.sudoHint ? { sudoHint: r.sudoHint } : {}) })),
      license: { spdx: entry.license.spdx, level: entry.license.level, ...(body.acceptLicense ? { acceptedAt: now } : {}) },
      provides: { connectorIds: [], skillIds: [] },
      installedAt: now,
      recipeVersion: entry.recipeVersion,
    };
    const job = this.newJob(entry, "install");
    app.jobId = job.id;
    await this.deps.store.put(app);
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:app", app });
    this.deps.publish({ type: "library:job", job });
    this.deps.record("app-instalacao-iniciada", `Instalação do app ${entry.name} iniciada (OK do dono: clique em Instalar)`, { appId: entry.id, jobId: job.id, version: entry.version.ref });
    this.start(entry, job, 0);
    return { app, job };
  }

  /** Retoma do passo em que parou (falhou ou esperava o dono). */
  async resume(appId: string): Promise<{ app: LibraryApp; job: InstallJob }> {
    const app = this.deps.store.get(appId);
    if (!app) throw new HttpError(404, `App "${appId}" não está instalado`);
    if (this.running.has(appId)) throw new HttpError(409, "Já há uma instalação em andamento para este app.");
    if (app.state !== "falhou" && app.state !== "precisa-do-dono") throw new HttpError(409, "Este app não tem nada a retomar.");
    const entry = this.entry(app.catalogId);
    const previous = app.jobId ? this.deps.store.job(app.jobId) : undefined;
    const kind: InstallJobKind = previous && previous.kind !== "uninstall" ? previous.kind : "install";
    const job = previous && previous.kind !== "uninstall" ? previous : this.newJob(entry, kind);
    const from = previous && previous.kind !== "uninstall" ? Math.min(previous.stepIndex, job.steps.length - 1) : 0;
    job.phase = "checando";
    delete job.error;
    delete job.needs;
    delete job.finishedAt;
    app.state = kind === "update" ? "atualizando" : "instalando";
    delete app.needs;
    delete app.error;
    app.jobId = job.id;
    await this.deps.store.put(app);
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:app", app });
    this.deps.publish({ type: "library:job", job });
    await this.writeLog(job.id, `--- retomando a partir do passo ${from + 1}: ${job.steps[from]?.label ?? ""} ---`);
    this.start(entry, job, from);
    return { app, job };
  }

  /** Atualiza para a receita nova do catálogo (mesma pasta; o conector e as liberações continuam). */
  async update(appId: string): Promise<{ app: LibraryApp; job: InstallJob }> {
    const app = this.deps.store.get(appId);
    if (!app) throw new HttpError(404, `App "${appId}" não está instalado`);
    if (this.running.has(appId)) throw new HttpError(409, "Já há uma operação em andamento para este app.");
    const entry = this.entry(app.catalogId);
    if (entry.status !== "disponivel") throw new HttpError(409, "O catálogo não tem receita para este app.");
    if (app.state !== "instalado") throw new HttpError(409, "Só dá para atualizar um app instalado.");
    if (app.recipeVersion === entry.recipeVersion) throw new HttpError(409, "Este app já está na versão do catálogo.");
    if (!this.deps.port.stdioAllowed()) throw new HttpError(403, "Os conectores locais estão desligados neste servidor (CONNECTORS_STDIO=1).");
    const job = this.newJob(entry, "update");
    app.state = "atualizando";
    app.jobId = job.id;
    delete app.error;
    await this.deps.store.put(app);
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:app", app });
    this.deps.publish({ type: "library:job", job });
    this.deps.record("app-atualizacao-iniciada", `Atualização do app ${entry.name} iniciada (${app.version} -> ${entry.version.ref})`, { appId, jobId: job.id });
    this.start(entry, job, 0);
    return { app, job };
  }

  /** Cancela uma instalação em andamento e limpa tudo (pasta, conector, runtimes que ela baixou). */
  async cancel(appId: string): Promise<void> {
    const running = this.running.get(appId);
    if (!running || running.kind === "uninstall") throw new HttpError(409, "Não há instalação em andamento para cancelar.");
    running.controller.abort();
    await running.promise;
  }

  /** Roda o mini teste de novo (e recria o conector se ele sumiu). */
  async retest(appId: string): Promise<LibraryApp> {
    const app = this.deps.store.get(appId);
    if (!app) throw new HttpError(404, `App "${appId}" não está instalado`);
    if (this.running.has(appId) || (app.state !== "instalado" && app.state !== "falhou")) throw new HttpError(409, "Espere a operação em andamento terminar.");
    const entry = this.entry(app.catalogId);
    const spec = entry.provides.connector;
    if (!spec || !entry.test) throw new HttpError(409, "Este app não tem conector para testar.");
    const connectorId = await this.registerConnector(entry, app);
    app.provides.connectorIds = [connectorId];
    const result = await this.runMiniTest(entry, connectorId);
    app.lastTest = { at: this.deps.now().toISOString(), ok: result.ok, tool: result.tool, detail: result.detail.slice(0, 400), ms: result.ms };
    app.state = "instalado";
    if (result.ok) await this.deps.port.setConnectorEnabled(connectorId, true);
    await this.deps.store.put(app);
    this.deps.publish({ type: "library:app", app });
    return app;
  }

  // ---------- Desinstalar ----------

  async uninstall(appId: string): Promise<void> {
    const app = this.deps.store.get(appId);
    if (!app) throw new HttpError(404, `App "${appId}" não está instalado`);
    if (this.running.has(appId)) throw new HttpError(409, "Há uma operação em andamento: cancele ou espere antes de desinstalar.");
    const name = app.name;
    const job: InstallJob = { id: this.deps.store.nextJobId(), appId, kind: "uninstall", phase: "removendo", steps: [{ label: "Parar os processos e remover o conector, as skills e as liberações", status: "pendente" }, { label: "Apagar a pasta do app", status: "pendente" }, { label: "Limpar os runtimes que ninguém mais usa", status: "pendente" }], stepIndex: 0, startedAt: this.deps.now().toISOString() };
    app.state = "desinstalando";
    app.jobId = job.id;
    await this.deps.store.put(app);
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:app", app });
    this.deps.publish({ type: "library:job", job });
    const controller = new AbortController();
    const promise = (async () => {
      try {
        await this.setStep(job, 0, "andando");
        await this.deps.port.stopApp(appId);
        const removed = await this.deps.port.removeAppConnectors(appId);
        await this.writeLog(job.id, `Conectores removidos: ${removed.length > 0 ? removed.join(", ") : "nenhum"}.`);
        const removedSkills = await this.deps.port.removeAppSkills(appId);
        await this.writeLog(job.id, `Skills removidas: ${removedSkills.length > 0 ? removedSkills.join(", ") : "nenhuma"}.`);
        await this.setStep(job, 0, "feito");
        await this.setStep(job, 1, "andando");
        await this.removeAppDir(appId);
        await this.writeLog(job.id, `Pasta apps/${appId} apagada.`);
        await this.setStep(job, 1, "feito");
        await this.setStep(job, 2, "andando");
        const cleaned = await this.cleanRuntimesExcept(appId);
        await this.writeLog(job.id, cleaned.length > 0 ? `Runtimes removidos (ninguém mais usa): ${cleaned.join(", ")}.` : "Runtimes mantidos (outro app usa) ou nenhum a limpar.");
        await this.setStep(job, 2, "feito");
        await this.deps.store.remove(appId);
        job.phase = "pronto";
        job.finishedAt = this.deps.now().toISOString();
        await this.deps.store.putJob(job);
        this.deps.publish({ type: "library:job", job });
        this.deps.publish({ type: "library:app-removed", id: appId });
        this.deps.record("app-desinstalado", `App ${name} desinstalado (pasta, conector e liberações removidos)`, { appId, jobId: job.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.error({ err: error, appId }, "desinstalação falhou");
        job.phase = "falhou";
        job.error = message;
        job.finishedAt = this.deps.now().toISOString();
        const current = this.deps.store.get(appId);
        if (current) {
          current.state = "falhou";
          current.error = `A desinstalação não terminou: ${message}`;
          await this.deps.store.put(current);
          this.deps.publish({ type: "library:app", app: current });
        }
        await this.deps.store.putJob(job);
        this.deps.publish({ type: "library:job", job });
      } finally {
        this.running.delete(appId);
      }
    })();
    this.running.set(appId, { controller, promise, jobId: job.id, kind: "uninstall" });
    await promise;
  }

  // ---------- Runtimes ----------

  private async collectRuntimes(): Promise<AppRuntimeInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.deps.paths.runtimesRoot);
    } catch {
      return [];
    }
    const used = this.runtimeUsers();
    const infos: AppRuntimeInfo[] = [];
    for (const name of names.sort()) {
      const dir = path.join(this.deps.paths.runtimesRoot, name);
      infos.push({ id: name, label: RUNTIMES[name as keyof typeof RUNTIMES]?.label ?? name, sizeBytes: await dirSize(dir), usedBy: used.get(name) ?? [] });
    }
    return infos;
  }

  /** runtime -> apps (instalados ou instalando) cuja receita o usa. */
  private runtimeUsers(except?: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const app of this.deps.store.list()) {
      if (app.id === except) continue;
      const entry = this.deps.catalog.find((candidate) => candidate.id === app.catalogId);
      for (const step of entry?.recipe ?? []) if (step.run === "download-runtime") map.set(step.runtime, [...(map.get(step.runtime) ?? []), app.id]);
    }
    return map;
  }

  /** Apaga os runtimes que nenhum app instalado usa; devolve os ids apagados. */
  async cleanRuntimes(): Promise<string[]> {
    return this.cleanRuntimesExcept();
  }

  private async cleanRuntimesExcept(except?: string): Promise<string[]> {
    const used = this.runtimeUsers(except);
    const removed: string[] = [];
    let names: string[];
    try {
      names = await readdir(this.deps.paths.runtimesRoot);
    } catch {
      return removed;
    }
    for (const name of names) {
      if ((used.get(name) ?? []).length > 0) continue;
      await this.removeManaged(path.join(this.deps.paths.runtimesRoot, name));
      removed.push(name);
    }
    return removed;
  }

  // ---------- Execução ----------

  /** Os passos da receita e os de depois (conector, skills, mini teste), na ordem em que rodam. */
  private stepLabels(entry: CatalogApp): string[] {
    return [...entry.recipe.map(describeStep), ...(entry.provides.connector ? [REGISTER_LABEL] : []), ...((entry.provides.skills ?? []).length > 0 ? [SKILLS_LABEL] : []), ...(entry.provides.connector && entry.test ? [TEST_LABEL] : [])];
  }

  private newJob(entry: CatalogApp, kind: InstallJobKind): InstallJob {
    const labels = this.stepLabels(entry);
    return { id: this.deps.store.nextJobId(), appId: entry.id, kind, phase: "checando", steps: labels.map((label) => ({ label, status: "pendente" as const })), stepIndex: 0, startedAt: this.deps.now().toISOString() };
  }

  private start(entry: CatalogApp, job: InstallJob, from: number): void {
    const controller = new AbortController();
    const promise = this.queued(() => this.run(entry, job, from, controller)).finally(() => this.running.delete(entry.id));
    this.running.set(entry.id, { controller, promise, jobId: job.id, kind: job.kind });
  }

  /** Uma instalação por vez (RAM e disco): a seguinte espera na fila. */
  private queued(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async writeLog(jobId: string, line: string): Promise<void> {
    this.deps.publish({ type: "library:job-log", jobId, line });
    await this.deps.store.appendLog(jobId, line).catch(() => undefined);
  }

  private async setStep(job: InstallJob, index: number, status: InstallJob["steps"][number]["status"]): Promise<void> {
    job.stepIndex = index;
    if (job.steps[index]) job.steps[index]!.status = status;
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:job", job });
  }

  private async setPhase(job: InstallJob, phase: InstallPhase): Promise<void> {
    job.phase = phase;
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:job", job });
  }

  private async run(entry: CatalogApp, job: InstallJob, from: number, controller: AbortController): Promise<void> {
    const appId = entry.id;
    const signal = controller.signal;
    const createdRuntimes = new Set<string>();
    const app = this.deps.store.get(appId);
    if (!app) return;
    try {
      if (signal.aborted) throw new Cancelled();
      await this.setPhase(job, "checando");
      await this.writeLog(job.id, `Instalando ${entry.name} (${entry.version.ref}) em apps/${appId}`);
      const requirements = checkRequirements(entry, this.deps.probe);
      for (const requirement of requirements) await this.writeLog(job.id, `  ${requirement.status === "ok" ? "ok" : requirement.status === "baixa" ? "será baixado" : requirement.status}: ${requirement.label}${requirement.found ? ` (${requirement.found})` : ""}`);
      const blocking = requirements.find((requirement) => requirement.status === "falta" && !requirement.sudoHint);
      if (blocking) throw new Error(`${blocking.label}: ${blocking.found ?? "não atende"}`);
      const appDir = this.deps.paths.appDir(appId);
      await mkdir(appDir, { recursive: true });
      const context: StepContext = {
        appId,
        appDir,
        runtimesRoot: this.deps.paths.runtimesRoot,
        env: stepEnvironment(appDir, this.deps.paths.runtimesRoot, this.deps.env),
        log: (line: string) => void this.writeLog(job.id, line),
        signal,
        timeoutMs: 0,
        exec: this.exec,
        fetch: this.fetchFn,
        which: this.which,
        platform: platformKey(this.deps.probe.platform, this.deps.probe.arch),
        createdRuntimes,
      };
      for (let index = from; index < entry.recipe.length; index++) {
        if (signal.aborted) throw new Cancelled();
        const step = entry.recipe[index]!;
        await this.setPhase(job, phaseOfStep(step));
        await this.setStep(job, index, "andando");
        await this.writeLog(job.id, `[${index + 1}/${job.steps.length}] ${describeStep(step)}`);
        const started = Date.now();
        const executor = this.deps.executors[step.run] as (step: RecipeStep, context: StepContext) => Promise<void>;
        try {
          await executor(step, { ...context, timeoutMs: (step.timeoutSec ?? DEFAULT_STEP_TIMEOUT_SEC[step.run]) * 1000 });
        } catch (error) {
          if (signal.aborted) throw new Cancelled();
          if (error instanceof NeedsOwnerError) {
            await this.setStep(job, index, "precisa");
            await this.writeLog(job.id, `Precisa de você: ${error.reason}`);
            await this.writeLog(job.id, `Rode no terminal: ${error.command}`);
            await this.needsOwner(app, job, error);
            return;
          }
          await this.setStep(job, index, "falhou");
          throw error;
        }
        await this.setStep(job, index, "feito");
        await this.writeLog(job.id, `  feito em ${((Date.now() - started) / 1000).toFixed(1)} s`);
      }

      // Registrar o conector, as skills e provar que funciona.
      if (entry.provides.connector) {
        let index = entry.recipe.length;
        if (signal.aborted) throw new Cancelled();
        await this.setPhase(job, "registrando");
        await this.setStep(job, index, "andando");
        await this.writeLog(job.id, `[${index + 1}/${job.steps.length}] ${REGISTER_LABEL}`);
        const connectorId = await this.registerConnector(entry, app);
        app.provides.connectorIds = [connectorId];
        await this.setStep(job, index, "feito");
        await this.writeLog(job.id, `  conector "${connectorId}" criado na Biblioteca, sem liberação a ninguém.`);
        index += 1;
        if ((entry.provides.skills ?? []).length > 0) {
          if (signal.aborted) throw new Cancelled();
          await this.setStep(job, index, "andando");
          await this.writeLog(job.id, `[${index + 1}/${job.steps.length}] ${SKILLS_LABEL}`);
          app.provides.skillIds = await this.registerSkills(entry, app);
          await this.setStep(job, index, "feito");
          await this.writeLog(job.id, `  ${app.provides.skillIds.length} skill${app.provides.skillIds.length === 1 ? "" : "s"} na Biblioteca (só leitura), sem liberação a ninguém: ${app.provides.skillIds.join(", ")}.`);
          index += 1;
        }
        if (entry.test) {
          const testIndex = index;
          if (signal.aborted) throw new Cancelled();
          await this.setPhase(job, "testando");
          await this.setStep(job, testIndex, "andando");
          await this.writeLog(job.id, `[${testIndex + 1}/${job.steps.length}] ${TEST_LABEL} (${entry.test.tool})`);
          const result = await this.runMiniTest(entry, connectorId);
          if (signal.aborted) throw new Cancelled();
          job.test = { ok: result.ok, tool: result.tool, detail: result.detail, ms: result.ms };
          app.lastTest = { at: this.deps.now().toISOString(), ok: result.ok, tool: result.tool, detail: result.detail.slice(0, 400), ms: result.ms };
          await this.setStep(job, testIndex, result.ok ? "feito" : "falhou");
          await this.writeLog(job.id, `  ${result.ok ? "passou" : "FALHOU"} em ${(result.ms / 1000).toFixed(1)} s: ${result.detail.slice(0, 300)}`);
          if (!result.ok) await this.deps.port.setConnectorEnabled(connectorId, false);
        }
      }

      app.state = "instalado";
      app.version = entry.version.ref;
      app.recipeVersion = entry.recipeVersion;
      delete app.needs;
      delete app.error;
      app.sizeBytes = await dirSize(this.deps.paths.appDir(appId));
      if (job.kind === "install") app.installedAt = this.deps.now().toISOString();
      await this.deps.store.put(app);
      this.deps.publish({ type: "library:app", app });
      job.phase = "pronto";
      job.finishedAt = this.deps.now().toISOString();
      await this.deps.store.putJob(job);
      this.deps.publish({ type: "library:job", job });
      const ok = app.lastTest?.ok !== false;
      this.deps.record(ok ? "app-instalado" : "app-instalado-com-problema", `App ${entry.name} ${job.kind === "update" ? "atualizado" : "instalado"} ${ok ? "e testado" : "mas o mini teste falhou"} (${((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(0)} s)`, { appId, jobId: job.id, version: entry.version.ref, ok });
      await this.writeLog(job.id, ok ? `Pronto: ${entry.name} instalado e testado.` : `Instalado, mas o mini teste falhou: ${app.lastTest?.detail ?? ""}`);
    } catch (error) {
      if (this.closing) return;
      if (error instanceof Cancelled || signal.aborted) {
        await this.onCancelled(entry, app, job, createdRuntimes);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.warn({ err: error, appId, jobId: job.id }, "instalação de app falhou");
      await this.writeLog(job.id, `FALHOU: ${message}`);
      if (job.steps[job.stepIndex]?.status === "andando") job.steps[job.stepIndex]!.status = "falhou";
      job.phase = "falhou";
      job.error = message;
      job.finishedAt = this.deps.now().toISOString();
      await this.deps.store.putJob(job);
      this.deps.publish({ type: "library:job", job });
      app.state = "falhou";
      app.error = message.slice(0, 800);
      await this.deps.store.put(app);
      this.deps.publish({ type: "library:app", app });
      this.deps.record("app-falhou", `Instalação do app ${entry.name} falhou: ${message.slice(0, 200)}`, { appId, jobId: job.id });
    }
  }

  private async needsOwner(app: LibraryApp, job: InstallJob, error: NeedsOwnerError): Promise<void> {
    job.phase = "precisa-do-dono";
    job.needs = { command: error.command, reason: error.reason };
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:job", job });
    app.state = "precisa-do-dono";
    app.needs = { command: error.command, reason: error.reason };
    await this.deps.store.put(app);
    this.deps.publish({ type: "library:app", app });
    this.deps.record("app-precisa-do-dono", `Instalação do app ${app.name} parou: precisa de você (${error.reason})`, { appId: app.id, jobId: job.id, command: error.command });
  }

  private async registerConnector(entry: CatalogApp, app: LibraryApp): Promise<string> {
    const spec = entry.provides.connector!;
    const appDir = this.deps.paths.appDir(app.id);
    if (spec.kind === "app") {
      return this.deps.port.upsertAppConnector({ appId: app.id, kind: "app", name: spec.name, description: spec.description, env: {}, warnings: [...entry.warnings] });
    }
    const [bin, ...rawArgs] = spec.command!;
    const command = resolveInside(appDir, bin!);
    // `{app}` nos argumentos e nas variáveis = a pasta do app (o servidor MCP roda em outra pasta e precisa do caminho inteiro).
    const fill = (text: string) => text.replaceAll("{app}", appDir);
    const args = rawArgs.map(fill);
    const env = { ...Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, fill(value)])), ...appEnvironment(appDir, this.deps.paths.runtimesRoot, this.deps.env ?? process.env) };
    return this.deps.port.upsertAppConnector({
      appId: app.id,
      kind: "stdio",
      name: spec.name,
      description: spec.description,
      command,
      args,
      env,
      warnings: [...entry.warnings],
      ...(spec.limits ? { limits: spec.limits } : {}),
    });
  }

  /** Copia (só os arquivos permitidos) e registra cada skill do app na Biblioteca. */
  private async registerSkills(entry: CatalogApp, app: LibraryApp): Promise<string[]> {
    const appDir = this.deps.paths.appDir(app.id);
    const ids: string[] = [];
    for (const [index, spec] of (entry.provides.skills ?? []).entries()) {
      const dir = await stageSkill(appDir, spec, index);
      ids.push(await this.deps.port.registerAppSkill(app.id, spec.from, dir, spec.requires));
    }
    return ids;
  }

  private async runMiniTest(entry: CatalogApp, connectorId: string): Promise<MiniTestResult> {
    // `{app}` nos argumentos do teste = a pasta do app (caminho absoluto que o MCP do app precisa).
    const appDir = this.deps.paths.appDir(entry.id);
    const fill = (value: unknown): unknown => (typeof value === "string" ? value.replaceAll("{app}", appDir) : Array.isArray(value) ? value.map(fill) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)])) : value);
    const test = { ...entry.test!, args: fill(entry.test!.args) as Record<string, unknown> };
    try {
      return await this.deps.port.miniTest(connectorId, test, entry.provides.connector?.expectTools ?? []);
    } catch (error) {
      return { ok: false, tool: test.tool, detail: error instanceof Error ? error.message : String(error), ms: 0 };
    }
  }

  /** Cancelou: instalação nova some inteira (pasta, conector, runtimes que ela baixou e ninguém mais usa); atualização só para. */
  private async onCancelled(entry: CatalogApp, app: LibraryApp, job: InstallJob, createdRuntimes: Set<string>): Promise<void> {
    await this.writeLog(job.id, "Cancelado pelo dono.");
    job.phase = "cancelado";
    job.finishedAt = this.deps.now().toISOString();
    if (job.kind === "update") {
      app.state = "falhou";
      app.error = "Atualização cancelada. Tente de novo ou desinstale.";
      await this.deps.store.put(app);
      this.deps.publish({ type: "library:app", app });
      await this.deps.store.putJob(job);
      this.deps.publish({ type: "library:job", job });
      return;
    }
    await this.deps.port.stopApp(app.id).catch(() => undefined);
    await this.deps.port.removeAppConnectors(app.id).catch(() => undefined);
    await this.deps.port.removeAppSkills(app.id).catch(() => undefined);
    await this.removeAppDir(app.id).catch((error: unknown) => this.deps.log.error({ err: error }, "não foi possível limpar a pasta do app cancelado"));
    const used = this.runtimeUsers(app.id);
    for (const id of createdRuntimes) if ((used.get(id) ?? []).length === 0) await this.removeManaged(path.join(this.deps.paths.runtimesRoot, id)).catch(() => undefined);
    await this.deps.store.remove(app.id);
    await this.writeLog(job.id, `Limpeza feita: pasta apps/${app.id}${createdRuntimes.size > 0 ? " e os runtimes baixados" : ""} apagados.`);
    await this.deps.store.putJob(job);
    this.deps.publish({ type: "library:job", job });
    this.deps.publish({ type: "library:app-removed", id: app.id });
    this.deps.record("app-instalacao-cancelada", `Instalação do app ${entry.name} cancelada e limpa`, { appId: app.id, jobId: job.id, by: ACTIVITY_USER });
  }

  private async removeAppDir(appId: string): Promise<void> {
    await this.removeManaged(this.deps.paths.appDir(appId));
  }

  /** `rm -rf` só dentro de `data/platform/apps` ou `data/platform/runtimes` (e nunca nas próprias raízes). */
  private async removeManaged(target: string): Promise<void> {
    const roots = [this.deps.paths.appsRoot, this.deps.paths.runtimesRoot];
    const full = path.resolve(target);
    if (roots.some((root) => path.resolve(root) === full) || !isInside(full, roots)) throw new Error(`recusei apagar fora das pastas de apps e runtimes: ${target}`);
    await rm(full, { recursive: true, force: true });
  }

  /** Ao abrir: o que estava no meio quando o servidor caiu vira "falhou" (dá para retomar ou desinstalar). */
  async recover(): Promise<void> {
    for (const app of this.deps.store.list()) {
      if (app.state !== "instalando" && app.state !== "atualizando" && app.state !== "desinstalando") continue;
      app.state = "falhou";
      app.error = "Interrompido pelo reinício do servidor. Retome do passo em que parou ou desinstale.";
      const job = app.jobId ? this.deps.store.job(app.jobId) : undefined;
      if (job && job.phase !== "pronto" && job.phase !== "falhou" && job.phase !== "cancelado") {
        job.phase = "falhou";
        job.error = app.error;
        job.finishedAt = this.deps.now().toISOString();
        await this.deps.store.putJob(job);
      }
      await this.deps.store.put(app);
    }
  }

  /** Espera todas as operações em andamento (testes e encerramento). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map((running) => running.promise.catch(() => undefined)));
  }

  /** Para tudo (encerramento do servidor): aborta os passos em andamento sem limpar (o job vira "falhou" no próximo boot). */
  async close(): Promise<void> {
    this.closing = true;
    for (const running of this.running.values()) running.controller.abort();
    await this.idle();
  }

}
