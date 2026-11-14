import { normalizeOpenRouterModelId, normalizeProgramModelRef, usageAgeLabel, type ModelPrice, type OpenRouterModel } from "@cyno/shared";

/**
 * A busca do seletor de modelos do OpenRouter (OpenClaw e Hermes), toda em funções puras: o componente só desenha.
 * Aguenta a lista inteira (centenas de modelos): a busca é uma passada só e o componente a memoriza.
 */

/** Quantos resultados aparecem de cada vez ("mostrar mais" soma outro tanto). */
export const PAGE_SIZE = 30;

export type PriceFilter = "all" | "free" | "paid";
export type ModelSort = "relevance" | "cheap" | "context" | "newest" | "name";
export type ModelFilters = { price: PriceFilter; tools: boolean; provider: string };

export const NO_FILTERS: ModelFilters = { price: "all", tools: false, provider: "" };

export const SORT_LABELS: Record<ModelSort, string> = { relevance: "Relevância", cheap: "Mais barato", context: "Maior contexto", newest: "Mais novo", name: "A–Z" };

/** Um caractere por caractere: minúscula, sem acento e separadores (`- _ . / : ~` e espaço) viram espaço. O tamanho não muda, então dá para marcar o trecho achado no texto original. */
export function fold(text: string): string {
  let out = "";
  for (const char of text) {
    const base = char.normalize("NFD")[0] ?? char;
    out += /[\s\-_./:~]/.test(base) ? " " : base.toLowerCase();
  }
  return out;
}

/** As palavras da busca (já sem acento, maiúscula e separadores). */
export const queryWords = (query: string): string[] => fold(query).split(" ").filter(Boolean);

/** Espaços repetidos viram um (só para comparar; o destaque usa o texto sem colapsar). */
const collapse = (folded: string) => folded.replace(/ +/g, " ").trim();
const compact = (folded: string) => folded.replaceAll(" ", "");

type Indexed = { model: OpenRouterModel; id: string; name: string; haystack: string; compact: string };

const indexCache = new WeakMap<readonly OpenRouterModel[], Indexed[]>();
function indexOf(models: readonly OpenRouterModel[]): Indexed[] {
  let index = indexCache.get(models);
  if (!index) {
    index = models.map((model) => {
      const id = collapse(fold(model.id));
      const name = collapse(fold(model.name));
      const haystack = `${id} ${name}`;
      return { model, id, name, haystack, compact: compact(haystack) };
    });
    indexCache.set(models, index);
  }
  return index;
}

/** Quanto menor, mais relevante: 0 id começa com o termo; 1 o nome do modelo (depois da barra) começa; 2 o id contém; 3 o nome contém; 4 todas as palavras no id; 5 as palavras no id e no nome. -1: não bate. */
function tier(entry: Indexed, phrase: string, words: string[]): number {
  const modelPart = entry.id.slice(entry.id.indexOf(" ") + 1);
  if (entry.id.startsWith(phrase)) return 0;
  if (modelPart.startsWith(phrase)) return 1;
  if (entry.id.includes(phrase)) return 2;
  if (entry.name.includes(phrase)) return 3;
  if (words.every((word) => entry.id.includes(word))) return 4;
  if (words.every((word) => entry.haystack.includes(word))) return 5;
  // "deepseekv4" acha "deepseek-v4": a busca sem separadores contra o texto sem separadores.
  if (entry.compact.includes(compact(phrase))) return 5;
  return -1;
}

const totalPrice = (price: ModelPrice) => (price.promptPerM ?? 0) + (price.completionPerM ?? 0);
const hasPrice = (price: ModelPrice) => price.free || price.promptPerM !== undefined || price.completionPerM !== undefined;

/** Passa nos filtros rápidos (Gratuitos/Pagos, Com ferramentas, provedor). `tools: false` na lista só some com o filtro ligado. */
export function passesFilters(model: OpenRouterModel, filters: ModelFilters): boolean {
  if (filters.price === "free" && !model.price.free) return false;
  if (filters.price === "paid" && model.price.free) return false;
  if (filters.tools && model.tools === false) return false;
  if (filters.provider && model.provider !== filters.provider) return false;
  return true;
}

export type SearchOptions = { query: string; filters?: ModelFilters; sort?: ModelSort };

/** Todos os modelos que batem, filtrados e ordenados (quem corta em N é o componente). Busca vazia + relevância = a ordem da lista. */
export function searchModels(models: readonly OpenRouterModel[], options: SearchOptions): OpenRouterModel[] {
  const filters = options.filters ?? NO_FILTERS;
  const sort = options.sort ?? "relevance";
  const words = queryWords(options.query);
  const phrase = words.join(" ");
  const hits: { model: OpenRouterModel; tier: number; position: number }[] = [];
  const entries = indexOf(models);
  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position]!;
    if (!passesFilters(entry.model, filters)) continue;
    const found = words.length === 0 ? 0 : tier(entry, phrase, words);
    if (found >= 0) hits.push({ model: entry.model, tier: found, position });
  }
  const byRelevance = (a: (typeof hits)[number], b: (typeof hits)[number]) => a.tier - b.tier || a.model.id.length - b.model.id.length || a.position - b.position;
  const name = (a: OpenRouterModel, b: OpenRouterModel) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const sorters: Record<ModelSort, (a: (typeof hits)[number], b: (typeof hits)[number]) => number> = {
    relevance: words.length === 0 ? (a, b) => a.position - b.position : byRelevance,
    // Gratuito primeiro (preço zero), depois o menor preço somado; sem preço lido, por último.
    cheap: (a, b) => Number(!hasPrice(a.model.price)) - Number(!hasPrice(b.model.price)) || totalPrice(a.model.price) - totalPrice(b.model.price) || byRelevance(a, b),
    context: (a, b) => (b.model.contextLength ?? -1) - (a.model.contextLength ?? -1) || byRelevance(a, b),
    newest: (a, b) => (b.model.created ?? -1) - (a.model.created ?? -1) || byRelevance(a, b),
    name: (a, b) => name(a.model, b.model),
  };
  return hits.sort(sorters[sort]).map((hit) => hit.model);
}

/** O trecho achado, para o destaque: partes do texto original, `hit: true` nas que casam com alguma palavra da busca. */
export function highlightParts(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  if (words.length === 0 || !text) return [{ text, hit: false }];
  const folded = fold(text);
  const marked = new Array<boolean>(text.length).fill(false);
  // `fold` não muda o tamanho de nenhum caractere comum; se mudar (caso raro), melhor sem destaque do que torto.
  if (folded.length !== text.length) return [{ text, hit: false }];
  for (const word of words) {
    for (let from = folded.indexOf(word); from >= 0; from = folded.indexOf(word, from + 1)) for (let i = from; i < from + word.length; i += 1) marked[i] = true;
  }
  // Um separador entre dois trechos achados ("v4" "." "1") entra no destaque, para "v4.1" não ficar picado.
  for (let i = 1; i < text.length - 1; i += 1) if (!marked[i] && folded[i] === " " && marked[i - 1] && marked[i + 1]) marked[i] = true;
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: marked[i]! });
  }
  return parts;
}

export type ProviderCount = { provider: string; count: number };

/** Os provedores com a contagem de modelos (do mais cheio ao menos; empate por nome). */
export function providerCounts(models: readonly OpenRouterModel[]): ProviderCount[] {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  return [...counts].map(([provider, count]) => ({ provider, count })).sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}

/** O filtro "Com ferramentas" nasce ligado quando a lista traz esse dado (os agentes do Cyno usam ferramentas MCP). */
export const defaultToolsFilter = (models: readonly OpenRouterModel[]): boolean => models.some((model) => model.tools !== undefined);

/** Os atalhos de antes, agora no topo da busca vazia: os gratuitos e a família DeepSeek (os mais novos primeiro), `limit` de cada. */
export function suggestionGroups(models: readonly OpenRouterModel[], filters: ModelFilters, limit = 4): { free: OpenRouterModel[]; deepseek: OpenRouterModel[] } {
  const pool = models.filter((model) => passesFilters(model, { ...filters, price: "all", provider: "" }));
  const newest = (a: OpenRouterModel, b: OpenRouterModel) => (b.created ?? 0) - (a.created ?? 0);
  return {
    free: pool.filter((model) => model.price.free && !model.id.startsWith("~")).sort(newest).slice(0, limit),
    deepseek: pool.filter((model) => model.provider === "deepseek" && !model.id.startsWith("~")).sort(newest).slice(0, limit),
  };
}

/** O que a linha "Usar ‘…’ como está" faz com o que foi digitado. */
export type TypedId = { state: "empty" } | { state: "invalid"; text: string } | { state: "listed"; id: string } | { state: "unlisted"; id: string };

export function typedId(query: string, models: readonly OpenRouterModel[], source: ModelSource = "openrouter"): TypedId {
  const text = query.trim();
  if (!text) return { state: "empty" };
  // Modelos do programa: `provedor/modelo` de qualquer provedor, sem mexer no prefixo (openrouter/…, openai/…, ollama/…).
  const id = source === "program" ? normalizeProgramModelRef(text) : normalizeOpenRouterModelId(text);
  if (!id) return { state: "invalid", text };
  return { state: models.some((model) => model.id === id) ? "listed" : "unlisted", id };
}

/** De onde vem a lista do seletor: o OpenRouter (chave do painel) ou os modelos do próprio programa. */
export type ModelSource = "openrouter" | "program";

/** Um modelo da lista do programa no formato do seletor (sem preço nem contexto: o programa não diz). */
export function programModelToPicker(model: { id: string; label?: string }): OpenRouterModel {
  const provider = model.id.split("/")[0] ?? "";
  return { id: model.id, name: model.label ?? model.id.slice(provider.length + 1), provider, price: { free: false } };
}

export const PROGRAM_INVALID_ID_HINT = "A referência tem o formato provedor/modelo (ex.: openai/gpt-5, ollama/llama3.2:3b, openrouter/deepseek/deepseek-v4-flash).";
export const PROGRAM_UNLISTED_HINT = "Este modelo não está na lista do programa: o “Verificar” confere se o provedor dele está ligado.";
export const INVALID_ID_HINT = "O id tem o formato provedor/modelo (ex.: deepseek/deepseek-v4-flash), com :sufixo opcional.";
export const UNLISTED_HINT = "Este id não está na lista lida: ele só é conferido no “Verificar”.";

// ---------- Textos ----------

const dollars = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 4 });

/** "gratuito" ou "US$ 0,09 / US$ 0,18 por milhão" (entrada / saída). */
export function priceBadge(price: ModelPrice): string {
  if (price.free) return "gratuito";
  if (price.promptPerM === undefined && price.completionPerM === undefined) return "preço não informado";
  const part = (value: number | undefined) => (value === undefined ? "?" : `US$ ${dollars(value)}`);
  return `${part(price.promptPerM)} / ${part(price.completionPerM)} por milhão`;
}

/** "128 mil tokens", "1 milhão de tokens", "1,5 milhão de tokens". */
export function contextLabel(tokens: number | undefined): string {
  if (!tokens) return "contexto não informado";
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions.toLocaleString("pt-BR")} ${millions <= 1 ? "milhão" : "milhões"} de tokens`;
  }
  return `${Math.round(tokens / 1000).toLocaleString("pt-BR")} mil tokens`;
}

/** "lista lida há 3 h" (ou o aviso certo quando ainda não foi lida). */
export function listStateLine(readAt: string | undefined, count: number, now: number): string {
  if (!readAt || count === 0) return "A lista de modelos ainda não foi lida.";
  const age = Math.max(0, Math.floor((now - Date.parse(readAt)) / 60_000));
  const when = Number.isFinite(age) ? usageAgeLabel(age) : "";
  return `${count.toLocaleString("pt-BR")} ${count === 1 ? "modelo" : "modelos"} · lista lida ${when}`.trim();
}

/** Os selos de uma linha: ferramentas, imagem e o aviso de quem não aceita ferramentas. */
export function modelBadges(model: OpenRouterModel): { label: string; tone: "ok" | "info" | "warn" }[] {
  const badges: { label: string; tone: "ok" | "info" | "warn" }[] = [];
  if (model.tools === true) badges.push({ label: "ferramentas", tone: "ok" });
  if (model.tools === false) badges.push({ label: "sem ferramentas", tone: "warn" });
  if (model.inputModalities?.includes("image")) badges.push({ label: "imagem", tone: "info" });
  if (model.id.startsWith("~")) badges.push({ label: "sempre o mais novo", tone: "info" });
  return badges;
}

export const NO_TOOLS_WARNING = "Este modelo não aceita ferramentas (segundo o OpenRouter), e os agentes do Cyno usam ferramentas para receber e entregar o trabalho.";
