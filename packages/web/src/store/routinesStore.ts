import type { ManagementSummary, RoutinesOverview, ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api } from "../api/client";
import { useNavStore } from "./navStore";

/** Eventos de rotinas (ficam fora do escritório; esta store recarrega a página Gestão). */
export const isRoutineEvent = (event: ServerEvent): boolean =>
  event.type === "routine:upserted" || event.type === "routine:removed" || event.type === "routine:entry" || event.type === "routine:execution" || event.type === "routine:items" || event.type === "routine:closed";

/** Junta rajadas de eventos (um lote do agente manda vários seguidos) numa só recarga. */
export const ROUTINES_RELOAD_DELAY_MS = 250;

type RoutinesState = {
  /** Workspace dos dados abaixo (trocar de workspace descarta tudo). */
  workspaceId: string | null;
  overview: RoutinesOverview | null;
  summary: ManagementSummary | null;
  error: string | null;
  /** Sobe a cada evento de rotina: o painel de detalhe aberto recarrega. */
  version: number;
  /** Busca visão geral e resumo; sem workspace não faz nada. */
  load: () => Promise<void>;
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

let timer: ReturnType<typeof setTimeout> | undefined;

export const useRoutinesStore = create<RoutinesState>()((set, get) => ({
  workspaceId: null,
  overview: null,
  summary: null,
  error: null,
  version: 0,

  async load() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    if (get().workspaceId !== workspaceId) set({ workspaceId, overview: null, summary: null, error: null });
    const [overview, summary] = await Promise.allSettled([api.getRoutinesOverview(), api.getManagementSummary()]);
    if (useNavStore.getState().workspaceId !== workspaceId) return;
    const failed = [overview, summary].find((result) => result.status === "rejected");
    set({
      ...(overview.status === "fulfilled" ? { overview: overview.value } : {}),
      ...(summary.status === "fulfilled" ? { summary: summary.value } : {}),
      error: failed && failed.status === "rejected" ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason)) : null,
    });
  },

  apply(event) {
    if (!isRoutineEvent(event)) return;
    set({ version: get().version + 1 });
    // Ainda não carregou (ninguém abriu a Gestão nem o selo pediu): nada a atualizar.
    if (get().workspaceId === null) return;
    clearTimeout(timer);
    timer = setTimeout(() => void get().load(), ROUTINES_RELOAD_DELAY_MS);
  },

  reset() {
    clearTimeout(timer);
    set({ workspaceId: null, overview: null, summary: null, error: null });
  },
}));

/** Metas atrasadas (o selo da barra lateral). */
export const behindCount = (overview: RoutinesOverview | null): number => overview?.verdict.behind ?? 0;
