import { useEffect, useState } from "react";
import { useOfficeStore } from "../store/officeStore";
import type { SocketStatus } from "../ws/officeSocket";

const SOCKET_LABELS: Record<SocketStatus, string> = {
  connecting: "Conectando…",
  open: "Ao vivo",
  reconnecting: "Reconectando…",
};

/** Sem conexão por mais que isso (ms): o indicador diz com todas as letras que o servidor está fora. */
export const SERVER_DOWN_AFTER_MS = 5000;
export const SERVER_DOWN_LABEL = "Servidor fora do ar — tentando reconectar…";

/** O socket está fora ("Conectando…" ou "Reconectando…") há mais de `SERVER_DOWN_AFTER_MS`? */
function useServerDown(socket: SocketStatus, since: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (socket === "open") return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, since + SERVER_DOWN_AFTER_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [socket, since]);
  return socket !== "open" && now - since >= SERVER_DOWN_AFTER_MS;
}

/**
 * Indicador do WebSocket de eventos. Ao vivo, fica só para leitores de tela (a pílula de status
 * mostra o ponto verde); reconectando vira uma pílula âmbar e, com o servidor fora, vermelha.
 */
export function SocketIndicator() {
  const socket = useOfficeStore((state) => state.socket);
  const since = useOfficeStore((state) => state.socketSince);
  const down = useServerDown(socket, since);
  return (
    <span
      className={`conn conn--${socket}${down ? " conn--down" : ""}`}
      role="status"
      data-testid="socket-status"
      data-state={socket}
      data-down={down ? "true" : undefined}
      title={down ? SERVER_DOWN_LABEL : SOCKET_LABELS[socket]}
    >
      <span className="conn__dot" aria-hidden="true" />
      <span className="conn__text">{down ? SERVER_DOWN_LABEL : SOCKET_LABELS[socket]}</span>
    </span>
  );
}
