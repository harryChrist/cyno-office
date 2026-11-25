import { readFile } from "node:fs/promises";
import path from "node:path";
import { userHomeDir } from "../../platform/os";
import { parseAccountUsage } from "./account-usage";
import { StaleError, UsagePoller, type RefreshResult, type UsagePollerOptions } from "./usage-poller";

/**
 * Endpoint (NÃO documentado) do uso da conta Claude — o mesmo que o /usage do Claude Code usa.
 * Fixo de propósito: o token da conta só pode ir para cá.
 */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_BETA = "oauth-2025-04-20";

export const DEFAULT_ACCOUNT_POLL_MS = 3 * 60_000;

/** Motivos (pt-BR) de o uso da conta estar velho. */
export const STALE_REASONS = {
  noCredentials: "Login do Claude Code não encontrado neste computador",
  noToken: "Credenciais do Claude Code sem token de acesso",
  expired: "Login do Claude Code expirado — abra o Claude Code para renovar",
  denied: "A Anthropic recusou o acesso (login expirado?)",
  rateLimited: "A Anthropic pediu para consultar menos (tentando mais tarde)",
  timeout: "A Anthropic demorou demais para responder",
  network: "Sem conexão com a Anthropic",
  badResponse: "Resposta inesperada da Anthropic",
  unknownFormat: "Formato do uso da conta mudou (não reconhecido)",
} as const;

/** Arquivo de credenciais do Claude Code (`$CLAUDE_CONFIG_DIR/.credentials.json` ou `~/.claude/`). */
export function defaultCredentialsFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(userHomeDir(env, platform), ".claude"), ".credentials.json");
}

export type AccountUsagePollerOptions = UsagePollerOptions & {
  /** Tempo máximo de uma consulta (ms). Padrão: 10 s. */
  timeoutMs?: number;
  credentialsFile?: string;
  fetch?: typeof fetch;
};

export type { RefreshResult };

/**
 * Consulta o uso da CONTA Claude na Anthropic: no boot, a cada `intervalMs` e quando o usuário
 * pede (`refresh`, com no mínimo `minRefreshMs` entre consultas reais). O token é lido do arquivo
 * de credenciais do Claude Code a cada consulta (o Claude Code o mantém renovado; aqui nunca se
 * renova o token), vai só para `CLAUDE_USAGE_URL` e nunca é logado nem guardado. Falha (sem
 * arquivo, token expirado, 401/403, rede, timeout) mantém o último valor, marca como velho com o
 * motivo e espera `backoffMs` antes de tentar de novo.
 */
export class AccountUsagePoller extends UsagePoller {
  private readonly timeoutMs: number;
  private readonly credentialsFile: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: AccountUsagePollerOptions) {
    super("claude", options, { intervalMs: DEFAULT_ACCOUNT_POLL_MS, fallbackReason: STALE_REASONS.badResponse });
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.credentialsFile = options.credentialsFile ?? defaultCredentialsFile();
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /** Lê o token (sempre do disco) e consulta o endpoint. Erros viram StaleError com motivo. */
  protected async fetchWindows() {
    const token = await this.readToken();
    let response: Response;
    try {
      response = await this.fetchFn(CLAUDE_USAGE_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_USAGE_BETA, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new StaleError(name === "TimeoutError" || name === "AbortError" ? STALE_REASONS.timeout : STALE_REASONS.network);
    }
    if (response.status === 401 || response.status === 403) throw new StaleError(STALE_REASONS.denied);
    if (response.status === 429) throw new StaleError(STALE_REASONS.rateLimited);
    if (!response.ok) throw new StaleError(`${STALE_REASONS.badResponse} (HTTP ${response.status})`);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new StaleError(STALE_REASONS.badResponse);
    }
    const windows = parseAccountUsage(data);
    if (!windows) throw new StaleError(STALE_REASONS.unknownFormat);
    return windows;
  }

  private async readToken(): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(this.credentialsFile, "utf8");
    } catch {
      throw new StaleError(STALE_REASONS.noCredentials);
    }
    let oauth: unknown;
    try {
      oauth = (JSON.parse(raw) as { claudeAiOauth?: unknown }).claudeAiOauth;
    } catch {
      throw new StaleError(STALE_REASONS.noToken);
    }
    if (typeof oauth !== "object" || oauth === null) throw new StaleError(STALE_REASONS.noToken);
    const { accessToken, expiresAt } = oauth as { accessToken?: unknown; expiresAt?: unknown };
    if (typeof accessToken !== "string" || !accessToken.trim()) throw new StaleError(STALE_REASONS.noToken);
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
      const expiresMs = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
      if (expiresMs <= this.now().getTime()) throw new StaleError(STALE_REASONS.expired);
    }
    return accessToken.trim();
  }
}
