import { parseServerMessage, workspaceSocketPath, WS_PATH, type EventCursor, type ServerEvent } from "@cyno/shared";
import { checkSessionAfterDrop } from "../auth/authStore";
import { healthPollDelay, retryDelay, uiDownPollDelay } from "./backoff";

/** connecting = primeira tentativa; open = ao vivo; reconnecting = caiu e vai tentar de novo. */
export type SocketStatus = "connecting" | "open" | "reconnecting";

export type OfficeSocketHandlers = {
  /** Workspace cujos eventos queremos (null = o primeiro da lista, escolhido pelo server). */
  workspaceId: string | null;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: SocketStatus) => void;
};

function socketUrl(workspaceId: string | null, cursor: EventCursor | null): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${workspaceId ? workspaceSocketPath(workspaceId, cursor) : WS_PATH}`;
}

/** Rota do Vite (dev e preview), fora do proxy: diz se o backend está de pé sem gerar erro algum. */
export const BACKEND_HEALTH_PATH = "/__backend-health";

/** Resultado da consulta: backend de pé, backend fora, ou o próprio servidor da UI fora (fetch falhou). */
export type BackendHealth = "up" | "down" | "ui-down";

/**
 * Consulta /__backend-health. Sem a rota (servido por outro servidor que não o Vite) ou com resposta
 * estranha, dá "up": aí o WS é tentado direto, como antes.
 */
export async function probeBackend(): Promise<BackendHealth> {
  try {
    const res = await fetch(BACKEND_HEALTH_PATH, { cache: "no-store" });
    if (!res.ok) return "up";
    const body = (await res.json()) as { up?: unknown };
    return body.up === false ? "down" : "up";
  } catch {
    return "ui-down";
  }
}

/** O backend está de pé? (false também com o próprio servidor da UI fora.) */
export async function backendUp(): Promise<boolean> {
  return (await probeBackend()) === "up";
}

/**
 * Em dev, o próprio servidor da UI (Vite) caiu? O cliente de HMR do Vite avisa quando o socket dele
 * cai e quando volta: enquanto ele está fora, nem adianta consultar /__backend-health (cada consulta
 * viraria um ERR_CONNECTION_REFUSED no console). Em produção não há HMR: vale o backoff longo.
 */
const uiServer = (() => {
  let down = false;
  const waiting = new Set<() => void>();
  const hot = import.meta.hot;
  if (hot) {
    hot.on("vite:ws:disconnect", () => {
      down = true;
    });
    hot.on("vite:ws:connect", () => {
      down = false;
      const resume = [...waiting];
      waiting.clear();
      for (const fn of resume) fn();
    });
  }
  return {
    /** Sabemos (pelo HMR) que o servidor da UI está fora? */
    isDown: () => down,
    /** Dá para esperar o aviso de volta (só em dev)? */
    canWait: () => hot !== undefined,
    /** Chama `fn` quando o servidor da UI voltar; devolve a função que cancela. */
    whenBack: (fn: () => void) => {
      waiting.add(fn);
      return () => waiting.delete(fn);
    },
  };
})();

/**
 * Conecta no WebSocket de eventos de um workspace e reconecta sozinho (backoff exponencial com jitter).
 *
 * Nada se perde numa queda: guarda o cursor (`epoch` do hub + último `seq` recebido) e reconecta com
 * `?since=&epoch=`. O server responde `sync:resumed` e reenvia só os eventos que faltaram (aplicados
 * em ordem; um `seq` repetido é descartado) ou, se já não os tem (server reiniciou, queda longa
 * demais), manda o `office:snapshot` e as stores fazem a ressincronização total.
 * Aba que volta para a frente (ou rede que volta) com o socket caído reconecta na hora, sem esperar o backoff.
 * Antes de cada tentativa consulta /__backend-health: com o server fora (reinício) não abre o WS,
 * então o navegador não loga a falha do handshake nem o proxy do Vite loga ECONNREFUSED. Com o
 * próprio servidor da UI fora, nem consulta (veja `uiServer`).
 * Não escreve nada no console: o estado da conexão sai por `onStatus`.
 * Mensagens que não são ServerEvent (ex.: heartbeat do server) são ignoradas.
 * Retorna a função que encerra a conexão de vez.
 */
export function connectOfficeSocket({ workspaceId, onEvent, onStatus }: OfficeSocketHandlers): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let probes = 0;
  let uiProbes = 0;
  let retryTimer: number | undefined;
  let cancelWait: (() => void) | null = null;
  let stopped = false;
  /** Consulta ao /__backend-health em voo (não dispara outra por cima). */
  let probing = false;
  /** Até onde já recebemos os eventos deste workspace (null = ainda sem snapshot: conexão nova). */
  let cursor: EventCursor | null = null;

  /** Guarda o cursor e diz se o evento é novo (false = repetido, já aplicado). */
  const advance = (event: ServerEvent, seq: number | undefined): boolean => {
    if (event.type === "office:snapshot") {
      cursor = event.epoch !== undefined && seq !== undefined ? { epoch: event.epoch, seq } : null;
      return true;
    }
    if (event.type === "sync:resumed") {
      // Mesmo epoch; o seq avança com cada evento reenviado.
      if (cursor?.epoch !== event.epoch) cursor = { epoch: event.epoch, seq: event.since };
      return true;
    }
    if (seq === undefined || !cursor) return true;
    if (seq <= cursor.seq) return false;
    cursor = { ...cursor, seq };
    return true;
  };

  /** Espera o servidor da UI voltar (aviso do HMR) e então tenta de novo. */
  const waitForUi = () => {
    cancelWait = uiServer.whenBack(() => {
      cancelWait = null;
      if (!stopped) connect();
    });
  };

  /** Espera o backend ficar de pé (consultas com backoff) e então abre o WS. */
  const connect = () => {
    if (uiServer.isDown()) {
      waitForUi();
      return;
    }
    probing = true;
    void probeBackend().then((health) => {
      probing = false;
      if (stopped) return;
      if (health === "up") {
        probes = 0;
        uiProbes = 0;
        open();
        return;
      }
      if (health === "ui-down") {
        // O servidor da UI caiu: em dev espera o HMR avisar a volta; senão tenta bem mais devagar.
        if (uiServer.canWait() && uiServer.isDown()) {
          waitForUi();
          return;
        }
        retryTimer = window.setTimeout(connect, uiDownPollDelay(uiProbes));
        uiProbes += 1;
        return;
      }
      uiProbes = 0;
      retryTimer = window.setTimeout(connect, healthPollDelay(probes));
      probes += 1;
    });
  };

  const open = () => {
    const current = new WebSocket(socketUrl(workspaceId, cursor));
    socket = current;
    current.onopen = () => {
      if (stopped) return;
      attempt = 0;
      onStatus?.("open");
    };
    current.onmessage = (message: MessageEvent<unknown>) => {
      if (stopped || typeof message.data !== "string") return;
      const parsed = parseServerMessage(message.data);
      if (parsed && advance(parsed.event, parsed.seq)) onEvent(parsed.event);
    };
    // Um erro sempre é seguido de close; a reconexão é tratada só lá.
    current.onerror = () => {};
    current.onclose = () => {
      // Socket já substituído (o `wake` reconectou antes deste close chegar): nada a fazer.
      if (stopped || socket !== current) return;
      onStatus?.("reconnecting");
      // O upgrade recusado por falta de sessão também só aparece como um close: confere com o servidor.
      void checkSessionAfterDrop();
      retryTimer = window.setTimeout(connect, retryDelay(attempt));
      attempt += 1;
    };
  };

  /**
   * A aba voltou para a frente (celular desbloqueado, aba trocada) ou a rede voltou: com o socket
   * caído e esperando o backoff, tenta já. Aberto, abrindo ou consultando o health: nada a fazer.
   */
  const wake = () => {
    if (stopped || document.visibilityState === "hidden" || probing || cancelWait) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    // Ainda fechando (o close dele vai ser ignorado): o status muda aqui.
    if (socket?.readyState === WebSocket.CLOSING) onStatus?.("reconnecting");
    socket = null;
    window.clearTimeout(retryTimer);
    attempt = 0;
    probes = 0;
    connect();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);

  onStatus?.("connecting");
  connect();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.clearTimeout(retryTimer);
    cancelWait?.();
    const current = socket;
    if (!current) return;
    current.onmessage = null;
    if (current.readyState === WebSocket.CONNECTING) {
      // Fechar durante o handshake gera aviso no console (StrictMode); fecha assim que abrir.
      current.onopen = () => current.close();
    } else {
      current.close();
    }
  };
}
