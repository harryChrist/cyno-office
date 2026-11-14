import type { AgentProvider, UsagePriceInfo, UsageRecordTokens } from "@cyno/shared";
import { z } from "zod";
import rawTable from "./prices.json" with { type: "json" };

/**
 * Preço da API (USD por 1 milhão de tokens) de cada modelo que os agentes podem rodar: é o "quanto
 * custaria na API" da página Gastos (as assinaturas não cobram por token). A tabela fica em
 * prices.json, com a fonte oficial e a data em que foi conferida. Modelo fora da tabela = custo
 * null ("sem preço"), nunca um chute.
 */

const rateSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  /** Gravar no cache de 5 min / 1 h (Claude). Ausente = o preço da entrada (Gemini: cache implícito, sem custo de gravação). */
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
});

const periodSchema = rateSchema.extend({
  /** A partir de que dia (UTC, inclusive) este preço vale; ausente = desde sempre. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Modo rápido: entrada e saída (o cache acompanha na mesma proporção). */
  fast: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
  /** Preço por tamanho do prompt: uma chamada com mais de `overPromptTokens` paga estes. */
  long: rateSchema.extend({ overPromptTokens: z.number().int().positive() }).optional(),
});

const tableSchema = z.object({
  version: z.string(),
  verifiedAt: z.string(),
  sources: z.record(z.string(), z.string()),
  providers: z.record(z.string(), z.object({ webSearchUsdPer1000: z.number().nonnegative().optional(), defaultCacheWrite: z.enum(["5m", "1h"]).optional() })),
  aliases: z.record(z.string(), z.string()),
  models: z.record(z.string(), z.object({ provider: z.enum(["claude", "gemini"]), label: z.string(), prices: z.array(periodSchema).min(1) })),
});

export type PriceTable = z.infer<typeof tableSchema>;
type Period = z.infer<typeof periodSchema>;
type Rate = z.infer<typeof rateSchema>;

export function parsePriceTable(raw: unknown): PriceTable {
  return tableSchema.parse(raw);
}

/** A tabela embutida (prices.json), validada no carregamento. */
export const PRICE_TABLE: PriceTable = parsePriceTable(rawTable);

export function priceInfo(table: PriceTable = PRICE_TABLE): UsagePriceInfo {
  return { version: table.version, verifiedAt: table.verifiedAt, sources: Object.values(table.sources) };
}

/** Sufixos de esforço/raciocínio que as CLIs põem no nome do modelo (agy: gemini-3.8-flash-low). */
const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max|thinking)$/;

export type ResolvedModel = { id: string; label: string; provider: AgentProvider };

/**
 * Nome que a CLI relatou (ou o configurado) -> modelo da tabela. Aceita alias do Claude Code
 * ("opus"), `[1m]`, prefixo de nuvem (`anthropic.`), data (`-20251101`, `@20251101`) e o nível de
 * esforço no fim (`-low`, `-high`…). Desconhecido = undefined.
 */
export function resolveModel(model: string | undefined, table: PriceTable = PRICE_TABLE): ResolvedModel | undefined {
  if (!model) return undefined;
  let name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/^(anthropic|google|models)[./]/, "").replace(/@.*$/, "").replace(/-\d{8}$/, "");
  for (let i = 0; i < 3 && name; i += 1) {
    const id = table.models[name] ? name : table.aliases[name];
    const entry = id ? table.models[id] : undefined;
    if (id && entry) return { id, label: entry.label, provider: entry.provider };
    const shorter = name.replace(EFFORT_SUFFIX, "");
    if (shorter === name) break;
    name = shorter;
  }
  return undefined;
}

/** O preço que valia no dia do turno (UTC). */
function periodAt(periods: Period[], at: string): Period {
  const day = at.slice(0, 10);
  let chosen = periods[0]!;
  for (const period of periods) if (!period.from || period.from <= day) chosen = period;
  return chosen;
}

export type CostInput = {
  model?: string;
  at: string;
  tokens?: UsageRecordTokens;
  /** Tamanho do prompt de uma chamada isolada (faixa de preço por tamanho). */
  promptTokens?: number;
  speed?: "standard" | "fast";
  webSearches?: number;
};

export type CostByType = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearch: number };

/** Custo em USD (null = modelo sem preço ou turno sem tokens) e de onde ele vem. */
export type Cost = { usd: number | null; byType: CostByType; model?: ResolvedModel };

const ZERO: CostByType = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 };
const PER_TOKEN = 1 / 1_000_000;

/**
 * Custo equivalente na API de um turno: entrada, saída, cache lido e cache gravado (5 min e 1 h
 * pelo preço de cada um; o que a CLI não separou vai pelo padrão do provedor, 5 min no Claude) e
 * as buscas na web. Sem tokens ou modelo desconhecido = null.
 */
export function computeCost(input: CostInput, table: PriceTable = PRICE_TABLE): Cost {
  const model = resolveModel(input.model, table);
  const entry = model ? table.models[model.id] : undefined;
  if (!model || !entry || !input.tokens) return { usd: null, byType: { ...ZERO }, ...(model ? { model } : {}) };
  const period = periodAt(entry.prices, input.at);
  let rate: Rate = period;
  if (period.long && input.promptTokens !== undefined && input.promptTokens > period.long.overPromptTokens) rate = period.long;
  if (input.speed === "fast" && period.fast && rate.input > 0) {
    // Modo rápido: entrada/saída pelo preço dele; os multiplicadores de cache valem por cima.
    const ratio = period.fast.input / rate.input;
    rate = {
      input: period.fast.input,
      output: period.fast.output,
      cacheRead: rate.cacheRead * ratio,
      ...(rate.cacheWrite5m !== undefined ? { cacheWrite5m: rate.cacheWrite5m * ratio } : {}),
      ...(rate.cacheWrite1h !== undefined ? { cacheWrite1h: rate.cacheWrite1h * ratio } : {}),
    };
  }
  const provider = table.providers[model.provider] ?? {};
  const write5m = rate.cacheWrite5m ?? rate.input;
  const write1h = rate.cacheWrite1h ?? write5m;
  const tokens = input.tokens;
  const split5m = tokens.cacheCreation5m ?? 0;
  const split1h = tokens.cacheCreation1h ?? 0;
  const rest = Math.max(0, tokens.cacheCreation - split5m - split1h);
  const restRate = provider.defaultCacheWrite === "1h" ? write1h : write5m;
  const byType: CostByType = {
    input: tokens.input * rate.input * PER_TOKEN,
    output: tokens.output * rate.output * PER_TOKEN,
    cacheRead: tokens.cacheRead * rate.cacheRead * PER_TOKEN,
    cacheWrite: (split5m * write5m + split1h * write1h + rest * restRate) * PER_TOKEN,
    webSearch: ((input.webSearches ?? 0) * (provider.webSearchUsdPer1000 ?? 0)) / 1000,
  };
  const usd = byType.input + byType.output + byType.cacheRead + byType.cacheWrite + byType.webSearch;
  return { usd, byType, model };
}
