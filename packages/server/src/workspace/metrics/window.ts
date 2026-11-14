import { addDays, dayStart, DAY_MS, METRICS_MEDIAN_DAYS, parseDayQuery, periodBounds, periodBoundsFor } from "@cyno/shared";

/** Janela pedida (ms, fim exclusivo); vazia = o padrão (7 dias para taxas, 28 para medianas). */
export type RequestedWindow = { from?: number; to?: number };

/** Janela maior que isto é recusada (400). É o tamanho máximo da janela, não até onde se pode olhar para trás (isso são os 90 dias da retenção do dia, `DAY_STATS_RETENTION_DAYS`). */
export const METRICS_MAX_DAYS = 60;

/**
 * `?from=AAAA-MM-DD&to=AAAA-MM-DD` (dias de São Paulo, `to` inclusivo) -> janela em ms. Só `from`: vai até agora;
 * só `to`: 28 dias até o fim dele. Dia mal escrito, no futuro, `from` depois de `to` ou janela de mais de 60 dias: 400; dia além dos 90 dias guardados: 404.
 */
export function windowFromDays(input: { from?: unknown; to?: unknown }, now: number): { ok: true; window: RequestedWindow } | { ok: false; status: 400 | 404; error: string } {
  if ((input.from === undefined || input.from === "") && (input.to === undefined || input.to === "")) return { ok: true, window: {} };
  const from = parseDayQuery(input.from === "" ? undefined : input.from, now);
  const to = parseDayQuery(input.to === "" ? undefined : input.to, now);
  if (!from.ok) return from;
  if (!to.ok) return to;
  const hasFrom = input.from !== undefined && input.from !== "";
  const end = Math.min(now, dayStart(addDays(to.day, 1)));
  const start = hasFrom ? dayStart(from.day) : end - METRICS_MEDIAN_DAYS * DAY_MS;
  if (start >= end) return { ok: false, status: 400, error: "`from` depois de `to`" };
  if (end - start > METRICS_MAX_DAYS * DAY_MS) return { ok: false, status: 400, error: `Janela grande demais (máximo ${METRICS_MAX_DAYS} dias)` };
  return { ok: true, window: { from: start, to: end } };
}

export const METRICS_WINDOWS = ["7d", "28d", "week", "month"] as const;
export type MetricsWindowPreset = (typeof METRICS_WINDOWS)[number];

/** Atalhos do `get_metrics`: 7 ou 28 dias até agora, a semana ou o mês de São Paulo até agora. */
export function windowFromPreset(preset: MetricsWindowPreset, now: number): RequestedWindow {
  if (preset === "7d") return { from: now - 7 * DAY_MS, to: now };
  if (preset === "28d") return { from: now - 28 * DAY_MS, to: now };
  const start = preset === "week" ? periodBounds(new Date(now)).start : periodBoundsFor(new Date(now), "month").start;
  return { from: start.getTime(), to: now };
}
