import { execFile } from "node:child_process";
import type { RunMode, UpdateApplyState, UpdateCheckState, UpdateJob, UpdateStep } from "@cyno/shared";
import { lsRemoteReason, type UpdateChecker } from "./checker";
import { runGit, type GitResult } from "./git";
import type { LocalVersion } from "./local";

export type NpmResult = { ok: boolean; output: string };
/** Roda `npm install` na raiz. Injetável: os testes nunca rodam o npm de verdade. */
export type NpmRunner = (cwd: string) => Promise<NpmResult>;

export const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 120_000;
const MERGE_TIMEOUT_MS = 60_000;
/** O estado do disco (HEAD, ramo, mudanças) é relido no máximo de 5 em 5 segundos. */
export const LIVE_TTL_MS = 5_000;
const MAX_LOG_LINES = 80;
const MAX_LOG_LINE = 300;

export const defaultNpmRunner: NpmRunner = (cwd) =>
  new Promise((resolve) => {
    execFile(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-progress"],
      { cwd, timeout: NPM_INSTALL_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8", env: { ...process.env, npm_config_loglevel: "error" } },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout ?? ""}\n${stderr ?? ""}${error && (error as { killed?: boolean }).killed ? "\nO npm install demorou demais e foi interrompido." : ""}` }),
    );
  });

/** Tira credenciais de um texto (usuário:senha em URL, tokens do GitHub e do npm). */
export function redact(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
    .replace(/\b(?:gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_]{8,}/g, "[oculto]")
    .replace(/(_authToken\s*=\s*)\S+/gi, "$1[oculto]")
    .replace(/(Bearer\s+)\S+/gi, "$1[oculto]");
}

/** As últimas linhas de uma saída, sem credenciais e com tamanho limitado. */
export function tailLines(text: string, max = 12): string[] {
  return redact(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-max)
    .map((line) => (line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line));
}

type Live = { head: string | null; branch: string | null; dirty: boolean };

export type UpdateManagerDeps = {
  rootDir: string;
  local: () => Promise<LocalVersion>;
  checker: Pick<UpdateChecker, "snapshot" | "check">;
  /** Ramo estável (`CYNO_UPDATE_BRANCH`, padrão main). */
  branch: string;
  /** `CYNO_UPDATE_APPLY` não está em off. */
  enabled: boolean;
  runMode: (local: LocalVersion) => RunMode;
  npm?: NpmRunner;
  now?: () => number;
  /** Validade do cache do estado do disco (padrão 5 s; os testes usam 0). */
  liveTtlMs?: number;
};

const HOST_ONLY = "Nesta instalação a atualização é feita no computador hospedeiro.";

/**
 * "Baixar atualização": `git fetch origin <ramo>` e `git merge --ff-only FETCH_HEAD` (só avanço direto), mais
 * `npm install` quando o package-lock mudou. Nunca reinicia nada (nem pm2, nem Docker): só diz que falta reiniciar.
 * Uma por vez; o resultado do último fica em memória.
 */
export class UpdateManager {
  private job: UpdateJob | null = null;
  private running: Promise<void> | null = null;
  private liveCache: { at: number; value: Live } | null = null;
  private readonly npm: NpmRunner;
  private readonly now: () => number;

  constructor(private readonly deps: UpdateManagerDeps) {
    this.npm = deps.npm ?? defaultNpmRunner;
    this.now = deps.now ?? Date.now;
  }

  /** O disco agora: HEAD, ramo e mudanças em arquivos versionados (consulta barata, com cache curto). */
  async live(force = false): Promise<Live> {
    const cached = this.liveCache;
    if (!force && cached && this.now() - cached.at < (this.deps.liveTtlMs ?? LIVE_TTL_MS)) return cached.value;
    const local = await this.deps.local();
    const cwd = local.gitCwd;
    let value: Live = { head: null, branch: null, dirty: false };
    if (cwd) {
      const [head, branch, status] = await Promise.all([
        runGit(["rev-parse", "HEAD"], { cwd }),
        runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd }),
        runGit(["status", "--porcelain", "--untracked-files=no"], { cwd, timeoutMs: 10_000 }),
      ]);
      const hash = head.ok ? head.stdout.trim() : "";
      value = { head: /^[0-9a-f]{40,64}$/.test(hash) ? hash : null, branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null, dirty: status.ok && status.stdout.trim() !== "" };
    }
    this.liveCache = { at: this.now(), value };
    return value;
  }

  /** O commit em disco como a verificação deve enxergar (o do processo pode ser mais velho). */
  async checkerLocal(): Promise<LocalVersion> {
    const local = await this.deps.local();
    const { head } = await this.live();
    if (!head || !local.info.commit) return local;
    return { ...local, info: { ...local.info, commit: { ...local.info.commit, hash: head, short: head.slice(0, 7) } } };
  }

  /** Se o disco já tem o que a verificação viu no origin, a verificação está velha: conta como em dia. */
  adjustCheck(check: UpdateCheckState, live: Live): UpdateCheckState {
    if (check.status === "update-available" && live.head && check.remote?.hash === live.head) return { ...check, status: "up-to-date", count: null, commits: null, commitsUrl: null };
    return check;
  }

  private blocker(local: LocalVersion, live: Live, check: UpdateCheckState): string | undefined {
    if (!this.deps.enabled) return "O botão está desligado nesta instalação (CYNO_UPDATE_APPLY=off).";
    if (this.deps.runMode(local) === "docker" || !local.gitCwd) return HOST_ONLY;
    if (live.branch !== this.deps.branch) return `Esta instalação está ${live.branch ? `no ramo ${live.branch}` : "sem ramo (HEAD solto)"}; o botão só atualiza instalações no ramo ${this.deps.branch}.`;
    if (live.dirty) return "Há mudanças locais em arquivos do projeto. Guarde ou descarte antes de atualizar.";
    const boot = local.info.commit?.hash;
    if (boot && live.head && boot !== live.head) return "A atualização já está no disco. Reinicie para aplicar antes de baixar outra.";
    if (check.status !== "update-available") return "Não há atualização disponível na última verificação.";
    return undefined;
  }

  async state(): Promise<UpdateApplyState> {
    const local = await this.deps.local();
    const live = await this.live();
    const check = this.adjustCheck(this.deps.checker.snapshot(), live);
    const running = this.job?.state === "running";
    const reason = running ? "Uma atualização está em andamento." : this.blocker(local, live, check);
    const boot = local.info.commit?.hash ?? null;
    const restartNeeded = !!boot && !!live.head && boot !== live.head;
    return {
      enabled: this.deps.enabled,
      canDownload: reason === undefined,
      ...(reason ? { blockedReason: reason } : {}),
      runMode: this.deps.runMode(local),
      restartNeeded,
      diskCommit: restartNeeded && live.head ? { hash: live.head, short: live.head.slice(0, 7) } : null,
      runningCommit: boot ? { hash: boot, short: boot.slice(0, 7) } : null,
      job: this.job ? { ...this.job, log: [...this.job.log] } : null,
    };
  }

  /** Começa a baixar (em segundo plano). Pedido repetido enquanto roda não inicia outro. */
  async start(): Promise<{ started: true } | { started: false; running: true } | { started: false; running: false; reason: string }> {
    if (this.running) return { started: false, running: true };
    const local = await this.deps.local();
    const live = await this.live(true);
    if (this.running) return { started: false, running: true };
    const reason = this.blocker(local, live, this.adjustCheck(this.deps.checker.snapshot(), live));
    if (reason) return { started: false, running: false, reason };
    const job: UpdateJob = { state: "running", step: "checking", startedAt: new Date(this.now()).toISOString(), finishedAt: null, from: null, to: null, codeUpdated: false, installRan: false, installFailed: false, message: null, log: [] };
    this.job = job;
    this.running = this.run(job, local).finally(() => {
      this.running = null;
    });
    return { started: true };
  }

  /** Espera a atualização em curso terminar (para os testes). */
  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private log(job: UpdateJob, line: string): void {
    job.log.push(redact(line).slice(0, MAX_LOG_LINE));
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }

  private step(job: UpdateJob, step: UpdateStep, line: string): void {
    job.step = step;
    this.log(job, line);
  }

  private finish(job: UpdateJob, state: "done" | "failed", message: string): void {
    job.state = state;
    job.step = null;
    job.message = message;
    job.finishedAt = new Date(this.now()).toISOString();
    this.log(job, message);
  }

  private async run(job: UpdateJob, local: LocalVersion): Promise<void> {
    try {
      await this.apply(job, local);
    } catch {
      this.finish(job, "failed", job.codeUpdated ? "A atualização terminou com um erro inesperado." : "Erro inesperado ao baixar a atualização. Nada foi alterado.");
    } finally {
      this.liveCache = null;
    }
  }

  private gitFailure(result: Extract<GitResult, { ok: false }>): string {
    return result.timedOut ? "demorou demais" : lsRemoteReason(result).replace(/\.$/, "").toLowerCase();
  }

  private async apply(job: UpdateJob, local: LocalVersion): Promise<void> {
    const cwd = local.gitCwd;
    if (!cwd) return this.finish(job, "failed", HOST_ONLY);
    const branch = this.deps.branch;
    this.step(job, "checking", "Conferindo o repositório…");
    const live = await this.live(true);
    const reason = this.blocker(local, live, this.adjustCheck(this.deps.checker.snapshot(), live));
    if (reason) return this.finish(job, "failed", `${reason} Nada foi alterado.`);
    const previous = live.head;
    if (!previous) return this.finish(job, "failed", "Não foi possível ler o commit atual. Nada foi alterado.");
    job.from = previous.slice(0, 7);
    this.log(job, `Commit atual: ${job.from}`);

    this.step(job, "fetching", `Baixando o ramo ${branch}…`);
    const fetched = await runGit(["fetch", "origin", branch], { cwd, timeoutMs: FETCH_TIMEOUT_MS });
    if (!fetched.ok) {
      for (const line of tailLines(fetched.stderr, 4)) this.log(job, line);
      return this.finish(job, "failed", `Não foi possível baixar o código (${this.gitFailure(fetched)}). Nada foi alterado.`);
    }

    this.step(job, "merging", "Aplicando o código novo (só avanço direto)…");
    const merged = await runGit(["merge", "--ff-only", "FETCH_HEAD"], { cwd, timeoutMs: MERGE_TIMEOUT_MS, env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" } });
    if (!merged.ok) {
      for (const line of tailLines(merged.stderr, 6)) this.log(job, line);
      return this.finish(job, "failed", `Não foi possível avançar o código de forma direta: o ramo local diverge do ${branch} do origin ou há arquivos que impedem. Nada foi alterado.`);
    }
    const head = await runGit(["rev-parse", "HEAD"], { cwd });
    const next = head.ok ? head.stdout.trim() : "";
    if (!next || next === previous) return this.finish(job, "done", "Já estava com o código mais recente. Nada para baixar.");
    job.codeUpdated = true;
    job.to = next.slice(0, 7);
    this.log(job, `Commit novo: ${job.to}`);

    const lock = await runGit(["diff", "--name-only", previous, next, "--", "package-lock.json"], { cwd });
    if (lock.ok && lock.stdout.trim() !== "") {
      this.step(job, "installing", "Instalando dependências (o package-lock mudou)…");
      job.installRan = true;
      const result = await this.npm(cwd);
      for (const line of tailLines(result.output, 12)) this.log(job, line);
      if (!result.ok) {
        job.installFailed = true;
        this.liveCache = null;
        return this.finish(job, "failed", "O código novo foi baixado, mas o npm install falhou. Rode npm install na pasta do projeto antes de reiniciar.");
      }
    } else {
      this.log(job, "Dependências sem mudança: o npm install não foi preciso.");
    }
    this.liveCache = null;
    await this.deps.checker.check().catch(() => undefined);
    this.finish(job, "done", "Atualização baixada. Reinicie para aplicar.");
  }
}
