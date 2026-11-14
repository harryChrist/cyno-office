import { describe, expect, it } from "vitest";
import { USAGE_STALE_MS, usageToneFor, usageWindowState, type UsageWindow } from "./usage";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const win = (utilization: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ id: "five_hour", utilization, resetsAt: inMinutes(120), ...extra });

describe("usageWindowState (regra única de honestidade do uso)", () => {
  it("leitura fresca: número, cor e idade", () => {
    expect(usageWindowState(win(0.27), { updatedAt: minutesAgo(0) }, NOW)).toEqual({
      kind: "value",
      percent: 27,
      tone: "ok",
      old: false,
      renewed: false,
      ageMinutes: 0,
      ageLabel: "agora",
      text: "27%",
    });
    expect(usageWindowState(win(0.27), { updatedAt: minutesAgo(3) }, NOW)).toMatchObject({ ageLabel: "há 3 min", old: false });
  });

  it.each([
    [29, false],
    [30, false],
    [31, true],
    [42, true],
  ])("leitura de %i min: antiga = %s (o limite é mais de 30 min)", (minutes, old) => {
    const state = usageWindowState(win(0.9), { updatedAt: minutesAgo(minutes) }, NOW);
    expect(state.old).toBe(old);
    expect(state.percent).toBe(90);
    expect(state.tone).toBe(old ? "ok" : "danger");
    expect(state.ageLabel).toBe(`há ${minutes} min`);
    expect(USAGE_STALE_MS).toBe(30 * 60_000);
  });

  it("a leitura mais recente entre a consulta da conta e o último dado vale", () => {
    expect(usageWindowState(win(0.3), { updatedAt: minutesAgo(90), fetchedAt: minutesAgo(5) }, NOW)).toMatchObject({ old: false, ageLabel: "há 5 min" });
    expect(usageWindowState(win(0.3), { updatedAt: minutesAgo(2), fetchedAt: minutesAgo(90) }, NOW)).toMatchObject({ old: false, ageLabel: "há 2 min" });
  });

  it("janela cujo resetsAt passou sem leitura nova: renovada, sem percentual", () => {
    const state = usageWindowState(win(0.9, { resetsAt: minutesAgo(10) }), { updatedAt: minutesAgo(20) }, NOW);
    expect(state).toMatchObject({ kind: "renewed", percent: null, renewed: true, tone: "ok", text: "renovada" });
  });

  it("resetsAt passado mas a leitura é posterior a ele: o número vale", () => {
    expect(usageWindowState(win(0.4, { resetsAt: minutesAgo(10) }), { updatedAt: minutesAgo(2) }, NOW)).toMatchObject({ kind: "value", percent: 40, renewed: false });
  });

  it("renovada e depois leitura nova com o ciclo novo: volta o número", () => {
    expect(usageWindowState(win(0.02, { resetsAt: inMinutes(300) }), { updatedAt: minutesAgo(0) }, NOW)).toMatchObject({ kind: "value", percent: 2, renewed: false, old: false });
  });

  it("sem dado nenhum: traço; sem data da leitura: número sem idade", () => {
    expect(usageWindowState(undefined, {}, NOW)).toMatchObject({ kind: "none", percent: null, text: "–", ageLabel: "", ageMinutes: null });
    expect(usageWindowState(win(0.5), {}, NOW)).toMatchObject({ kind: "value", percent: 50, old: false, ageLabel: "" });
    expect(usageWindowState(win(0.5), { updatedAt: "" }, NOW)).toMatchObject({ old: false, ageLabel: "" });
  });

  it.each([
    [0.49, 49, "ok"],
    [0.5, 50, "warn"],
    [0.79, 79, "warn"],
    [0.8, 80, "danger"],
    [1, 100, "danger"],
    [1.4, 100, "danger"],
  ])("faixa de cor no limite: %d -> %d%% é %s", (utilization, percent, tone) => {
    expect(usageWindowState(win(utilization), { updatedAt: minutesAgo(1) }, NOW)).toMatchObject({ percent, tone });
    expect(usageToneFor(percent)).toBe(tone);
  });

  it("barrada ou gravidade crítica força perigo; aviso força atenção", () => {
    const meta = { updatedAt: minutesAgo(1) };
    expect(usageWindowState(win(0.1, { status: "rejected" }), meta, NOW).tone).toBe("danger");
    expect(usageWindowState(win(0.1, { severity: "critical" }), meta, NOW).tone).toBe("danger");
    expect(usageWindowState(win(0.1, { status: "allowed_warning" }), meta, NOW).tone).toBe("warn");
  });

  it("os dois motores: Claude (conta) e Antigravity (grupo de modelos) seguem a mesma regra", () => {
    const claude = usageWindowState(win(0.55), { updatedAt: minutesAgo(1), fetchedAt: minutesAgo(1) }, NOW);
    const gemini = usageWindowState(win(0.55, { group: "Modelos Gemini", label: "Sessão 5h" }), { updatedAt: minutesAgo(1) }, NOW);
    expect(gemini).toEqual(claude);
    const geminiOld = usageWindowState(win(0.55, { group: "Modelos Gemini" }), { updatedAt: minutesAgo(45) }, NOW);
    expect(geminiOld).toMatchObject({ old: true, tone: "ok", ageLabel: "há 45 min" });
  });

  it("idade longa em horas e dias", () => {
    expect(usageWindowState(win(0.2), { updatedAt: minutesAgo(125) }, NOW).ageLabel).toBe("há 2 h 5 min");
    expect(usageWindowState(win(0.2), { updatedAt: minutesAgo(3 * 24 * 60) }, NOW).ageLabel).toBe("há 3 d");
  });
});
