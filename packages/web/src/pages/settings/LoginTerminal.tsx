import { ENGINE_LABELS, type AccountEngine } from "@cyno/shared";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { copyText, token, xtermTheme } from "../../agentWork/MaestroTerminal";
import { clipboardKey } from "../../agentWork/maestroTerminalClient";
import { useAuthStore } from "../../auth/authStore";
import { useModalDialog } from "../../ui/widgets";
import {
  appendUrlBuffer,
  buildPasteCodeMessage,
  clampLoginPtySize,
  extractLastHttpsUrl,
  INITIAL_LOGIN_TERMINAL_STATE,
  loginExitMessage,
  loginHttpPath,
  loginPhaseBadge,
  LoginSocket,
  loginSocketUrl,
  loginTerminalReducer,
  probeLoginUpgradeError,
} from "./loginTerminalClient";

export type LoginTerminalProps = {
  engine: AccountEngine;
  accountId: string;
  accountLabel: string;
  onClose: () => void;
  /** Chamado quando o servidor confirma `login: true` (antes de fechar). */
  onSuccess: () => void;
};

/**
 * Mini terminal de login em modal (`<dialog>` nativo: foco preso dentro e Esc fecha).
 * Reaproveita xterm, tema, `copyText` e `WebLinksAddon` do terminal do Maestro.
 * Nunca grava conteúdo do terminal, links ou códigos em storage nem em log.
 */
export function LoginTerminal({ engine, accountId, accountLabel, onClose, onSuccess }: LoginTerminalProps) {
  const dialogRef = useModalDialog(onClose, { closeOnBackdrop: false });
  const titleId = useId();
  const pasteInputId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<LoginSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);
  const [state, dispatch] = useReducer(loginTerminalReducer, INITIAL_LOGIN_TERMINAL_STATE);
  const [codeValue, setCodeValue] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let scanBuffer = "";

    const term = new Terminal({
      fontFamily: token("--ui-font-mono", "ui-monospace, monospace"),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 3000,
      theme: xtermTheme(),
      allowTransparency: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    term.open(host);
    termRef.current = term;

    const fitNow = () => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        // ainda sem medidas
      }
    };
    fitNow();

    const sendSize = () => {
      const size = clampLoginPtySize(term.cols, term.rows);
      socketRef.current?.send({ type: "resize", cols: size.cols, rows: size.rows });
    };

    const httpPath = loginHttpPath(accountId, engine);
    const socket = new LoginSocket({
      url: loginSocketUrl(window.location, accountId, engine),
      onOpen: () => {
        if (!alive) return;
        dispatch({ type: "open" });
        fitNow();
        sendSize();
        term.focus();
      },
      onMessage: (message) => {
        if (!alive) return;
        switch (message.type) {
          case "hello":
            term.reset();
            scanBuffer = "";
            dispatch({ type: "hello", label: message.label });
            dispatch({ type: "url", url: null });
            return;
          case "replay":
            scanBuffer = appendUrlBuffer("", message.data);
            term.write(message.data);
            dispatch({ type: "url", url: extractLastHttpsUrl(scanBuffer) });
            return;
          case "out":
            scanBuffer = appendUrlBuffer(scanBuffer, message.data);
            term.write(message.data);
            dispatch({ type: "url", url: extractLastHttpsUrl(scanBuffer) });
            return;
          case "login":
            if (message.loggedIn) {
              dispatch({ type: "logged_in" });
              socket.close();
              onSuccessRef.current();
            }
            return;
          case "exit":
            dispatch({ type: "exit", code: message.code });
            return;
        }
      },
      onHandshakeFailure: () => {
        if (!alive) return;
        void probeLoginUpgradeError(httpPath).then((result) => {
          if (!alive) return;
          if (result.expired) useAuthStore.getState().expire();
          dispatch({ type: "error", message: result.message, status: result.status });
        });
      },
      onUnexpectedClose: () => {
        if (!alive) return;
        dispatch({
          type: "error",
          message:
            "A conexão com o terminal de login foi encerrada. Você pode tentar reconectar em até 60 s.",
          status: null,
        });
      },
    });
    socketRef.current = socket;

    const offData = term.onData((data) => {
      socket.send({ type: "in", data });
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const offResize = term.onResize(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendSize, 80);
    });
    term.attachCustomKeyEventHandler((event) => {
      // Esc fecha o modal nativo em vez de ficar preso dentro do xterm.
      if (event.type === "keydown" && event.key === "Escape") {
        dialogRef.current?.close();
        return false;
      }
      const action = clipboardKey(event, term.hasSelection());
      if (action === "copy") {
        copyText(term.getSelection());
        term.clearSelection();
        event.preventDefault();
        return false;
      }
      if (action === "paste") return false;
      return true;
    });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => fitNow());
    observer?.observe(host);

    return () => {
      alive = false;
      scanBuffer = "";
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      offData.dispose();
      offResize.dispose();
      socket.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [accountId, engine, attempt, dialogRef]);

  const badge = loginPhaseBadge(state.phase);
  const canSendInput = state.phase === "open";
  const canRetry = state.phase === "error" && state.errorStatus !== 403 && state.errorStatus !== 404;

  const handleClose = () => {
    dialogRef.current?.close();
  };

  const handleCopyLink = () => {
    if (!state.lastUrl) return;
    copyText(state.lastUrl);
    setCopiedLink(true);
    window.setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleSendCode = () => {
    if (!canSendInput) return;
    const message = buildPasteCodeMessage(codeValue);
    if (!message) return;
    if (socketRef.current?.send(message)) {
      setCodeValue("");
      termRef.current?.focus();
    }
  };

  const handleRetry = () => {
    dispatch({ type: "connecting" });
    setAttempt((current) => current + 1);
  };

  return (
    <dialog
      ref={dialogRef}
      className="ui-modal ui-modal--wide login-term-modal"
      aria-labelledby={titleId}
      data-testid="login-terminal-modal"
      data-phase={state.phase}
    >
      <header className="ui-modal__header">
        <div className="login-term-modal__head-left">
          <h2 id={titleId} className="ui-modal__title">
            Entrar · {ENGINE_LABELS[engine]} — {accountLabel}
          </h2>
          <span className={`ui-badge ui-badge--${badge.tone}`} data-testid="login-terminal-status">
            {badge.label}
          </span>
        </div>
        <button
          type="button"
          className="ui-icon-button"
          aria-label="Fechar terminal de login"
          onClick={handleClose}
          data-testid="login-terminal-close-x"
        >
          ×
        </button>
      </header>

      <div className="ui-modal__body login-term">
        <p className="login-term__tip" role="note" data-testid="login-terminal-tip">
          <strong>Dica:</strong> para entrar com outra conta Google ou Claude, abra o link em janela anônima do navegador.
        </p>

        <div className="login-term__controls">
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--small"
            onClick={handleCopyLink}
            disabled={!state.lastUrl}
            title={
              state.lastUrl
                ? "Copiar o último link https exibido no terminal"
                : "Aguardando o link de login aparecer no terminal…"
            }
            data-testid="login-terminal-copy-link"
          >
            {copiedLink ? "Link copiado" : "Copiar link"}
          </button>

          <form
            className="login-term__paste"
            onSubmit={(event) => {
              event.preventDefault();
              handleSendCode();
            }}
          >
            <label className="login-term__paste-label" htmlFor={pasteInputId}>
              Colar código
            </label>
            <input
              id={pasteInputId}
              type="text"
              className="ui-input"
              value={codeValue}
              autoComplete="off"
              spellCheck={false}
              disabled={!canSendInput}
              placeholder="Cole o código aqui e clique em Enviar"
              onChange={(event) => setCodeValue(event.currentTarget.value)}
              data-testid="login-terminal-code-input"
            />
            <button
              type="submit"
              className="ui-button ui-button--small"
              disabled={!canSendInput || !codeValue.trim()}
              data-testid="login-terminal-code-send"
            >
              Enviar
            </button>
          </form>
        </div>

        <div className="login-term__screen">
          <div
            ref={hostRef}
            className="login-term__xterm"
            aria-label={`Mini terminal de login de ${ENGINE_LABELS[engine]} (${accountLabel})`}
            data-testid="login-terminal-xterm"
          />
          {state.phase === "error" && (
            <div className="login-term__overlay" role="alert" data-testid="login-terminal-error">
              <p className="login-term__overlay-title">Não foi possível continuar o login</p>
              <p className="login-term__overlay-text">{state.error}</p>
              <div className="login-term__overlay-actions">
                {canRetry && (
                  <button
                    type="button"
                    className="ui-button ui-button--small"
                    onClick={handleRetry}
                    data-testid="login-terminal-retry"
                  >
                    Tentar novamente
                  </button>
                )}
                <button
                  type="button"
                  className="ui-button ui-button--secondary ui-button--small"
                  onClick={handleClose}
                  data-testid="login-terminal-error-close"
                >
                  Fechar
                </button>
              </div>
            </div>
          )}
        </div>

        {state.phase === "exited" && (
          <div className="login-term__exit" role="status" data-testid="login-terminal-exit">
            <span>{loginExitMessage(state.exitCode)}</span>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              onClick={handleClose}
              data-testid="login-terminal-exit-close"
            >
              Fechar
            </button>
          </div>
        )}

        <footer className="login-term__footer">
          <p className="login-term__note">
            Fechar encerra apenas a janela; o servidor mantém a sessão por 60 s para reconectar.
          </p>
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--small"
            onClick={handleClose}
            data-testid="login-terminal-close"
          >
            Fechar
          </button>
        </footer>
      </div>
    </dialog>
  );
}
