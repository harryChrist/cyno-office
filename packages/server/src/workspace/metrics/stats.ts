import { METRICS_MIN_SAMPLES, type MetricGroup, type MetricTrend, type MetricValue } from "@cyno/shared";

/** Posto mais próximo (sem interpolar): o menor valor com pelo menos `p` das amostras até ele. `p` de 0 a 1. */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length - 1e-9)));
  return sorted[rank - 1]!;
}

/** Mediana por posto mais próximo: em n par é a menor das duas do meio (sempre um valor que existe). */
export const median = (values: readonly number[]): number | null => nearestRank(values, 0.5);
export const p90 = (values: readonly number[]): number | null => nearestRank(values, 0.9);

export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** "poucos dados" (sem a contagem) ou undefined. */
export function fewDataNote(n: number): string | undefined {
  return n < METRICS_MIN_SAMPLES ? "poucos dados" : undefined;
}

/**
 * Seta contra o período anterior, só com amostras suficientes dos dois lados. Taxas (0 a 1) mudam em
 * pontos (10 pontos); o resto, em proporção (10%).
 */
export function trendOf(value: number | null, prev: number | null, n: number, prevN: number, kind: "rate" | "relative"): MetricTrend | undefined {
  if (value === null || prev === null || n < METRICS_MIN_SAMPLES || prevN < METRICS_MIN_SAMPLES) return undefined;
  const change = kind === "rate" ? value - prev : prev === 0 ? (value === 0 ? 0 : Number.POSITIVE_INFINITY) : (value - prev) / Math.abs(prev);
  if (Math.abs(change) < 0.1) return "flat";
  return change > 0 ? "up" : "down";
}

/** Monta o `MetricValue` (a nota e a seta seguem a regra de n < 5). */
export function metricValue(input: { value: number | null; n: number; prev: number | null; prevN: number; hits?: number; kind: "rate" | "relative" }): MetricValue {
  const note = fewDataNote(input.n);
  const trend = trendOf(input.value, input.prev, input.n, input.prevN, input.kind);
  return {
    value: input.value,
    n: input.n,
    prev: input.prev,
    prevN: input.prevN,
    ...(input.hits !== undefined ? { hits: input.hits } : {}),
    fewData: input.n < METRICS_MIN_SAMPLES,
    ...(note ? { note } : {}),
    ...(trend ? { trend } : {}),
  };
}

/** Uma taxa (`hits` de `n`). */
export function rateValue(hits: number, n: number, prevHits: number, prevN: number): MetricValue {
  return metricValue({ value: n > 0 ? hits / n : null, n, prev: prevN > 0 ? prevHits / prevN : null, prevN, hits, kind: "rate" });
}

/** Uma mediana de `values` contra a do período anterior. */
export function medianValue(values: readonly number[], prevValues: readonly number[]): MetricValue {
  return metricValue({ value: median(values), n: values.length, prev: median(prevValues), prevN: prevValues.length, kind: "relative" });
}

/** Agrupa por chave, na ordem em que as chaves aparecem. */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** Ordena os grupos: mais amostras primeiro, depois pelo nome (estável e sem depender de relógio). */
export function sortGroups<G extends Pick<MetricGroup, "n" | "label" | "key">>(list: G[]): G[] {
  return list.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "pt-BR") || a.key.localeCompare(b.key));
}
