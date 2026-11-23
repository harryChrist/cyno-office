import { sortUsageWindows, usageKey, type AgentProvider, type FreebuffUsageDetail, type SubscriptionUsage, type UsageWindow } from "@cyno/shared";
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
 * Uso da assinatura de cada CLI (o último relato por provedor ou por conta extra). O uso é da CONTA,
 * então é um só para o server todo: os terminais de qualquer workspace relatam aqui (`report`), a
 * consulta do uso da conta também (`reportAccount` / `markStale`), e o `hub` publica `usage:updated`
 * para os sockets de todos os workspaces (o WebSocket também manda o estado no office:snapshot).
 * A chave interna é `usageKey(provider, accountId)` (conta ausente = conta padrão, chave só com o
 * provedor). Um relato com só algumas janelas atualiza essas e mantém as outras. Relato da CLI que
 * não muda nada não publica.
 */
export class SubscriptionUsageTracker {
  readonly hub = new EventHub();
  private readonly byKey = new Map<string, SubscriptionUsage>();
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Relato vindo de uma CLI rodando (ex.: `rate_limit_event` do Claude Code). */
  report(provider: AgentProvider, report: UsageReport, accountId?: string): void {
    if (report.windows.length === 0) return;
    const key = usageKey(provider, accountId);
    const previous = this.byKey.get(key);
    const windows = mergeWindows(previous?.windows, report.windows);
    const status = report.status ?? previous?.status;
    if (previous && previous.status === status && sameWindows(previous.windows, windows)) return;
    const next: SubscriptionUsage = {
      ...previous,
      provider,
      ...(accountId ? { accountId } : {}),
      windows,
      source: "cli",
      updatedAt: this.now().toISOString(),
    };
    if (status) next.status = status;
    this.set(next);
  }

  /**
   * Resultado da consulta do uso da CONTA: autoritativo, substitui a lista de janelas (uma janela
   * que a conta deixou de informar some). Sempre publica (o `fetchedAt` muda) e tira o aviso de
   * dado velho.
   */
  reportAccount(provider: AgentProvider, windows: UsageWindow[], fetchedAt: string = this.now().toISOString(), accountId?: string): void {
    const key = usageKey(provider, accountId);
    const previous = this.byKey.get(key);
    const next: SubscriptionUsage = {
      ...previous,
      provider,
      ...(accountId ? { accountId } : {}),
      windows: sortUsageWindows([...windows]),
      source: "account",
      fetchedAt,
      updatedAt: this.now().toISOString(),
    };
    delete next.stale;
    this.set(next);
  }

  /**
   * A consulta da conta falhou: mantém o último valor (e o `updatedAt` dele) e marca como velho,
   * com o motivo. O mesmo motivo de novo não publica (e mantém o `since` da primeira falha).
   */
  markStale(provider: AgentProvider, reason: string, accountId?: string): void {
    const key = usageKey(provider, accountId);
    const previous = this.byKey.get(key);
    if (previous?.stale?.reason === reason) return;
    // `updatedAt` continua o do último dado (o web mostra "atualizado há X min" a partir dele).
    const at = this.now().toISOString();
    const since = previous?.stale?.since ?? at;
    const base: SubscriptionUsage = previous ?? { provider, ...(accountId ? { accountId } : {}), windows: [], updatedAt: at };
    this.set({ ...base, stale: { reason, since } });
  }

  /**
   * O estado do Freebuff (as horas do dia, as horas abertas por agente e o modelo): vira o uso do provedor
   * "freebuff" (sem conta extra). A janela `daily_hours` (usadas/total) só existe quando o total do dia é conhecido.
   */
  reportFreebuff(detail: FreebuffUsageDetail): void {
    const previous = this.byKey.get(usageKey("freebuff"));
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

  /**
   * Remove o uso guardado de um provedor ou conta (ex.: conta excluída).
   * Não existe evento `usage:removed` no protocolo WebSocket: apenas remove da memória, avisa a
   * persistência e deixa `snapshot()` refletir a remoção.
   */
  forget(provider: AgentProvider, accountId?: string): boolean {
    const removed = this.byKey.delete(usageKey(provider, accountId));
    if (removed) this.notifyChange();
    return removed;
  }

  /** Todos os usos conhecidos de um provedor (conta padrão, se houver, e contas extras). */
  listAccounts(provider: AgentProvider): SubscriptionUsage[] {
    const out: SubscriptionUsage[] = [];
    for (const usage of this.byKey.values()) {
      if (usage.provider === provider) out.push(copyUsage(usage));
    }
    return out;
  }

  /** Estado lido do disco no boot (não publica: ainda não há sockets). */
  restore(usages: SubscriptionUsage[]): void {
    for (const usage of usages) this.byKey.set(usageKey(usage.provider, usage.accountId), copyUsage(usage));
  }

  /** Último uso de cada provedor/conta conhecido (vai no office:snapshot). */
  snapshot(): SubscriptionUsage[] {
    return [...this.byKey.values()].map(copyUsage);
  }

  /** Uso de um provedor/conta (cópia), se conhecido. Conta ausente = conta padrão. */
  get(provider: AgentProvider, accountId?: string): SubscriptionUsage | undefined {
    const usage = this.byKey.get(usageKey(provider, accountId));
    return usage ? copyUsage(usage) : undefined;
  }

  /** Avisa ouvintes internos (como a persistência em `usage.json`) em toda alteração (`set` ou `forget`). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private set(usage: SubscriptionUsage): void {
    this.byKey.set(usageKey(usage.provider, usage.accountId), usage);
    this.hub.publish({ type: "usage:updated", usage: copyUsage(usage) });
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }
}
