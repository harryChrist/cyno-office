import {
  maestroTerminalPath,
  WS_CLOSE_NO_MAESTRO_TERMINAL,
  type MaestroTerminalClientMessage,
  type MaestroTerminalServerMessage,
  type RemoteControlInfo,
  type TerminalStatus,
} from "@cyno/shared";
import { retryDelay } from "../ws/backoff";

/** connecting: abrindo; open: ao vivo; reconnecting: caiu e tenta de novo; unavailable: o Maestro não tem terminal. */
export type TerminalConnection = "connecting" | "open" | "reconnecting" | "unavailable";

const STATUSES: readonly TerminalStatus[] = ["stopped", "starting", "idle", "busy", "error"];

/** URL do WebSocket do terminal do Maestro (ws:/wss: conforme a página). */
export function terminalSocketUrl(location: Pick<Location, "protocol" | "host">, workspaceId: string): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${maestroTerminalPath(workspaceId)}`;
}

function remoteOf(value: unknown): RemoteControlInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { active, name, url } = value as Record<string, unknown>;
  if (typeof active !== "boolean") return undefined;
  return { active, ...(typeof name === "string" ? { name } : {}), ...(typeof url === "string" && url.startsWith("https://") ? { url } : {}) };
}

/** Lê uma mensagem do server com cuidado (formato estranho = null, nunca lança). */
export function parseTerminalMessage(raw: string): MaestroTerminalServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  const status = STATUSES.includes(message.status as TerminalStatus) ? (message.status as TerminalStatus) : undefined;
  const error = typeof message.error === "string" ? message.error : undefined;
  switch (message.t) {
    case "hello": {
      const cols = typeof message.cols === "number" ? message.cols : 0;
      const rows = typeof message.rows === "number" ? message.rows : 0;
      if (!status) return null;
      const remote = remoteOf(message.remote);
      return { t: "hello", status, cols, rows, ...(remote ? { remote } : {}), ...(error ? { error } : {}) };
    }
    case "replay":
    case "out":
      return typeof message.d === "string" ? { t: message.t, d: message.d } : null;
    case "status":
      return status ? { t: "status", status, ...(error ? { error } : {}) } : null;
    case "remote": {
      const remote = remoteOf(message.remote);
      return remote ? { t: "remote", remote } : null;
    }
    case "exit":
      return { t: "exit", code: typeof message.code === "number" ? message.code : null };
    default:
      return null;
  }
}

/** O pedaço do WebSocket do navegador que a conexão usa (os testes passam um falso). */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
};

export type TerminalSocketOptions = {
  url: string;
  onMessage: (message: MaestroTerminalServerMessage) => void;
  onConnection: (state: TerminalConnection) => void;
  /** Ao abrir (e a cada reconexão): ex.: mandar o tamanho da tela. */
  onOpen?: () => void;
  createSocket?: (url: string) => SocketLike;
  delay?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

const OPEN = 1;

/**
 * Conexão do xterm com o terminal do Maestro: reconecta sozinha com espera crescente (o server
 * reiniciando, a rede caindo) e para de vez com o código 4409 (o Maestro não roda num terminal).
 */
export class TerminalSocket {
  private socket: SocketLike | undefined;
  private attempt = 0;
  private timer: unknown;
  private closed = false;

  constructor(private readonly options: TerminalSocketOptions) {
    this.connect();
  }

  send(message: MaestroTerminalClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Tenta de novo agora (ex.: o usuário clicou em "Reconectar"). */
  retry(): void {
    if (this.closed) return;
    if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = undefined;
    this.attempt = 0;
    if (!this.socket) this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  private connect(): void {
    this.options.onConnection(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.options.onConnection("open");
      this.options.onOpen?.();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseTerminalMessage(event.data);
      if (message) this.options.onMessage(message);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.closed) return;
      if (event.code === WS_CLOSE_NO_MAESTRO_TERMINAL) {
        this.options.onConnection("unavailable");
        return;
      }
      this.options.onConnection("reconnecting");
      const wait = (this.options.delay ?? retryDelay)(this.attempt++);
      this.timer = (this.options.setTimer ?? setTimeout)(() => {
        this.timer = undefined;
        if (!this.closed) this.connect();
      }, wait);
    };
  }
}

/** Atalhos de copiar/colar do terminal no navegador (Ctrl+C só copia quando há seleção). */
export type ClipboardKey = "copy" | "paste" | null;

export function clipboardKey(event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "metaKey" | "shiftKey">, hasSelection: boolean): ClipboardKey {
  if (event.type !== "keydown") return null;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return null;
  if (key === "c" && (event.shiftKey || hasSelection)) return "copy";
  if (key === "v") return "paste";
  return null;
}

/** Rótulo do estado do terminal para o painel. */
export function terminalStatusLabel(status: TerminalStatus | undefined, connection: TerminalConnection): { label: string; tone: "neutral" | "busy" | "success" | "danger" | "attention" } {
  if (connection === "unavailable") return { label: "Sem terminal", tone: "neutral" };
  if (connection !== "open") return { label: connection === "connecting" ? "Conectando…" : "Reconectando…", tone: "attention" };
  switch (status) {
    case "busy":
      return { label: "Trabalhando", tone: "busy" };
    case "idle":
      return { label: "Pronto", tone: "success" };
    case "starting":
      return { label: "Ligando…", tone: "attention" };
    case "error":
      return { label: "Caiu", tone: "danger" };
    default:
      return { label: "Parado", tone: "neutral" };
  }
}
