import type { OpenRouterModel } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  contextLabel,
  defaultToolsFilter,
  fold,
  highlightParts,
  listStateLine,
  modelBadges,
  NO_FILTERS,
  PAGE_SIZE,
  priceBadge,
  providerCounts,
  queryWords,
  searchModels,
  suggestionGroups,
  typedId,
  programModelToPicker,
} from "./modelSearch";

const model = (id: string, name: string, over: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
  id,
  name,
  provider: id.split("/")[0]!.replace(/^~/, ""),
  contextLength: 128_000,
  price: { free: false, promptPerM: 1, completionPerM: 2 },
  tools: true,
  created: 1_700_000_000,
  ...over,
});

const LIST: OpenRouterModel[] = [
  model("deepseek/deepseek-v4-flash", "DeepSeek: DeepSeek V4 Flash", { price: { free: false, promptPerM: 0.09, completionPerM: 0.18 }, contextLength: 1_000_000, created: 1_790_000_000 }),
  model("deepseek/deepseek-v4.1-flash-1017", "DeepSeek: DeepSeek V4.1 Flash 1017", { price: { free: false, promptPerM: 0.15, completionPerM: 0.6 }, contextLength: 1_048_576, created: 1_792_000_000, inputModalities: ["text", "image"] }),
  model("deepseek/deepseek-pro", "DeepSeek: DeepSeek Pro", { price: { free: false, promptPerM: 2, completionPerM: 8 }, contextLength: 200_000, created: 1_780_000_000 }),
  model("~deepseek/deepseek-flash-latest", "DeepSeek Flash (último)", { price: { free: false, promptPerM: 0.09, completionPerM: 0.18 } }),
  model("google/gemini-flash:free", "Google: Gemini Flash (free)", { price: { free: true, promptPerM: 0, completionPerM: 0 }, contextLength: 64_000, created: 1_785_000_000, tools: false }),
  model("qwen/qwen3-coder:free", "Qwen: Qwen3 Coder (free)", { price: { free: true, promptPerM: 0, completionPerM: 0 }, contextLength: 262_000, created: 1_786_000_000 }),
  model("meta-llama/llama-3.3-70b", "Meta: Llama 3.3 70B", { price: { free: false, promptPerM: 0.1, completionPerM: 0.3 }, contextLength: 131_072, created: 1_740_000_000 }),
  model("mistralai/flash-mistral", "Mistral: Flash Mistral", { price: { free: false } }),
  model("acme/sem-dados", "Acme: Sem Dados", { contextLength: undefined, created: undefined, tools: undefined, price: { free: false } }),
  model("openrouter/auto", "Auto Router", { price: { free: false } }),
];
const ids = (list: OpenRouterModel[]) => list.map((item) => item.id);

describe("fold e as palavras da busca", () => {
  it("tira maiúscula e acento e trata separadores como espaço", () => {
    expect(fold("DeepSeek-V4.1_Flash/Çã:free")).toBe("deepseek v4 1 flash ca free");
    expect(fold("São Paulo").length).toBe("São Paulo".length);
    expect(queryWords("  deepseek-v4.1  ")).toEqual(["deepseek", "v4", "1"]);
    expect(queryWords("   ")).toEqual([]);
  });
});

describe("a busca (função pura)", () => {
  it("sem termo e com relevância, devolve a lista inteira na ordem original", () => {
    expect(ids(searchModels(LIST, { query: "" }))).toEqual(ids(LIST));
    expect(ids(searchModels(LIST, { query: "   " }))).toEqual(ids(LIST));
  });

  it("acha por id, nome e provedor, sem diferenciar maiúscula nem acento", () => {
    expect(ids(searchModels(LIST, { query: "LLAMA" }))).toEqual(["meta-llama/llama-3.3-70b"]);
    expect(ids(searchModels(LIST, { query: "Último" }))).toEqual(["~deepseek/deepseek-flash-latest"]);
    expect(ids(searchModels(LIST, { query: "mistralai" }))).toEqual(["mistralai/flash-mistral"]);
    expect(ids(searchModels(LIST, { query: "Sem Dádos" }))).toEqual(["acme/sem-dados"]);
  });

  it("várias palavras em qualquer ordem dão o mesmo conjunto", () => {
    const a = ids(searchModels(LIST, { query: "deepseek flash" }));
    const b = ids(searchModels(LIST, { query: "flash deepseek" }));
    expect([...a].sort()).toEqual([...b].sort());
    expect(a).toContain("deepseek/deepseek-v4-flash");
    expect(a).not.toContain("deepseek/deepseek-pro");
    expect(a).not.toContain("google/gemini-flash:free");
  });

  it("tolera separadores: deepseek-v4.1, deepseek v4 1 e deepseekv4 acham o mesmo modelo", () => {
    for (const query of ["deepseek-v4.1", "deepseek v4 1", "DEEPSEEK_V4.1", "v4.1 flash"]) expect(ids(searchModels(LIST, { query }))[0], query).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(ids(searchModels(LIST, { query: "deepseekv4" }))).toContain("deepseek/deepseek-v4-flash");
  });

  it("ordena por relevância: id que começa com o termo, depois o nome da família, depois nome que contém, depois o resto", () => {
    const hits = ids(searchModels(LIST, { query: "flash" }));
    // "mistralai/flash-mistral": o modelo (depois da barra) começa com flash; os deepseek/google só têm flash no meio do id.
    expect(hits[0]).toBe("mistralai/flash-mistral");
    expect(hits.slice(1).sort()).toEqual(["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4.1-flash-1017", "google/gemini-flash:free", "~deepseek/deepseek-flash-latest"].sort());
    expect(ids(searchModels(LIST, { query: "deepseek" }))[0]).toMatch(/^deepseek\//);
    // O id que começa com o termo vem antes do que só tem o termo no nome.
    const mixed = [model("zeta/outro", "Algo com deepseek no nome"), model("deepseek/primeiro", "Primeiro")];
    expect(ids(searchModels(mixed, { query: "deepseek" }))).toEqual(["deepseek/primeiro", "zeta/outro"]);
  });

  it("filtros combinados: gratuitos, pagos, ferramentas e provedor", () => {
    expect(ids(searchModels(LIST, { query: "", filters: { ...NO_FILTERS, price: "free" } }))).toEqual(["google/gemini-flash:free", "qwen/qwen3-coder:free"]);
    expect(ids(searchModels(LIST, { query: "", filters: { ...NO_FILTERS, price: "free", tools: true } }))).toEqual(["qwen/qwen3-coder:free"]);
    expect(ids(searchModels(LIST, { query: "flash", filters: { price: "paid", tools: true, provider: "deepseek" } })).sort()).toEqual(["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4.1-flash-1017", "~deepseek/deepseek-flash-latest"].sort());
    // "Com ferramentas" não tira quem a rota não informou (tools ausente).
    expect(ids(searchModels(LIST, { query: "sem dados", filters: { ...NO_FILTERS, tools: true } }))).toEqual(["acme/sem-dados"]);
    expect(searchModels(LIST, { query: "", filters: { ...NO_FILTERS, provider: "inexistente" } })).toEqual([]);
  });

  it("ordenações: mais barato, maior contexto, mais novo e A–Z (sem dado vai para o fim)", () => {
    const all = (sort: Parameters<typeof searchModels>[1]["sort"]) => ids(searchModels(LIST, { query: "", sort }));
    const cheap = all("cheap");
    expect(cheap.slice(0, 2).sort()).toEqual(["google/gemini-flash:free", "qwen/qwen3-coder:free"]);
    expect(cheap.indexOf("deepseek/deepseek-v4-flash")).toBeLessThan(cheap.indexOf("deepseek/deepseek-pro"));
    expect(cheap.slice(-3).sort()).toEqual(["acme/sem-dados", "mistralai/flash-mistral", "openrouter/auto"]);
    const context = all("context");
    expect(context.slice(0, 3)).toEqual(["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4-flash", "qwen/qwen3-coder:free"]);
    expect(context[context.length - 1]).not.toBe("deepseek/deepseek-v4-flash");
    expect(context.indexOf("acme/sem-dados")).toBeGreaterThan(context.indexOf("meta-llama/llama-3.3-70b"));
    const newest = all("newest");
    expect(newest.slice(0, 3)).toEqual(["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4-flash", "qwen/qwen3-coder:free"]);
    expect(newest[newest.length - 1]).toBe("acme/sem-dados");
    const name = all("name");
    expect(name[0]).toBe("acme/sem-dados");
    expect(name.indexOf("openrouter/auto")).toBeLessThan(name.indexOf("qwen/qwen3-coder:free"));
  });

  it("a ordenação vale também com busca (e a relevância volta a mandar quando se escolhe Relevância)", () => {
    expect(ids(searchModels(LIST, { query: "deepseek", sort: "context" }))[0]).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(ids(searchModels(LIST, { query: "deepseek", sort: "name" }))[0]).toBe("~deepseek/deepseek-flash-latest");
  });

  it("lista vazia e termo sem resultado", () => {
    expect(searchModels([], { query: "qualquer" })).toEqual([]);
    expect(searchModels([], { query: "" })).toEqual([]);
    expect(searchModels(LIST, { query: "zzzz-nada" })).toEqual([]);
  });

  it("aguenta uma lista grande de uma vez e o corte em N com 'mostrar mais' é só slice", () => {
    const big = Array.from({ length: 800 }, (_, i) => model(`prov${i % 40}/modelo-${i}`, `Modelo número ${i}`));
    const started = Date.now();
    const found = searchModels(big, { query: "modelo 7", sort: "relevance" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(found.length).toBeGreaterThan(PAGE_SIZE);
    expect(found.slice(0, PAGE_SIZE)).toHaveLength(PAGE_SIZE);
    expect(found.slice(0, PAGE_SIZE * 2)).toHaveLength(PAGE_SIZE * 2);
  });
});

describe("destaque do trecho achado", () => {
  it("marca as palavras no texto original (com acento e maiúscula)", () => {
    expect(highlightParts("DeepSeek: V4 Flash", ["deepseek", "flash"])).toEqual([
      { text: "DeepSeek", hit: true },
      { text: ": V4 ", hit: false },
      { text: "Flash", hit: true },
    ]);
    expect(highlightParts("Açúcar", ["acu"])).toEqual([
      { text: "Açú", hit: true },
      { text: "car", hit: false },
    ]);
    expect(highlightParts("deepseek/deepseek-v4.1", queryWords("v4.1"))).toEqual([
      { text: "deepseek/deepseek-", hit: false },
      { text: "v4.1", hit: true },
    ]);
  });

  it("sem palavras ou sem texto, devolve uma parte só, sem marca", () => {
    expect(highlightParts("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(highlightParts("", ["a"])).toEqual([{ text: "", hit: false }]);
    expect(highlightParts("abc", ["zzz"])).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("provedores, atalhos e filtro de ferramentas", () => {
  it("conta os modelos por provedor (o ~ fica junto do provedor)", () => {
    const counts = providerCounts(LIST);
    expect(counts[0]).toEqual({ provider: "deepseek", count: 4 });
    expect(counts.find((entry) => entry.provider === "qwen")).toEqual({ provider: "qwen", count: 1 });
    expect(counts.map((entry) => entry.count)).toEqual([...counts.map((entry) => entry.count)].sort((a, b) => b - a));
  });

  it("o filtro Com ferramentas nasce ligado só quando a lista traz o dado", () => {
    expect(defaultToolsFilter(LIST)).toBe(true);
    expect(defaultToolsFilter(LIST.map((item) => ({ ...item, tools: undefined })))).toBe(false);
    expect(defaultToolsFilter([])).toBe(false);
  });

  it("os atalhos da busca vazia: gratuitos e DeepSeek (os mais novos, sem apelidos ~), respeitando Com ferramentas", () => {
    const groups = suggestionGroups(LIST, NO_FILTERS);
    expect(ids(groups.free)).toEqual(["qwen/qwen3-coder:free", "google/gemini-flash:free"]);
    expect(ids(groups.deepseek)).toEqual(["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4-flash", "deepseek/deepseek-pro"]);
    expect(ids(suggestionGroups(LIST, { ...NO_FILTERS, tools: true }).free)).toEqual(["qwen/qwen3-coder:free"]);
    expect(suggestionGroups(LIST, NO_FILTERS, 1).deepseek).toHaveLength(1);
    expect(suggestionGroups([], NO_FILTERS)).toEqual({ free: [], deepseek: [] });
  });
});

describe("a linha de digitação livre e a validação do id", () => {
  it("vazio não oferece nada", () => {
    expect(typedId("   ", LIST)).toEqual({ state: "empty" });
  });

  it("id válido, com ou sem openrouter/ e com espaços ao redor", () => {
    expect(typedId("openai/gpt-9-novo", LIST)).toEqual({ state: "unlisted", id: "openai/gpt-9-novo" });
    expect(typedId("  openrouter/openai/gpt-9-novo:beta \n", LIST)).toEqual({ state: "unlisted", id: "openai/gpt-9-novo:beta" });
    expect(typedId("openrouter/deepseek/deepseek-v4-flash", LIST)).toEqual({ state: "listed", id: "deepseek/deepseek-v4-flash" });
    expect(typedId("deepseek/deepseek-v4-flash", LIST)).toEqual({ state: "listed", id: "deepseek/deepseek-v4-flash" });
    expect(typedId("openrouter/auto", LIST)).toEqual({ state: "listed", id: "openrouter/auto" });
    expect(typedId("~vendor/novo-latest", LIST)).toEqual({ state: "unlisted", id: "~vendor/novo-latest" });
  });

  it("id inválido", () => {
    for (const text of ["deepseek flash", "semBarra", "deepseek/", "/flash", "a/b:", "a/b c", "openrouter/", "https://openrouter.ai/x/y z"]) expect(typedId(text, LIST), text).toMatchObject({ state: "invalid" });
  });

  it("com a lista vazia o id digitado vale do mesmo jeito", () => {
    expect(typedId("deepseek/deepseek-v4-flash", [])).toEqual({ state: "unlisted", id: "deepseek/deepseek-v4-flash" });
  });
});

describe("textos das linhas", () => {
  it("preço, contexto e selos", () => {
    expect(priceBadge({ free: true, promptPerM: 0, completionPerM: 0 })).toBe("gratuito");
    expect(priceBadge({ free: false, promptPerM: 0.09, completionPerM: 0.18 })).toBe("US$ 0,09 / US$ 0,18 por milhão");
    expect(priceBadge({ free: false, promptPerM: 3 })).toBe("US$ 3 / ? por milhão");
    expect(priceBadge({ free: false })).toBe("preço não informado");
    expect(contextLabel(128_000)).toBe("128 mil tokens");
    expect(contextLabel(1_048_576)).toBe("1 milhão de tokens");
    expect(contextLabel(1_500_000)).toBe("1,5 milhões de tokens");
    expect(contextLabel(undefined)).toBe("contexto não informado");
    expect(modelBadges(LIST[1]!).map((badge) => badge.label)).toEqual(["ferramentas", "imagem"]);
    expect(modelBadges(LIST[4]!).map((badge) => badge.label)).toEqual(["sem ferramentas"]);
    expect(modelBadges(LIST[3]!).map((badge) => badge.label)).toEqual(["ferramentas", "sempre o mais novo"]);
    expect(modelBadges(LIST[8]!)).toEqual([]);
  });

  it("o estado da lista: quantos modelos e há quanto tempo, ou que ainda não foi lida", () => {
    const now = Date.parse("2026-11-12T15:00:00Z");
    expect(listStateLine("2026-11-12T12:00:00Z", 473, now)).toBe("473 modelos · lista lida há 3 h");
    expect(listStateLine("2026-11-12T14:59:50Z", 1, now)).toBe("1 modelo · lista lida agora");
    expect(listStateLine(undefined, 0, now)).toBe("A lista de modelos ainda não foi lida.");
    expect(listStateLine("", 5, now)).toBe("A lista de modelos ainda não foi lida.");
  });
});

describe("modelos do programa (configuração do próprio programa)", () => {
  it("a digitação livre vale provedor/modelo de qualquer provedor e não mexe no prefixo openrouter/", () => {
    expect(typedId("ollama/llama3.2:3b", [], "program")).toEqual({ state: "unlisted", id: "ollama/llama3.2:3b" });
    expect(typedId("openrouter/deepseek/deepseek-v4-flash", [], "program")).toEqual({ state: "unlisted", id: "openrouter/deepseek/deepseek-v4-flash" });
    expect(typedId("semprovedor", [], "program")).toEqual({ state: "invalid", text: "semprovedor" });
    const listed = [programModelToPicker({ id: "openai/gpt-5.2", label: "GPT 5.2" })];
    expect(typedId("openai/gpt-5.2", listed, "program")).toEqual({ state: "listed", id: "openai/gpt-5.2" });
    // No modo do OpenRouter o prefixo openrouter/ continua sendo tirado.
    expect(typedId("openrouter/deepseek/deepseek-v4-flash", [])).toEqual({ state: "unlisted", id: "deepseek/deepseek-v4-flash" });
  });

  it("um modelo do programa entra no seletor com provedor e nome, sem preço", () => {
    expect(programModelToPicker({ id: "openai/gpt-5.2", label: "GPT 5.2" })).toEqual({ id: "openai/gpt-5.2", name: "GPT 5.2", provider: "openai", price: { free: false } });
    expect(programModelToPicker({ id: "ollama/llama3.2:3b" }).name).toBe("llama3.2:3b");
  });
});
