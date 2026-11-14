import type { TerminalStatus } from "@cyno/shared";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { clipboardKey, TerminalSocket, terminalSocketUrl, terminalStatusLabel, type TerminalConnection } from "./maestroTerminalClient";

/** Cor de um token do tema (as variáveis --ui-* do app), com reserva. */
function token(name: string, fallback: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Tema escuro do xterm com as cores do app (fundo do painel, texto, destaque roxo). */
function xtermTheme(): ITheme {
  return {
    background: token("--ui-bg", "#0b0d1a"),
    foreground: token("--ui-text", "#e7e9f6"),
    cursor: token("--ui-accent", "#8b7cff"),
    cursorAccent: token("--ui-bg", "#0b0d1a"),
    selectionBackground: "rgba(139, 124, 255, 0.35)",
    black: "#1b1f36",
    brightBlack: "#5b6183",
    red: "#ff6b81",
    brightRed: "#ff8fa0",
    green: "#4fd6a0",
    brightGreen: "#7ee8bd",
    yellow: "#f5c46b",
    brightYellow: "#ffd98f",
    blue: "#6aa8ff",
    brightBlue: "#94c1ff",
    magenta: "#b18cff",
    brightMagenta: "#cbb0ff",
    cyan: "#5ed3e6",
    brightCyan: "#8be4f1",
    white: "#d5d8ea",
    brightWhite: "#ffffff",
  };
}

/** Copia texto mesmo fora de contexto seguro (http na rede local não tem navigator.clipboard). */
export function copyText(text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    void navigator.clipboard.writeText(text).catch(() => undefined);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

type Props = {
  workspaceId: string;
  /** A aba do terminal está à vista (ao voltar, ajusta o tamanho e foca). */
  visible: boolean;
};

/**
 * O terminal do Maestro de verdade no navegador: o `claude` interativo dele (TUI) desenhado num
 * xterm, ao vivo pelo WebSocket do server. Dá para digitar (inclusive comandos `/`), rolar,
 * selecionar e copiar (Ctrl+C com seleção, Ctrl+Shift+C) e colar (Ctrl+V). A tela acompanha o
 * tamanho do painel. Se a conexão cai, reconecta e redesenha.
 */
export function MaestroTerminal({ workspaceId, visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const [connection, setConnection] = useState<TerminalConnection>("connecting");
  const [status, setStatus] = useState<TerminalStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: token("--ui-font-mono", "ui-monospace, monospace"),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(),
      allowTransparency: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, "_blank", "noopener,noreferrer");
    }));
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const fitNow = () => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return; // aba escondida: não encolhe para 0
      try {
        fit.fit();
      } catch {
        // ainda sem medidas
      }
    };
    fitNow();

    const sendSize = () => socketRef.current?.send({ t: "resize", cols: term.cols, rows: term.rows });
    const socket = new TerminalSocket({
      url: terminalSocketUrl(window.location, workspaceId),
      onConnection: setConnection,
      onOpen: () => {
        fitNow();
        sendSize();
      },
      onMessage: (message) => {
        switch (message.t) {
          case "hello":
            term.reset();
            setStatus(message.status);
            setError(message.error);
            return;
          case "replay":
          case "out":
            term.write(message.d);
            return;
          case "status":
            setStatus(message.status);
            setError(message.status === "error" ? message.error : undefined);
            return;
          default:
            return;
        }
      },
    });
    socketRef.current = socket;

    const offData = term.onData((data) => socket.send({ t: "in", d: data }));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const offResize = term.onResize(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendSize, 80);
    });
    term.attachCustomKeyEventHandler((event) => {
      const action = clipboardKey(event, term.hasSelection());
      if (action === "copy") {
        copyText(term.getSelection());
        term.clearSelection();
        event.preventDefault();
        return false;
      }
      // Colar: deixa o navegador mandar o evento de colar (o xterm cola com bracketed paste).
      if (action === "paste") return false;
      return true;
    });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => fitNow());
    observer?.observe(host);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      offData.dispose();
      offResize.dispose();
      socket.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [workspaceId]);

  // Voltou para a aba: ajusta ao espaço e foca.
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // sem medidas
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const chip = terminalStatusLabel(status, connection);
  const stopped = connection === "open" && (status === "stopped" || status === "error");
  return (
    <div className="mterm" data-testid="maestro-terminal" data-status={status ?? "unknown"} data-connection={connection}>
      <div className="mterm__bar">
        <span className={`work-status work-status--${chip.tone} mterm__status`} data-testid="maestro-terminal-status">
          <span className="work-status__dot" aria-hidden="true" />
          {chip.label}
        </span>
        <span className="mterm__hint">
          Digite aqui como no seu terminal: <kbd>/</kbd> abre os comandos do Claude Code · <kbd>Esc</kbd> interrompe · <kbd>Ctrl</kbd>+<kbd>C</kbd> com seleção copia
        </span>
        {connection === "reconnecting" && (
          <button type="button" className="ui-link mterm__retry" onClick={() => socketRef.current?.retry()}>
            Reconectar agora
          </button>
        )}
      </div>
      <div className="mterm__screen">
        <div ref={hostRef} className="mterm__xterm" aria-label="Terminal do Maestro (Claude Code)" />
        {connection === "unavailable" && (
          <div className="mterm__overlay" role="status">
            <p className="mterm__overlay-title">O Maestro não roda num terminal agora.</p>
            <p className="mterm__overlay-text">Só o Maestro com motor Claude Code tem terminal. Troque o motor no painel dele.</p>
          </div>
        )}
        {stopped && (
          <div className="mterm__overlay" role="status" data-testid="maestro-terminal-stopped">
            <p className="mterm__overlay-title">{status === "error" ? "O terminal do Maestro caiu." : "O terminal do Maestro está parado."}</p>
            {error && <p className="mterm__overlay-text">{error}</p>}
            <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => socketRef.current?.send({ t: "start" })} data-testid="maestro-terminal-start">
              Ligar o terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
