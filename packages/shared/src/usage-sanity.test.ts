import { describe, expect, it } from "vitest";
import { SUSPECT_LIMITS, suspectReasonOf } from "./usage-sanity";

const ok = { input: 10, output: 500, cacheRead: 200_000, cacheCreation: 3_000 };

describe("guarda de sanidade do gasto", () => {
  it("um turno normal passa", () => {
    expect(suspectReasonOf(ok, 0.4)).toBeUndefined();
    expect(suspectReasonOf(undefined, null)).toBeUndefined();
    expect(suspectReasonOf(undefined, undefined)).toBeUndefined();
  });

  it("número negativo, NaN ou infinito é inválido", () => {
    expect(suspectReasonOf({ ...ok, output: -1 }, 0.1)).toBe("negative");
    expect(suspectReasonOf({ ...ok, cacheRead: Number.NaN }, 0.1)).toBe("negative");
    expect(suspectReasonOf({ ...ok, input: Number.POSITIVE_INFINITY }, 0.1)).toBe("negative");
    expect(suspectReasonOf({ ...ok, cacheCreation1h: -5 }, 0.1)).toBe("negative");
    expect(suspectReasonOf(ok, -0.01)).toBe("negative");
  });

  it("os limites são exatos: o limite passa, um a mais é impossível", () => {
    const limit = SUSPECT_LIMITS.inputTokens;
    expect(suspectReasonOf({ input: 1, output: 0, cacheRead: limit - 1, cacheCreation: 0 }, 1)).toBeUndefined();
    expect(suspectReasonOf({ input: 1, output: 0, cacheRead: limit, cacheCreation: 0 }, 1)).toBe("input");
    expect(suspectReasonOf({ input: 0, output: SUSPECT_LIMITS.outputTokens, cacheRead: 0, cacheCreation: 0 }, 1)).toBeUndefined();
    expect(suspectReasonOf({ input: 0, output: SUSPECT_LIMITS.outputTokens + 1, cacheRead: 0, cacheCreation: 0 }, 1)).toBe("output");
    expect(suspectReasonOf(ok, SUSPECT_LIMITS.costUsd)).toBeUndefined();
    expect(suspectReasonOf(ok, SUSPECT_LIMITS.costUsd + 0.01)).toBe("cost");
  });
});
