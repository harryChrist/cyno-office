import type { PlatformToday, ServerEvent, TodayView } from "@cyno/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { useNavStore } from "./navStore";

/**
 * Eventos do workspace que mudam o painel "Hoje". O progresso (`task:progress`) fica de fora de
 * propósito: ele chega a cada passo do agente e o painel o põe por cima da última conta (veja
 * `withLiveProgress`), sem pedir tudo de novo. Também ficam de fora o log, o uso e o navegador.
 */
export function isTodayEvent(event: ServerEvent): boolean {
  switch (event.type) {
    case "office:snapshot":
    case "task:upserted":
    case "project:upserted":
    case "project:deleted":
    case "foryou:upserted":
    case "foryou:deleted":
    case "agent:upserted":
    case "agent:deleted":
    case "media:upserted":
    case "routine:upserted":
    case "routine:removed":
    case "routine:entry":
    case "routine:execution":
    case "routine:items":
    case "routine:closed":
      return true;
    default:
      return false;
  }
}

/** Junta uma rajada de eventos numa só busca. */
export const TODAY_RELOAD_DELAY_MS = 500;
/** Sem evento nenhum, o painel se recalcula assim (a hora passa: o que "vai rodar" vira "rodou"; a agenda chega pelo outro socket). */
export const TODAY_REFRESH_MS = 30_000;

type TodayStore = {
  /** Workspace da visão abaixo (trocar de workspace descarta). */
  workspaceId: string | null;
  view: TodayView | null;
  error: string | null;
  platform: PlatformToday | null;
  platformError: string | null;
  loadWorkspace: () => Promise<void>;
  loadPlatform: () => Promise<void>;
  /** Cada evento do workspace: se alguém está olhando o painel e o evento importa, recarrega com debounce. */
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

let workspaceWatchers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let workspaceSeq = 0;
let platformSeq = 0;

export const useTodayStore = create<TodayStore>()((set, get) => ({
  workspaceId: null,
  view: null,
  error: null,
  platform: null,
  platformError: null,

  async loadWorkspace() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    if (get().workspaceId !== workspaceId) set({ workspaceId, view: null, error: null });
    const seq = ++workspaceSeq;
    try {
      const view = await api.getToday();
      if (seq !== workspaceSeq || useNavStore.getState().workspaceId !== workspaceId) return;
      set({ view, error: null });
    } catch (error) {
      if (seq !== workspaceSeq || useNavStore.getState().workspaceId !== workspaceId) return;
      set({ error: describeError(error) });
    }
  },

  async loadPlatform() {
    const seq = ++platformSeq;
    try {
      const platform = await api.getPlatformToday();
      if (seq === platformSeq) set({ platform, platformError: null });
    } catch (error) {
      if (seq === platformSeq) set({ platformError: describeError(error) });
    }
  },

  apply(event) {
    if (workspaceWatchers === 0 || !isTodayEvent(event)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void get().loadWorkspace(), TODAY_RELOAD_DELAY_MS);
  },

  reset() {
    clearTimeout(timer);
    workspaceSeq += 1;
    set({ workspaceId: null, view: null, error: null });
  },
}));

/** O painel do workspace está aberto: busca agora, depois a cada evento relevante e a cada 30 s. */
export function useWorkspaceToday(): { view: TodayView | null; error: string | null } {
  const workspaceId = useNavStore((state) => state.workspaceId);
  useEffect(() => {
    workspaceWatchers += 1;
    void useTodayStore.getState().loadWorkspace();
    const interval = window.setInterval(() => void useTodayStore.getState().loadWorkspace(), TODAY_REFRESH_MS);
    return () => {
      workspaceWatchers -= 1;
      window.clearInterval(interval);
    };
  }, [workspaceId]);
  const view = useTodayStore((state) => (state.workspaceId === workspaceId ? state.view : null));
  const error = useTodayStore((state) => state.error);
  return { view, error };
}

/** O bloco da página do Cyno está na tela: busca agora, a cada 20 s e quando as fichas dos workspaces mudam. */
export function usePlatformToday(refreshOn?: unknown): { platform: PlatformToday | null; error: string | null } {
  useEffect(() => {
    void useTodayStore.getState().loadPlatform();
    const interval = window.setInterval(() => void useTodayStore.getState().loadPlatform(), 20_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (refreshOn === undefined) return;
    const handle = window.setTimeout(() => void useTodayStore.getState().loadPlatform(), TODAY_RELOAD_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [refreshOn]);
  return { platform: useTodayStore((state) => state.platform), error: useTodayStore((state) => state.platformError) };
}
