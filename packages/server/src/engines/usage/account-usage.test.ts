import { describe, expect, it } from "vitest";
import { parseAccountUsage } from "./account-usage";

/** Resposta real (resumida) de /api/oauth/usage em 2026-11-08. */
const REAL = {
  five_hour: { utilization: 24, resets_at: "2026-11-08T07:40:00.93+00:00", limit_dollars: null },
  seven_day: { utilization: 47, resets_at: "2026-11-08T20:00:00.93+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  iguana_necktie: null,
  extra_usage: { is_enabled: false, monthly_limit: null },
  limits: [
    { kind: "session", group: "session", percent: 24, severity: "normal", resets_at: "2026-11-08T07:40:00.93+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 47, severity: "normal", resets_at: "2026-11-08T20:00:00.93+00:00", scope: null, is_active: false },
  ],
};

describe("parseAccountUsage", () => {
  it("lê o array `limits` (porcentagem -> 0..1, gravidade, renovação em ISO)", () => {
    expect(parseAccountUsage(REAL)).toEqual([
      { id: "five_hour", utilization: 0.24, resetsAt: "2026-11-08T07:40:00.930Z", severity: "normal" },
      { id: "seven_day", utilization: 0.47, resetsAt: "2026-11-08T20:00:00.930Z", severity: "normal" },
    ]);
  });

  it("limites semanais por escopo viram seven_day_<escopo> (string ou objeto)", () => {
    const windows = parseAccountUsage({
      limits: [
        { kind: "weekly_scoped", percent: 81.5, severity: "warning", scope: "Opus" },
        { kind: "weekly_scoped", percent: 12, scope: { model: "Sonnet 4" } },
        { kind: "monthly", percent: 3 },
        { kind: "session", percent: "24" },
        { percent: 50 },
        "lixo",
      ],
    });
    expect(windows).toEqual([
      { id: "seven_day_opus", utilization: 0.815, severity: "warning" },
      { id: "seven_day_sonnet_4", utilization: 0.12 },
      { id: "monthly", utilization: 0.03 },
    ]);
  });

  it("escopo aninhado do formato real ({ model: { id: null, display_name } })", () => {
    const windows = parseAccountUsage({
      limits: [{ kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", scope: { model: { id: null, display_name: "Fable" }, surface: null } }],
    });
    expect(windows?.map((window) => window.id)).toEqual(["seven_day_fable"]);
  });

  it("sem `limits`: cai nas chaves soltas (só five_hour/seven_day*), ignorando nulos e codinomes", () => {
    const flat: Record<string, unknown> = { ...REAL };
    delete flat.limits;
    expect(parseAccountUsage({ ...flat, seven_day_opus: { utilization: 100, resets_at: null }, iguana_necktie: { utilization: 5 } })).toEqual([
      { id: "five_hour", utilization: 0.24, resetsAt: "2026-11-08T07:40:00.930Z" },
      { id: "seven_day", utilization: 0.47, resetsAt: "2026-11-08T20:00:00.930Z" },
      { id: "seven_day_opus", utilization: 1 },
    ]);
  });

  it("chaves soltas completam o que `limits` não trouxe (limits manda nas repetidas)", () => {
    const windows = parseAccountUsage({ ...REAL, seven_day: { utilization: 99 }, seven_day_opus: { utilization: 10 } });
    expect(windows?.map((window) => [window.id, window.utilization])).toEqual([
      ["five_hour", 0.24],
      ["seven_day", 0.47],
      ["seven_day_opus", 0.1],
    ]);
  });

  it("porcentagem acima de 100 fica em 1; abaixo de 1 é porcentagem mesmo (0,5% != 50%)", () => {
    expect(parseAccountUsage({ limits: [{ kind: "session", percent: 140 }, { kind: "weekly_all", percent: 0.5 }] })).toEqual([
      { id: "five_hour", utilization: 1 },
      { id: "seven_day", utilization: 0.005 },
    ]);
  });

  it("formato desconhecido = null, nunca lança", () => {
    for (const data of [null, undefined, 42, "x", [], {}, { limits: "x" }, { limits: [null] }, { five_hour: null, seven_day: { utilization: -1 } }]) {
      expect(parseAccountUsage(data)).toBeNull();
    }
  });
});
