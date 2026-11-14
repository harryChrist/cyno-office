import { CYNO_WS_PATH, parseCynoEvent, type CynoServerEvent } from "@cyno/shared";
import { checkSessionAfterDrop } from "../auth/authStore";
import { retryDelay } from "./backoff";

export type CynoSocketStatus = "connecting" | "open" | "reconnecting";

/**
 * Conecta no websocket do Cyno (`/api/cyno/ws`) e reconecta sozinho (backoff com jitter). Cada
 * conexão começa com um `cyno:snapshot` (estado e as entradas recentes), então não há cursor: o que
 * se perdeu numa queda volta no snapshot. Aba que volta para a frente com o socket caído reconecta
 * na hora. Devolve a função que encerra a conexão de vez.
 */
export function connectCynoSocket({ onEvent, onStatus }: { onEvent: (event: CynoServerEvent) => void; onStatus?: (status: CynoSocketStatus) => void }): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: number | undefined;
  let stopped = false;

  const open = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${window.location.host}${CYNO_WS_PATH}`);
    socket = current;
    current.onopen = () => {
      if (stopped) return;
      attempt = 0;
      onStatus?.("open");
    };
    current.onmessage = (message: MessageEvent<unknown>) => {
      if (stopped || typeof message.data !== "string") return;
      try {
        const event = parseCynoEvent(JSON.parse(message.data));
        if (event) onEvent(event);
      } catch {
        // Mensagem que não é JSON (ex.: heartbeat): ignora.
      }
    };
    current.onerror = () => {};
    current.onclose = () => {
      if (stopped || socket !== current) return;
      onStatus?.("reconnecting");
      void checkSessionAfterDrop();
      retryTimer = window.setTimeout(open, retryDelay(attempt));
      attempt += 1;
    };
  };

  const wake = () => {
    if (stopped || document.visibilityState === "hidden") return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    window.clearTimeout(retryTimer);
    attempt = 0;
    open();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);

  onStatus?.("connecting");
  open();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.clearTimeout(retryTimer);
    const current = socket;
    if (!current) return;
    current.onmessage = null;
    if (current.readyState === WebSocket.CONNECTING) current.onopen = () => current.close();
    else current.close();
  };
}
