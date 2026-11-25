import { stat } from "node:fs/promises";
import path from "node:path";
import {
  ACCOUNT_ENGINES,
  DEFAULT_ACCOUNT_ID,
  type AccountEngine,
  type EngineAccount,
  type EngineAccountView,
} from "@cyno/shared";
import { userHomeDir } from "../../platform/os";
import { defaultProbe, type EngineBinary, type EngineProbe } from "../terminals/engines";
import { parseLoggedIn } from "../terminals/engine-status";
import type { EngineAccountStore } from "./account-store";

/** Validade do cache de estado de login por conta (10 s: abrir a tela não dispara processos repetidos). */
export const LOGIN_CACHE_TTL_MS = 10_000;

/** Tempo máximo para `claude auth status` responder. */
export const CLAUDE_AUTH_TIMEOUT_MS = 5_000;

/** Rótulo exibido para a conta padrão sintética (a do HOME real do servidor). */
export const DEFAULT_ACCOUNT_LABEL = "Padrão";

/** Arquivo de token OAuth do Antigravity (nunca ler o conteúdo — só checar existência). */
export function agyTokenFile(homeDir: string): string {
  return path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

export type LoginTarget = {
  engine: AccountEngine;
  accountId: string;
  isDefault: boolean;
};

export type AccountLoginCheckerOptions = {
  store: Pick<EngineAccountStore, "list" | "get" | "profileEnv">;
  resolveBinary: (engine: AccountEngine) => EngineBinary;
  /** HOME real usado pela conta padrão do Antigravity (nos testes: pasta temporária; nunca o HOME real). */
  realHomeDir?: string;
  /** Sobrescrita opcional do `CLAUDE_CONFIG_DIR` da conta padrão (útil em testes). */
  defaultClaudeConfigDir?: string;
  probe?: EngineProbe;
  now?: () => number;
  cacheTtlMs?: number;
  claudeTimeoutMs?: number;
  /** Ambiente e plataforma opcionais (para simular Windows/Linux nos testes). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

type CacheEntry = { loggedIn: boolean; at: number };

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Calcula e faz cache curto (10 s) do estado `loggedIn` de cada conta (padrão e extras):
 * - Claude Code: `claude auth status` (JSON, lê SÓ o campo `loggedIn`) com `CLAUDE_CONFIG_DIR` da conta;
 * - Antigravity: só a EXISTÊNCIA do arquivo `antigravity-oauth-token` em `<HOME>/.gemini/antigravity-cli/`
 *   (nunca abre nem lê o conteúdo do token).
 */
export class AccountLoginChecker {
  private readonly probe: EngineProbe;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly claudeTimeoutMs: number;
  private readonly realHomeDir: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(private readonly options: AccountLoginCheckerOptions) {
    this.probe = options.probe ?? defaultProbe;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? LOGIN_CACHE_TTL_MS;
    this.claudeTimeoutMs = options.claudeTimeoutMs ?? CLAUDE_AUTH_TIMEOUT_MS;
    this.realHomeDir = path.resolve(options.realHomeDir ?? userHomeDir(options.env ?? process.env, options.platform));
  }

  private key(engine: AccountEngine, accountId: string): string {
    return `${engine}:${accountId}`;
  }

  /** Estado de login usando cache curto (10 s) e deduplicando chamadas simultâneas. */
  async check(target: LoginTarget): Promise<boolean> {
    const key = this.key(target.engine, target.accountId);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.loggedIn;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.compute(target)
      .then((loggedIn) => {
        this.cache.set(key, { loggedIn, at: this.now() });
        return loggedIn;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Checa diretamente sem usar o cache (ex.: polling de 2 s durante o login) e atualiza o cache. */
  async checkFresh(target: LoginTarget): Promise<boolean> {
    const loggedIn = await this.compute(target);
    this.cache.set(this.key(target.engine, target.accountId), { loggedIn, at: this.now() });
    return loggedIn;
  }

  /** Atualiza o cache manualmente (ex.: quando o login termina). */
  setCached(engine: AccountEngine, accountId: string, loggedIn: boolean): void {
    this.cache.set(this.key(engine, accountId), { loggedIn, at: this.now() });
  }

  /** Remove do cache (ex.: conta apagada). */
  invalidate(engine: AccountEngine, accountId: string): void {
    this.cache.delete(this.key(engine, accountId));
  }

  /** Monta a lista de `GET /api/engines/accounts`: contas padrão sintéticas + contas extras, todas com `loggedIn`. */
  async listWithStatus(): Promise<EngineAccountView[]> {
    const extras = this.options.store.list();
    const defaults = await Promise.all(
      ACCOUNT_ENGINES.map(async (engine): Promise<EngineAccountView> => ({
        id: DEFAULT_ACCOUNT_ID,
        engine,
        label: DEFAULT_ACCOUNT_LABEL,
        isDefault: true,
        loggedIn: await this.check({ engine, accountId: DEFAULT_ACCOUNT_ID, isDefault: true }),
      })),
    );
    const extraViews = await Promise.all(
      extras.map((account) => this.viewOf(account)),
    );
    return [...defaults, ...extraViews];
  }

  /** Constrói a visão da API de uma conta extra específica com o estado `loggedIn`. */
  async viewOf(account: EngineAccount): Promise<EngineAccountView> {
    const loggedIn = await this.check({ engine: account.engine, accountId: account.id, isDefault: false });
    return { ...account, loggedIn };
  }

  private async compute(target: LoginTarget): Promise<boolean> {
    if (target.engine === "gemini") {
      const profile = target.isDefault ? undefined : this.options.store.profileEnv({ id: target.accountId, engine: "gemini" });
      const homeDir = target.isDefault ? this.realHomeDir : (profile?.USERPROFILE ?? profile?.HOME)!;
      return fileExists(agyTokenFile(homeDir));
    }

    const bin = this.options.resolveBinary("claude");
    const extraEnv = target.isDefault
      ? (this.options.defaultClaudeConfigDir ? { CLAUDE_CONFIG_DIR: this.options.defaultClaudeConfigDir } : undefined)
      : this.options.store.profileEnv({ id: target.accountId, engine: "claude" });
    const result = await this.probe(bin.command, [...(bin.prefixArgs ?? []), "auth", "status"], this.claudeTimeoutMs, extraEnv);
    return parseLoggedIn(result.stdout) === true;
  }
}
