import type { TurnUsage } from "@cyno/shared";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** O que vai além dos 4 contadores de tokens (todos opcionais: só entram se a CLI mandou). */
export type ClaudeUsageDetail = Pick<TurnUsage, "cacheCreation5mTokens" | "cacheCreation1hTokens" | "speed" | "webSearches">;

/**
 * Detalhes de um `usage` do Claude (o do evento `result` ou o de uma mensagem da conversa):
 * `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` (a validade do cache
 * gravado muda o preço), `speed` ("fast" = modo rápido) e `server_tool_use.web_search_requests`.
 */
export function claudeUsageDetail(usage: unknown): ClaudeUsageDetail {
  if (!isObject(usage)) return {};
  const out: ClaudeUsageDetail = {};
  const creation = isObject(usage.cache_creation) ? usage.cache_creation : undefined;
  if (creation && ("ephemeral_5m_input_tokens" in creation || "ephemeral_1h_input_tokens" in creation)) {
    out.cacheCreation5mTokens = count(creation.ephemeral_5m_input_tokens);
    out.cacheCreation1hTokens = count(creation.ephemeral_1h_input_tokens);
  }
  if (usage.speed === "fast" || usage.speed === "standard") out.speed = usage.speed;
  const server = isObject(usage.server_tool_use) ? usage.server_tool_use : undefined;
  const searches = count(server?.web_search_requests);
  if (searches > 0) out.webSearches = searches;
  return out;
}

/**
 * Detalhes do turno no evento `result` do Claude Code: os do `usage` (acima), os modelos que
 * rodaram no turno (`modelUsage`: um por chave, ex.: o do agente e o dos subagentes) e a duração
 * (`duration_ms`). Nunca lança; o que não vier fica de fora.
 */
export function claudeTurnDetail(result: unknown): Omit<TurnUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"> {
  if (!isObject(result)) return {};
  const out: Omit<TurnUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"> = { ...claudeUsageDetail(result.usage) };
  if (isObject(result.modelUsage)) {
    const models = Object.keys(result.modelUsage).filter((model) => model && model !== "<synthetic>");
    if (models.length > 0) out.models = models.slice(0, 8);
  }
  const duration = count(result.duration_ms);
  if (duration > 0) out.durationMs = duration;
  return out;
}
