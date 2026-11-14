import { attentionPrefsSchema } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DEVICE_PREFS, sanitizeDevicePrefs } from "./devicePrefs";
import { notificationContent, notificationPermission, requestNotificationPermission, showAttentionNotification } from "./notify";
import { clockLabel, dndChoice, dndText, muteState, withMute } from "./settingsModel";
import { gainOf, playSynth } from "./sound";
import { keyBelongsToTyping } from "./useAttentionKeys";

const NOW = Date.parse("2026-11-12T15:00:00.000Z");

describe("preferências deste aparelho", () => {
  it("tudo desligado por padrão, menos o aviso na tela; o som discreto da falha vem ligado", () => {
    expect(DEFAULT_DEVICE_PREFS).toMatchObject({ sound: false, browserNotifications: false, toasts: true, volume: 40, soundKinds: { pedidos: true, falhas: true, informativos: false } });
  });

  it("lê o que está salvo com tolerância: tipo errado volta ao padrão, volume é preso entre 0 e 100", () => {
    expect(sanitizeDevicePrefs(undefined)).toEqual(DEFAULT_DEVICE_PREFS);
    expect(sanitizeDevicePrefs("lixo")).toEqual(DEFAULT_DEVICE_PREFS);
    expect(sanitizeDevicePrefs({ sound: "sim", volume: 250, soundKinds: { falhas: false, pedidos: 1 }, toasts: false })).toMatchObject({ sound: false, volume: 100, soundKinds: { pedidos: true, falhas: false, informativos: false }, toasts: false });
    expect(sanitizeDevicePrefs({ volume: -5 }).volume).toBe(0);
    expect(sanitizeDevicePrefs({ volume: Number.NaN }).volume).toBe(40);
  });
});

describe("a tecla P", () => {
  const event = (target: object | null, extra: object = {}) => ({ target, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, ...extra }) as unknown as KeyboardEvent;
  it("não é nossa em campo de texto, seleção, contenteditable, diálogo aberto ou com Ctrl/Alt/Cmd", () => {
    expect(keyBelongsToTyping(event({ tagName: "INPUT" }), false)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "TEXTAREA" }), false)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "SELECT" }), false)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "DIV", isContentEditable: true }), false)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "BODY" }), true)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "BODY" }), false, )).toBe(false);
    expect(keyBelongsToTyping(event({ tagName: "BODY" }, { ctrlKey: true }), false)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "BODY" }, { metaKey: true }), false)).toBe(true);
    expect(keyBelongsToTyping(event({ tagName: "BODY" }, { defaultPrevented: true }), false)).toBe(true);
    expect(keyBelongsToTyping(event(null), false)).toBe(false);
  });
});

describe("silêncio nas Configurações", () => {
  it("silenciar um workspace por 1 hora, até amanhã ou sempre; tirar; e limpar prazos velhos", () => {
    const prefs = attentionPrefsSchema.parse({ mutedWorkspaces: { velho: { until: new Date(NOW - 1000).toISOString() }, b: {} } });
    const hour = withMute(prefs.mutedWorkspaces, "a", "1h", NOW);
    expect(hour).toEqual({ b: {}, a: { until: new Date(NOW + 3_600_000).toISOString() } });
    expect(withMute(hour, "a", "tomorrow", NOW).a).toEqual({ until: "2026-11-13T03:00:00.000Z" });
    expect(withMute(hour, "a", "always", NOW).a).toEqual({});
    expect(withMute(hour, "a", "off", NOW)).toEqual({ b: {} });
    expect(muteState(attentionPrefsSchema.parse({ mutedWorkspaces: hour }), "a", NOW)).toEqual({ state: "until", until: new Date(NOW + 3_600_000).toISOString() });
    expect(muteState(attentionPrefsSchema.parse({ mutedWorkspaces: hour }), "b", NOW)).toEqual({ state: "always" });
    expect(muteState(attentionPrefsSchema.parse({ mutedWorkspaces: hour }), "a", NOW + 2 * 3_600_000)).toEqual({ state: "off" });
  });

  it("não perturbe: 1 hora, até amanhã (meia-noite de São Paulo) ou desligar, e o texto do estado", () => {
    expect(dndChoice("1h", NOW)).toBe(new Date(NOW + 3_600_000).toISOString());
    expect(dndChoice("tomorrow", NOW)).toBe("2026-11-13T03:00:00.000Z");
    expect(dndChoice("off", NOW)).toBeNull();
    const prefs = attentionPrefsSchema.parse({ dndUntil: new Date(NOW + 3_600_000).toISOString() });
    expect(dndText(prefs, NOW, (iso) => clockLabel(iso, NOW))).toBe("Ligado até 13:00");
    expect(dndText(prefs, NOW + 2 * 3_600_000, (iso) => clockLabel(iso, NOW))).toBe("Desligado");
    expect(clockLabel("2026-11-13T03:00:00.000Z", NOW)).toBe("13/11 00:00");
  });
});

describe("o som sintetizado", () => {
  function fakeContext() {
    const oscillators: { type: string; frequency: { setValueAtTime: number[] } }[] = [];
    const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    const ac = {
      currentTime: 0,
      destination: {},
      createGain: () => ({ gain: param(), connect: (next: unknown) => next }),
      createOscillator: () => {
        const calls: number[] = [];
        const oscillator = { type: "sine", frequency: { setValueAtTime: (value: number) => calls.push(value), exponentialRampToValueAtTime: vi.fn() }, connect: (next: unknown) => next, start: vi.fn(), stop: vi.fn() };
        oscillators.push({ get type() { return oscillator.type; }, frequency: { setValueAtTime: calls } });
        return oscillator;
      },
    };
    return { ac: ac as unknown as AudioContext, oscillators };
  }

  it("o sino tem três notas; o som discreto da falha tem duas, mais graves", () => {
    const chime = fakeContext();
    playSynth(chime.ac, "chime", 1);
    expect(chime.oscillators.map((o) => o.frequency.setValueAtTime[0])).toEqual([880, 1318.5, 1174.7]);
    const soft = fakeContext();
    playSynth(soft.ac, "soft", 1);
    expect(soft.oscillators).toHaveLength(2);
    expect(Math.max(...soft.oscillators.map((o) => o.frequency.setValueAtTime[0]!))).toBeLessThan(440);
  });

  it("o volume vira ganho crescente (zero é mudo)", () => {
    expect(gainOf(0)).toBe(0);
    expect(gainOf(100)).toBeGreaterThan(gainOf(50));
    expect(gainOf(50)).toBeGreaterThan(gainOf(10));
  });
});

describe("notificação do navegador", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const alert = { key: "approval:ws:A-1", text: "Eco pede a sua aprovação", needsOwner: true, workspaceName: "Demo" };

  it("o texto diz o que é e de quem, e a chave faz uma notificação substituir a outra", () => {
    expect(notificationContent(alert)).toEqual({ title: "Cyno · precisa de você", body: "Eco pede a sua aprovação (Demo)", tag: "approval:ws:A-1" });
    expect(notificationContent({ ...alert, needsOwner: false, workspaceName: undefined }).title).toBe("Cyno");
  });

  it("sem suporte, sem permissão: não mostra e não quebra", async () => {
    expect(notificationPermission()).toBe("unsupported");
    expect(await requestNotificationPermission()).toBe("unsupported");
    expect(await showAttentionNotification({ ...alert, id: "x", kind: "approval", level: "alert", count: 1, at: "", updatedAt: "", target: { page: "para-voce" } }, vi.fn())).toBe(false);
  });

  it("com a permissão concedida mostra a notificação com a tag do alerta; o clique abre o item", async () => {
    const instances: { title: string; options: NotificationOptions; onclick?: () => void; close: () => void }[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      onclick?: () => void;
      close = vi.fn();
      constructor(public title: string, public options: NotificationOptions) {
        instances.push(this);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("window", { focus: vi.fn() });
    const onOpen = vi.fn();
    const full = { ...alert, id: "x", kind: "approval" as const, level: "alert" as const, count: 1, at: "", updatedAt: "", target: { page: "para-voce" as const } };
    expect(await showAttentionNotification(full, onOpen)).toBe(true);
    expect(instances[0]!.title).toBe("Cyno · precisa de você");
    expect(instances[0]!.options).toMatchObject({ tag: "approval:ws:A-1", body: "Eco pede a sua aprovação (Demo)" });
    instances[0]!.onclick?.();
    expect(onOpen).toHaveBeenCalledWith(full);
  });

  it("permissão negada: não mostra nada", async () => {
    vi.stubGlobal("Notification", class {
      static permission = "denied";
    });
    expect(notificationPermission()).toBe("denied");
    expect(await requestNotificationPermission()).toBe("denied");
  });
});
