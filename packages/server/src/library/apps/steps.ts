import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RecipeStep } from "@cyno/shared";
import { sanitizeChildEnv } from "../../engines/terminals/env";
import { isInside, resolveInside } from "./paths";
import { RUNTIMES, platformKey } from "./runtimes";
import { unzipTo } from "./unzip";

/** O passo precisa de algo que só o dono faz (sudo, instalar algo do sistema): o job vira "precisa de você". */
export class NeedsOwnerError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "NeedsOwnerError";
  }
}

/** Roda um programa SEM shell (argumentos separados). Linhas de saída vão para `onLine`. */
export type ExecFn = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; onLine: (line: string) => void }) => Promise<void>;

/** Programas que nenhuma receita pode rodar. */
const FORBIDDEN_BINARIES = new Set(["sudo", "su", "doas", "sh", "bash", "zsh", "dash", "fish", "csh", "ksh", "env", "xargs", "nohup", "eval"]);

export function isForbiddenBinary(file: string): boolean {
  return FORBIDDEN_BINARIES.has(path.basename(file));
}

export const realExec: ExecFn = (file, args, { cwd, env, signal, timeoutMs, onLine }) =>
  new Promise<void>((resolve, reject) => {
    if (isForbiddenBinary(file)) {
      reject(new Error(`o instalador não roda "${path.basename(file)}"`));
      return;
    }
    // execFile: sem shell, argumentos separados; `timeout` e `signal` matam o processo.
    const child = nodeExecFile(file, [...args], { cwd, env, signal, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const anyError = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number; name: string };
      if (anyError.name === "AbortError") reject(new Error("cancelado"));
      else if (anyError.killed) reject(new Error(`passou do tempo limite (${Math.round(timeoutMs / 1000)} s)`));
      else if (anyError.code === "ENOENT") reject(new Error(`programa não encontrado: ${path.basename(file)}`));
      else reject(new Error(`${path.basename(file)} terminou com erro (código ${String(anyError.code)})${stderr ? `: ${stderr.trim().split("\n").slice(-4).join(" | ").slice(0, 400)}` : ""}`));
    });
    let tail = "";
    const feed = (chunk: string) => {
      tail += chunk;
      const lines = tail.split(/\r?\n|\r/);
      tail = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout?.setEncoding("utf8").on("data", feed);
    child.stderr?.setEncoding("utf8").on("data", feed);
    child.on("close", () => {
      if (tail.trim()) onLine(tail);
    });
  });

export type StepContext = {
  appId: string;
  appDir: string;
  runtimesRoot: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  signal: AbortSignal;
  timeoutMs: number;
  exec: ExecFn;
  fetch: typeof fetch;
  which: (bin: string) => string | undefined;
  /** "<os>-<arch>" (para escolher o arquivo do runtime). */
  platform: string;
  /** Runtimes que ESTE job baixou (para limpar se o dono cancelar). */
  createdRuntimes: Set<string>;
};

export type StepExecutor<S extends RecipeStep = RecipeStep> = (step: S, context: StepContext) => Promise<void>;
export type StepExecutors = { [K in RecipeStep["run"]]: StepExecutor<Extract<RecipeStep, { run: K }>> };

/** Ambiente dos passos e do processo do app: nada fora da pasta do app e dos runtimes, sem chaves de API. */
export function appEnvironment(appDir: string, runtimesRoot: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const cache = path.join(appDir, ".cache");
  const uvBin = path.join(runtimesRoot, "uv", "bin");
  const ffmpegBin = path.join(runtimesRoot, "ffmpeg", "bin");
  return {
    HOME: path.join(cache, "home"),
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: path.join(cache, "data"),
    XDG_CONFIG_HOME: path.join(cache, "config"),
    TMPDIR: path.join(cache, "tmp"),
    HF_HOME: path.join(cache, "huggingface"),
    npm_config_cache: path.join(cache, "npm"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    UV_PYTHON_INSTALL_DIR: path.join(runtimesRoot, "uv", "python"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    PIP_REQUIRE_VIRTUALENV: "1",
    PYTHONNOUSERSITE: "1",
    PATH: [path.join(appDir, ".venv", "bin"), uvBin, ffmpegBin, base.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };
}

/** Ambiente completo de um passo: o do server sem chaves de API, mais o do app por cima. */
export function stepEnvironment(appDir: string, runtimesRoot: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...sanitizeChildEnv(base), ...appEnvironment(appDir, runtimesRoot, base) };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureCacheDirs(context: StepContext): Promise<void> {
  for (const name of ["home", "data", "config", "tmp", "huggingface", "npm", "pip", "uv"]) await mkdir(path.join(context.appDir, ".cache", name), { recursive: true });
}

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** Baixa `url` para `target` (dentro de apps/ ou runtimes/), confere o sha256 e só então deixa o arquivo no lugar. */
async function downloadVerified(context: StepContext, url: string, sha256: string, target: string): Promise<void> {
  if (!isInside(target, [context.appDir, context.runtimesRoot])) throw new Error("destino fora das pastas permitidas");
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  context.log(`Baixando ${url}`);
  const response = await context.fetch(url, { signal: context.signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`o download falhou (HTTP ${response.status})`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let nextMark = 10 * 1024 * 1024;
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received >= nextMark) {
      context.log(`  ${Math.round(received / 1024 / 1024)} MB${total ? ` de ${Math.round(total / 1024 / 1024)} MB` : ""}`);
      nextMark += 10 * 1024 * 1024;
    }
  });
  await pipeline(body, createWriteStream(partial), { signal: context.signal });
  const actual = await sha256Of(partial);
  if (actual !== sha256) {
    await rm(partial, { force: true });
    throw new Error(`o arquivo baixado não bate com o sha256 esperado (veio ${actual.slice(0, 12)}…, esperado ${sha256.slice(0, 12)}…)`);
  }
  await rename(partial, target);
  context.log(`  sha256 conferido (${actual.slice(0, 12)}…)`);
}

const uvBinary = (context: StepContext) => path.join(context.runtimesRoot, "uv", RUNTIMES.uv.bin);

export const defaultExecutors: StepExecutors = {
  async "download-runtime"(step, context) {
    const def = RUNTIMES[step.runtime];
    const dir = path.join(context.runtimesRoot, def.id);
    const bin = path.join(dir, def.bin);
    if (await exists(bin)) {
      context.log(`${def.id} já está em runtimes/${def.id}; nada a baixar.`);
      return;
    }
    const target = def.targets[context.platform];
    if (!target) throw new Error(`não há ${def.id} para este sistema (${context.platform})`);
    context.createdRuntimes.add(def.id);
    const into = path.join(dir, def.into);
    await mkdir(into, { recursive: true });
    const archive = path.join(dir, `${def.id}.${def.archive}.download`);
    await downloadVerified(context, target.url, target.sha256, archive);
    context.log("Descompactando...");
    if (def.archive === "zip") {
      const result = await unzipTo(archive, into, { strip: def.strip, signal: context.signal });
      context.log(`  ${result.files} arquivos (${Math.round(result.bytes / 1024 / 1024)} MB)`);
    } else {
      // O pacote traz pastas de nível único (uv-<triple>/uv; ffmpeg-<build>/bin/ffmpeg): tira os níveis e deixa só os binários.
      const only = (def.only ?? []).flatMap((pattern) => ["--wildcards", pattern]);
      await context.exec("tar", ["-xf", archive, `--strip-components=${def.strip}`, "-C", into, ...only], { cwd: dir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
    }
    await rm(archive, { force: true });
    await chmod(bin, 0o755);
    await writeFile(path.join(dir, "VERSION"), `${def.version}\n`);
    context.log(`${def.id} ${def.version} pronto em runtimes/${def.id}.`);
  },

  async venv(step, context) {
    const python = path.join(context.appDir, ".venv", "bin", "python");
    if (await exists(python)) {
      context.log("O ambiente .venv já existe; mantido.");
      return;
    }
    await ensureCacheDirs(context);
    await context.exec(uvBinary(context), ["venv", "--python", step.python, path.join(context.appDir, ".venv")], { cwd: context.appDir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
  },

  async "pip-install"(step, context) {
    await ensureCacheDirs(context);
    const python = path.join(context.appDir, ".venv", "bin", "python");
    const args = ["pip", "install", "--python", python, ...(step.torchBackend ? ["--torch-backend", step.torchBackend] : []), ...step.packages];
    await context.exec(uvBinary(context), args, { cwd: context.appDir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
  },

  async "npm-install"(step, context) {
    await ensureCacheDirs(context);
    const npm = context.which("npm");
    if (!npm) throw new NeedsOwnerError("sudo apt install nodejs npm", "O npm não foi encontrado nesta máquina.");
    const args = ["install", "--prefix", context.appDir, "--no-audit", "--no-fund", ...(step.ignoreScripts ? ["--ignore-scripts"] : []), ...step.packages];
    await context.exec(npm, args, { cwd: context.appDir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
  },

  async "git-clone"(step, context) {
    const git = context.which("git");
    if (!git) throw new NeedsOwnerError("sudo apt install git", "O git não foi encontrado nesta máquina.");
    const to = resolveInside(context.appDir, step.to);
    const run = (args: string[]) => context.exec(git, args, { cwd: context.appDir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
    await mkdir(to, { recursive: true });
    await run(["-C", to, "init", "--quiet"]);
    // Clone parcial: só as pastas pedidas (os repositórios de vídeo passam de 300 MB; as skills têm 4 MB).
    if (step.sparse && step.sparse.length > 0) {
      for (const folder of step.sparse) resolveInside(context.appDir, path.join(step.to, folder));
      await run(["-C", to, "sparse-checkout", "set", "--cone", ...step.sparse]);
    }
    await run(["-C", to, "fetch", "--quiet", "--depth", "1", ...(step.sparse && step.sparse.length > 0 ? ["--filter=blob:none"] : []), step.repo, step.ref]);
    await run(["-C", to, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
  },

  async download(step, context) {
    const to = resolveInside(context.appDir, step.to);
    await downloadVerified(context, step.url, step.sha256, step.unpack ? `${to}.download` : to);
    if (step.unpack === "tar.gz") {
      await mkdir(to, { recursive: true });
      await context.exec("tar", ["-xzf", `${to}.download`, "-C", to], { cwd: context.appDir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
      await rm(`${to}.download`, { force: true });
    }
    if (step.unpack === "zip") {
      const result = await unzipTo(`${to}.download`, to, { signal: context.signal });
      context.log(`  ${result.files} arquivos descompactados`);
      await rm(`${to}.download`, { force: true });
    }
  },

  async "write-file"(step, context) {
    const to = resolveInside(context.appDir, step.to);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, step.content);
    context.log(`  ${step.to} escrito (${step.content.length} caracteres)`);
  },

  async exec(step, context) {
    // `runtime:<id>/<arquivo>` = um binário dos runtimes compartilhados (ex.: o ffmpeg); senão, dentro da pasta do app.
    const bin = step.bin.startsWith("runtime:") ? resolveInside(context.runtimesRoot, step.bin.slice("runtime:".length)) : resolveInside(context.appDir, step.bin);
    if (isForbiddenBinary(bin)) throw new Error(`o instalador não roda "${path.basename(bin)}"`);
    await ensureCacheDirs(context);
    await context.exec(bin, step.args, { cwd: context.appDir, env: context.env, signal: context.signal, timeoutMs: context.timeoutMs, onLine: context.log });
  },

  async "require-system"(step, context) {
    const found = context.which(step.bin);
    if (found) {
      context.log(`${step.bin} encontrado em ${found}.`);
      return;
    }
    throw new NeedsOwnerError(step.sudoHint, step.reason ?? `Falta "${step.bin}" no sistema.`);
  },
};

/** Tempo limite padrão por tipo de passo (segundos), quando a receita não diz. */
export const DEFAULT_STEP_TIMEOUT_SEC: Record<RecipeStep["run"], number> = {
  "download-runtime": 600,
  venv: 300,
  "pip-install": 1800,
  "npm-install": 900,
  "git-clone": 300,
  download: 900,
  "write-file": 15,
  exec: 300,
  "require-system": 15,
};

/** Fase mostrada ao dono para cada tipo de passo. */
export function phaseOfStep(step: RecipeStep): "baixando" | "construindo" {
  return step.run === "download-runtime" || step.run === "download" || step.run === "git-clone" || step.run === "require-system" ? "baixando" : "construindo";
}

/** O que o passo faz, em português (a lista do plano e do progresso). */
export function describeStep(step: RecipeStep): string {
  if (step.label) return step.label;
  switch (step.run) {
    case "download-runtime":
      return `Baixar o runtime ${step.runtime}`;
    case "venv":
      return `Criar o ambiente Python ${step.python}`;
    case "pip-install":
      return `Instalar ${step.packages.join(", ")}`;
    case "npm-install":
      return `Instalar (npm) ${step.packages.join(", ")}`;
    case "git-clone":
      return `Clonar ${step.repo} (commit ${step.ref.slice(0, 8)})`;
    case "download":
      return `Baixar ${step.url}`;
    case "exec":
      return `Rodar ${step.bin}`;
    case "write-file":
      return `Escrever ${step.to}`;
    case "require-system":
      return `Conferir ${step.bin} no sistema`;
  }
}

/** O que o passo baixa e de onde (para o plano). */
export function downloadsOfStep(step: RecipeStep, platform: string): { what: string; from: string }[] {
  switch (step.run) {
    case "download-runtime": {
      const target = RUNTIMES[step.runtime].targets[platform];
      return target ? [{ what: `${RUNTIMES[step.runtime].label} (~${target.sizeMB} MB)`, from: target.url }] : [];
    }
    case "venv":
      return [{ what: `Python ${step.python} (pelo uv, compartilhado em runtimes/)`, from: "https://github.com/astral-sh/python-build-standalone" }];
    case "pip-install":
      return [{ what: `Pacotes Python: ${step.packages.join(", ")}${step.torchBackend ? ` (PyTorch para ${step.torchBackend.toUpperCase()})` : ""}`, from: step.torchBackend ? "https://pypi.org e https://download.pytorch.org" : "https://pypi.org" }];
    case "npm-install":
      return [{ what: `Pacotes npm: ${step.packages.join(", ")}`, from: "https://registry.npmjs.org" }];
    case "git-clone":
      return [{ what: `Repositório no commit ${step.ref.slice(0, 8)}`, from: step.repo }];
    case "download":
      return [{ what: step.to, from: step.url }];
    default:
      return [];
  }
}

export { platformKey };
