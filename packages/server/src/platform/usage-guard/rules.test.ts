import { FREEBUFF_NO_WALLET_KEY, freebuffWalletState, type FreebuffUsageDetail, type SubscriptionUsage, type UsageGuardPause } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { USAGE_GUARD_CLOCK_FALLBACK_MS, USAGE_GUARD_ORPHAN_MS, decideGuard, effectiveRule, guardCandidates, nextGuardWakeup, pauseAppliesTo } from "./rules";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const claude = (five: number, week: number, fiveResets = at(120), weekResets = at(3 * 24 * 60), opus = 0.5): SubscriptionUsage => ({
  provider: "claude",
  updatedAt: NOW_ISO,
  windows: [
    { id: "five_hour", utilization: five, resetsAt: fiveResets },
    { id: "seven_day", utilization: week, resetsAt: weekResets },
    { id: "seven_day_opus", utilization: opus, resetsAt: weekResets },
  ],
});

const freebuff = (remaining: number, wallet?: number, resetsAt = at(300)): SubscriptionUsage => {
  const detail: FreebuffUsageDetail = { settings: { model: "m", effort: "high", maxOpenHours: 1 }, hours: { total: 21, remaining, ...(wallet !== undefined ? { wallet } : {}), resetsAt, openedSince: 0 }, sessions: [] };
  return { provider: "freebuff", updatedAt: NOW_ISO, source: "cli", windows: [{ id: "daily_hours", utilization: (21 - remaining) / 21, resetsAt, label: "Horas do dia" }], freebuff: detail };
};

/** As regras nascem desligadas; nos testes de decisão, toda janela (e toda pausa aberta) conta como ligada, salvo o que o teste disser. */
const decide = (usages: SubscriptionUsage[], pauses: UsageGuardPause[] = [], rules: Record<string, { enabled?: boolean; percent?: number }> = {}, now = NOW, snoozed?: Set<string>) => {
  const candidates = guardCandidates(usages, now);
  const keys = [...candidates.filter((candidate) => candidate.kind === "window").map((candidate) => candidate.key), ...pauses.filter((pause) => pause.kind === "window").map((pause) => pause.key)];
  const merged = { ...Object.fromEntries(keys.map((key) => [key, { enabled: true, ...rules[key] }])), ...Object.fromEntries(Object.entries(rules).filter(([key]) => !keys.includes(key))) };
  return decideGuard({ candidates, settings: { rules: merged }, pauses, ...(snoozed ? { snoozed } : {}), now, nowIso: new Date(now).toISOString() });
};

describe("guardCandidates", () => {
  it("Claude: 5 h e semana valem para a conta; a semana de um modelo é regra à parte, só para ele", () => {
    const candidates = guardCandidates([claude(0.1, 0.2)], NOW);
    expect(candidates.map((candidate) => candidate.key)).toEqual(["claude:five_hour", "claude:seven_day", "claude:seven_day_opus"]);
    expect(candidates.map((candidate) => candidate.appliesTo)).toEqual([undefined, undefined, ["opus"]]);
    expect(candidates[2]!.label).toBe("semana · só Opus");
  });
  it("janela que já renovou (resetsAt passou) fica sem leitura: o número é de antes", () => {
    const [five] = guardCandidates([claude(0.99, 0.2, at(-5))], NOW);
    expect(five!.utilization).toBeUndefined();
  });
  it("status rejected conta como 100%", () => {
    const usage = claude(0.4, 0.2);
    usage.windows[0]!.status = "rejected";
    expect(guardCandidates([usage], NOW)[0]!.utilization).toBe(1);
  });
  it("motores sem dado confiável (codex, hermes...) não entram", () => {
    const keys = guardCandidates([{ provider: "codex", updatedAt: NOW_ISO, windows: [{ id: "x", utilization: 0.99 }] }, { provider: "hermes", updatedAt: NOW_ISO, windows: [] }], NOW);
    expect(keys).toEqual([]);
  });
  it("Antigravity: cada grupo é uma regra", () => {
    const usage: SubscriptionUsage = {
      provider: "gemini",
      updatedAt: NOW_ISO,
      windows: [
        { id: "five_hour", utilization: 0.5, group: "Modelos Gemini", appliesTo: ["gemini"] },
        { id: "five_hour", utilization: 0.1, group: "Claude e GPT", appliesTo: ["claude", "gpt"] },
      ],
    };
    expect(guardCandidates([usage], NOW).map((candidate) => candidate.key)).toEqual(["gemini:five_hour:Modelos Gemini", "gemini:five_hour:Claude e GPT"]);
  });
  it("Freebuff: a cota do dia é uma janela e a carteira é uma regra à parte", () => {
    const keys = guardCandidates([freebuff(10, 5)], NOW).map((candidate) => candidate.key);
    expect(keys).toEqual(["freebuff:daily_hours", FREEBUFF_NO_WALLET_KEY]);
  });
});

describe("effectiveRule", () => {
  it("padrão: toda regra nasce desligada, com 90% já preenchido (a da carteira também)", () => {
    expect(effectiveRule({ rules: {} }, "claude:five_hour", "window")).toEqual({ enabled: false, percent: 90 });
    // Ligar sem escolher percentual: vale o 90%.
    expect(effectiveRule({ rules: { "claude:five_hour": { enabled: true } } }, "claude:five_hour", "window")).toEqual({ enabled: true, percent: 90 });
    expect(effectiveRule({ rules: {} }, FREEBUFF_NO_WALLET_KEY, "no_wallet")).toEqual({ enabled: false, percent: 100 });
  });
  it("o que o dono escolheu vale, com o percentual dentro de 10 a 100", () => {
    expect(effectiveRule({ rules: { a: { enabled: false, percent: 70 } } }, "a", "window")).toEqual({ enabled: false, percent: 70 });
    expect(effectiveRule({ rules: { a: { percent: 3 } } }, "a", "window").percent).toBe(10);
  });
});

describe("decideGuard", () => {
  it("sem o dono ligar nada, nada pausa, mesmo com o plano esgotado", () => {
    const candidates = guardCandidates([claude(1, 1, at(120), at(3 * 24 * 60), 1)], NOW);
    expect(decideGuard({ candidates, settings: { rules: {} }, pauses: [], now: NOW, nowIso: NOW_ISO }).pause).toEqual([]);
  });
  it("abaixo do percentual não pausa; no percentual pausa só aquela janela, com o reset guardado", () => {
    expect(decide([claude(0.89, 0.5)]).pause).toEqual([]);
    const { pause } = decide([claude(0.9, 0.5)]);
    expect(pause).toHaveLength(1);
    expect(pause[0]).toMatchObject({ key: "claude:five_hour", engine: "claude", percent: 90, resetsAt: at(120), kind: "window" });
  });
  it("cada janela tem a sua chave e o seu percentual", () => {
    const rules = { "claude:five_hour": { enabled: false }, "claude:seven_day": { percent: 60 } };
    expect(decide([claude(0.95, 0.6)], [], rules).pause.map((pause) => pause.key)).toEqual(["claude:seven_day"]);
  });
  it("semana de um modelo só: pausa à parte, que segura só os agentes daquele modelo", () => {
    const { pause } = decide([claude(0.1, 0.2, at(120), at(3 * 24 * 60), 0.95)]);
    expect(pause.map((item) => item.key)).toEqual(["claude:seven_day_opus"]);
    expect(pauseAppliesTo(pause[0]!, "claude", "claude-opus-4-5")).toBe(true);
    expect(pauseAppliesTo(pause[0]!, "claude", "sonnet")).toBe(false);
    // Sem modelo escolhido: a janela de um modelo só não segura o agente do Claude Code.
    expect(pauseAppliesTo(pause[0]!, "claude", undefined)).toBe(false);
    expect(pauseAppliesTo(pause[0]!, "gemini", "opus")).toBe(false);
  });

  it("pausa já aberta não pausa de novo", () => {
    const first = decide([claude(0.95, 0.1)]).pause;
    expect(decide([claude(0.96, 0.1)], first).pause).toEqual([]);
  });
  it("histerese: perto do limite a pausa segura; só libera com 5 pontos abaixo", () => {
    const pauses = decide([claude(0.92, 0.1)]).pause;
    expect(decide([claude(0.88, 0.1)], pauses).release).toEqual([]);
    expect(decide([claude(0.84, 0.1)], pauses).release).toEqual([{ key: "claude:five_hour", why: "dropped" }]);
  });
  it("regra que o dono acabou de mudar solta sem a folga: uso abaixo do percentual novo já basta", () => {
    const paused = decide([claude(0.95, 0.2)]).pause;
    const usages = [claude(0.95, 0.2)];
    const args = { candidates: guardCandidates(usages, NOW), settings: { rules: { "claude:five_hour": { enabled: true, percent: 100 } } }, pauses: paused, now: NOW, nowIso: NOW_ISO };
    expect(decideGuard(args).release).toEqual([]);
    expect(decideGuard({ ...args, changedKey: "claude:five_hour" }).release).toEqual([{ key: "claude:five_hour", why: "dropped" }]);
    expect(decideGuard({ ...args, changedKey: "claude:seven_day" }).release).toEqual([]);
  });

  it("depois do reset, leitura ainda alta NÃO libera; leitura baixa libera", () => {
    const pauses = decide([claude(0.95, 0.1)]).pause;
    const later = NOW + 130 * 60_000;
    const next = new Date(later + 5 * 3600_000).toISOString();
    expect(decide([claude(0.95, 0.1, next)], pauses, {}, later).release).toEqual([]);
    expect(decide([claude(0.02, 0.1, next)], pauses, {}, later).release).toEqual([{ key: "claude:five_hour", why: "dropped" }]);
  });
  it("sem leitura nova depois do reset: só pelo relógio, 30 min depois", () => {
    const pauses = decide([claude(0.95, 0.1)]).pause;
    const stale = claude(0.95, 0.1);
    expect(decide([stale], pauses, {}, NOW + 130 * 60_000).release).toEqual([]);
    expect(decide([stale], pauses, {}, NOW + 120 * 60_000 + USAGE_GUARD_CLOCK_FALLBACK_MS).release).toEqual([{ key: "claude:five_hour", why: "clock" }]);
  });
  it("regra desligada libera a pausa", () => {
    const pauses = decide([claude(0.95, 0.1)]).pause;
    expect(decide([claude(0.95, 0.1)], pauses, { "claude:five_hour": { enabled: false } }).release).toEqual([{ key: "claude:five_hour", why: "disabled" }]);
  });
  it("janela que sumiu segura a pausa até o reset (mais a folga)", () => {
    const pauses = decide([claude(0.95, 0.1)]).pause;
    const none: SubscriptionUsage[] = [{ provider: "claude", updatedAt: NOW_ISO, windows: [] }];
    expect(decide(none, pauses).release).toEqual([]);
    expect(decide(none, pauses, {}, NOW + 120 * 60_000 + USAGE_GUARD_CLOCK_FALLBACK_MS).release).toEqual([{ key: "claude:five_hour", why: "gone" }]);
  });
  it("janela que sumiu e pausa sem hora de volta: não fica presa, acaba pelo teto contado do começo", () => {
    const orphan: UsageGuardPause = { key: "gemini:quota:pro", engine: "gemini", windowId: "quota", label: "Cota", percent: 90, utilization: 0.95, pausedAt: NOW_ISO, kind: "window" };
    expect(decide([], [orphan], {}, NOW + USAGE_GUARD_ORPHAN_MS - 60_000).release).toEqual([]);
    expect(decide([], [orphan], {}, NOW + USAGE_GUARD_ORPHAN_MS).release).toEqual([{ key: "gemini:quota:pro", why: "gone" }]);
  });

  it("liberada na mão (folga) não pausa de novo", () => {
    expect(decide([claude(0.95, 0.1)], [], {}, NOW, new Set(["claude:five_hour"])).pause).toEqual([]);
  });
  it("motor sem dado não gera nada", () => {
    expect(decide([])).toEqual({ pause: [], release: [] });
  });
  it("Freebuff: a cota do dia pausa a 90%; a carteira só pausa se a chave estiver ligada e a cota do dia acabou", () => {
    expect(decide([freebuff(0, 30)]).pause.map((pause) => pause.key)).toEqual(["freebuff:daily_hours"]);
    expect(decide([freebuff(5, 30)], [], { "freebuff:daily_hours": { enabled: false } }).pause).toEqual([]);
    const walletRule = { "freebuff:daily_hours": { enabled: false }, [FREEBUFF_NO_WALLET_KEY]: { enabled: true } };
    expect(decide([freebuff(0, 30)], [], walletRule).pause.map((pause) => pause.kind)).toEqual(["no_wallet"]);
    expect(decide([freebuff(3, 30)], [], walletRule).pause).toEqual([]);
  });
});

describe("freebuffWalletState", () => {
  const detail = (remaining: number, wallet: number | undefined, resetsAt: string): FreebuffUsageDetail => ({
    settings: { model: "m", effort: "high", maxOpenHours: 1, multiplier: 2 },
    hours: { total: 21, remaining, ...(wallet !== undefined ? { wallet } : {}), resetsAt, openedSince: 0 },
    sessions: [],
  });
  it("cota do dia menor que o custo da hora e carteira com saldo: gastando a carteira", () => {
    expect(freebuffWalletState(detail(1, 10, at(60)), NOW)).toEqual({ wallet: 10, dailyExhausted: true, usingWallet: true });
  });
  it("sem saldo na carteira: cota acabou, mas não gasta carteira", () => {
    expect(freebuffWalletState(detail(0, 0, at(60)), NOW)).toEqual({ wallet: 0, dailyExhausted: true, usingWallet: false });
    expect(freebuffWalletState(detail(0, undefined, at(60)), NOW).usingWallet).toBe(false);
  });
  it("leitura de antes da virada do dia não vale", () => {
    expect(freebuffWalletState(detail(0, 10, at(-1)), NOW).dailyExhausted).toBe(false);
  });
  it("sem dado nenhum: nada", () => {
    expect(freebuffWalletState(undefined, NOW)).toEqual({ dailyExhausted: false, usingWallet: false });
  });
});

describe("pauseAppliesTo e nextGuardWakeup", () => {
  it("só o motor da pausa; janela de grupo só segura os modelos dela", () => {
    expect(pauseAppliesTo({ engine: "claude" }, "claude", "opus")).toBe(true);
    expect(pauseAppliesTo({ engine: "claude" }, "gemini", undefined)).toBe(false);
    expect(pauseAppliesTo({ engine: "gemini", appliesTo: ["claude", "gpt"] }, "gemini", "gemini-3-flash")).toBe(false);
    expect(pauseAppliesTo({ engine: "gemini", appliesTo: ["claude", "gpt"] }, "gemini", "claude-opus-5")).toBe(true);
  });
  it("o próximo despertar é o reset mais perto", () => {
    const pauses = decide([claude(0.95, 0.95)]).pause;
    expect(nextGuardWakeup(pauses, NOW)).toBe(NOW + 120 * 60_000);
    expect(nextGuardWakeup([], NOW)).toBeUndefined();
  });
});
