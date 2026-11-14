import { sortUsageWindows, type AgentProvider, type FreebuffUsageDetail, type SubscriptionUsage, type UsageWindow } from "@cyno/shared";
import { EventHub } from "../../platform/events/hub";

/** Relato de uso de uma CLI (o evento `usage` do terminal). */
export type UsageReport = { windows: UsageWindow[]; status?: string };

const sameWindows = (a: UsageWindow[], b: UsageWindow[]): boolean =>
  a.length === b.length &&
  a.every((window, i) => {
    const other = b[i]!;
    return (
      window.id === other.id &&
      window.utilization === other.utilization &&
      window.resetsAt === other.resetsAt &&
      window.status === other.status &&
      window.severity === other.severity &&
      window.label === other.label &&
      window.group === other.group &&
      (window.appliesTo ?? []).join(",") === (other.appliesTo ?? []).join(",")
    );
  });

const copyUsage = (usage: SubscriptionUsage): SubscriptionUsage => ({
  ...usage,
  windows: usage.windows.map((window) => ({ ...window, ...(window.appliesTo ? { appliesTo: [...window.appliesTo] } : {}) })),
  ...(usage.stale ? { stale: { ...usage.stale } } : {}),
  ...(usage.freebuff ? { freebuff: structuredClone(usage.freebuff) } : {}),
});

/** Junta as janelas novas às conhecidas: as que vieram substituem as de mesmo id; as outras ficam. */
function mergeWindows(previous: UsageWindow[] | undefined, incoming: UsageWindow[]): UsageWindow[] {
  const merged = new Map((previous ?? []).map((window) => [window.id, window]));
  for (const window of incoming) merged.set(window.id, window);
  return sortUsageWindows([...merged.values()]);
}

/**
 * Uso da assinatura de cada CLI (o último relato por provedor). O uso é da CONTA, então é um só
 * para o server todo: os terminais de qualquer workspace relatam aqui (`report`), a consulta do
 * uso da conta também (`reportAccount` / `markStale`), e o `hub` publica `usage:updated` para os
 * sockets de todos os workspaces (o WebSocket também manda o estado no office:snapshot).
 * Um relato com só algumas janelas atualiza essas e mantém as outras. Relato da CLI que não muda
 * nada não publica.
 */
export class SubscriptionUsageTracker {
  readonly hub = new EventHub();
  private readonly byProvider = new Map<AgentProvider, SubscriptionUsage>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Relato vindo de uma CLI rodando (ex.: `rate_limit_event` do Claude Code). */
  report(provider: AgentProvider, report: UsageReport): void {
    if (report.windows.length === 0) return;
    const previous = this.byProvider.get(provider);
    const windows = mergeWindows(previous?.windows, report.windows);
    const status = report.status ?? previous?.status;
    if (previous && previous.status === status && sameWindows(previous.windows, windows)) return;
    const next: SubscriptionUsage = { ...previous, provider, windows, source: "cli", updatedAt: this.now().toISOString() };
    if (status) next.status = status;
    this.set(next);
  }

  /**
   * Resultado da consulta do uso da CONTA: autoritativo, substitui a lista de janelas (uma janela
   * que a conta deixou de informar some). Sempre publica (o `fetchedAt` muda) e tira o aviso de
   * dado velho.
   */
  reportAccount(provider: AgentProvider, windows: UsageWindow[], fetchedAt: string = this.now().toISOString()): void {
    const previous = this.byProvider.get(provider);
    const next: SubscriptionUsage = { ...previous, provider, windows: sortUsageWindows([...windows]), source: "account", fetchedAt, updatedAt: this.now().toISOString() };
    delete next.stale;
    this.set(next);
  }

  /**
   * A consulta da conta falhou: mantém o último valor (e o `updatedAt` dele) e marca como velho,
   * com o motivo. O mesmo motivo de novo não publica (e mantém o `since` da primeira falha).
   */
  markStale(provider: AgentProvider, reason: string): void {
    const previous = this.byProvider.get(provider);
    if (previous?.stale?.reason === reason) return;
    // `updatedAt` continua o do último dado (o web mostra "atualizado há X min" a partir dele).
    const at = this.now().toISOString();
    const since = previous?.stale?.since ?? at;
    this.set({ ...(previous ?? { provider, windows: [], updatedAt: at }), stale: { reason, since } });
  }

  /**
   * O estado do Freebuff (as horas do dia, as horas abertas por agente e o modelo): vira o uso do provedor
   * "freebuff". A janela `daily_hours` (usadas/total) só existe quando o total do dia é conhecido.
   */
  reportFreebuff(detail: FreebuffUsageDetail): void {
    const previous = this.byProvider.get("freebuff");
    // Nada a mostrar ainda (nenhuma leitura do saldo, nenhuma hora, nenhum pedido): o Freebuff não aparece no uso.
    if (!previous && detail.hours.total === undefined && detail.sessions.length === 0 && (detail.pending?.length ?? 0) === 0 && detail.hours.openedSince === 0) return;
    const { total, remaining, resetsAt } = detail.hours;
    const windows: UsageWindow[] =
      total !== undefined && total > 0 && remaining !== undefined
        ? [{ id: "daily_hours", utilization: Math.min(1, Math.max(0, (total - remaining) / total)), ...(resetsAt ? { resetsAt } : {}), label: "Horas do dia" }]
        : [];
    const next: SubscriptionUsage = { provider: "freebuff", windows, source: "cli", updatedAt: this.now().toISOString(), freebuff: structuredClone(detail) };
    if (previous?.fetchedAt) next.fetchedAt = previous.fetchedAt;
    this.set(next);
  }

  /** Estado lido do disco no boot (não publica: ainda não há sockets). */
  restore(usages: SubscriptionUsage[]): void {
    for (const usage of usages) this.byProvider.set(usage.provider, copyUsage(usage));
  }

  /** Último uso de cada provedor conhecido (vai no office:snapshot). */
  snapshot(): SubscriptionUsage[] {
    return [...this.byProvider.values()].map(copyUsage);
  }

  /** Uso de um provedor (cópia), se conhecido. */
  get(provider: AgentProvider): SubscriptionUsage | undefined {
    const usage = this.byProvider.get(provider);
    return usage ? copyUsage(usage) : undefined;
  }

  private set(usage: SubscriptionUsage): void {
    this.byProvider.set(usage.provider, usage);
    this.hub.publish({ type: "usage:updated", usage: copyUsage(usage) });
  }
}
