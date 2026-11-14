import type { Card, CardMetrics } from "@cyno/shared";
import { METRICS_MIN_SAMPLES } from "@cyno/shared";

/**
 * O bloco "Gestão" da página do Cyno: uma linha por workspace com os números que a aba Gestão já calcula (`Card.metrics`, o mesmo
 * `computeMetrics` em modo leve). Funções puras, para testar sem tela.
 */

export type Trend = "up" | "down" | "flat";

/** Seta das entregas: só com 5 ou mais entregas nas duas semanas e uma diferença de pelo menos 10%. */
export function throughputTrend(metrics: Pick<CardMetrics, "throughput7d" | "throughputPrev7d">): Trend | undefined {
  const { throughput7d: now, throughputPrev7d: before } = metrics;
  if (now < METRICS_MIN_SAMPLES || before < METRICS_MIN_SAMPLES) return undefined;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.1) return "flat";
  return change > 0 ? "up" : "down";
}

export const TREND_ARROW: Record<Trend, string> = { up: "▲", down: "▼", flat: "→" };

/** "35 min", "9 h", "2 d": a espera, curta. */
export function shortAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** "US$ 6,40". */
export function usdLabel(value: number): string {
  return `US$ ${value.toFixed(2).replace(".", ",")}`;
}

export type GestaoRow = {
  workspace: string;
  name: string;
  /** Ainda sem números (a ficha ainda não calculou). */
  pending: boolean;
  deliveries: string;
  trend?: Trend;
  waiting: string;
  /** A espera passa de 24 h: a linha avisa. */
  waitingLate: boolean;
  blocked: string;
  atRisk: string;
  cost: string;
  quota?: string;
  /** Quanto pesa para ordenar: quem mais espera você primeiro. */
  rank: number;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A linha de um workspace. A idade do item mais antigo soma o tempo desde que a ficha foi calculada (ela só recalcula quando algo muda). */
export function gestaoRow(card: Card, now: Date): GestaoRow {
  const metrics = card.metrics;
  const base = { workspace: card.workspace, name: card.name };
  if (!metrics) return { ...base, pending: true, deliveries: "calculando…", waiting: "", waitingLate: false, blocked: "", atRisk: "", cost: "", rank: 0 };
  const trend = throughputTrend(metrics);
  const oldest = metrics.oldestWaitMs === null ? undefined : metrics.oldestWaitMs + Math.max(0, now.getTime() - Date.parse(card.updatedAt));
  return {
    ...base,
    pending: false,
    deliveries: `entregas 7 d: ${metrics.throughput7d}`,
    ...(trend ? { trend } : {}),
    waiting: metrics.waiting === 0 ? "nada esperando você" : `${plural(metrics.waiting, "esperando", "esperando")} você${oldest !== undefined ? ` (mais antigo há ${shortAge(oldest)})` : ""}`,
    waitingLate: oldest !== undefined && oldest > 24 * 3_600_000,
    blocked: metrics.blocked === 0 ? "nada travado" : plural(metrics.blocked, "travado", "travados"),
    atRisk: metrics.atRisk === 0 ? "prazos ok" : plural(metrics.atRisk, "prazo em risco", "prazos em risco"),
    cost: `${usdLabel(metrics.weekCostUsd)} na semana (equiv.)`,
    ...(card.usage.windowPercent !== undefined ? { quota: `cota ${card.usage.windowPercent}%` } : {}),
    rank: metrics.waiting * 1000 + metrics.blocked * 10 + metrics.atRisk,
  };
}

/** As linhas do bloco: quem mais espera você (e mais está travado) primeiro; empate pelo nome. */
export function gestaoRows(cards: readonly Card[], now: Date): GestaoRow[] {
  return cards.map((card) => gestaoRow(card, now)).sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, "pt-BR"));
}
