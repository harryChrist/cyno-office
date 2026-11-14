import { create } from "zustand";

/**
 * Preferências de avisos que valem só neste aparelho (localStorage `cyno:attention`, versão 1): o som,
 * o volume, quais sons tocam e a notificação do navegador. O resto (tipos, workspaces silenciados,
 * "não perturbe") é da conta e mora no servidor. Tudo desligado por padrão, menos o aviso na tela.
 */
export type DevicePrefs = {
  /** Interruptor geral do som dos avisos (desligado por padrão: o dono liga em Configurações). */
  sound: boolean;
  /** 0 a 100. */
  volume: number;
  soundKinds: {
    /** O sino para o que espera o dono (aprovação, pergunta, pedido de ajuda, terminal que caiu...). */
    pedidos: boolean;
    /** O som discreto de tarefa que falhou. */
    falhas: boolean;
    /** Limite de uso, entrega e o resto. */
    informativos: boolean;
  };
  /** Notificação do navegador (só vale com a permissão concedida e a aba escondida). */
  browserNotifications: boolean;
  /** O aviso na tela. */
  toasts: boolean;
};

export const DEVICE_PREFS_KEY = "cyno:attention";
export const DEVICE_PREFS_VERSION = 1;

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  sound: false,
  volume: 40,
  soundKinds: { pedidos: true, falhas: true, informativos: false },
  browserNotifications: false,
  toasts: true,
};

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** Lê o que está salvo com tolerância (campo faltando ou com tipo errado volta ao padrão). */
export function sanitizeDevicePrefs(raw: unknown): DevicePrefs {
  const base = DEFAULT_DEVICE_PREFS;
  if (typeof raw !== "object" || raw === null) return structuredClone(base);
  const value = raw as Partial<Record<keyof DevicePrefs, unknown>> & { version?: unknown };
  const kinds = (typeof value.soundKinds === "object" && value.soundKinds !== null ? value.soundKinds : {}) as Record<string, unknown>;
  const volume = typeof value.volume === "number" && Number.isFinite(value.volume) ? Math.min(100, Math.max(0, Math.round(value.volume))) : base.volume;
  return {
    sound: bool(value.sound, base.sound),
    volume,
    soundKinds: { pedidos: bool(kinds.pedidos, base.soundKinds.pedidos), falhas: bool(kinds.falhas, base.soundKinds.falhas), informativos: bool(kinds.informativos, base.soundKinds.informativos) },
    browserNotifications: bool(value.browserNotifications, base.browserNotifications),
    toasts: bool(value.toasts, base.toasts),
  };
}

export function loadDevicePrefs(): DevicePrefs {
  try {
    const text = window.localStorage.getItem(DEVICE_PREFS_KEY);
    return sanitizeDevicePrefs(text ? JSON.parse(text) : undefined);
  } catch {
    return structuredClone(DEFAULT_DEVICE_PREFS);
  }
}

function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    window.localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ version: DEVICE_PREFS_VERSION, ...prefs }));
  } catch {
    // Sem armazenamento (janela privada, dados bloqueados): vale nesta sessão, só não lembra.
  }
}

type DevicePrefsStore = {
  prefs: DevicePrefs;
  set: (change: Partial<Omit<DevicePrefs, "soundKinds">> & { soundKinds?: Partial<DevicePrefs["soundKinds"]> }) => void;
};

export const useDevicePrefs = create<DevicePrefsStore>()((set, get) => ({
  prefs: loadDevicePrefs(),
  set(change) {
    const current = get().prefs;
    const next = sanitizeDevicePrefs({ ...current, ...change, soundKinds: { ...current.soundKinds, ...change.soundKinds } });
    saveDevicePrefs(next);
    set({ prefs: next });
  },
}));
