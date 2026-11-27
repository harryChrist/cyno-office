import { execFile as nodeExecFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GIT_LIMITS,
  normalizeGitHost,
  type AddWorkFolderBody,
  type GitCloneBody,
  type GitCloneJob,
  type WorkFolderMode,
} from "@cyno/shared";
import { sanitizeChildEnv } from "../../engines/terminals/env";
import { errorMessage } from "../../util/text";
import { HttpError } from "../http/errors";
import { isPathInside, isWindows, killProcessTree } from "../os";
import { safeChmod, type GitCredentialStore } from "./credentials";

const MAX_LOG_LINES = 120;
const MAX_LINE_LENGTH = 300;
const MAX_JOBS_RETAINED = 50;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Caracteres que quebram nomes de pasta de trabalho nos motores. */
const UNSAFE_NAME_CHARS = /[,*?[\]{}()\r\n]/;
/** SCP SSH: `git@github.com:org/repo.git`. */
const SCP_SSH_PATTERN = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):([^\s]+)$/;
/** ANSI escape sequences. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type ParsedCloneUrl = {
  url: string;
  protocol: "https" | "ssh" | "local";
  host?: string;
};

/**
 * Valida a URL de clone:
 * - Em produção (`allowLocalPaths` desligado): aceita apenas `https://`, `ssh://` ou `git@host:caminho`;
 * - Recusa `file://`, `ext::`, `-` inicial, espaços, caracteres de controle e credenciais embutidas na URL;
 * - Caminhos locais só entram quando a opção interna `allowLocalPaths` está ligada (testes sem rede).
 */
export function validateCloneUrl(raw: string, options: { allowLocalPaths?: boolean; platform?: NodeJS.Platform } = {}): ParsedCloneUrl {
  const url = raw.trim();
  if (!url || url.length > GIT_LIMITS.url) {
    throw new HttpError(400, "URL inválida. Informe uma URL https:// ou SSH do repositório.");
  }
  if (url.startsWith("-")) {
    throw new HttpError(400, "URL inválida. A URL não pode começar com hífen.");
  }
  const lower = url.toLowerCase();
  if (lower.startsWith("file://") || lower.startsWith("ext::")) {
    throw new HttpError(400, "URL inválida. Protocolos file:// e ext:: não são permitidos.");
  }
  if (/\s/.test(url) || hasControlChar(url)) {
    throw new HttpError(400, "URL inválida. A URL não pode conter espaços.");
  }

  if (lower.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, "URL inválida. Confira o endereço https:// do repositório.");
    }
    if (parsed.protocol !== "https:") {
      throw new HttpError(400, "URL inválida. Use https:// ou SSH.");
    }
    if (parsed.username || parsed.password) {
      throw new HttpError(400, "Não coloque usuário ou token na URL. Cadastre uma credencial do git.");
    }
    const host = normalizeGitHost(parsed.hostname);
    if (!host) {
      throw new HttpError(400, "URL inválida. O endereço do servidor não é válido.");
    }
    const cleanPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) {
      throw new HttpError(400, "URL inválida. Informe o caminho do repositório na URL.");
    }
    return { url, protocol: "https", host };
  }

  if (lower.startsWith("ssh://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, "URL inválida. Confira o endereço ssh:// do repositório.");
    }
    if (parsed.protocol !== "ssh:") {
      throw new HttpError(400, "URL inválida. Use https:// ou SSH.");
    }
    if (parsed.password) {
      throw new HttpError(400, "Não coloque senha na URL SSH. Use uma chave SSH salva.");
    }
    const host = normalizeGitHost(parsed.hostname);
    if (!host) {
      throw new HttpError(400, "URL inválida. O host SSH não é válido.");
    }
    const cleanPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) {
      throw new HttpError(400, "URL inválida. Informe o caminho do repositório na URL SSH.");
    }
    return { url, protocol: "ssh", host };
  }

  const scp = SCP_SSH_PATTERN.exec(url);
  if (scp && !url.includes("://")) {
    const [, user, rawHost, repoPath] = scp;
    const host = normalizeGitHost(rawHost ?? "");
    if (!user || user.startsWith("-") || !host || !repoPath || repoPath.startsWith("-")) {
      throw new HttpError(400, "URL inválida. Use o formato git@host:organizacao/repositorio.git.");
    }
    return { url, protocol: "ssh", host };
  }

  if (options.allowLocalPaths) {
    const pathApi = isWindows(options.platform) ? path.win32 : path.posix;
    if (!url.includes("://") && pathApi.isAbsolute(url)) {
      return { url, protocol: "local" };
    }
  }

  throw new HttpError(400, "URL inválida. Use https://, ssh:// ou git@host:caminho.");
}

/** Valida nome de branch opcional contra injeção de flags e sintaxe inválida do git. */
export function validateBranchName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const branch = raw.trim();
  if (!branch) return undefined;
  if (
    branch.length > GIT_LIMITS.branch ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    /\s/.test(branch) ||
    hasControlChar(branch) ||
    /[~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{")
  ) {
    throw new HttpError(400, "Nome de branch inválido.");
  }
  return branch;
}

/** Deriva e sanitiza o nome de pasta a partir da URL do repositório. */
export function deriveRepoName(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  let rawSegment: string;
  const scp = SCP_SSH_PATTERN.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    const repoPath = (scp[3] ?? "").replace(/\/+$/, "");
    rawSegment = repoPath.split("/").filter(Boolean).pop() ?? "";
  } else if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      rawSegment = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      rawSegment = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
    }
  } else {
    rawSegment = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
  }

  rawSegment = rawSegment.replace(/\.git$/i, "");
  const sanitized = rawSegment
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 60);

  return sanitized || "repositorio";
}

/**
 * Resolve o caminho final dentro de `parentDir`:
 * - Impede qualquer saída de `parentDir` (`..`, `/`, `\`, nomes vazios ou com caracteres perigosos);
 * - Quando `name` é omitido, deriva da URL e acrescenta `-2`, `-3`… se já existir;
 * - Quando `name` é informado explicitamente e já existe, lança 409 ("A pasta já existe nesse destino.").
 */
export function resolveCloneDestination(
  parentDir: string,
  options: {
    url: string;
    name?: string;
    exists?: (target: string) => boolean;
    platform?: NodeJS.Platform;
  },
): { name: string; targetDir: string } {
  const platform = options.platform ?? process.platform;
  const pathApi = isWindows(platform) ? path.win32 : path.posix;
  const checkExists = options.exists ?? existsSync;
  const resolvedParent = pathApi.resolve(parentDir);

  if (options.name !== undefined && options.name.trim() !== "") {
    const custom = options.name.trim();
    if (
      custom === "." ||
      custom === ".." ||
      custom.includes("..") ||
      custom.includes("/") ||
      custom.includes("\\") ||
      custom.includes("\0") ||
      custom.startsWith("-") ||
      UNSAFE_NAME_CHARS.test(custom)
    ) {
      throw new HttpError(400, "Nome de pasta inválido. Use apenas o nome da pasta, sem barras nem '..'.");
    }
    const targetDir = pathApi.resolve(resolvedParent, custom);
    if (!isPathInside(targetDir, resolvedParent, { strict: true, platform })) {
      throw new HttpError(400, "Nome de pasta inválido. O destino precisa ficar dentro da pasta escolhida.");
    }
    if (checkExists(targetDir)) {
      throw new HttpError(409, "A pasta já existe nesse destino.");
    }
    return { name: custom, targetDir };
  }

  const base = deriveRepoName(options.url);
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const candidateName = attempt === 1 ? base : `${base}-${attempt}`;
    const targetDir = pathApi.resolve(resolvedParent, candidateName);
    if (!isPathInside(targetDir, resolvedParent, { strict: true, platform })) {
      throw new HttpError(400, "Nome de pasta inválido.");
    }
    if (!checkExists(targetDir)) {
      return { name: candidateName, targetDir };
    }
  }
  throw new HttpError(409, "A pasta já existe nesse destino.");
}

/**
 * Monta o valor de `GIT_SSH_COMMAND` apontando para a chave temporária.
 * No Windows, converte `\` em `/` e envolve o caminho em aspas duplas (compatível com o `sh` do Git for Windows).
 */
export function buildGitSshCommand(keyFile: string, platform: NodeJS.Platform = process.platform): string {
  const formatted = isWindows(platform)
    ? `"${keyFile.replace(/\\/g, "/").replace(/"/g, '\\"')}"`
    : `'${keyFile.replace(/'/g, "'\\''")}'`;
  return `ssh -i ${formatted} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
}

export type AskpassArtifacts = {
  /** Arquivo principal passado para `GIT_ASKPASS`. */
  mainPath: string;
  /** Lista de arquivos a criar (e remover ao fim do clone). */
  files: Array<{ path: string; content: string; mode: number }>;
};

/**
 * Gera o script auxiliar de `GIT_ASKPASS` que lê `CYNO_GIT_USERNAME` e `CYNO_GIT_TOKEN` do ambiente
 * do processo filho (nunca grava o token em disco):
 * - Linux/macOS: script `/bin/sh` (`0700`);
 * - Windows: `.cmd` chamando `node` + `.cjs` auxiliar.
 */
export function buildAskpassArtifacts(
  tmpDir: string,
  jobId: string,
  options: { platform?: NodeJS.Platform; nodeExecPath?: string } = {},
): AskpassArtifacts {
  const platform = options.platform ?? process.platform;
  const pathApi = isWindows(platform) ? path.win32 : path.posix;
  if (isWindows(platform)) {
    const helperPath = pathApi.join(tmpDir, `askpass-${jobId}.cjs`);
    const cmdPath = pathApi.join(tmpDir, `askpass-${jobId}.cmd`);
    const nodeBin = (options.nodeExecPath ?? process.execPath).replace(/"/g, "");
    const helperContent = [
      'const prompt = String(process.argv[2] || "").toLowerCase();',
      'const out = prompt.includes("username") ? (process.env.CYNO_GIT_USERNAME || "x-access-token") : (process.env.CYNO_GIT_TOKEN || "");',
      'process.stdout.write(out + "\\n");',
      "",
    ].join("\n");
    const cmdContent = `@echo off\r\n"${nodeBin}" "${helperPath}" %*\r\n`;
    return {
      mainPath: cmdPath,
      files: [
        { path: helperPath, content: helperContent, mode: 0o600 },
        { path: cmdPath, content: cmdContent, mode: 0o700 },
      ],
    };
  }

  const shPath = pathApi.join(tmpDir, `askpass-${jobId}.sh`);
  const shContent = [
    "#!/bin/sh",
    'case "$1" in',
    '  *Username*|*username*) printf \'%s\\n\' "${CYNO_GIT_USERNAME:-x-access-token}" ;;',
    '  *) printf \'%s\\n\' "${CYNO_GIT_TOKEN}" ;;',
    "esac",
    "",
  ].join("\n");
  return {
    mainPath: shPath,
    files: [{ path: shPath, content: shContent, mode: 0o700 }],
  };
}

export type BuildGitCloneCommandParams = {
  url: string;
  targetDir: string;
  branch?: string;
  /** Ligado apenas para clone local em testes sem rede. Nunca ligado via API. */
  allowFileTransport?: boolean;
  askpassPath?: string;
  sshKeyFile?: string;
  username?: string;
  token?: string;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export type BuiltGitCloneCommand = {
  command: "git";
  args: string[];
  env: NodeJS.ProcessEnv;
};

/**
 * Monta argumentos e ambiente seguros para `execFile("git", args, { env })`:
 * - Sem shell, sempre `--` antes da URL e do destino;
 * - `-c core.fsmonitor=false`, `-c protocol.ext.allow=never`, `-c protocol.file.allow=never` (salvo transporte local de teste);
 * - `GIT_TERMINAL_PROMPT=0` e `GCM_INTERACTIVE=never`;
 * - Token só via `GIT_ASKPASS` + variáveis de ambiente, nunca na URL nem em `args`;
 * - SSH só via `GIT_SSH_COMMAND` apontando para arquivo temporário 0600.
 */
export function buildGitCloneCommand(params: BuildGitCloneCommandParams): BuiltGitCloneCommand {
  const platform = params.platform ?? process.platform;
  const args: string[] = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    params.allowFileTransport ? "protocol.file.allow=always" : "protocol.file.allow=never",
  ];
  if (params.askpassPath) {
    // Limpa helpers do sistema para que o GIT_ASKPASS responda e o token nunca fique salvo no chaveiro do SO.
    args.push("-c", "credential.helper=");
  }
  args.push("clone", "--progress");
  if (params.branch) {
    args.push("--branch", params.branch);
  }
  args.push("--", params.url, params.targetDir);

  const extraEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  if (params.askpassPath) {
    extraEnv.GIT_ASKPASS = params.askpassPath;
    extraEnv.SSH_ASKPASS = "";
    extraEnv.CYNO_GIT_USERNAME = params.username?.trim() || "x-access-token";
    extraEnv.CYNO_GIT_TOKEN = params.token ?? "";
  }
  if (params.sshKeyFile) {
    extraEnv.GIT_SSH_COMMAND = buildGitSshCommand(params.sshKeyFile, platform);
  }

  const env = sanitizeChildEnv(params.baseEnv ?? process.env, extraEnv);
  return { command: "git", args, env };
}

/** Remove qualquer segredo conhecido ou credencial embutida em URL antes de gravar log ou erro. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text.replace(ANSI_PATTERN, "");
  // Mascara credenciais embutidas em URLs (ex.: https://user:token@host).
  out = out.replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1[oculto]@");
  for (const raw of secrets) {
    const secret = raw.trim();
    if (!secret) continue;
    if (out.includes(secret)) out = out.split(secret).join("[oculto]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret && out.includes(encoded)) out = out.split(encoded).join("[oculto]");
    // Em chaves SSH multilinha, mascara também qualquer linha individual do corpo.
    if (secret.includes("\n")) {
      for (const line of secret.split(/\r?\n/)) {
        const piece = line.trim();
        if (piece.length >= 12 && out.includes(piece)) {
          out = out.split(piece).join("[oculto]");
        }
      }
    }
  }
  return out;
}

/** Extrai porcentagem de progresso das linhas de `git clone --progress`, se houver. */
function parseProgressPercent(line: string): number | undefined {
  const match = /\b(\d{1,3})%\s*\(/.exec(line);
  if (!match) return undefined;
  const pct = Number(match[1]);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined;
}

/** Traduz erros comuns do git para mensagens curtas em pt-BR (sem vazar segredos). */
export function classifyGitError(
  stderr: string,
  options: { errorCode?: string; timedOut?: boolean; platform?: NodeJS.Platform } = {},
): string {
  if (options.timedOut) {
    return "Tempo esgotado ao clonar o repositório.";
  }
  if (options.errorCode === "ENOENT") {
    return isWindows(options.platform)
      ? "Git não está instalado. Instale o Git para Windows (https://git-scm.com/download/win) e tente de novo."
      : "Git não está instalado. Instale o pacote git (ex.: sudo apt install git) e tente de novo.";
  }
  const lower = stderr.toLowerCase();
  if (lower.includes("already exists and is not an empty directory")) {
    return "A pasta já existe nesse destino.";
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("invalid username or password") ||
    lower.includes("invalid username or token") ||
    lower.includes("http basic: access denied") ||
    lower.includes("permission denied (publickey") ||
    lower.includes("could not read username") ||
    lower.includes("terminal prompts disabled") ||
    lower.includes("returned error: 401") ||
    lower.includes("returned error: 403")
  ) {
    return "Credencial recusada. Confira o token ou a chave SSH escolhida.";
  }
  if (lower.includes("remote branch") && lower.includes("not found")) {
    return "Branch não encontrada nesse repositório.";
  }
  if (
    lower.includes("repository not found") ||
    lower.includes("does not appear to be a git repository") ||
    lower.includes("could not read from remote repository") ||
    lower.includes("returned error: 404") ||
    lower.includes("not found")
  ) {
    return "Repositório não encontrado ou sem acesso. Confira a URL e a credencial.";
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("failed to connect") ||
    lower.includes("connection timed out") ||
    lower.includes("unable to access")
  ) {
    return "Não foi possível conectar ao servidor do repositório. Confira a URL e a conexão.";
  }
  return "Não foi possível clonar o repositório.";
}

export type GitExecFileFn = (
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean; maxBuffer?: number },
) => ChildProcess;

export type GitCloneServiceOptions = {
  dataDir: string;
  credentials: GitCredentialStore;
  /** Callback para cadastrar a pasta clonada no workspace (normalmente `manager.addFolder`). */
  addFolder?: (workspaceId: string, body: AddWorkFolderBody & { mode?: WorkFolderMode }) => Promise<unknown>;
  /** Tempo limite do clone em ms (padrão: 10 min). */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Apenas para testes sem rede: permite clonar caminhos locais. Nunca exponha pela API. */
  allowLocalPaths?: boolean;
  /** Injeção de `execFile` para testes. */
  execFile?: GitExecFileFn;
  env?: NodeJS.ProcessEnv;
  onFinish?: (job: GitCloneJob) => void;
};

type QueuedClone = {
  job: GitCloneJob;
  parsedUrl: ParsedCloneUrl;
  parentDir: string;
  requestedName?: string;
  branch?: string;
  credentialId?: string;
  addToWorkspace?: string;
};

/**
 * Serviço de clone de repositórios git com fila simples (um clone por vez), timeout,
 * progresso sanitizado e limpeza garantida de arquivos temporários (askpass / chave SSH).
 */
export class GitCloneService {
  readonly defaultReposDir: string;
  readonly tmpDir: string;
  private readonly jobs = new Map<string, GitCloneJob>();
  private queue: Promise<void> = Promise.resolve();
  private runningCount = 0;
  private counter = 0;
  private activeChild: ChildProcess | undefined;
  private closed = false;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly execFileFn: GitExecFileFn;

  constructor(private readonly options: GitCloneServiceOptions) {
    this.defaultReposDir = path.join(options.dataDir, "repos");
    this.tmpDir = path.join(options.dataDir, "platform", "git", "tmp");
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.execFileFn =
      options.execFile ??
      ((file, args, opts) => nodeExecFile(file, args, { ...opts, shell: false }));
  }

  /** Inicia (ou enfileira) um clone e devolve o job imediatamente. */
  async start(input: GitCloneBody): Promise<GitCloneJob> {
    if (this.closed) throw new HttpError(503, "O servidor está fechando.");

    const parsedUrl = validateCloneUrl(input.url, {
      allowLocalPaths: this.options.allowLocalPaths === true,
      platform: this.platform,
    });
    const branch = validateBranchName(input.branch);

    if (input.credentialId) {
      const cred = this.options.credentials.get(input.credentialId);
      if (!cred) throw new HttpError(404, "Credencial não encontrada.");
      if (cred.kind === "token" && parsedUrl.protocol === "ssh") {
        throw new HttpError(400, "Essa credencial é de token (HTTPS), mas a URL é SSH.");
      }
      if (cred.kind === "ssh" && parsedUrl.protocol === "https") {
        throw new HttpError(400, "Essa credencial é uma chave SSH, mas a URL é HTTPS.");
      }
    }

    const parentDir = await this.resolveParentDir(input.parent);
    // Pré-valida nome / colisão antes de aceitar o job (o destino exato é recalculado na hora de executar).
    const preview = resolveCloneDestination(parentDir, {
      url: parsedUrl.url,
      ...(input.name ? { name: input.name } : {}),
      platform: this.platform,
    });

    const id = `clone-${++this.counter}-${Date.now().toString(36)}`;
    const job: GitCloneJob = {
      id,
      status: "running",
      url: parsedUrl.url,
      name: preview.name,
      startedAt: this.now().toISOString(),
      log: this.runningCount > 0 ? ["Na fila, aguardando o clone anterior terminar…"] : [],
    };
    this.rememberJob(job);

    const task: QueuedClone = {
      job,
      parsedUrl,
      parentDir,
      ...(input.name ? { requestedName: input.name } : {}),
      ...(branch ? { branch } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.addToWorkspace ? { addToWorkspace: input.addToWorkspace } : {}),
    };

    this.runningCount += 1;
    const run = this.queue.then(
      () => this.execute(task),
      () => this.execute(task),
    );
    this.queue = run.finally(() => {
      this.runningCount = Math.max(0, this.runningCount - 1);
    });

    return this.snapshot(job);
  }

  get(id: string): GitCloneJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  list(): GitCloneJob[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job));
  }

  idle(): Promise<void> {
    return this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.activeChild;
    if (child?.pid !== undefined) {
      killProcessTree(child.pid, "SIGTERM", { platform: this.platform });
      const killer = setTimeout(() => {
        if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL", { platform: this.platform });
      }, 3000);
      killer.unref();
      await this.queue.catch(() => undefined);
      clearTimeout(killer);
    } else {
      await this.queue.catch(() => undefined);
    }
  }

  private snapshot(job: GitCloneJob): GitCloneJob {
    return {
      ...job,
      log: [...job.log],
      ...(job.result ? { result: { ...job.result } } : {}),
    };
  }

  private rememberJob(job: GitCloneJob): void {
    this.jobs.set(job.id, job);
    while (this.jobs.size > MAX_JOBS_RETAINED) {
      const oldest = [...this.jobs.values()].find((item) => item.status !== "running");
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
  }

  private async resolveParentDir(customParent: string | undefined): Promise<string> {
    if (!customParent) {
      await mkdir(this.defaultReposDir, { recursive: true });
      return this.defaultReposDir;
    }
    const trimmed = customParent.trim();
    const pathApi = isWindows(this.platform) ? path.win32 : path.posix;
    if (!pathApi.isAbsolute(trimmed)) {
      throw new HttpError(400, "A pasta de destino precisa ser um caminho completo.");
    }
    let info;
    try {
      info = await stat(trimmed);
    } catch {
      throw new HttpError(400, "A pasta de destino não existe neste computador.");
    }
    if (!info.isDirectory()) {
      throw new HttpError(400, "O destino informado não é uma pasta.");
    }
    return pathApi.resolve(trimmed);
  }

  private appendLog(job: GitCloneJob, rawLine: string, secrets: readonly string[]): void {
    const clean = scrubSecrets(rawLine, secrets).trim();
    if (!clean) return;
    const pct = parseProgressPercent(clean);
    if (pct !== undefined) job.progress = pct;
    const clipped = clean.slice(0, MAX_LINE_LENGTH);
    // Evita repetir a mesma linha de progresso idêntica consecutiva.
    if (job.log[job.log.length - 1] === clipped) return;
    job.log.push(clipped);
    if (job.log.length > MAX_LOG_LINES) job.log.shift();
  }

  private async execute(task: QueuedClone): Promise<void> {
    const { job, parsedUrl, parentDir, requestedName, branch, credentialId, addToWorkspace } = task;
    if (this.closed) {
      job.status = "error";
      job.error = "O servidor foi encerrado antes de concluir o clone.";
      job.finishedAt = this.now().toISOString();
      return;
    }

    const secretsToScrub: string[] = [];
    const tempFiles: string[] = [];
    let targetDir: string | undefined;
    let targetExistedBefore = false;

    try {
      await mkdir(parentDir, { recursive: true });
      const resolved = resolveCloneDestination(parentDir, {
        url: parsedUrl.url,
        ...(requestedName ? { name: requestedName } : {}),
        platform: this.platform,
      });
      job.name = resolved.name;
      targetDir = resolved.targetDir;
      targetExistedBefore = existsSync(targetDir);

      let askpassPath: string | undefined;
      let sshKeyFile: string | undefined;
      let username: string | undefined;
      let token: string | undefined;

      if (credentialId) {
        const loaded = await this.options.credentials.readSecret(credentialId);
        secretsToScrub.push(loaded.secret);
        await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
        await safeChmod(this.tmpDir, 0o700, this.platform);

        if (loaded.credential.kind === "token") {
          const artifacts = buildAskpassArtifacts(this.tmpDir, job.id, { platform: this.platform });
          for (const file of artifacts.files) {
            await writeFile(file.path, file.content, { mode: file.mode, encoding: "utf8" });
            await safeChmod(file.path, file.mode, this.platform);
            tempFiles.push(file.path);
          }
          askpassPath = artifacts.mainPath;
          username = loaded.credential.username;
          token = loaded.secret;
        } else {
          const keyPath = path.join(this.tmpDir, `ssh-${job.id}.key`);
          await writeFile(keyPath, loaded.secret, { mode: 0o600, encoding: "utf8" });
          await safeChmod(keyPath, 0o600, this.platform);
          tempFiles.push(keyPath);
          sshKeyFile = keyPath;
        }
      }

      const cmd = buildGitCloneCommand({
        url: parsedUrl.url,
        targetDir,
        ...(branch ? { branch } : {}),
        allowFileTransport: this.options.allowLocalPaths === true && parsedUrl.protocol === "local",
        ...(askpassPath ? { askpassPath } : {}),
        ...(sshKeyFile ? { sshKeyFile } : {}),
        ...(username ? { username } : {}),
        ...(token ? { token } : {}),
        ...(this.options.env ? { baseEnv: this.options.env } : {}),
        platform: this.platform,
      });

      this.appendLog(job, `Clonando em ${resolved.name}…`, secretsToScrub);
      await this.runGit(job, cmd, secretsToScrub);

      job.progress = 100;
      job.result = { path: targetDir };

      if (addToWorkspace && this.options.addFolder) {
        try {
          await this.options.addFolder(addToWorkspace, { name: resolved.name, path: targetDir, mode: "read" });
          job.result.folderAdded = true;
          this.appendLog(job, "Pasta cadastrada no workspace.", secretsToScrub);
        } catch (error) {
          const warn = scrubSecrets(errorMessage(error), secretsToScrub);
          job.result.folderAdded = false;
          job.result.folderWarning = `Repositório clonado, mas não foi possível cadastrar a pasta no workspace: ${warn}`;
          this.appendLog(job, job.result.folderWarning, secretsToScrub);
        }
      }

      job.status = "done";
    } catch (error) {
      job.status = "error";
      const msg = error instanceof HttpError ? error.message : errorMessage(error);
      job.error = scrubSecrets(msg, secretsToScrub);
      this.appendLog(job, `Falhou: ${job.error}`, secretsToScrub);
      // Limpa pasta parcial criada por clone que falhou, sem tocar em pasta pré-existente.
      if (targetDir && !targetExistedBefore) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      for (const file of tempFiles) {
        await rm(file, { force: true }).catch(() => undefined);
      }
      job.finishedAt = this.now().toISOString();
      this.options.onFinish?.(this.snapshot(job));
    }
  }

  private runGit(job: GitCloneJob, cmd: BuiltGitCloneCommand, secrets: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.execFileFn(cmd.command, cmd.args, {
        env: cmd.env,
        windowsHide: isWindows(this.platform),
        maxBuffer: 8 * 1024 * 1024,
      });
      this.activeChild = child;

      let stderrText = "";
      let timedOut = false;
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = undefined;
        if (err) reject(err);
        else resolve();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killProcessTree(child.pid, "SIGTERM", { platform: this.platform });
          setTimeout(() => {
            if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL", { platform: this.platform });
          }, 3000).unref();
        }
        finish(new Error(classifyGitError(stderrText, { timedOut: true, platform: this.platform })));
      }, this.timeoutMs);
      timer.unref();

      const onChunk = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderrText += text;
        if (stderrText.length > 32 * 1024) stderrText = stderrText.slice(-32 * 1024);
        for (const line of text.split(/\r\n|\r|\n/)) {
          this.appendLog(job, line, secrets);
        }
      };

      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      child.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        finish(new Error(classifyGitError(stderrText, { ...(code ? { errorCode: code } : {}), timedOut, platform: this.platform })));
      });

      child.once("close", (code) => {
        if (code === 0 && !timedOut) {
          finish();
        } else {
          finish(new Error(classifyGitError(stderrText, { timedOut, platform: this.platform })));
        }
      });
    });
  }
}
