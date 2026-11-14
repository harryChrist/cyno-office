import { DAY_STATS_PATH, WORKSPACE_DAY_STATS_PATH, type DayStats, type DayStatsDaysResponse, type PlatformDayStats, type ServerEvent } from "@cyno/shared";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { describeError, requestJson } from "../api/client";
import { useNavStore } from "./navStore";

/**
 * "Meu dia": a tela lê a diária do servidor (`GET /api/w/:ws/day-stats`) e só recarrega quando algo que muda o dia
 * acontece (uma aprovação decidida, uma tarefa concluída), com um atraso de 1 segundo para juntar a rajada. Sem polling.
 */

/** Eventos do workspace que mudam os números do dia. */
export function isDayEvent(event: ServerEvent): boolean {
  switch (event.type) {
    case "foryou:upserted":
    case "foryou:deleted":
    case "project:upserted":
      return true;
    case "task:upserted":
      return event.task.status === "done" || event.task.status === "failed";
    default:
      return false;
  }
}

/** Junta uma rajada de eventos numa só busca. */
export const DAY_RELOAD_DELAY_MS = 1000;

type DayStatsStore = {
  /** Sobe a cada evento que muda o dia (a tela de hoje recarrega quando muda). */
  version: number;
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useDayStatsStore = create<DayStatsStore>()((set) => ({
  version: 0,
  apply(event) {
    if (watchers === 0 || !isDayEvent(event)) return;
    clearTimeout(timer);
    timer = setTimeout(() => set((state) => ({ version: state.version + 1 })), DAY_RELOAD_DELAY_MS);
  },
  reset() {
    clearTimeout(timer);
  },
}));

const wsBase = (): string => {
  const id = useNavStore.getState().workspaceId;
  if (!id) throw new Error("Nenhum workspace selecionado");
  return `/api/w/${encodeURIComponent(id)}`;
};

export const dayStatsApi = {
  day: (day: string) => requestJson<DayStats>(`${wsBase()}${WORKSPACE_DAY_STATS_PATH}?day=${encodeURIComponent(day)}`),
  days: () => requestJson<DayStatsDaysResponse>(`${wsBase()}${WORKSPACE_DAY_STATS_PATH}/days`),
  platform: (day: string) => requestJson<PlatformDayStats>(`${DAY_STATS_PATH}?day=${encodeURIComponent(day)}`),
};

export type DayLoad = { stats: DayStats | null; days: DayStatsDaysResponse | null; error: string | null; loading: boolean; reload: () => void };

/**
 * O dia pedido. `live` (o dia de hoje com a aba aberta) recarrega, 1 s depois, quando chega um evento que muda o dia.
 * Trocar de dia mantém o anterior na tela até o novo chegar (sem piscar); resposta fora de ordem é descartada.
 */
export function useDayStats(day: string, live: boolean, workspaceId: string | null): DayLoad {
  const [stats, setStats] = useState<DayStats | null>(null);
  const [days, setDays] = useState<DayStatsDaysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const version = useDayStatsStore((state) => state.version);
  const refresh = live ? version : 0;

  // Trocou de workspace: zera o que estava na tela (ajuste de estado na renderização, sem efeito).
  const [workspaceVisto, setWorkspaceVisto] = useState(workspaceId);
  if (workspaceId !== workspaceVisto) {
    setWorkspaceVisto(workspaceId);
    setStats(null);
    setDays(null);
  }
  // Pedido novo (outro dia, workspace, recarga ou evento): volta a "carregando" enquanto a resposta não chega.
  const pedido = `${day}|${workspaceId ?? ""}|${tick}|${refresh}`;
  const [pedidoVisto, setPedidoVisto] = useState(pedido);
  if (pedido !== pedidoVisto) {
    setPedidoVisto(pedido);
    if (workspaceId) setLoading(true);
  }

  useEffect(() => {
    if (!live) return;
    watchers += 1;
    return () => {
      watchers -= 1;
    };
  }, [live]);

  useEffect(() => {
    if (!workspaceId) return;
    let stale = false;
    dayStatsApi
      .day(day)
      .then((next) => {
        if (stale) return;
        setStats(next);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!stale) setError(describeError(failure));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [day, workspaceId, tick, refresh]);

  useEffect(() => {
    if (!workspaceId) return;
    let stale = false;
    dayStatsApi
      .days()
      .then((next) => {
        if (!stale) setDays(next);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [workspaceId, tick, refresh]);

  return { stats, days, error, loading, reload: () => setTick((value) => value + 1) };
}

/** A linha "Esperando você" do Hoje (um workspace) e do Cyno (todos): carrega hoje, de novo quando o dia muda e a cada minuto (a espera aberta cresce). */
export function useWaitedToday(scope: "workspace" | "platform", today: string): { stats: DayStats | PlatformDayStats | null; error: string | null } {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const [stats, setStats] = useState<DayStats | PlatformDayStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useDayStatsStore((state) => state.version);
  useEffect(() => {
    watchers += 1;
    return () => {
      watchers -= 1;
    };
  }, []);
  useEffect(() => {
    if (scope === "workspace" && !workspaceId) return;
    let stale = false;
    const load = () => {
      const request = scope === "workspace" ? dayStatsApi.day(today) : dayStatsApi.platform(today);
      request
        .then((next) => {
          if (stale) return;
          setStats(next);
          setError(null);
        })
        .catch((failure: unknown) => {
          if (!stale) setError(describeError(failure));
        });
    };
    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      stale = true;
      window.clearInterval(interval);
    };
  }, [scope, workspaceId, today, version]);
  return { stats, error };
}
