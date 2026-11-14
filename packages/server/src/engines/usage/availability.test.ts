import type { EngineInfo } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineAvailability } from "./availability";
import { SubscriptionUsageTracker } from "./subscription-usage";

describe("EngineAvailability", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cota esgotada bloqueia o motor; quando o resetsAt passa, avisa sozinha e libera", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-08T12:00:00Z") });
    const now = () => new Date();
    const usage = new SubscriptionUsageTracker(now);
    const availability = new EngineAvailability({ usage, now });
    const changes = vi.fn();
    availability.onChange(changes);

    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 1, resetsAt }], status: "rejected" });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(availability.block("claude")).toEqual({ reason: "quota", resetsAt });
    expect(availability.block("mock")).toBeUndefined();
    expect(availability.block("gemini")).toBeUndefined();

    vi.advanceTimersByTime(30_000);
    expect(changes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(35_000);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(availability.block("claude")).toBeUndefined();
    availability.close();
  });

  it("tentar agora: ignora a cota até chegar uso novo do motor", () => {
    const usage = new SubscriptionUsageTracker();
    const availability = new EngineAvailability({ usage, now: () => new Date() });
    const changes = vi.fn();
    availability.onChange(changes);
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 1, resetsAt }] });
    availability.retry("claude");
    expect(changes).toHaveBeenCalledTimes(2);
    expect(availability.block("claude")).toBeUndefined();
    // A CLI disse de novo que não há cota: volta a bloquear.
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 1, resetsAt }], status: "rejected" });
    expect(availability.block("claude")).toMatchObject({ reason: "quota" });
    availability.close();
  });

  it("CLI ausente (detecção já feita) bloqueia; sem detecção, não", () => {
    const usage = new SubscriptionUsageTracker();
    const detected: EngineInfo[] = [];
    const availability = new EngineAvailability({ usage, engines: () => (detected.length > 0 ? detected : undefined), now: () => new Date() });
    expect(availability.block("claude")).toBeUndefined();
    detected.push({ engine: "claude", label: "Claude Code", available: false, models: [], freeModel: true });
    expect(availability.block("claude")).toEqual({ reason: "unavailable" });
    availability.close();
  });
});
