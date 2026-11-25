/**
 * Ponte opcional entre o web (@cyno/web) e a casca desktop Tauri 2 (`window.__TAURI__`).
 * Fora do aplicativo desktop (navegador, Linux, Docker), degrada silenciosamente sem erro.
 */

type TauriCore = {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

type TauriGlobal = {
  core?: TauriCore;
};

type WindowWithTauri = Window & {
  __TAURI__?: TauriGlobal;
};

export type DesktopNotifyPayload = {
  title: string;
  body?: string;
  /** Rota interna para abrir ao clicar na notificação (ex.: `/?alert=<chave>`). */
  onClickRoute?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  data?: unknown;
  /** Callback de clique no navegador (sobrepõe `onClickRoute` quando informado). */
  onClick?: () => void;
};

function tauriCore(): TauriCore | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as WindowWithTauri).__TAURI__?.core;
  return typeof candidate?.invoke === "function" ? candidate : null;
}

/** Verdadeiro quando a página está rodando dentro da casca desktop (Tauri 2). */
export function isDesktopApp(): boolean {
  return tauriCore() !== null;
}

/**
 * Abre o diálogo nativo do sistema para escolher uma pasta.
 * Fora do aplicativo desktop (ou se o usuário cancelar), devolve `null`.
 */
export async function pickFolder(): Promise<string | null> {
  const core = tauriCore();
  if (!core) return null;
  try {
    const selected = await core.invoke<string | null>("pick_folder");
    return typeof selected === "string" && selected.length > 0 ? selected : null;
  } catch {
    return null;
  }
}

/**
 * Dispara uma notificação: nativa do sistema quando dentro do Tauri, ou pela API `Notification`
 * do navegador nos demais ambientes. Devolve `true` se conseguiu enviar.
 */
export async function notify(payload: DesktopNotifyPayload): Promise<boolean> {
  const core = tauriCore();
  if (core) {
    try {
      const sent = await core.invoke<boolean>("desktop_notify", {
        title: payload.title,
        body: payload.body ?? "",
        onClickRoute: payload.onClickRoute ?? null,
      });
      return sent !== false;
    } catch {
      return false;
    }
  }

  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;

  const options: NotificationOptions = {};
  if (payload.body !== undefined) options.body = payload.body;
  if (payload.tag !== undefined) options.tag = payload.tag;
  if (payload.icon !== undefined) options.icon = payload.icon;
  if (payload.badge !== undefined) options.badge = payload.badge;
  if (payload.data !== undefined) options.data = payload.data;

  try {
    const notification = new Notification(payload.title, options);
    notification.onclick = () => {
      if (typeof window !== "undefined" && typeof window.focus === "function") {
        window.focus();
      }
      if (payload.onClick) {
        payload.onClick();
      } else if (payload.onClickRoute && typeof window !== "undefined" && typeof window.location?.assign === "function") {
        window.location.assign(payload.onClickRoute);
      }
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
