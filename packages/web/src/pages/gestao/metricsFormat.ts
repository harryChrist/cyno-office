import { METRICS_MIN_SAMPLES, type MetricTrend, type MetricValue } from "@cyno/shared";

/**
 * Como a Gestão escreve os números das métricas (Painel e Pessoas). Tudo puro, sem relógio: as regras do plano
 * ficam aqui, num lugar só. Regras: seta só com n >= 5 dos dois lados e mudança acima de 10 pontos; com n < 5
 * o número vira "—" e a tela diz quantos faltam; com menos de 3 entregas por semana, taxa vira contagem.
 */

export const NO_VALUE = "—";
/** Abaixo disto (entregas por semana) taxa vira contagem: "1 de 2", não "50%". */
export const LOW_WEEKLY_THROUGHPUT = 3;

const WEEK_MS = 7 * 86_400_000;

/** "12 min", "5 h 20 min", "1 d 3 h" (duração, sem "há"). */
export function formatSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return NO_VALUE;
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plainSpaces = (text: string): string => text.replace(/\s/g, " ");

/** "US$ 6,40"; abaixo de um centavo (e acima de zero): "< US$ 0,01". */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  if (value > 0 && value < 0.005) return `< ${plainSpaces(usd.format(0.01))}`;
  return plainSpaces(usd.format(value));
}

/** "12%" (a taxa vem de 0 a 1). */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? NO_VALUE : `${Math.round(rate * 100)}%`;
}

/** "3 entregas", "1 decisão": o plural simples do pt-BR. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "faltam 3 entregas para mostrar" (ou "falta 1 ..."); `unit` traz o singular e o plural. */
export function missingText(n: number, unit: { one: string; many: string }): string {
  const missing = Math.max(1, METRICS_MIN_SAMPLES - n);
  return `${missing === 1 ? "falta" : "faltam"} ${plural(missing, unit.one, unit.many)} para mostrar`;
}

export type Arrow = { dir: "up" | "down"; glyph: "▲" | "▼"; text: string };

/**
 * A seta de um indicador contra o período anterior: só com n >= 5 nos dois períodos e uma mudança que passou de
 * 10 pontos (o servidor decide a mudança em `trend`; aqui só se confere de novo e se esconde o "igual").
 * `text` descreve a mudança com palavras, para o `title` e para leitores de tela.
 */
export function arrowOf(metric: Pick<MetricValue, "n" | "prevN" | "trend" | "value" | "prev">, describe: (value: number, prev: number) => string): Arrow | null {
  const trend: MetricTrend | undefined = metric.trend;
  if (trend === undefined || trend === "flat") return null;
  if (metric.n < METRICS_MIN_SAMPLES || metric.prevN < METRICS_MIN_SAMPLES) return null;
  if (metric.value === null || metric.prev === null) return null;
  return { dir: trend, glyph: trend === "up" ? "▲" : "▼", text: describe(metric.value, metric.prev) };
}

/** Descreve uma taxa que mudou: "era 12%, agora 25%". */
export const rateChange = (value: number, prev: number): string => `era ${formatRate(prev)}, agora ${formatRate(value)}`;

/** Entregas por semana na janela (a janela das taxas pode ter 7 ou 28 dias). */
export function weeklyThroughput(deliveries: number, window: { from: string; to: string }): number {
  const span = Date.parse(window.to) - Date.parse(window.from);
  if (!Number.isFinite(span) || span <= 0) return deliveries;
  return deliveries / Math.max(1, span / WEEK_MS);
}

/** Entregas de menos: taxas viram contagens. */
export const isLowThroughput = (perWeek: number): boolean => perWeek < LOW_WEEKLY_THROUGHPUT;

export type RateCell = {
  /** O que vai na célula: "12%", "1 de 2" ou "—". */
  text: string;
  /** Linha de baixo (só quando falta amostra): "faltam 3 decisões para mostrar". */
  note?: string;
  arrow: Arrow | null;
  /** O número existe (não é "—"). */
  known: boolean;
  /** Para ordenar: a taxa de 0 a 1, ou null quando não há. */
  sort: number | null;
};

/**
 * Uma taxa pronta para a tela. Com pouca entrega na semana mostra a contagem (`hits de n`), que não finge
 * precisão; senão, com n < 5, "—" e quantos faltam; senão, a porcentagem (com seta, se houver).
 */
export function rateCell(metric: Pick<MetricValue, "value" | "n" | "prev" | "prevN" | "hits" | "trend">, options: { lowVolume: boolean; unit: { one: string; many: string } }): RateCell {
  if (metric.n === 0) return { text: NO_VALUE, note: `sem ${options.unit.many} no período`, arrow: null, known: false, sort: null };
  if (options.lowVolume) return { text: `${metric.hits ?? 0} de ${metric.n}`, arrow: null, known: true, sort: metric.value };
  if (metric.n < METRICS_MIN_SAMPLES || metric.value === null) return { text: NO_VALUE, note: missingText(metric.n, options.unit), arrow: null, known: false, sort: null };
  return { text: formatRate(metric.value), arrow: arrowOf(metric, rateChange), known: true, sort: metric.value };
}
