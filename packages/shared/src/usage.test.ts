import { describe, expect, it } from "vitest";
import { sortUsageWindows, subscriptionUsageSchema, usageProviderLabel, usageWindowLabel } from "./usage";

describe("uso da assinatura", () => {
  it("ordena as janelas: 5h, semana, semana por modelo e depois as desconhecidas", () => {
    const ids = sortUsageWindows([{ id: "zeta" }, { id: "seven_day_opus" }, { id: "seven_day" }, { id: "alfa" }, { id: "five_hour" }].map((w) => ({ ...w, utilization: 0 }))).map(
      (window) => window.id,
    );
    expect(ids).toEqual(["five_hour", "seven_day", "seven_day_opus", "alfa", "zeta"]);
  });

  it("rótulos em pt-BR", () => {
    expect(usageWindowLabel("five_hour")).toBe("Sessão 5h");
    expect(usageWindowLabel("seven_day")).toBe("Semana");
    expect(usageWindowLabel("seven_day_sonnet")).toBe("Semana · Sonnet");
    expect(usageWindowLabel("seven_day_claude_design")).toBe("Semana · Claude Design");
    expect(usageWindowLabel("five_hour_opus")).toBe("Sessão 5h · Opus");
    expect(usageWindowLabel("monthly_extra")).toBe("monthly extra");
    expect(usageProviderLabel("claude")).toBe("Claude");
  });

  it("valida o uso guardado (data/usage.json) e recusa formatos estranhos", () => {
    const ok = {
      provider: "claude",
      windows: [{ id: "five_hour", utilization: 0.24, resetsAt: "2026-11-08T07:40:00.930Z", severity: "normal" }],
      updatedAt: "2026-11-08T05:00:00.000Z",
      source: "account",
      fetchedAt: "2026-11-08T05:00:00.000Z",
      stale: { reason: "Sem conexão com a Anthropic", since: "2026-11-08T05:03:00.000Z" },
    };
    expect(subscriptionUsageSchema.safeParse(ok).success).toBe(true);
    expect(subscriptionUsageSchema.safeParse({ ...ok, provider: "outro" }).success).toBe(false);
    expect(subscriptionUsageSchema.safeParse({ ...ok, windows: [{ id: "five_hour", utilization: 24 }] }).success).toBe(false);
    expect(subscriptionUsageSchema.safeParse({ ...ok, updatedAt: "lixo" }).success).toBe(false);
  });
});
