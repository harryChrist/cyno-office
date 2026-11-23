import { usageKey, type AgentProvider, type SubscriptionUsage, type UsageWindow } from "@cyno/shared";
import { activity } from "../../workspace/activity/log";
import type { QueryGate } from "./query-gate";
import type { SubscriptionUsageTracker } from "./subscription-usage";

export type UsageLogger = { debug: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };

/** Opções comuns das consultas periódicas do uso da conta (Claude e Antigravity). */
export type UsagePollerOptions = {
  tracker: Pick<SubscriptionUsageTracker, "reportAccount" | "markStale" | "get">;
  /** Id da conta extra do motor; ausente = conta padrão (HOME real). */
  accountId?: string;
  /** Intervalo entre consultas (ms). 0 = sem consultas periódicas (só boot e pedido manual). */
  intervalMs?: number;
  /** Espera depois de uma falha (ms). Padrão: 10 min (ou o intervalo, se maior). */
  backoffMs?: number;
  /** Porteiro compartilhado: limita quantas consultas de contas rodam ao mesmo tempo. Ausente = sem limite. */
  gate?: QueryGate;
  /** Mínimo entre consultas reais pedidas à mão (ms). Padrão: 30 s. */
  minRefreshMs?: number;
  now?: () => Date;
  log?: UsageLogger;
};

export type RefreshResult = { refreshed: boolean; usage: SubscriptionUsage | null; accountId?: string };

/** Falha com motivo curto em pt-BR (vai para o `stale.reason` que o web mostra). */
export class StaleError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Consulta periódica do uso da CONTA de um provedor: no boot, a cada `intervalMs` e quando o
 * usuário pede (`refresh`, com no mínimo `minRefreshMs` entre consultas reais). Pedidos simultâneos
 * viram uma consulta só. Falha mantém o último valor, marca como velho com o motivo e espera
 * `backoffMs` antes da próxima tentativa automática. Cada provedor diz só como buscar as janelas
 * (`fetchWindows`, que lança StaleError com o motivo).
 */
export abstract class UsagePoller {
  readonly accountId: string | undefined;
  protected readonly intervalMs: number;
  private readonly backoffMs: number;
  private readonly minRefreshMs: number;
  private readonly fallbackReason: string;
  protected readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<boolean> | undefined;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private stopped = true;

  constructor(
    readonly provider: AgentProvider,
    private readonly base: UsagePollerOptions,
    defaults: { intervalMs: number; fallbackReason: string },
  ) {
    this.accountId = base.accountId;
    this.intervalMs = base.intervalMs ?? defaults.intervalMs;
    this.backoffMs = base.backoffMs ?? 10 * 60_000;
    this.minRefreshMs = base.minRefreshMs ?? 30_000;
    this.now = base.now ?? (() => new Date());
    this.fallbackReason = defaults.fallbackReason;
  }

  /** Busca as janelas da conta agora (erro conhecido = StaleError com o motivo). */
  protected abstract fetchWindows(): Promise<UsageWindow[]>;

  /** Começa: uma consulta já e as próximas no intervalo. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Pedido manual: consulta já, a menos que a última consulta real tenha sido há < minRefreshMs. */
  async refresh(): Promise<RefreshResult> {
    if (this.inFlight) {
      await this.inFlight;
      return this.refreshResult(true);
    }
    if (this.now().getTime() - this.lastFetchAt < this.minRefreshMs) return this.refreshResult(false);
    await this.poll();
    return this.refreshResult(true);
  }

  /** Espera a consulta em andamento, se houver (testes e shutdown). */
  async idle(): Promise<void> {
    await this.inFlight;
  }

  /** Uma consulta (junta pedidos simultâneos) e agenda a próxima. Devolve se deu certo. */
  poll(): Promise<boolean> {
    this.inFlight ??= (this.base.gate ? this.base.gate(() => this.fetchOnce()) : this.fetchOnce()).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private current(): SubscriptionUsage | null {
    return this.base.tracker.get(this.provider, this.accountId) ?? null;
  }

  private refreshResult(refreshed: boolean): RefreshResult {
    return { refreshed, usage: this.current(), ...(this.accountId ? { accountId: this.accountId } : {}) };
  }

  private async fetchOnce(): Promise<boolean> {
    this.lastFetchAt = this.now().getTime();
    let ok = false;
    try {
      const windows = await this.fetchWindows();
      this.base.tracker.reportAccount(this.provider, windows, this.now().toISOString(), this.accountId);
      ok = true;
    } catch (error) {
      const reason = error instanceof StaleError ? error.reason : this.fallbackReason;
      const target = this.accountId ? `${this.provider}/${this.accountId}` : this.provider;
      const key = usageKey(this.provider, this.accountId);
      this.base.log?.debug({ provider: this.provider, ...(this.accountId ? { accountId: this.accountId } : {}), reason }, "uso da conta indisponível");
      activity(
        {
          category: "sistema",
          action: "consulta_de_uso_falhou",
          actor: "sistema",
          summary: `Não foi possível consultar o uso da conta (${target}): ${reason}`,
          data: { provider: this.provider, ...(this.accountId ? { accountId: this.accountId } : {}), reason },
        },
        { throttle: { key: `usage-poll:${key}`, ms: 60 * 60_000 } },
      );
      this.base.tracker.markStale(this.provider, reason, this.accountId);
    }
    this.schedule(ok ? this.intervalMs : Math.max(this.backoffMs, this.intervalMs));
    return ok;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.intervalMs <= 0) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
    this.timer.unref?.();
  }
}
