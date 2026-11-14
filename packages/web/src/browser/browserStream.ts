import { browserStreamPath, type BrowserClientMessage, type BrowserServerMessage } from "@cyno/shared";

/** Endereço do WebSocket da tela ao vivo (mesma origem: o Vite repassa /api ao server). */
export function browserStreamUrl(workspaceId: string): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${browserStreamPath(workspaceId)}`;
}

/** Tecla do teclado do navegador -> o que mandar: texto (`type`) ou nome de tecla do Playwright (`key`). */
export function keyMessage(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): Extract<BrowserClientMessage, { t: "type" | "key" }> | null {
  const { key } = event;
  if (key === "Dead" || key === "Unidentified" || key === "Process") return null;
  if (["Control", "Shift", "Alt", "Meta", "CapsLock", "OS"].includes(key)) return null;
  const modifiers = [event.ctrlKey ? "Control" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : ""].filter(Boolean);
  if (key.length === 1 && modifiers.length === 0) return { t: "type", text: key };
  const name = key === " " ? "Space" : key;
  return { t: "key", key: [...modifiers, ...(event.shiftKey && key.length > 1 ? ["Shift"] : []), name].join("+") };
}

export type StreamStatus = "connecting" | "open" | "closed";

export type BrowserStreamHandlers = {
  onFrame: (tab: string, data: string) => void;
  onGone: (tab: string) => void;
  onError: (message: string) => void;
  onStatus: (status: StreamStatus) => void;
};

/**
 * Conexão da tela ao vivo + controle remoto. Reconecta sozinha (e volta a assistir à mesma aba).
 * `watch(tab)` troca a aba transmitida; `send` manda clique/rolagem/teclas para a aba assistida.
 */
export class BrowserStream {
  private socket: WebSocket | null = null;
  private tab: string | null = null;
  private retry: number | undefined;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: BrowserStreamHandlers,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.handlers.onStatus("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.handlers.onStatus("open");
      if (this.tab) this.raw({ t: "watch", tab: this.tab });
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: BrowserServerMessage;
      try {
        message = JSON.parse(event.data) as BrowserServerMessage;
      } catch {
        return;
      }
      if (message.t === "frame") this.handlers.onFrame(message.tab, message.data);
      else if (message.t === "gone") this.handlers.onGone(message.tab);
      else if (message.t === "error") this.handlers.onError(message.message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handlers.onStatus("closed");
      // 4409 = navegador desligado no server: não adianta tentar de novo.
      if (!this.closed && event.code !== 4409) this.retry = window.setTimeout(() => this.connect(), 1500);
    };
  }

  private raw(message: BrowserClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  watch(tab: string | null): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.raw({ t: "watch", tab });
  }

  send(message: Exclude<BrowserClientMessage, { t: "watch" }>): void {
    if (this.tab) this.raw(message);
  }

  close(): void {
    this.closed = true;
    if (this.retry !== undefined) window.clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
