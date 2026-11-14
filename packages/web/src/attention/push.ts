import { PUSH_DEVICES_PATH, PUSH_KEY_PATH, PUSH_SUBSCRIBE_PATH, PUSH_TEST_PATH, PUSH_UNSUBSCRIBE_PATH, type PushDevicesResponse, type PushKeyResponse, type PushSubscribeResponse, type PushTestResponse } from "@cyno/shared";
import { requestJson } from "../api/client";
import { ensureNotificationWorker, notificationPermission, requestNotificationPermission, type NotificationPermissionState } from "./notify";

/**
 * O aviso com o site fechado (Web Push), do lado do navegador. O estado deste aparelho:
 * - `insecure`: o endereço não é seguro (http://192.168.x.x): o navegador nem oferece push; só `https` e `localhost`;
 * - `unsupported`: o navegador não tem service worker, push ou notificação (no iPhone: só com o site na tela de início);
 * - `blocked`: o dono bloqueou as notificações do site no navegador;
 * - `off`: pode ligar; `on`: este aparelho está inscrito.
 */
export type PushState = "insecure" | "unsupported" | "blocked" | "off" | "on";

/** Pura: o estado a partir do que o navegador diz. */
export function pushStateOf(input: { secure: boolean; supported: boolean; permission: NotificationPermissionState; subscribed: boolean }): PushState {
  if (!input.secure) return "insecure";
  if (!input.supported) return "unsupported";
  if (input.permission === "denied") return "blocked";
  return input.subscribed && input.permission === "granted" ? "on" : "off";
}

/** O navegador tem as três peças do push? */
export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && typeof Notification !== "undefined";
}

export function isSecure(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/** Pura: "Chrome no Android", "Safari no iPhone" a partir do texto do navegador (só para o dono reconhecer o aparelho). */
export function deviceName(userAgent: string): string {
  const ua = userAgent || "";
  const system = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux|X11/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return system ? `${browser} no ${system}` : browser;
}

/** Pura: a chave pública VAPID (base64url) como bytes, no formato que `pushManager.subscribe` pede. */
export function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Pura: de `?alert=<chave>` tira a chave (ou nada). */
export function alertKeyFromSearch(search: string): string | undefined {
  const key = new URLSearchParams(search).get("alert");
  return key && key.length <= 200 ? key : undefined;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** O estado de agora (lê o navegador). */
export async function readPushState(): Promise<{ state: PushState; endpoint?: string }> {
  const subscription = await currentSubscription();
  const state = pushStateOf({ secure: isSecure(), supported: pushSupported(), permission: notificationPermission(), subscribed: subscription !== null });
  return { state, ...(subscription ? { endpoint: subscription.endpoint } : {}) };
}

/** Liga neste aparelho (chamar de dentro de um clique: é aqui que o navegador pergunta a permissão). */
export async function enablePush(): Promise<PushState> {
  if (!isSecure()) return "insecure";
  if (!pushSupported()) return "unsupported";
  const permission = await requestNotificationPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const registration = await ensureNotificationWorker();
  if (!registration) return "unsupported";
  const { publicKey } = await requestJson<PushKeyResponse>(PUSH_KEY_PATH);
  const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("O navegador não devolveu as chaves da inscrição");
  await requestJson<PushSubscribeResponse>(PUSH_SUBSCRIBE_PATH, {
    method: "POST",
    body: { subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, name: deviceName(navigator.userAgent) },
  });
  return "on";
}

/** Desliga neste aparelho: tira do servidor e do navegador. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await requestJson<void>(PUSH_UNSUBSCRIBE_PATH, { method: "POST", body: { endpoint } }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => false);
}

export const pushApi = {
  devices: () => requestJson<PushDevicesResponse>(PUSH_DEVICES_PATH),
  removeDevice: (id: string) => requestJson<void>(`${PUSH_DEVICES_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  test: (endpoint?: string) => requestJson<PushTestResponse>(PUSH_TEST_PATH, { method: "POST", body: endpoint ? { endpoint } : {} }),
};
