import { USAGE_HISTORY_TIMEZONE, type UsageHistoryGroup, type UsageTotals } from "@cyno/shared";

/**
 * Contas da página Gastos (funções puras): períodos (dia, semana começando na segunda, mês) no fuso
 * de São Paulo, o intervalo do gráfico, dinheiro em BRL/USD e as dicas de onde dá para economizar.
 */

export type SpendUnit = "day" | "week" | "month";
export type Currency = "BRL" | "USD";

export const UNIT_LABELS: Record<SpendUnit, string> = { day: "Dia", week: "Semana", month: "Mês" };
/** Quantas barras o gráfico mostra (terminando no período escolhido). */
export const CHART_BARS: Record<SpendUnit, number> = { day: 14, week: 12, month: 12 };

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" de hoje em São Paulo. */
export function todayKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: USAGE_HISTORY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const toUtc = (day: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date));
};
const fromUtc = (at: Date) => `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;

export function addDays(day: string, days: number): string {
  const at = toUtc(day);
  at.setUTCDate(at.getUTCDate() + days);
  return fromUtc(at);
}

/** Segunda-feira da semana do dia. */
export function mondayOf(day: string): string {
  return addDays(day, -((toUtc(day).getUTCDay() + 6) % 7));
}

/** Primeiro e último dia (inclusive) do período que contém `day`. */
export function periodRange(day: string, unit: SpendUnit): { from: string; to: string } {
  if (unit === "day") return { from: day, to: day };
  if (unit === "week") {
    const monday = mondayOf(day);
    return { from: monday, to: addDays(monday, 6) };
  }
  const first = `${day.slice(0, 7)}-01`;
  const next = shiftPeriod(first, "month", 1);
  return { from: first, to: addDays(next, -1) };
}

/** O mesmo período `n` unidades para frente (n > 0) ou para trás. Mês: vai para o dia 1. */
export function shiftPeriod(day: string, unit: SpendUnit, n: number): string {
  if (unit === "day") return addDays(day, n);
  if (unit === "week") return addDays(mondayOf(day), 7 * n);
  const [year, month] = day.split("-").map(Number) as [number, number];
  const at = new Date(Date.UTC(year, month - 1 + n, 1));
  return fromUtc(at);
}

/** O intervalo do gráfico: as últimas CHART_BARS unidades, terminando no período escolhido. */
export function chartRange(day: string, unit: SpendUnit): { from: string; to: string } {
  const end = periodRange(day, unit).to;
  const start = periodRange(shiftPeriod(day, unit, -(CHART_BARS[unit] - 1)), unit).from;
  return { from: start, to: end };
}

/** A chave do período (como o server agrupa): o dia, a segunda da semana ou "YYYY-MM". */
export function periodKey(day: string, unit: SpendUnit): string {
  if (unit === "day") return day;
  if (unit === "week") return mondayOf(day);
  return day.slice(0, 7);
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const short = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Título do período: "terça, 10/11/2026", "03/11 – 09/11/2026", "novembro de 2026". */
export function periodTitle(day: string, unit: SpendUnit): string {
  const year = day.slice(0, 4);
  if (unit === "day") return `${WEEKDAYS[toUtc(day).getUTCDay()]}, ${short(day)}/${year}`;
  if (unit === "week") {
    const { from, to } = periodRange(day, unit);
    return `${short(from)} – ${short(to)}/${to.slice(0, 4)}`;
  }
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} de ${year}`;
}

/** Rótulo curto de uma barra a partir da chave do grupo. */
export function barLabel(key: string, unit: SpendUnit): string {
  if (unit === "month") return `${MONTHS[Number(key.slice(5, 7)) - 1]!.slice(0, 3)}`;
  return short(key);
}

/** Valor em USD na moeda pedida. */
export function inCurrency(usd: number, currency: Currency, usdBrl: number): number {
  return currency === "BRL" ? usd * usdBrl : usd;
}

const moneyFormats = new Map<string, Intl.NumberFormat>();
function moneyFormat(currency: Currency, digits: number): Intl.NumberFormat {
  const key = `${currency}:${digits}`;
  let found = moneyFormats.get(key);
  if (!found) {
    found = new Intl.NumberFormat("pt-BR", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    moneyFormats.set(key, found);
  }
  return found;
}

/** "R$ 12,34" / "US$ 2,24"; abaixo de um centavo (e acima de zero): "< R$ 0,01". */
export function formatMoney(value: number, currency: Currency): string {
  if (value > 0 && value < 0.005) return `< ${moneyFormat(currency, 2).format(0.01)}`;
  return moneyFormat(currency, 2).format(value);
}

/** "1,2 mi", "345 mil", "980". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} bi`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000).toLocaleString("pt-BR")} mil`;
  return tokens.toLocaleString("pt-BR");
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

/** Cotação no campo: "5,51". */
export function formatRate(rate: number): string {
  return rate.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** "5,51" ou "5.51" -> 5.51 (inválido = null). */
export function parseRate(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, "").replace(/^R\$/i, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0.01 && value <= 1000 ? value : null;
}

/** As séries do gráfico: as 7 de maior custo no intervalo têm cor própria; o resto vira "Outros". */
export const SERIES_SLOTS = 7;
export const OTHER_KEY = "_outros";

export type Series = { key: string; label: string; slot: number };

/** Ordem fixa das séries no intervalo do gráfico (a cor acompanha a série, não a posição na barra). */
export function chartSeries(groups: readonly UsageHistoryGroup[]): Series[] {
  const totals = new Map<string, { label: string; cost: number; tokens: number }>();
  for (const group of groups) {
    for (const part of group.stack ?? []) {
      const found = totals.get(part.key) ?? { label: part.label, cost: 0, tokens: 0 };
      found.cost += part.costUsd;
      found.tokens += part.totalTokens;
      totals.set(part.key, found);
    }
  }
  const ordered = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]));
  const series = ordered.slice(0, SERIES_SLOTS).map(([key, value], index) => ({ key, label: value.label, slot: index + 1 }));
  if (ordered.length > SERIES_SLOTS) series.push({ key: OTHER_KEY, label: "Outros", slot: 0 });
  return series;
}

export type BarSegment = { key: string; label: string; slot: number; value: number };

/** Os segmentos de uma barra (na ordem das séries), em USD. As séries fora do top viram "Outros". */
export function barSegments(group: UsageHistoryGroup, series: readonly Series[]): BarSegment[] {
  const known = new Map(series.map((item) => [item.key, item]));
  const values = new Map<string, number>();
  for (const part of group.stack ?? []) {
    const key = known.has(part.key) ? part.key : OTHER_KEY;
    values.set(key, (values.get(key) ?? 0) + part.costUsd);
  }
  return series.filter((item) => (values.get(item.key) ?? 0) > 0).map((item) => ({ key: item.key, label: item.label, slot: item.slot, value: values.get(item.key) ?? 0 }));
}

/** Topo "redondo" do eixo e as linhas de grade (0, 1/2, 1). */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

export type CostShare = { key: keyof UsageTotals["costByType"]; label: string; usd: number; share: number };

const COST_LABELS: Record<keyof UsageTotals["costByType"], string> = {
  input: "Entrada",
  output: "Saída (resposta e raciocínio)",
  cacheRead: "Cache lido",
  cacheWrite: "Cache gravado",
  webSearch: "Buscas na web",
};

/** De onde vem o custo do período, maior primeiro (só o que tem valor). */
export function costShares(totals: UsageTotals): CostShare[] {
  const total = totals.costUsd;
  return (Object.keys(COST_LABELS) as (keyof UsageTotals["costByType"])[])
    .map((key) => ({ key, label: COST_LABELS[key], usd: totals.costByType[key], share: total > 0 ? totals.costByType[key] / total : 0 }))
    .filter((item) => item.usd > 0)
    .sort((a, b) => b.usd - a.usd);
}

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * Onde dá para melhorar, a partir dos números do período (no máximo 4 dicas, a mais forte primeiro).
 * `agents`/`models`: os rankings do período (maior custo primeiro).
 */
export function spendInsights(totals: UsageTotals, agents: readonly UsageHistoryGroup[], models: readonly UsageHistoryGroup[]): string[] {
  const tips: { weight: number; text: string }[] = [];
  const cost = totals.costUsd;
  if (cost > 0) {
    const write = totals.costByType.cacheWrite / cost;
    if (write >= 0.3) {
      tips.push({
        weight: write,
        text: `Gravar no cache é ${pct(write)} do custo. Cada conversa nova (ou o cache que expirou) grava de novo as instruções e o contexto inteiros — o cache de 1 h custa 2× a entrada. Instruções mais curtas e menos conversas novas por tarefa reduzem isso.`,
      });
    }
    const output = totals.costByType.output / cost;
    if (output >= 0.35) {
      tips.push({ weight: output, text: `A saída (respostas e raciocínio) é ${pct(output)} do custo. Para tarefas simples, um esforço menor no agente corta o raciocínio longo.` });
    }
    const topModel = models[0];
    if (topModel && models.length > 0 && topModel.totals.costUsd / cost >= 0.5) {
      const share = topModel.totals.costUsd / cost;
      const premium = /opus|fable|mythos/i.test(topModel.label);
      tips.push({
        weight: share * 0.9,
        text: premium
          ? `${topModel.label} responde por ${pct(share)} do custo. Tarefas rotineiras podem rodar num modelo mais barato (o Sonnet custa metade).`
          : `${topModel.label} responde por ${pct(share)} do custo do período.`,
      });
    }
    const topAgent = agents[0];
    if (topAgent && agents.length > 1 && topAgent.totals.costUsd / cost >= 0.5) {
      const share = topAgent.totals.costUsd / cost;
      tips.push({ weight: share * 0.8, text: `${topAgent.label} gastou ${pct(share)} do período: vale olhar as tarefas dele abaixo.` });
    }
  }
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  if (totals.cacheHitRatio !== null && prompt >= 100_000 && totals.cacheHitRatio < 0.6) {
    tips.push({ weight: 0.6 - totals.cacheHitRatio, text: `Só ${pct(totals.cacheHitRatio)} da entrada veio do cache (o cache lido custa bem menos). Conversas que continuam na mesma sessão aproveitam mais o cache.` });
  }
  if (totals.unpricedTurns > 0) {
    tips.push({ weight: 0.05, text: `${totals.unpricedTurns} ${totals.unpricedTurns === 1 ? "turno de modelo sem preço na tabela ficou" : "turnos de modelos sem preço na tabela ficaram"} fora do custo ("sem preço").` });
  }
  if (totals.unmeasuredTurns > 0) {
    tips.push({ weight: 0.04, text: `${totals.unmeasuredTurns} ${totals.unmeasuredTurns === 1 ? "turno veio" : "turnos vieram"} sem contagem de tokens (a CLI não informou): contam como turno, sem custo.` });
  }
  return tips
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((tip) => tip.text);
}
