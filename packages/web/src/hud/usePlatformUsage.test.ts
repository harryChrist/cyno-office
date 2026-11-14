import type { SubscriptionUsage } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { useUsageStore } from "../store/usageStore";
import { pullPlatformUsage } from "./usePlatformUsage";

const usage = (provider: "claude" | "gemini", utilization: number): SubscriptionUsage => ({
  provider,
  windows: [{ id: "five_hour", utilization }],
  updatedAt: "2026-11-11T12:00:00.000Z",
});

describe("pullPlatformUsage", () => {
  beforeEach(() => {
    useUsageStore.setState({ byProvider: {} });
    vi.restoreAllMocks();
  });

  it("busca o uso de cada motor pela rota e joga no store", async () => {
    vi.spyOn(api, "refreshUsage").mockImplementation(async (provider = "claude") => ({ refreshed: false, usage: usage(provider, provider === "claude" ? 0.4 : 0.2) }));
    await pullPlatformUsage();
    expect(useUsageStore.getState().byProvider.claude?.windows[0]?.utilization).toBe(0.4);
    expect(useUsageStore.getState().byProvider.gemini?.windows[0]?.utilization).toBe(0.2);
  });

  it("consulta desligada (erro) de um motor não derruba o outro nem apaga o que já havia", async () => {
    useUsageStore.setState({ byProvider: { claude: usage("claude", 0.1) } });
    vi.spyOn(api, "refreshUsage").mockImplementation(async (provider = "claude") => {
      if (provider === "claude") throw new Error("503");
      return { refreshed: true, usage: usage("gemini", 0.3) };
    });
    await pullPlatformUsage();
    expect(useUsageStore.getState().byProvider.claude?.windows[0]?.utilization).toBe(0.1);
    expect(useUsageStore.getState().byProvider.gemini?.windows[0]?.utilization).toBe(0.3);
  });
});
