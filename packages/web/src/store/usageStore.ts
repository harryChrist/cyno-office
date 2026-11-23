import type { AgentProvider, ServerEvent, SubscriptionUsage } from "@cyno/shared";
import { create } from "zustand";

/** Último uso da assinatura de cada CLI (é da conta: não muda ao trocar de workspace). */
export type UsageByProvider = Partial<Record<AgentProvider, SubscriptionUsage>>;

/**
 * Aplica um evento ao uso conhecido (função pura): `usage:updated` troca o do provedor (só a conta
 * padrão: eventos com `accountId` são ignorados para não sobrescrever a conta padrão) e o
 * `office:snapshot` com `usage` troca tudo (também só a conta padrão). Outros eventos não mexem.
 * Devolve o mesmo objeto se nada mudou.
 */
export function applyUsageEvent(state: UsageByProvider, event: ServerEvent): UsageByProvider {
  if (event.type === "usage:updated") {
    if (event.usage.accountId) return state;
    return { ...state, [event.usage.provider]: event.usage };
  }
  if (event.type === "office:snapshot" && event.usage) {
    const next: UsageByProvider = {};
    for (const usage of event.usage) {
      if (!usage.accountId) next[usage.provider] = usage;
    }
    return next;
  }
  return state;
}

type UsageStoreState = {
  byProvider: UsageByProvider;
  apply: (event: ServerEvent) => void;
};

export const useUsageStore = create<UsageStoreState>()((set, get) => ({
  byProvider: {},
  apply(event) {
    const current = get().byProvider;
    const next = applyUsageEvent(current, event);
    if (next !== current) set({ byProvider: next });
  },
}));
