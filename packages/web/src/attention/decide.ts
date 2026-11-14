import { ATTENTION_STALE_MS, silenceReason, type AttentionAlert, type AttentionPrefs } from "@cyno/shared";
import type { DevicePrefs } from "./devicePrefs";

/**
 * As decisões da cadeia de atenção no navegador, todas puras (testadas por tabela): se o aviso
 * aparece, se toca som e se vira notificação do navegador. O alerta em si já nasceu no servidor;
 * aqui só se escolhe como chamar o dono, respeitando o que ele ligou e desligou.
 */

/** "chime" = o sino de quem espera o dono; "soft" = o som discreto (tarefa que falhou, avisos). */
export type AttentionSound = "chime" | "soft";

/** Intervalo mínimo entre dois sons quaisquer. */
export const SOUND_MIN_GAP_MS = 1_200;
/** Alerta que espera o dono: um sino por 20 s. */
export const SOUND_ALERT_GAP_MS = 20_000;
/** Aviso (falha, limite): um som a cada 5 min. */
export const SOUND_WARN_GAP_MS = 5 * 60_000;

/** Quando cada som tocou por último (guardado pelo chamador). */
export type SoundMemory = { lastAt: number; lastAlertAt: number; lastWarnAt: number };
export const EMPTY_SOUND_MEMORY: SoundMemory = { lastAt: 0, lastAlertAt: 0, lastWarnAt: 0 };

const soundClassOf = (alert: Pick<AttentionAlert, "level">): "alert" | "warn" => (alert.level === "alert" ? "alert" : "warn");

/**
 * Que som toca para este alerta (ou nenhum). Com a aba escondida os dois sons tocam: é o som que
 * chama o dono de volta. Desligado por padrão: o dono liga em Configurações.
 */
export function decideSound(device: DevicePrefs, account: AttentionPrefs, alert: AttentionAlert, memory: SoundMemory, now: number): AttentionSound | null {
  if (!device.sound || device.volume <= 0) return null;
  if (alert.replay) return null;
  if (silenceReason(account, alert, now) !== null) return null;
  let sound: AttentionSound;
  // A entrega é aviso discreto: nunca toca (a lista "Feito hoje" e o sino já mostram).
  if (alert.kind === "delivery") return null;
  if (alert.kind === "failed") {
    if (!device.soundKinds.falhas) return null;
    sound = "soft";
  } else if (alert.needsOwner) {
    if (!device.soundKinds.pedidos) return null;
    sound = "chime";
  } else {
    if (!device.soundKinds.informativos) return null;
    sound = alert.level === "alert" ? "chime" : "soft";
  }
  if (now - memory.lastAt < SOUND_MIN_GAP_MS) return null;
  if (soundClassOf(alert) === "alert" ? now - memory.lastAlertAt < SOUND_ALERT_GAP_MS : now - memory.lastWarnAt < SOUND_WARN_GAP_MS) return null;
  return sound;
}

/** Marca que o som tocou. */
export function noteSound(memory: SoundMemory, alert: Pick<AttentionAlert, "level">, now: number): SoundMemory {
  return soundClassOf(alert) === "alert" ? { ...memory, lastAt: now, lastAlertAt: now } : { ...memory, lastAt: now, lastWarnAt: now };
}

export type NotifyContext = { hidden: boolean; permission: "granted" | "denied" | "default" | "unsupported"; now: number };

/**
 * A notificação do navegador só vale com TODAS estas condições: o dono ligou a opção, o navegador
 * concedeu a permissão, a aba está escondida (com a aba à vista só vale o aviso), o alerta é de nível
 * `alert`, não é reabertura nem eco do boot, e o tipo, o workspace e o "não perturbe" deixam.
 */
export function decideNotify(device: DevicePrefs, account: AttentionPrefs, alert: AttentionAlert, context: NotifyContext): boolean {
  if (!device.browserNotifications || context.permission !== "granted" || !context.hidden) return false;
  if (alert.level !== "alert" || alert.replay) return false;
  return silenceReason(account, alert, context.now) === null;
}

export type ToastContext = { visible: boolean; onTarget: boolean; now: number };

/**
 * O aviso na tela. Quem já está olhando para o lugar do alerta (a aba à vista e a tela atual é o
 * destino) não é avisado: o cartão novo já está na frente dele. Eco do boot, da reconexão, reabertura
 * e alerta velho não viram aviso; entrega só avisa se o dono ligou.
 */
export function decideToast(device: DevicePrefs, account: AttentionPrefs, alert: AttentionAlert, context: ToastContext): boolean {
  if (!device.toasts || alert.replay) return false;
  if (silenceReason(account, alert, context.now) !== null) return false;
  if (context.now - Date.parse(alert.at) > ATTENTION_STALE_MS) return false;
  if (alert.kind === "delivery" && account.kinds.delivery !== true) return false;
  return !(context.visible && context.onTarget);
}

export type NavPlace = { page: string; sub: string; workspaceId: string | null };

/** O dono já está na tela para onde o alerta leva? */
export function isOnTarget(alert: Pick<AttentionAlert, "target">, place: NavPlace): boolean {
  const { target } = alert;
  if (target.workspaceId && target.workspaceId !== place.workspaceId) return false;
  if (target.page === "gestao") return place.page === "gestao" && (target.ref ? place.sub.split("?")[0]!.startsWith(target.ref) : true);
  return place.page === target.page;
}
