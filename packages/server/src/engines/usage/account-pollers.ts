import path from "node:path";
import type { EngineAccount } from "@cyno/shared";
import type { EngineAccountStore } from "../accounts/account-store";
import { AccountUsagePoller, type AccountUsagePollerOptions } from "./account-poller";
import { AntigravityUsagePoller, type AntigravityUsagePollerOptions } from "./antigravity-poller";
import { createQueryGate, type QueryGate } from "./query-gate";
import type { SubscriptionUsageTracker } from "./subscription-usage";
import type { RefreshResult, UsageLogger, UsagePoller } from "./usage-poller";

export type AccountPollerManagerOptions = {
  store: Pick<EngineAccountStore, "list" | "get" | "profileEnv">;
  tracker: SubscriptionUsageTracker;
  /** Opções base dos pollers Claude (ausente = desligado, acompanhando o poller da conta padrão). */
  claude?: Omit<AccountUsagePollerOptions, "tracker" | "now" | "log" | "accountId" | "credentialsFile" | "gate">;
  /** Opções base dos pollers Antigravity (ausente = desligado, acompanhando o poller da conta padrão). */
  gemini?: Omit<AntigravityUsagePollerOptions, "tracker" | "now" | "log" | "accountId" | "env" | "gate">;
  /** Consultas simultâneas no máximo (todas as contas juntas). Padrão: 4. */
  concurrency?: number;
  /** Espera entre o início de um poller e o do seguinte no boot, para as contas não consultarem todas juntas (ms). Padrão: 2 s. */
  staggerMs?: number;
  now?: () => Date;
  log?: UsageLogger;
};

/**
 * Gerencia um `UsagePoller` por conta extra cadastrada no `EngineAccountStore`:
 * - `start()` cria e inicia os pollers das contas já existentes (para os motores ligados);
 * - `add(account)` cria (e inicia, se já estiver rodando) o poller ao cadastrar uma conta;
 * - `remove(account)` para o poller, aguarda a consulta em curso e esquece o uso no tracker;
 * - `refresh(accountId)` consulta manualmente aquela conta (respeitando o mínimo de 30 s dela).
 */
export class AccountPollerManager {
  private readonly pollers = new Map<string, UsagePoller>();
  private started = false;
  private readonly gate: QueryGate;
  private readonly staggerTimers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: AccountPollerManagerOptions) {
    this.gate = createQueryGate(options.concurrency ?? 4);
  }

  /** Inicia os pollers de todas as contas já cadastradas cujos motores estejam ligados. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const staggerMs = this.options.staggerMs ?? 2_000;
    let index = 0;
    for (const account of this.options.store.list()) {
      const poller = this.ensurePoller(account);
      if (!poller) continue;
      this.startLater(poller, index * staggerMs);
      index += 1;
    }
  }

  /** Começa o poller depois de `delayMs` (0 = já); o timer some se o gerenciador parar antes. */
  private startLater(poller: UsagePoller, delayMs: number): void {
    if (delayMs <= 0) {
      poller.start();
      return;
    }
    const timer = setTimeout(() => {
      this.staggerTimers.delete(timer);
      if (this.started) poller.start();
    }, delayMs);
    timer.unref?.();
    this.staggerTimers.add(timer);
  }

  /** Cria o poller para uma conta recém-criada (e inicia se o gerenciador já estiver rodando). */
  add(account: EngineAccount): UsagePoller | undefined {
    const poller = this.ensurePoller(account);
    if (this.started) poller?.start();
    return poller;
  }

  /** Para o poller da conta removida, aguarda a consulta em andamento e remove o uso dela do tracker. */
  async remove(account: Pick<EngineAccount, "id" | "engine">): Promise<void> {
    const poller = this.pollers.get(account.id);
    this.pollers.delete(account.id);
    if (poller) {
      poller.stop();
      await poller.idle();
    }
    this.options.tracker.forget(account.engine, account.id);
  }

  /** Devolve o poller ativo de uma conta (ou `undefined` se o motor dela estiver desligado). */
  getPoller(accountId: string): UsagePoller | undefined {
    const existing = this.pollers.get(accountId);
    if (existing) return existing;
    const account = this.options.store.get(accountId);
    if (!account) return undefined;
    return this.ensurePoller(account);
  }

  /** Consulta manual da conta (respeita o mínimo de 30 s daquela conta). */
  async refresh(accountId: string): Promise<RefreshResult | undefined> {
    const poller = this.getPoller(accountId);
    return poller ? poller.refresh() : undefined;
  }

  stop(): void {
    this.started = false;
    for (const timer of this.staggerTimers) clearTimeout(timer);
    this.staggerTimers.clear();
    for (const poller of this.pollers.values()) poller.stop();
  }

  async idle(): Promise<void> {
    await Promise.all([...this.pollers.values()].map((poller) => poller.idle()));
  }

  private ensurePoller(account: EngineAccount): UsagePoller | undefined {
    const existing = this.pollers.get(account.id);
    if (existing) return existing;

    const env = this.options.store.profileEnv(account);
    let poller: UsagePoller | undefined;
    if (account.engine === "claude" && this.options.claude) {
      poller = new AccountUsagePoller({
        ...this.options.claude,
        tracker: this.options.tracker,
        gate: this.gate,
        accountId: account.id,
        credentialsFile: path.join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
      });
    } else if (account.engine === "gemini" && this.options.gemini) {
      poller = new AntigravityUsagePoller({
        ...this.options.gemini,
        tracker: this.options.tracker,
        gate: this.gate,
        accountId: account.id,
        env,
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
      });
    }

    if (poller) this.pollers.set(account.id, poller);
    return poller;
  }
}
