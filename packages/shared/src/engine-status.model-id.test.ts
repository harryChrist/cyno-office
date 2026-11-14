import { describe, expect, it } from "vitest";
import { normalizeOpenRouterModelId, OPENROUTER_MODEL_ID } from "./engine-status";

describe("o id de modelo do OpenRouter", () => {
  it("aceita provedor/modelo, com sufixo e com o apelido ~", () => {
    for (const id of ["deepseek/deepseek-v4-flash", "meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-6.1-terra:batch", "~deepseek/deepseek-flash-latest", "openrouter/auto", "x-ai/grok-4.1"]) expect(OPENROUTER_MODEL_ID.test(id), id).toBe(true);
  });

  it("recusa o que não tem a forma provedor/modelo", () => {
    for (const id of ["", "semBarra", "/modelo", "provedor/", "pro vedor/modelo", "deepseek/flash:", "deepseek/flash:a:b", "deepseek//x", "-x/y", "a/b c", "a/b;rm"]) expect(OPENROUTER_MODEL_ID.test(id), id).toBe(false);
  });

  it("normaliza: tira espaços e o prefixo openrouter/, mantém openrouter/auto", () => {
    expect(normalizeOpenRouterModelId("  openrouter/deepseek/deepseek-v4-flash \n")).toBe("deepseek/deepseek-v4-flash");
    expect(normalizeOpenRouterModelId("OpenRouter/qwen/qwen3:free")).toBe("qwen/qwen3:free");
    expect(normalizeOpenRouterModelId("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(normalizeOpenRouterModelId("openrouter/auto")).toBe("openrouter/auto");
    expect(normalizeOpenRouterModelId("auto")).toBeUndefined();
    expect(normalizeOpenRouterModelId("openrouter/")).toBeUndefined();
    expect(normalizeOpenRouterModelId("a/" + "b".repeat(90))).toBeUndefined();
  });
});
