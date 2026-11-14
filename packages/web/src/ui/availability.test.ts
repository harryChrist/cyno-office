import type { EngineInfo, SubscriptionUsage } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent } from "../test-fixtures";
import { agentAvailability, availabilityByAgent } from "./availability";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const blocked: SubscriptionUsage = {
  provider: "claude",
  windows: [{ id: "five_hour", utilization: 1, resetsAt: new Date(NOW + 3600_000).toISOString() }],
  status: "rejected",
  updatedAt: new Date(NOW).toISOString(),
};

describe("disponibilidade dos agentes (web)", () => {
  it("só agentes do motor sem cota ficam indisponíveis; o simulado nunca", () => {
    const claude = makeAgent("rafa", "t1", { engine: "claude" });
    const gemini = makeAgent("iara", "t1", { engine: "gemini" });
    const mock = makeAgent("leo", "t1");
    const map = availabilityByAgent([claude, gemini, mock], { claude: blocked }, undefined, NOW);
    expect(Object.keys(map)).toEqual(["rafa"]);
    expect(map.rafa!.block).toMatchObject({ reason: "quota" });
    expect(map.rafa!.label).toMatch(/^sem cota · volta às \d\d:\d\d$/);
  });

  it("depois do resetsAt volta sozinho; CLI ausente = motor indisponível", () => {
    const claude = makeAgent("rafa", "t1", { engine: "claude" });
    expect(agentAvailability(claude, { claude: blocked }, undefined, NOW + 2 * 3600_000)).toBeNull();
    const engines: EngineInfo[] = [{ engine: "claude", label: "Claude Code", available: false, models: [], freeModel: true }];
    expect(agentAvailability(claude, {}, engines, NOW)).toEqual({ block: { reason: "unavailable" }, label: "motor indisponível" });
  });
});
