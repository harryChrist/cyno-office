import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appToolsOf, type AppRun, type AppToolParam, type AppToolSpec, type CatalogApp, type ServerEvent } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { StoredConnectorTool } from "../connectors/store";
import { isInside, resolveInside, type AppsPaths } from "./paths";
import { stepEnvironment } from "./steps";

/**
 * O executor das ferramentas do conector `app` (o "MCP fino nosso"). O app não tem servidor MCP: a
 * receita declara cada ferramenta (nome em inglês, parâmetros tipados, comando) e este código valida e
 * roda. Regras por código, não por prompt:
 * - sem shell: `spawn(exe, args)` com os argumentos montados item a item (um `{param}` por item);
 * - caminhos presos à pasta do agente (realpath; `..`, link para fora e arquivo que não existe são recusados);
 * - valor de texto que começa com `-` não vira argumento solto (não vira "flag" escondida);
 * - UMA execução por vez por app (a fila mostra a posição); tempo limite mata o grupo de processos;
 * - ambiente sem chaves de API e com caches dentro da pasta do app; prioridade baixa (a máquina continua usável);
 * - a saída (vídeo/imagem) tem que existir, não estar vazia e, sendo vídeo/áudio, passar no ffprobe; com um
 *   agente por trás ela vai para a Mídia do workspace dele.
 */

export type AppRunWho = { workspaceId: string; workspaceName: string; agentId: string; agentName: string };

export type AppRunContext = {
  /** Pasta em que os caminhos ficam presos: a do agente, ou a do app (teste do instalador). */
  root: string;
  who?: AppRunWho;
  /** Guarda o arquivo (caminho absoluto, dentro de `root`) na Mídia do workspace e devolve o id. */
  registerMedia?: (file: string, info: { title: string; kind: "video" | "image" | "audio" | "file"; note: string; appId: string; tool: string }) => Promise<{ id: string; title: string }>;
};

export type AppRunResult = { text: string; isError: boolean; run: AppRun };

export type SpawnFn = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export type AppToolRunnerDeps = {
  paths: AppsPaths;
  /** A receita do app (o catálogo) e se ele está instalado. */
  resolve: (appId: string) => { entry: CatalogApp; installed: boolean } | undefined;
  env?: NodeJS.ProcessEnv;
  publish: (event: ServerEvent) => void;
  now: () => Date;
  spawn?: SpawnFn;
  cpus?: () => number;
  /** Prioridade do processo (nice); 0 = não mexe. */
  niceness?: number;
  log: { warn: (object: object, message: string) => void };
  /** Tempo de espera do ffprobe (ms). */
  probeTimeoutMs?: number;
};

const MAX_RUNS = 30;
const OUTPUT_TAIL_LINES = 60;
const RESULT_MAX_CHARS = 8 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

class ParamError extends Error {}

/** Uma execução na fila de um app. */
type Job = {
  /** Fila em que espera: o grupo do conector (vários apps pesados dividem uma) ou o id do app. */
  group: string;
  run: AppRun;
  spec: AppToolSpec;
  entry: CatalogApp;
  ctx: AppRunContext;
  values: Record<string, string | number | boolean>;
  resolve: (result: AppRunResult) => void;
  cancelled: boolean;
  child?: ChildProcess;
};

export class AppToolRunner {
  private readonly queues = new Map<string, Job[]>();
  private readonly active = new Map<string, Job>();
  private readonly pumping = new Set<string>();
  private runs: AppRun[] = [];
  private seq = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly spawnFn: SpawnFn;

  constructor(private readonly deps: AppToolRunnerDeps) {
    this.spawnFn =
      deps.spawn ??
      ((file, args, options) =>
        nodeSpawn(file, [...args], {
          cwd: options.cwd,
          env: options.env,
          // Grupo próprio: o tempo limite e o cancelamento matam o programa e os filhos dele (Chrome).
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        }));
  }

  private get runsFile(): string {
    return path.join(this.deps.paths.libraryDir, "app-runs.json");
  }

  /** Carrega o histórico guardado (execuções que estavam no meio viram "falhou"). */
  async load(): Promise<void> {
    try {
      const list = JSON.parse(await readFile(this.runsFile, "utf8")) as AppRun[];
      this.runs = list.slice(0, MAX_RUNS).map((run) => (run.state === "rodando" || run.state === "na-fila" ? { ...run, state: "falhou" as const, summary: "Interrompido pelo reinício do servidor.", queuePosition: undefined } : run));
      for (const run of this.runs) {
        delete run.queuePosition;
        const n = Number(/^R-(\d+)$/.exec(run.id)?.[1] ?? 0);
        this.seq = Math.max(this.seq, n);
      }
    } catch {
      this.runs = [];
    }
  }

  // ---------- Leitura ----------

  /** Execuções recentes (mais novas primeiro), de um app ou de todos. */
  list(appId?: string): AppRun[] {
    return structuredClone(this.runs.filter((run) => !appId || run.appId === appId));
  }

  /** Pasta do app (onde o teste do instalador prende os caminhos). */
  appDir(appId: string): string {
    return this.deps.paths.appDir(appId);
  }

  /** As ferramentas do app como o conector as mostra. */
  toolsOfApp(appId: string): StoredConnectorTool[] {
    const found = this.deps.resolve(appId);
    return found ? AppToolRunner.toolsOf(found.entry) : [];
  }

  /** As ferramentas de uma receita na forma do cache do conector (nome, descrição e JSON Schema). */
  static toolsOf(entry: Pick<CatalogApp, "provides">): StoredConnectorTool[] {
    return appToolsOf(entry).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: jsonSchemaOf(tool) }));
  }

  // ---------- Chamada ----------

  /** Valida, entra na fila do app e roda. Nunca lança: o erro volta como resultado `isError`. */
  async run(appId: string, toolName: string, rawArgs: unknown, ctx: AppRunContext): Promise<AppRunResult> {
    const found = this.deps.resolve(appId);
    const spec = found ? appToolsOf(found.entry).find((tool) => tool.name === toolName) : undefined;
    const baseRun = (state: AppRun["state"], summary?: string): AppRun => ({
      id: this.nextId(),
      appId,
      tool: toolName,
      state,
      ...(ctx.who ?? {}),
      enqueuedAt: this.deps.now().toISOString(),
      ...(summary ? { summary } : {}),
    });
    if (!found || !found.installed || !spec) {
      const run = baseRun("falhou", !found || !found.installed ? `App "${appId}" is not installed.` : `Unknown tool "${toolName}".`);
      this.remember(run);
      return { text: run.summary!, isError: true, run };
    }
    let values: Record<string, string | number | boolean>;
    try {
      values = await this.validate(spec, rawArgs, ctx.root);
    } catch (error) {
      const message = error instanceof ParamError ? error.message : `Could not check the arguments: ${error instanceof Error ? error.message : String(error)}`;
      const run = baseRun("falhou", message);
      this.remember(run);
      return { text: message, isError: true, run };
    }
    return new Promise<AppRunResult>((resolve) => {
      const run = baseRun("na-fila");
      const group = found.entry.provides.connector?.queueGroup ?? appId;
      const job: Job = { group, run, spec, entry: found.entry, ctx, values, resolve, cancelled: false };
      const queue = this.queues.get(group) ?? [];
      queue.push(job);
      this.queues.set(group, queue);
      this.remember(run);
      this.renumber(group);
      void this.pump(group);
    });
  }

  /** Cancela uma execução (na fila ou rodando). */
  cancel(runId: string): boolean {
    for (const [group, queue] of this.queues) {
      const job = queue.find((candidate) => candidate.run.id === runId);
      if (job) {
        queue.splice(queue.indexOf(job), 1);
        this.finish(job, "cancelada", "Cancelled by the user before it started.", true);
        this.renumber(group);
        return true;
      }
    }
    for (const job of this.active.values()) {
      if (job.run.id !== runId) continue;
      job.cancelled = true;
      killGroup(job.child);
      return true;
    }
    return false;
  }

  /** Para tudo (desinstalar o app, encerrar o servidor). */
  async stopApp(appId: string): Promise<void> {
    const mine = (job: Job) => job.entry.id === appId;
    for (const queue of this.queues.values()) for (const job of queue.filter(mine)) this.cancel(job.run.id);
    for (const job of this.active.values()) if (mine(job)) this.cancel(job.run.id);
    for (let i = 0; i < 100 && [...this.active.values()].some(mine); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Encerramento do servidor: cancela o que está na fila e mata o que está rodando. */
  async close(): Promise<void> {
    const ids = new Set([...[...this.queues.values()].flat(), ...this.active.values()].map((job) => job.entry.id));
    for (const appId of ids) await this.stopApp(appId);
    await this.persistChain;
  }

  async idle(): Promise<void> {
    for (let i = 0; i < 2000 && (this.active.size > 0 || [...this.queues.values()].some((queue) => queue.length > 0)); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.persistChain;
  }

  // ---------- Fila ----------

  private nextId(): string {
    this.seq += 1;
    return `R-${String(this.seq).padStart(4, "0")}`;
  }

  private remember(run: AppRun): void {
    this.runs = [run, ...this.runs.filter((other) => other.id !== run.id)].slice(0, MAX_RUNS);
    this.deps.publish({ type: "library:app-run", run: structuredClone(run) });
  }

  private emit(run: AppRun): void {
    this.deps.publish({ type: "library:app-run", run: structuredClone(run) });
  }

  private renumber(group: string): void {
    const queue = this.queues.get(group) ?? [];
    queue.forEach((job, index) => {
      if (job.run.queuePosition === index + 1) return;
      job.run.queuePosition = index + 1;
      this.emit(job.run);
    });
  }

  private async pump(group: string): Promise<void> {
    if (this.pumping.has(group) || this.active.has(group)) return;
    this.pumping.add(group);
    try {
      for (;;) {
        const queue = this.queues.get(group) ?? [];
        const job = queue.shift();
        if (!job) break;
        delete job.run.queuePosition;
        this.renumber(group);
        this.active.set(group, job);
        try {
          await this.execute(job);
        } catch (error) {
          this.deps.log.warn({ err: error, appId: job.entry.id, tool: job.spec.name }, "execução de ferramenta de app falhou por erro interno");
          this.finish(job, "falhou", `Internal error: ${error instanceof Error ? error.message : String(error)}`, true);
        } finally {
          this.active.delete(group);
        }
      }
    } finally {
      this.pumping.delete(group);
    }
  }

  private finish(job: Job, state: AppRun["state"], summary: string, isError: boolean, extra: { mediaId?: string } = {}): void {
    const run = job.run;
    run.state = state;
    delete run.queuePosition;
    run.summary = summary.slice(0, 600);
    run.finishedAt = this.deps.now().toISOString();
    if (run.startedAt) run.ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (extra.mediaId) run.mediaId = extra.mediaId;
    if (state === "concluida") run.progress = 100;
    this.emit(run);
    this.persist();
    job.resolve({ text: summary.slice(0, RESULT_MAX_CHARS), isError, run: structuredClone(run) });
  }

  private persist(): void {
    const snapshot = structuredClone(this.runs);
    this.persistChain = this.persistChain
      .then(async () => {
        await mkdir(this.deps.paths.libraryDir, { recursive: true });
        await writeJsonAtomic(this.runsFile, snapshot);
      })
      .catch((error: unknown) => this.deps.log.warn({ err: error }, "não foi possível gravar app-runs.json"));
  }

  // ---------- Validação ----------

  /** Confere cada parâmetro contra a receita. Junta todos os problemas numa mensagem (em inglês: o modelo lê). */
  private async validate(spec: AppToolSpec, rawArgs: unknown, root: string): Promise<Record<string, string | number | boolean>> {
    if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) throw new ParamError("Arguments must be an object.");
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const known = new Set(spec.params.map((param) => param.name));
    const problems: string[] = [];
    for (const key of Object.keys(args)) if (!known.has(key)) problems.push(`unknown argument "${key}" (accepted: ${[...known].join(", ") || "none"})`);
    const values: Record<string, string | number | boolean> = {};
    for (const param of spec.params) {
      let value = args[param.name];
      if (value === undefined || value === null) {
        if ("default" in param && param.default !== undefined) value = param.default;
        else if (param.optional) continue;
        else {
          problems.push(`"${param.name}" is required`);
          continue;
        }
      }
      try {
        values[param.name] = await this.checkValue(param, value, root);
      } catch (error) {
        problems.push(error instanceof ParamError ? error.message : String(error));
      }
    }
    if (problems.length > 0) throw new ParamError(`Invalid arguments for ${spec.name}: ${problems.join("; ")}.`);
    return values;
  }

  private async checkValue(param: AppToolParam, value: unknown, root: string): Promise<string | number | boolean> {
    const name = param.name;
    switch (param.type) {
      case "string": {
        if (typeof value !== "string") throw new ParamError(`"${name}" must be a string`);
        if (value.includes("\0")) throw new ParamError(`"${name}" has an invalid character`);
        if (value.length > param.maxLength) throw new ParamError(`"${name}" is too long (max ${param.maxLength} characters)`);
        if (param.pattern && !new RegExp(param.pattern).test(value)) throw new ParamError(`"${name}" does not match the expected format (${param.pattern})`);
        return value;
      }
      case "integer": {
        if (typeof value !== "number" || !Number.isInteger(value)) throw new ParamError(`"${name}" must be an integer`);
        if (param.min !== undefined && value < param.min) throw new ParamError(`"${name}" must be at least ${param.min}`);
        if (param.max !== undefined && value > param.max) throw new ParamError(`"${name}" must be at most ${param.max}`);
        return value;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new ParamError(`"${name}" must be a number`);
        if (param.min !== undefined && value < param.min) throw new ParamError(`"${name}" must be at least ${param.min}`);
        if (param.max !== undefined && value > param.max) throw new ParamError(`"${name}" must be at most ${param.max}`);
        return value;
      }
      case "boolean": {
        if (typeof value !== "boolean") throw new ParamError(`"${name}" must be true or false`);
        return value;
      }
      case "enum": {
        if (typeof value !== "string" || !param.values.includes(value)) throw new ParamError(`"${name}" must be one of: ${param.values.join(", ")}`);
        return value;
      }
      case "path":
        return resolveJailedPath(root, value, param);
    }
  }

  // ---------- Execução ----------

  private async execute(job: Job): Promise<void> {
    const { spec, entry, ctx, run } = job;
    const appId = entry.id;
    const appDir = this.deps.paths.appDir(appId);
    run.state = "rodando";
    run.startedAt = this.deps.now().toISOString();
    this.emit(run);
    if (job.cancelled) return this.finish(job, "cancelada", "Cancelled by the user.", true);

    // Comando: o primeiro item é o executável (dentro da pasta do app ou `runtime:<id>/<arquivo>`); o resto vira argumentos.
    let file: string;
    let args: string[];
    let cwd: string;
    try {
      const built = this.buildCommand(spec, job.values, appDir);
      file = built.file;
      args = built.args;
      cwd = spec.cwd.startsWith("param:") ? String(job.values[spec.cwd.slice(6)] ?? appDir) : appDir;
      // `new-dir` ainda pode não existir (o próprio comando cria): usa a pasta de cima.
      if (!(await stat(cwd).then((info) => info.isDirectory(), () => false))) cwd = path.dirname(cwd);
    } catch (error) {
      return this.finish(job, "falhou", `Could not build the command: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    // A pasta do arquivo de saída precisa existir.
    const output = spec.output ? String(job.values[spec.output.param]) : undefined;
    if (output) await mkdir(path.dirname(output), { recursive: true });

    const baseEnv = this.deps.env ?? process.env;
    const env: NodeJS.ProcessEnv = { ...stepEnvironment(appDir, this.deps.paths.runtimesRoot, baseEnv), ...this.expandEnv(spec.env, appDir) };
    await mkdir(env.TMPDIR ?? path.join(appDir, ".cache", "tmp"), { recursive: true });
    for (const dir of ["home", "data", "config"]) await mkdir(path.join(appDir, ".cache", dir), { recursive: true });
    const started = Date.now();
    const tail: string[] = [];
    let timedOut = false;
    let spawnError: string | undefined;
    let lastLine = "";
    let lastEmit = 0;
    const progress = spec.progress ? new RegExp(spec.progress.regex) : undefined;
    const quiet = (spec.quiet ?? []).map((pattern) => new RegExp(pattern));
    const onLine = (raw: string) => {
      const line = raw.replace(ANSI, "").trim();
      if (!line) return;
      const noisy = quiet.some((pattern) => pattern.test(line));
      if (!noisy) {
        tail.push(line.slice(0, 400));
        if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
      }
      if (progress) {
        const match = progress.exec(line);
        const groups = match?.groups;
        let pct: number | undefined;
        if (groups?.pct !== undefined) pct = Number(groups.pct);
        else if (groups?.done !== undefined && groups.total !== undefined && Number(groups.total) > 0) pct = (Number(groups.done) / Number(groups.total)) * 100;
        if (pct !== undefined && Number.isFinite(pct)) run.progress = Math.max(0, Math.min(99, Math.round(pct)));
      }
      // Linha de ruído (barras, rastros em JSON) não vira "última linha" na tela; só o andamento muda.
      if (!noisy) lastLine = line.slice(0, 200);
      const now = Date.now();
      if (now - lastEmit > 700 || run.progress === 99) {
        lastEmit = now;
        if (lastLine) run.line = lastLine;
        this.emit(run);
      }
    };

    const code = await new Promise<number | null>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(file, args, { cwd, env });
      } catch (error) {
        spawnError = error instanceof Error ? error.message : String(error);
        resolve(null);
        return;
      }
      job.child = child;
      if (child.pid && (this.deps.niceness ?? 10) !== 0) {
        try {
          os.setPriority(child.pid, this.deps.niceness ?? 10);
        } catch {
          // sem permissão para mudar a prioridade: segue
        }
      }
      const feed = (stream: NodeJS.ReadableStream | null) => {
        let rest = "";
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          rest += chunk;
          const lines = rest.split(/\r?\n|\r/);
          rest = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        });
        stream?.on("end", () => rest && onLine(rest));
      };
      feed(child.stdout);
      feed(child.stderr);
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, spec.timeoutSec * 1000);
      child.on("error", (error: NodeJS.ErrnoException) => {
        spawnError = error.code === "ENOENT" ? `program not found: ${path.basename(file)}` : error.message;
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    job.child = undefined;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const tailText = tail.slice(-12).join("\n").slice(-2500);

    if (job.cancelled) return this.finish(job, "cancelada", `Cancelled by the user after ${seconds} s.`, true);
    if (timedOut) return this.finish(job, "falhou", `TIMED OUT after ${spec.timeoutSec} s (the process was killed).${tailText ? `\nLast output:\n${tailText}` : ""}`, true);
    if (spawnError) return this.finish(job, "falhou", `FAILED to start: ${spawnError}`, true);
    if (code !== 0) return this.finish(job, "falhou", `FAILED (exit code ${String(code)}) after ${seconds} s.${tailText ? `\nLast output:\n${tailText}` : ""}`, true);

    if (!spec.output || !output) {
      const text = tail.join("\n").slice(-RESULT_MAX_CHARS);
      return this.finish(job, "concluida", text ? `OK (${seconds} s)\n${text}` : `OK (${seconds} s)`, false);
    }

    // Saída: existe, não está vazia e (vídeo/áudio) o ffprobe confirma.
    const info = await stat(output).catch(() => undefined);
    if (!info || !info.isFile()) return this.finish(job, "falhou", `The command finished but did not create the output file ${path.basename(output)}.${tailText ? `\nLast output:\n${tailText}` : ""}`, true);
    if (info.size === 0) return this.finish(job, "falhou", `The output file ${path.basename(output)} is empty.${tailText ? `\nLast output:\n${tailText}` : ""}`, true);
    let detail = `${humanSize(info.size)}`;
    if (spec.output.kind === "video" || spec.output.kind === "audio") {
      const probed = await this.probe(output, appDir);
      if (probed === "missing") detail = `${humanSize(info.size)}, not checked (no ffprobe)`;
      else if (probed.error !== undefined) return this.finish(job, "falhou", `The output ${path.basename(output)} is not a valid ${spec.output.kind} file: ${probed.error}.`, true);
      else {
        if (spec.output.kind === "video" && !probed.video) return this.finish(job, "falhou", `The output ${path.basename(output)} has no video stream.`, true);
        detail = `${probed.duration.toFixed(1)} s${probed.video ? `, ${probed.video.width}x${probed.video.height}` : ""}, ${humanSize(info.size)}`;
      }
    }
    const relative = path.relative(ctx.root, output);
    if (ctx.registerMedia) {
      try {
        const given = typeof job.values.title === "string" ? job.values.title.trim() : "";
        const title = given || spec.output.title || `${entry.name}: ${spec.name}`;
        const media = await ctx.registerMedia(output, { title, kind: spec.output.kind, note: `${entry.name} · ${spec.name} (${seconds} s)`, appId, tool: spec.name });
        return this.finish(job, "concluida", `RENDERED media ${media.id} “${media.title}” (${detail}). File in your folder: ${relative}`, false, { mediaId: media.id });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return this.finish(job, "falhou", `The file was created (${relative}, ${detail}) but could not be saved to the media library: ${reason}`, true);
      }
    }
    return this.finish(job, "concluida", `RENDERED file ${relative} (${detail})`, false);
  }

  /** Monta o executável e os argumentos. Um `{param}` por item; valor de texto solto não começa com `-`. */
  private buildCommand(spec: AppToolSpec, values: Record<string, string | number | boolean>, appDir: string): { file: string; args: string[] } {
    const builtin: Record<string, string> = { app: appDir, runtimes: this.deps.paths.runtimesRoot, ...this.limits() };
    const substitute = (text: string): string => {
      const whole = /^\{([a-z][a-z0-9_]*)\}$/.exec(text);
      return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (_all, name: string) => {
        if (name in values) {
          const value = values[name]!;
          const rendered = typeof value === "boolean" ? String(value) : String(value);
          const param = spec.params.find((candidate) => candidate.name === name);
          if (whole && typeof value === "string" && rendered.startsWith("-") && param?.type !== "enum") throw new Error(`the value of "${name}" cannot start with "-"`);
          return rendered;
        }
        if (name in builtin) return builtin[name]!;
        throw new Error(`unknown variable {${name}}`);
      });
    };
    const first = spec.command[0] as string;
    let file: string;
    // `{node}` = o próprio Node do servidor (scripts do app, escritos pela receita, rodam com ele).
    if (first === "{node}") file = process.execPath;
    else if (first.startsWith("runtime:")) file = resolveInside(this.deps.paths.runtimesRoot, first.slice("runtime:".length));
    else file = resolveInside(appDir, substitute(first));
    const args: string[] = [];
    for (const item of spec.command.slice(1)) {
      if (typeof item === "string") {
        args.push(substitute(item));
        continue;
      }
      if (!(item.if in values)) continue;
      const flag = values[item.if];
      // `if` de boolean só entra quando for verdadeiro.
      if (flag === false) continue;
      for (const text of item.args) args.push(substitute(text));
    }
    return { file, args };
  }

  /** `workers` cabe em 4 núcleos e ~6 GB: no máximo 2 (e nunca mais que núcleos - 2). */
  private limits(): Record<string, string> {
    const cpus = Math.max(1, this.deps.cpus?.() ?? os.cpus().length);
    return { cpus: String(cpus), workers: String(Math.max(1, Math.min(2, cpus - 2))) };
  }

  private expandEnv(env: Record<string, string>, appDir: string): Record<string, string> {
    const builtin: Record<string, string> = { app: appDir, runtimes: this.deps.paths.runtimesRoot, ...this.limits() };
    return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replace(/\{([a-z]+)\}/g, (match, name: string) => builtin[name] ?? match)]));
  }

  /** ffprobe do runtime: duração e dimensões. `missing` se o runtime não existe. */
  private async probe(file: string, appDir: string): Promise<"missing" | ProbeResult> {
    const ffprobe = path.join(this.deps.paths.runtimesRoot, "ffmpeg", "bin", "ffprobe");
    if (!(await stat(ffprobe).then(() => true, () => false))) return "missing";
    return new Promise((resolve) => {
      const child = this.spawnFn(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { cwd: appDir, env: { PATH: process.env.PATH ?? "" } });
      let out = "";
      let err = "";
      const timer = setTimeout(() => killGroup(child), this.deps.probeTimeoutMs ?? 30_000);
      child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ error: error.message });
      });
      child.on("close", (exit) => {
        clearTimeout(timer);
        if (exit !== 0) return resolve({ error: err.trim().split("\n").slice(-1)[0]?.slice(0, 200) || `ffprobe exit ${String(exit)}` });
        try {
          const data = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
          const duration = Number(data.format?.duration ?? 0);
          if (!Number.isFinite(duration) || duration <= 0) return resolve({ error: "zero duration" });
          const video = data.streams?.find((stream) => stream.codec_type === "video" && stream.width && stream.height);
          resolve({ duration, ...(video ? { video: { width: video.width!, height: video.height! } } : {}) });
        } catch {
          resolve({ error: "unreadable ffprobe output" });
        }
      });
    });
  }
}

type ProbeResult = { error: string; duration?: undefined; video?: undefined } | { error?: undefined; duration: number; video?: { width: number; height: number } };

function killGroup(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // já saiu
    }
  }
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Resolve um caminho pedido por um agente e o prende à pasta `root`: relativo à pasta, ou absoluto dentro
 * dela; `..`, link simbólico que sai e caminho fora são recusados (realpath do que existe e do ancestral
 * do que ainda não existe).
 */
export async function resolveJailedPath(root: string, value: unknown, param: Extract<AppToolParam, { type: "path" }>): Promise<string> {
  const name = param.name;
  if (typeof value !== "string" || value.trim() === "") throw new ParamError(`"${name}" must be a path (relative to your folder)`);
  if (value.includes("\0") || value.length > 500) throw new ParamError(`"${name}" is not a valid path`);
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) throw new ParamError(`your working folder does not exist yet`);
  const rawAbs = path.isAbsolute(value) ? path.normalize(value) : path.resolve(realRoot, value);
  // Aceita o caminho absoluto escrito com a pasta "de verdade" ou com a pasta como a conhecemos (link).
  const lexicalRoot = path.resolve(root);
  const abs = rawAbs === lexicalRoot || rawAbs.startsWith(lexicalRoot + path.sep) ? path.join(realRoot, path.relative(lexicalRoot, rawAbs)) : rawAbs;
  if (!isInside(abs, [realRoot])) throw new ParamError(`"${name}" must be inside your own folder (${path.basename(realRoot)}); "${value}" is not`);
  const outside = `"${name}" leaves your folder through a link`;
  if (param.ext && param.ext.length > 0 && !param.ext.includes(path.extname(abs).toLowerCase())) throw new ParamError(`"${name}" must end with ${param.ext.join(" or ")}`);
  if (param.must === "exist-dir" || param.must === "exist-file") {
    const real = await realpath(abs).catch(() => undefined);
    if (!real) throw new ParamError(`"${name}" does not exist: ${value}`);
    if (!isInside(real, [realRoot])) throw new ParamError(outside);
    const info = await stat(real);
    if (param.must === "exist-dir" && !info.isDirectory()) throw new ParamError(`"${name}" is not a folder: ${value}`);
    if (param.must === "exist-file" && !info.isFile()) throw new ParamError(`"${name}" is not a file: ${value}`);
    return real;
  }
  // new-file / new-dir: o alvo pode existir (arquivo comum, para regravar) ou não; o ancestral que existe tem que estar dentro.
  const existing = await lstat(abs).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink()) throw new ParamError(outside);
    if (param.must === "new-dir") throw new ParamError(`"${name}" already exists: ${value}. Pick a new folder name.`);
    if (!existing.isFile()) throw new ParamError(`"${name}" is not a file: ${value}`);
    return abs;
  }
  let ancestor = path.dirname(abs);
  while (ancestor !== path.dirname(ancestor) && !(await lstat(ancestor).then(() => true, () => false))) ancestor = path.dirname(ancestor);
  const realAncestor = await realpath(ancestor).catch(() => undefined);
  if (!realAncestor || !isInside(realAncestor, [realRoot])) throw new ParamError(outside);
  return abs;
}

/** JSON Schema da ferramenta (o que o agente vê). */
export function jsonSchemaOf(tool: AppToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of tool.params) {
    const base: Record<string, unknown> = { description: describeParam(param) };
    switch (param.type) {
      case "string":
        properties[param.name] = { type: "string", maxLength: param.maxLength, ...base, ...(param.default !== undefined ? { default: param.default } : {}) };
        break;
      case "integer":
      case "number":
        properties[param.name] = { type: param.type, ...(param.min !== undefined ? { minimum: param.min } : {}), ...(param.max !== undefined ? { maximum: param.max } : {}), ...base, ...(param.default !== undefined ? { default: param.default } : {}) };
        break;
      case "boolean":
        properties[param.name] = { type: "boolean", ...base, ...(param.default !== undefined ? { default: param.default } : {}) };
        break;
      case "enum":
        properties[param.name] = { type: "string", enum: param.values, ...base, ...(param.default !== undefined ? { default: param.default } : {}) };
        break;
      case "path":
        properties[param.name] = { type: "string", ...base };
        break;
    }
    if (!param.optional && (param as { default?: unknown }).default === undefined) required.push(param.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function describeParam(param: AppToolParam): string {
  if (param.type !== "path") return param.description;
  const where = param.must === "exist-dir" ? "existing folder" : param.must === "exist-file" ? "existing file" : param.must === "new-dir" ? "new folder (must not exist)" : "output file";
  return `${param.description} Path of an ${where} inside your own folder (relative to it, or absolute inside it).${param.ext ? ` Extension: ${param.ext.join(" or ")}.` : ""}`;
}
