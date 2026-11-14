import type { AgentProvider, SubscriptionUsage, UsageWindow } from "@cyno/shared";
import { activity } from "../../workspace/activity/log";
import type { SubscriptionUsageTracker } from "./subscription-usage";

export type UsageLogger = { debug: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };

/** Opções comuns das consultas periódicas do uso da conta (Claude e Antigravity). */
export type UsagePollerOptions = {
  tracker: Pick<SubscriptionUsageTracker, "reportAccount" | "markStale" | "get">;
  /** Intervalo entre consultas (ms). 0 = sem consultas periódicas (só boot e pedido manual). */
  intervalMs?: number;
  /** Espera depois de uma falha (ms). Padrão: 10 min (ou o intervalo, se maior). */
  backoffMs?: number;
  /** Mínimo entre consultas reais pedidas à mão (ms). Padrão: 30 s. */
  minRefreshMs?: number;
  now?: () => Date;
  log?: UsageLogger;
};

export type RefreshResult = { refreshed: boolean; usage: SubscriptionUsage | null };

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
      return { refreshed: true, usage: this.current() };
    }
    if (this.now().getTime() - this.lastFetchAt < this.minRefreshMs) return { refreshed: false, usage: this.current() };
    await this.poll();
    return { refreshed: true, usage: this.current() };
  }

  /** Espera a consulta em andamento, se houver (testes e shutdown). */
  async idle(): Promise<void> {
    await this.inFlight;
  }

  /** Uma consulta (junta pedidos simultâneos) e agenda a próxima. Devolve se deu certo. */
  poll(): Promise<boolean> {
    this.inFlight ??= this.fetchOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private current(): SubscriptionUsage | null {
    return this.base.tracker.get(this.provider) ?? null;
  }

  private async fetchOnce(): Promise<boolean> {
    this.lastFetchAt = this.now().getTime();
    let ok = false;
    try {
      const windows = await this.fetchWindows();
      this.base.tracker.reportAccount(this.provider, windows, this.now().toISOString());
      ok = true;
    } catch (error) {
      const reason = error instanceof StaleError ? error.reason : this.fallbackReason;
      this.base.log?.debug({ provider: this.provider, reason }, "uso da conta indisponível");
      activity(
        { category: "sistema", action: "consulta_de_uso_falhou", actor: "sistema", summary: `Não foi possível consultar o uso da conta (${this.provider}): ${reason}`, data: { provider: this.provider, reason } },
        { throttle: { key: `usage-poll:${this.provider}`, ms: 60 * 60_000 } },
      );
      this.base.tracker.markStale(this.provider, reason);
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
