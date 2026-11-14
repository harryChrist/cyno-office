import { describe, expect, it } from "vitest";
import { parseClaudeTurnUsage } from "../terminals/claude-adapter";

describe("detalhes do turno do Claude Code (evento result)", () => {
  it("validade do cache gravado, modelos do turno, duração, modo e buscas na web", () => {
    const result = {
      type: "result",
      subtype: "success",
      duration_ms: 12_345,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 },
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        speed: "standard",
      },
      modelUsage: { "claude-sonnet-5-5": { inputTokens: 10 }, "<synthetic>": {}, "claude-haiku-5-5": { inputTokens: 1 } },
    };
    expect(parseClaudeTurnUsage(result)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      cacheCreation5mTokens: 15,
      cacheCreation1hTokens: 25,
      webSearches: 2,
      speed: "standard",
      models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
      durationMs: 12_345,
    });
  });

  it("sem os campos novos: só os quatro contadores, como antes", () => {
    expect(parseClaudeTurnUsage({ usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });
});
