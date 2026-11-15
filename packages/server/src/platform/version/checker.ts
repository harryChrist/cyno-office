import type { UpdateCheckState, UpdateCommit, UpdateStatus } from "@cyno/shared";
import { compareOnGithub, MAX_LISTED_COMMITS } from "./github";
import { runGit, type GitResult } from "./git";
import type { LocalVersion } from "./local";

export const DEFAULT_UPDATE_BRANCH = "main";
/** Primeira verificação 1 min depois da subida; depois, a cada 6 horas. */
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
/** Cliques repetidos em "Verificar agora" dentro deste intervalo devolvem o último resultado. */
export const MANUAL_COOLDOWN_MS = 10_000;

export type UpdateConfig = { auto: boolean; branch: string };

/** `CYNO_UPDATE_CHECK=off|0` desliga a automática; `CYNO_UPDATE_BRANCH` troca o ramo (nome de ramo válido, senão main). */
export function updateConfigFromEnv(env: NodeJS.ProcessEnv): UpdateConfig {
  const check = (env.CYNO_UPDATE_CHECK ?? "").trim().toLowerCase();
  const branch = (env.CYNO_UPDATE_BRANCH ?? "").trim();
  return { auto: check !== "off" && check !== "0", branch: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) && !branch.includes("..") ? branch : DEFAULT_UPDATE_BRANCH };
}

export type UpdateCheckerDeps = {
  local: () => Promise<LocalVersion>;
  config: UpdateConfig;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tempo limite do `git ls-remote`. */
  lsRemoteTimeoutMs?: number;
  githubTimeoutMs?: number;
};

const HEX = /^[0-9a-f]{40,64}$/;

export function lsRemoteReason(result: Extract<GitResult, { ok: false }>): string {
  const text = result.stderr.toLowerCase();
  if (result.timedOut) return "A consulta ao repositório demorou demais.";
  if (/could not resolve host|network is unreachable|connection timed out|could not connect|unable to access|connection refused|operation timed out/.test(text)) return "Sem conexão com o repositório.";
  if (/permission denied|authentication|could not read username|could not read password|repository not found|access denied|host key verification/.test(text)) return "Sem permissão para ler o repositório (credencial ou chave).";
  if (result.code === "ENOENT") return "O git não está instalado neste servidor.";
  return "Não foi possível consultar o repositório.";
}

/**
 * Compara o commit instalado com o ramo estável do `origin`, sem alterar o repositório (`git ls-remote`, nunca `fetch`).
 * Guarda só o último resultado, em memória.
 */
export class UpdateChecker {
  private state: UpdateCheckState;
  private inFlight: Promise<UpdateCheckState> | null = null;
  private timers: { first?: NodeJS.Timeout; every?: NodeJS.Timeout } = {};
  private readonly now: () => number;
  private lastStartedAt = 0;

  constructor(private readonly deps: UpdateCheckerDeps) {
    this.now = deps.now ?? Date.now;
    this.state = {
      auto: deps.config.auto,
      branch: deps.config.branch,
      checking: false,
      checkedAt: null,
      status: "none",
      remote: null,
      count: null,
      commits: null,
      commitsUrl: null,
      reason: null,
    };
  }

  snapshot(): UpdateCheckState {
    return { ...this.state, checking: this.inFlight !== null };
  }

  /** Liga a verificação automática (se não estiver desligada): uma vez após 1 min e a cada 6 horas. */
  start(): void {
    if (!this.deps.config.auto || this.timers.first || this.timers.every) return;
    this.timers.first = setTimeout(() => {
      void this.check();
      this.timers.every = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
      this.timers.every.unref();
    }, FIRST_CHECK_DELAY_MS);
    this.timers.first.unref();
  }

  stop(): void {
    if (this.timers.first) clearTimeout(this.timers.first);
    if (this.timers.every) clearInterval(this.timers.every);
    this.timers = {};
  }

  /** Verifica agora. Uma verificação em curso é reaproveitada; cliques em sequência (< 10 s) devolvem o último resultado. */
  check(options: { manual?: boolean } = {}): Promise<UpdateCheckState> {
    if (this.inFlight) return this.inFlight;
    if (options.manual && this.state.checkedAt !== null && this.now() - this.lastStartedAt < MANUAL_COOLDOWN_MS) return Promise.resolve(this.snapshot());
    this.lastStartedAt = this.now();
    this.inFlight = this.run()
      .catch((): Partial<UpdateCheckState> => ({ status: "unavailable", reason: "Não foi possível verificar agora." }))
      .then((result) => {
        this.state = { ...this.state, remote: null, count: null, commits: null, commitsUrl: null, reason: null, ...result, checkedAt: new Date(this.now()).toISOString() };
        this.inFlight = null;
        return this.snapshot();
      });
    return this.inFlight;
  }

  private unavailable(reason: string): Partial<UpdateCheckState> {
    return { status: "unavailable", reason };
  }

  private async run(): Promise<Partial<UpdateCheckState>> {
    const local = await this.deps.local();
    const head = local.info.commit?.hash;
    if (!head) return this.unavailable("Esta instalação não registra o commit em uso.");
    if (!local.origin) return this.unavailable("Esta instalação não tem um repositório de origem configurado.");
    const branch = this.deps.config.branch;
    // Sem repositório local (Docker), consulta o endereço direto; ssh do GitHub vira https (leitura pública, sem chave).
    const remoteArg = local.gitCwd ? "origin" : (local.origin.github?.httpsUrl ?? local.origin.clean);
    const listed = await runGit(["ls-remote", remoteArg, `refs/heads/${branch}`], { ...(local.gitCwd ? { cwd: local.gitCwd } : {}), timeoutMs: this.deps.lsRemoteTimeoutMs ?? 20_000 });
    if (!listed.ok) return this.unavailable(lsRemoteReason(listed));
    const remoteHash = listed.stdout.split("\n").map((line) => line.split("\t")).find((parts) => parts[1] === `refs/heads/${branch}`)?.[0]?.trim();
    if (!remoteHash || !HEX.test(remoteHash)) return this.unavailable(`O ramo ${branch} não existe no repositório de origem.`);
    const remote = { hash: remoteHash, short: remoteHash.slice(0, 7) };
    const web = local.origin.github?.webUrl ?? null;
    const commitsUrl = web ? `${web}/compare/${head}...${remoteHash}` : null;
    const upToDate = (): Partial<UpdateCheckState> => ({ status: "up-to-date", remote });
    const updateAvailable = (count: number | null, commits: UpdateCommit[] | null): Partial<UpdateCheckState> => ({ status: "update-available" as UpdateStatus, remote, count, commits, commitsUrl });
    if (remoteHash === head) return upToDate();

    if (local.gitCwd) {
      const known = await runGit(["cat-file", "-e", `${remoteHash}^{commit}`], { cwd: local.gitCwd });
      if (known.ok) {
        const contained = await runGit(["merge-base", "--is-ancestor", remoteHash, head], { cwd: local.gitCwd });
        if (contained.ok) return upToDate();
        const [log, count] = await Promise.all([
          runGit(["log", `-n${MAX_LISTED_COMMITS}`, "--format=%H%x1f%cI%x1f%s", `${head}..${remoteHash}`], { cwd: local.gitCwd }),
          runGit(["rev-list", "--count", `${head}..${remoteHash}`], { cwd: local.gitCwd }),
        ]);
        const commits = log.ok ? parseLog(log.stdout) : null;
        const total = count.ok ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
        return updateAvailable(Number.isFinite(total) ? total : (commits?.length ?? null), commits);
      }
    }

    // Os objetos novos não estão aqui: só a API pública do GitHub (sem credencial) sabe listá-los.
    if (!local.origin.github) return local.gitCwd ? updateAvailable(null, null) : this.unavailable("Não foi possível comparar com o repositório de origem.");
    const compared = await compareOnGithub(local.origin.github, head, remoteHash, { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(this.deps.githubTimeoutMs ? { timeoutMs: this.deps.githubTimeoutMs } : {}) });
    if (!compared.ok) return local.gitCwd ? updateAvailable(null, null) : this.unavailable("Não foi possível comparar com o GitHub (repositório privado ou limite de uso).");
    if (compared.status === "identical" || compared.status === "behind") return upToDate();
    return updateAvailable(compared.count, compared.commits);
  }
}

function parseLog(stdout: string): UpdateCommit[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", date = "", ...subject] = line.split("\x1f");
      return { hash, short: hash.slice(0, 7), date, subject: subject.join("\x1f").trim() };
    })
    .filter((commit) => HEX.test(commit.hash));
}
