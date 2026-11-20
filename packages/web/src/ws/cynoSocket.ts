import { createWsLiveness, CYNO_WS_PATH, parseCynoEvent, WS_SILENCE_CHECK_MS, WS_SILENCE_LIMIT_MS, WS_WAKE_SILENCE_MS, type CynoServerEvent } from "@cyno/shared";
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
  /** Há quanto tempo o servidor não fala nesta conexão (para perceber a conexão que morreu em silêncio). */
  const liveness = createWsLiveness();

  const open = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${window.location.host}${CYNO_WS_PATH}`);
    socket = current;
    liveness.reset();
    current.onopen = () => {
      if (stopped) return;
      attempt = 0;
      liveness.reset();
      onStatus?.("open");
    };
    current.onmessage = (message: MessageEvent<unknown>) => {
      if (stopped || typeof message.data !== "string") return;
      liveness.seen(message.data);
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

  /** Conexão "aberta" mas calada há tempo demais (morreu em silêncio): larga e abre outra já; o snapshot traz o que faltou. */
  const replaceSilent = () => {
    const dead = socket;
    socket = null;
    if (dead) {
      dead.onmessage = null;
      try {
        dead.close();
      } catch {
        // socket em estado estranho: seguimos sem ele
      }
    }
    window.clearTimeout(retryTimer);
    attempt = 0;
    onStatus?.("reconnecting");
    open();
  };
  const isSilent = (limitMs: number) => socket?.readyState === WebSocket.OPEN && liveness.silentFor() > limitMs;
  const silenceCheck = window.setInterval(() => {
    if (!stopped && isSilent(WS_SILENCE_LIMIT_MS)) replaceSilent();
  }, WS_SILENCE_CHECK_MS);

  const wake = () => {
    if (stopped || document.visibilityState === "hidden") return;
    if (isSilent(WS_WAKE_SILENCE_MS)) {
      replaceSilent();
      return;
    }
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
    window.clearInterval(silenceCheck);
    const current = socket;
    if (!current) return;
    current.onmessage = null;
    if (current.readyState === WebSocket.CONNECTING) current.onopen = () => current.close();
    else current.close();
  };
}
