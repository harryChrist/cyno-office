import { readFile } from "node:fs/promises";
import type { ModelPrice, OpenRouterModel, OpenRouterModelsResponse } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import { errorMessage } from "../../util/text";

/** Endereço do OpenRouter (os testes apontam para um servidor HTTP local falso). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const FETCH_TIMEOUT_MS = 20_000;
/** Id de modelo que o Cyno aceita (entram os apelidos "~vendor/…-latest": sempre o mais novo da família). */
const MODEL_ID = /^~?[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const perMillion = (value: unknown): number | undefined => {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1000) / 1000 : undefined;
};

/** O trecho do id antes da barra (sem o `~` dos apelidos, para ficarem junto do provedor). */
const providerOf = (id: string) => (id.split("/")[0] ?? id).replace(/^~/, "");

/**
 * Lista pública `GET /models` (não pede chave): id, nome, provedor, contexto, preço por milhão de tokens (entrada e saída),
 * modalidades de entrada, suporte a ferramentas e data de criação. A lista vem inteira (nada é cortado). Gratuito = preço zero (os `:free`).
 */
export function parseOpenRouterModels(body: unknown): OpenRouterModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: OpenRouterModel[] = [];
  for (const item of data) {
    const raw = item as { id?: unknown; name?: unknown; created?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; architecture?: { input_modalities?: unknown }; supported_parameters?: unknown };
    if (typeof raw.id !== "string" || !MODEL_ID.test(raw.id) || raw.id.length > 80) continue;
    const promptPerM = perMillion(raw.pricing?.prompt);
    const completionPerM = perMillion(raw.pricing?.completion);
    const free = promptPerM === 0 && completionPerM === 0;
    const price: ModelPrice = { free, ...(promptPerM !== undefined ? { promptPerM } : {}), ...(completionPerM !== undefined ? { completionPerM } : {}) };
    const modalities = Array.isArray(raw.architecture?.input_modalities) ? raw.architecture.input_modalities.filter((value): value is string => typeof value === "string") : [];
    const tools = Array.isArray(raw.supported_parameters) ? raw.supported_parameters.includes("tools") : undefined;
    models.push({
      id: raw.id,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      provider: providerOf(raw.id),
      ...(typeof raw.context_length === "number" ? { contextLength: raw.context_length } : {}),
      price,
      ...(tools !== undefined ? { tools } : {}),
      ...(modalities.length > 0 ? { inputModalities: modalities } : {}),
      ...(typeof raw.created === "number" && Number.isFinite(raw.created) && raw.created > 0 ? { created: raw.created } : {}),
    });
  }
  return models;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type OpenRouterClientOptions = { baseUrl?: string; fetch?: FetchLike };

async function get(options: OpenRouterClientOptions, pathName: string, headers?: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const run = options.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await run(`${options.baseUrl ?? OPENROUTER_BASE_URL}${pathName}`, { ...(headers ? { headers } : {}), signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOpenRouterModels(options: OpenRouterClientOptions = {}): Promise<OpenRouterModel[]> {
  const result = await get(options, "/models");
  if (!result.ok) throw new Error(`O OpenRouter respondeu ${result.status} à lista de modelos.`);
  const models = parseOpenRouterModels(result.body);
  if (models.length === 0) throw new Error("A lista de modelos do OpenRouter veio vazia ou em outro formato.");
  return models;
}

/** O que `GET /key` diz da chave (docs: limit, usage, limit_remaining, is_free_tier). Nunca devolve a chave. */
export type OpenRouterKeyStatus = { ok: true; limit: number | null; usage: number | null; remaining: number | null; isFreeTier?: boolean; /** Chave de gerenciamento/provisionamento: aceita em `/key`, mas não roda modelos. */ management?: boolean } | { ok: false; error: string; rejected?: boolean };

export async function checkOpenRouterKey(key: string, options: OpenRouterClientOptions = {}): Promise<OpenRouterKeyStatus> {
  try {
    const result = await get(options, "/key", { Authorization: `Bearer ${key}` });
    if (result.status === 401 || result.status === 403) return { ok: false, rejected: true, error: "O OpenRouter recusou a chave (inválida, removida ou desativada)." };
    if (!result.ok) return { ok: false, error: `O OpenRouter respondeu ${result.status} à consulta da chave.` };
    const data = (result.body as { data?: { limit?: unknown; usage?: unknown; limit_remaining?: unknown; is_free_tier?: unknown; is_management_key?: unknown; is_provisioning_key?: unknown } } | undefined)?.data ?? {};
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return { ok: true, limit: num(data.limit), usage: num(data.usage), remaining: num(data.limit_remaining), ...(typeof data.is_free_tier === "boolean" ? { isFreeTier: data.is_free_tier } : {}), ...(data.is_management_key === true || data.is_provisioning_key === true ? { management: true } : {}) };
  } catch (error) {
    return { ok: false, error: `Não consegui falar com o OpenRouter: ${errorMessage(error)}` };
  }
}

/** A lista de modelos guardada em disco (para a tela não depender da rede a cada abertura). */
export class OpenRouterModelsCache {
  private constructor(
    private readonly file: string | undefined,
    private data: OpenRouterModelsResponse | undefined,
  ) {}

  static async open(file: string): Promise<OpenRouterModelsCache> {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Partial<OpenRouterModelsResponse>;
      // Cache de antes dos campos novos: o provedor sai do id; o resto fica ausente até a próxima leitura.
      if (Array.isArray(raw.models) && typeof raw.readAt === "string") return new OpenRouterModelsCache(file, { models: raw.models.map((model) => (typeof model.provider === "string" ? model : { ...model, provider: providerOf(model.id) })), readAt: raw.readAt });
    } catch {
      // sem cache ainda
    }
    return new OpenRouterModelsCache(file, undefined);
  }

  static inMemory(): OpenRouterModelsCache {
    return new OpenRouterModelsCache(undefined, undefined);
  }

  read(): OpenRouterModelsResponse | undefined {
    return this.data;
  }

  find(id: string): OpenRouterModel | undefined {
    return this.data?.models.find((model) => model.id === id);
  }

  async write(models: OpenRouterModel[], readAt: string): Promise<OpenRouterModelsResponse> {
    this.data = { models, readAt };
    if (this.file) await writeJsonAtomic(this.file, this.data);
    return this.data;
  }
}
