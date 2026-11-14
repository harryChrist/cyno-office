import type { BrowserActivity, BrowserState, ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { useNavStore } from "./navStore";

/** Quanto o globo fica no balão do agente depois de cada ação no navegador (ms). */
export const BROWSER_ACTIVITY_MS = 8000;

/** Última ação de um agente no navegador (o balão com o globo e o rótulo). */
export type BrowserMark = BrowserActivity & { seq: number };

type BrowserStoreState = {
  /** Abas do navegador do workspace (GET /browser + browser:tabs); null = ainda não carregado. */
  browser: BrowserState | null;
  error: string | null;
  /** Última ação de cada agente no navegador (some depois de BROWSER_ACTIVITY_MS). */
  byAgent: Record<string, BrowserMark>;
  load: () => Promise<void>;
  /** As abas que vieram no office:snapshot (um GET em voo fica velho). */
  replace: (browser: BrowserState) => void;
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

let seq = 0;
/** Quantos browser:tabs chegaram (um GET em voo que perdeu algum é descartado). */
let seenTabs = 0;

/** Navegador compartilhado do workspace atual (fora do OfficeState, como os conectores). */
export const useBrowserStore = create<BrowserStoreState>()((set, get) => ({
  browser: null,
  error: null,
  byAgent: {},

  async load() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const seen = seenTabs;
    try {
      const browser = await api.getBrowser();
      if (useNavStore.getState().workspaceId !== workspaceId || seen !== seenTabs) return;
      set({ browser, error: null });
    } catch (error) {
      if (useNavStore.getState().workspaceId === workspaceId) set({ error: describeError(error) });
    }
  },

  replace(browser) {
    seenTabs++;
    set({ browser, error: null });
  },

  apply(event) {
    if (event.type === "browser:tabs") {
      seenTabs++;
      set({ browser: event.browser, error: null });
      return;
    }
    if (event.type !== "browser:activity") return;
    const mark: BrowserMark = { ...event.activity, seq: ++seq };
    set({ byAgent: { ...get().byAgent, [mark.agentId]: mark } });
    window.setTimeout(() => {
      const current = get().byAgent[mark.agentId];
      if (current?.seq !== mark.seq) return;
      const next = { ...get().byAgent };
      delete next[mark.agentId];
      set({ byAgent: next });
    }, BROWSER_ACTIVITY_MS);
  },

  reset() {
    set({ browser: null, error: null, byAgent: {} });
  },
}));

export function isBrowserEvent(event: ServerEvent): boolean {
  return event.type === "browser:tabs" || event.type === "browser:activity";
}
