import { DEFAULT_ATTENTION_PREFS, attentionPrefsSchema, type AttentionAlert, type AttentionPrefs } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { decideNotify, decideSound, decideToast, EMPTY_SOUND_MEMORY, isOnTarget, noteSound, SOUND_ALERT_GAP_MS, SOUND_MIN_GAP_MS, SOUND_WARN_GAP_MS } from "./decide";
import { DEFAULT_DEVICE_PREFS, type DevicePrefs } from "./devicePrefs";

const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const alert = (change: Partial<AttentionAlert> = {}): AttentionAlert => ({
  id: "al-1",
  key: "approval:ws:A-1",
  kind: "approval",
  level: "alert",
  needsOwner: true,
  workspaceId: "ws",
  text: "Eco pede a sua aprovação",
  count: 1,
  at: iso(NOW),
  updatedAt: iso(NOW),
  target: { page: "para-voce", workspaceId: "ws", ref: "A-1" },
  ...change,
});
const failed = alert({ key: "failed:ws:T-1", kind: "failed", level: "warn", needsOwner: false, target: { page: "trabalho", workspaceId: "ws", ref: "T-1" } });
const usage = alert({ key: "usage:plataforma:x", kind: "usage", level: "warn", needsOwner: false, workspaceId: undefined, target: { page: "gestao", ref: "gastos" } });

const device = (change: Partial<DevicePrefs> = {}): DevicePrefs => ({ ...DEFAULT_DEVICE_PREFS, soundKinds: { ...DEFAULT_DEVICE_PREFS.soundKinds }, ...change });
const on = device({ sound: true });
const account = (change: object = {}): AttentionPrefs => attentionPrefsSchema.parse(change);

describe("decideSound", () => {
  it("entrega é aviso discreto: nunca toca som, mesmo com os sons informativos ligados", () => {
    const delivery = { ...alert(), kind: "delivery" as const, level: "info" as const, needsOwner: false };
    expect(decideSound(device({ sound: true, soundKinds: { pedidos: true, falhas: true, informativos: true } }), DEFAULT_ATTENTION_PREFS, delivery, EMPTY_SOUND_MEMORY, NOW)).toBeNull();
  });

  it("desligado por padrão: nada toca", () => {
    expect(decideSound(device(), DEFAULT_ATTENTION_PREFS, alert(), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
  });

  it("ligado: o que espera o dono toca o sino; a falha de tarefa toca o som discreto; o limite de uso só com a categoria", () => {
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, alert(), EMPTY_SOUND_MEMORY, NOW)).toBe("chime");
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, failed, EMPTY_SOUND_MEMORY, NOW)).toBe("soft");
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, usage, EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(device({ sound: true, soundKinds: { pedidos: true, falhas: true, informativos: true } }), DEFAULT_ATTENTION_PREFS, usage, EMPTY_SOUND_MEMORY, NOW)).toBe("soft");
    expect(decideSound(device({ sound: true, soundKinds: { pedidos: true, falhas: true, informativos: true } }), DEFAULT_ATTENTION_PREFS, { ...usage, level: "alert" }, EMPTY_SOUND_MEMORY, NOW)).toBe("chime");
  });

  it("cada categoria desligada cala o seu som e só o dela", () => {
    expect(decideSound(device({ sound: true, soundKinds: { pedidos: false, falhas: true, informativos: false } }), DEFAULT_ATTENTION_PREFS, alert(), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(device({ sound: true, soundKinds: { pedidos: true, falhas: false, informativos: false } }), DEFAULT_ATTENTION_PREFS, failed, EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(device({ sound: true, soundKinds: { pedidos: true, falhas: false, informativos: false } }), DEFAULT_ATTENTION_PREFS, alert(), EMPTY_SOUND_MEMORY, NOW)).toBe("chime");
  });

  it("volume zero, replay (boot, reconexão, reabertura) e silêncios da conta não tocam", () => {
    expect(decideSound(device({ sound: true, volume: 0 }), DEFAULT_ATTENTION_PREFS, alert(), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, alert({ replay: true }), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(on, account({ kinds: { approval: false } }), alert(), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(on, account({ kinds: { failed: false } }), failed, EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(on, account({ mutedWorkspaces: { ws: {} } }), alert(), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(on, account({ mutedWorkspaces: { outro: {} } }), alert(), EMPTY_SOUND_MEMORY, NOW)).toBe("chime");
    expect(decideSound(on, account({ dndUntil: iso(NOW + 3_600_000) }), alert(), EMPTY_SOUND_MEMORY, NOW)).toBeNull();
    expect(decideSound(on, account({ dndUntil: iso(NOW - 1000) }), alert(), EMPTY_SOUND_MEMORY, NOW)).toBe("chime");
  });

  it("a falha de tarefa também respeita o silêncio por workspace", () => {
    expect(decideSound(on, account({ mutedWorkspaces: { ws: { until: iso(NOW + 1000) } } }), failed, EMPTY_SOUND_MEMORY, NOW)).toBeNull();
  });

  it("intervalos: 1,2 s entre quaisquer sons, 20 s entre sinos, 5 min entre avisos", () => {
    const afterChime = noteSound(EMPTY_SOUND_MEMORY, alert(), NOW);
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, alert(), afterChime, NOW + SOUND_MIN_GAP_MS - 1)).toBeNull();
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, alert(), afterChime, NOW + SOUND_ALERT_GAP_MS - 1)).toBeNull();
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, alert(), afterChime, NOW + SOUND_ALERT_GAP_MS)).toBe("chime");
    // A falha (aviso) não espera o sino de 20 s, só o intervalo mínimo.
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, failed, afterChime, NOW + SOUND_MIN_GAP_MS)).toBe("soft");
    const afterSoft = noteSound(EMPTY_SOUND_MEMORY, failed, NOW);
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, failed, afterSoft, NOW + SOUND_WARN_GAP_MS - 1)).toBeNull();
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, failed, afterSoft, NOW + SOUND_WARN_GAP_MS)).toBe("soft");
    // O sino não é barrado pelo som discreto de antes (só pelo intervalo mínimo).
    expect(decideSound(on, DEFAULT_ATTENTION_PREFS, alert(), afterSoft, NOW + SOUND_MIN_GAP_MS)).toBe("chime");
  });
});

describe("decideNotify", () => {
  const ctx = { hidden: true, permission: "granted" as const, now: NOW };
  const withNotify = device({ browserNotifications: true });

  it("só com a opção ligada, a permissão concedida, a aba escondida e alerta de nível alert", () => {
    expect(decideNotify(withNotify, DEFAULT_ATTENTION_PREFS, alert(), ctx)).toBe(true);
    expect(decideNotify(device(), DEFAULT_ATTENTION_PREFS, alert(), ctx)).toBe(false);
    expect(decideNotify(withNotify, DEFAULT_ATTENTION_PREFS, alert(), { ...ctx, hidden: false })).toBe(false);
    for (const permission of ["default", "denied", "unsupported"] as const) expect(decideNotify(withNotify, DEFAULT_ATTENTION_PREFS, alert(), { ...ctx, permission })).toBe(false);
    expect(decideNotify(withNotify, DEFAULT_ATTENTION_PREFS, failed, ctx)).toBe(false);
    expect(decideNotify(withNotify, DEFAULT_ATTENTION_PREFS, alert({ replay: true }), ctx)).toBe(false);
  });

  it("tipo desligado, workspace silenciado e não perturbe também calam a notificação", () => {
    expect(decideNotify(withNotify, account({ kinds: { approval: false } }), alert(), ctx)).toBe(false);
    expect(decideNotify(withNotify, account({ mutedWorkspaces: { ws: {} } }), alert(), ctx)).toBe(false);
    expect(decideNotify(withNotify, account({ dndUntil: iso(NOW + 1000) }), alert(), ctx)).toBe(false);
  });
});

describe("decideToast e isOnTarget", () => {
  const away = { visible: true, onTarget: false, now: NOW };

  it("avisa quando o dono está em outra tela; quem já está na tela do alerta (aba à vista) não é avisado", () => {
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, alert(), away)).toBe(true);
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, alert(), { ...away, onTarget: true })).toBe(false);
    // Aba escondida na tela do alerta: o aviso espera por ele.
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, alert(), { visible: false, onTarget: true, now: NOW })).toBe(true);
  });

  it("não avisa: aviso desligado, replay, alerta velho, tipo desligado, workspace silenciado, não perturbe", () => {
    expect(decideToast(device({ toasts: false }), DEFAULT_ATTENTION_PREFS, alert(), away)).toBe(false);
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, alert({ replay: true }), away)).toBe(false);
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, alert({ at: iso(NOW - 6 * 60_000) }), away)).toBe(false);
    expect(decideToast(DEFAULT_DEVICE_PREFS, account({ kinds: { approval: false } }), alert(), away)).toBe(false);
    expect(decideToast(DEFAULT_DEVICE_PREFS, account({ mutedWorkspaces: { ws: {} } }), alert(), away)).toBe(false);
    expect(decideToast(DEFAULT_DEVICE_PREFS, account({ dndUntil: iso(NOW + 5000) }), alert(), away)).toBe(false);
  });

  it("entrega só avisa se o dono ligou; falha e limite de uso avisam por padrão", () => {
    const delivery = alert({ kind: "delivery", level: "info", needsOwner: false });
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, delivery, away)).toBe(false);
    expect(decideToast(DEFAULT_DEVICE_PREFS, account({ kinds: { delivery: true } }), delivery, away)).toBe(true);
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, failed, away)).toBe(true);
    expect(decideToast(DEFAULT_DEVICE_PREFS, DEFAULT_ATTENTION_PREFS, usage, away)).toBe(true);
  });

  it("isOnTarget compara a página e o workspace", () => {
    const place = (page: string, workspaceId: string | null = "ws", sub = "") => ({ page, sub, workspaceId });
    expect(isOnTarget(alert(), place("para-voce"))).toBe(true);
    expect(isOnTarget(alert(), place("para-voce", "outro"))).toBe(false);
    expect(isOnTarget(alert(), place("trabalho"))).toBe(false);
    expect(isOnTarget(failed, place("trabalho"))).toBe(true);
    expect(isOnTarget(usage, place("gestao", "qualquer", "gastos"))).toBe(true);
    expect(isOnTarget(usage, place("gestao", "qualquer", "atividade"))).toBe(false);
    expect(isOnTarget(alert({ target: { page: "agente", workspaceId: "ws", ref: "eco" } }), place("office"))).toBe(false);
  });
});
