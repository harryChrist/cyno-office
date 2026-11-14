import { addDays, dayKeyOf, WORKSPACE_METRICS_PATH, type MetricsReport } from "@cyno/shared";
import { useCallback, useEffect, useState } from "react";
import { describeError, requestJson } from "../../api/client";
import { useDayStatsStore } from "../../store/dayStatsStore";

/** Quantos dias a aba Pessoas olha (4 semanas: o número de cada agente fica em n suficiente para ter taxa). */
export const PEOPLE_WINDOW_DAYS = 28;

/** O pedido das métricas: sem janela = o padrão do servidor (7 dias para taxas, 28 para medianas); `days` = os últimos N dias. */
export function metricsPath(workspaceId: string, days?: number, now: number = Date.now()): string {
  const base = `/api/w/${encodeURIComponent(workspaceId)}${WORKSPACE_METRICS_PATH}`;
  if (days === undefined) return base;
  const today = dayKeyOf(now);
  return `${base}?from=${addDays(today, -(days - 1))}&to=${today}`;
}

export const metricsApi = {
  get: (workspaceId: string, days?: number) => requestJson<MetricsReport>(metricsPath(workspaceId, days)),
};

/** O servidor recalcula a cada pedido; a tela repete a cada minuto e quando chega um evento que muda o dia. */
export const METRICS_REFRESH_MS = 60_000;

export type MetricsLoad = { report: MetricsReport | null; error: string | null; loading: boolean; reload: () => void };

/** As métricas do workspace (`days` vazio = a janela padrão do Painel). Trocar de workspace zera; resposta fora de ordem é descartada. */
export function useMetrics(workspaceId: string | null, days?: number): MetricsLoad {
  const [report, setReport] = useState<MetricsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const version = useDayStatsStore((state) => state.version);

  const [visto, setVisto] = useState(`${workspaceId ?? ""}|${days ?? ""}`);
  const chave = `${workspaceId ?? ""}|${days ?? ""}`;
  if (chave !== visto) {
    setVisto(chave);
    setReport(null);
    setError(null);
    setLoading(true);
  }

  useEffect(() => {
    if (!workspaceId) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), METRICS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let stale = false;
    metricsApi
      .get(workspaceId, days)
      .then((next) => {
        if (stale) return;
        setReport(next);
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
  }, [workspaceId, days, tick, version]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { report, error, loading, reload };
}
