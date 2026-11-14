import { describe, expect, it } from "vitest";
import { healthPollDelay, MAX_HEALTH_POLL_MS, MAX_RETRY_MS, MAX_UI_DOWN_POLL_MS, MIN_RETRY_MS, MIN_UI_DOWN_POLL_MS, retryDelay, uiDownPollDelay } from "./backoff";

describe("retryDelay", () => {
  it("dobra a cada tentativa até o teto", () => {
    const max = () => 1;
    expect([0, 1, 2, 3, 10].map((attempt) => retryDelay(attempt, max))).toEqual([
      MIN_RETRY_MS,
      2 * MIN_RETRY_MS,
      4 * MIN_RETRY_MS,
      8 * MIN_RETRY_MS,
      MAX_RETRY_MS,
    ]);
  });

  it("aplica jitter entre 50% e 100%", () => {
    expect(retryDelay(0, () => 0)).toBe(MIN_RETRY_MS / 2);
    expect(retryDelay(0, () => 0.5)).toBe(MIN_RETRY_MS * 0.75);
    expect(retryDelay(-3, () => 1)).toBe(MIN_RETRY_MS);
  });
});

describe("healthPollDelay", () => {
  it("começa curto, dobra até o teto e aplica jitter", () => {
    expect([0, 1, 2, 3, 20].map((probe) => healthPollDelay(probe, () => 1))).toEqual([250, 500, 1000, 2000, MAX_HEALTH_POLL_MS]);
    expect(healthPollDelay(0, () => 0)).toBe(125);
  });
});

describe("uiDownPollDelay", () => {
  it("servidor da UI fora: começa em 5 s e dobra até 60 s (bem mais devagar que o health do backend)", () => {
    expect([0, 1, 2, 3, 4, 10].map((probe) => uiDownPollDelay(probe, () => 1))).toEqual([MIN_UI_DOWN_POLL_MS, 10_000, 20_000, 40_000, MAX_UI_DOWN_POLL_MS, MAX_UI_DOWN_POLL_MS]);
    expect(uiDownPollDelay(0, () => 0)).toBe(MIN_UI_DOWN_POLL_MS / 2);
  });
});
