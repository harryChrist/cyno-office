import type { AttentionAlert } from "@cyno/shared";
import { isDesktopApp, notify as desktopNotify } from "../desktop/desktopBridge";

/** A permissão de notificação (nativa no desktop ou do navegador), com "sem suporte" no lugar de uma exceção. */
export type NotificationPermissionState = "unsupported" | "default" | "granted" | "denied";

export function notificationPermission(): NotificationPermissionState {
  if (isDesktopApp()) return "granted";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Pede a permissão (chamar de dentro de um clique). Devolve o estado final. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isDesktopApp()) return "granted";
  const state = notificationPermission();
  if (state !== "default") return state;
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

/** O texto da notificação: o que é e de quem. */
export function notificationContent(alert: Pick<AttentionAlert, "text" | "needsOwner" | "workspaceName" | "key">): { title: string; body: string; tag: string } {
  return {
    title: alert.needsOwner ? "Cyno · precisa de você" : "Cyno",
    body: alert.workspaceName ? `${alert.text} (${alert.workspaceName})` : alert.text,
    // A chave faz a notificação nova substituir a anterior do mesmo alerta.
    tag: alert.key,
  };
}

/** Registra o service worker mínimo (o Android só mostra notificação por ele). Só roda com a opção ligada. */
export async function ensureNotificationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  } catch {
    return undefined;
  }
}

/**
 * Mostra a notificação. No aplicativo desktop usa a ponte nativa (`desktopBridge`); no navegador,
 * com service worker usa `registration.showNotification` (único jeito no Android) e sem ele delega
 * para a ponte (construtor `Notification`). O clique traz a aba e leva ao item (`onOpen`).
 */
export async function showAttentionNotification(alert: AttentionAlert, onOpen: (alert: AttentionAlert) => void): Promise<boolean> {
  if (notificationPermission() !== "granted") return false;
  const { title, body, tag } = notificationContent(alert);
  if (isDesktopApp()) {
    return desktopNotify({ title, body, tag, onClickRoute: `/?alert=${encodeURIComponent(alert.key)}` });
  }
  const options: NotificationOptions = { body, tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { key: alert.key } };
  try {
    const registration = await ensureNotificationWorker();
    if (registration) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch {
    // Cai para o construtor via ponte.
  }
  return desktopNotify({
    title,
    body,
    tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { key: alert.key },
    onClick: () => onOpen(alert),
  });
}

/** O clique numa notificação feita pelo service worker avisa a página por mensagem. */
export function listenNotificationClicks(onKey: (key: string | undefined) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => undefined;
  const handler = (event: MessageEvent) => {
    const data = event.data as { type?: string; key?: string } | undefined;
    if (data?.type === "cyno:attention-open") onKey(data.key);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
