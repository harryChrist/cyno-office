import { AUTH_LOGIN_2FA_PATH, AUTH_LOGIN_PATH, type LoginResult } from "@cyno/shared";
import { useState, type FormEvent } from "react";
import { useAuthStore } from "./authStore";
import { blockedMessage, cleanCode, codeErrorMessage, loginErrorMessage } from "./authView";
import { retryAfterOf, useCountdown } from "./useCountdown";
import "./login.css";

/**
 * Tela cheia de senha: aparece antes de tudo (nada do app carrega, nem o WebSocket) quando o servidor tem senha.
 * Com a verificação em duas etapas ligada, a senha certa leva ao segundo passo (código do app ou de recuperação).
 */
export function LoginScreen() {
  const expired = useAuthStore((state) => state.expired);
  const loggedIn = useAuthStore((state) => state.loggedIn);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, startWaiting] = useCountdown();
  const secondStep = token !== null;

  const done = () => {
    // Sessão que caiu com o app aberto: recarrega para não ficar nada velho na tela.
    if (expired) window.location.reload();
    else loggedIn();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || waiting > 0 || (secondStep ? !code.trim() : !password)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(secondStep ? AUTH_LOGIN_2FA_PATH : AUTH_LOGIN_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(secondStep ? { token, code: cleanCode(code) } : { password }),
      });
      if (response.status === 429) {
        startWaiting(await retryAfterOf(response));
        setPassword("");
        setCode("");
        return;
      }
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as { error?: string };
        if (secondStep && response.status === 401 && failure.error?.startsWith("Etapa expirada")) {
          // O token do segundo passo venceu: volta para a senha.
          setToken(null);
          setCode("");
          setError("A etapa expirou. Digite a senha de novo.");
          return;
        }
        setError(secondStep ? codeErrorMessage(response.status) : loginErrorMessage(response.status));
        setPassword("");
        setCode("");
        return;
      }
      const result = (await response.json().catch(() => ({}))) as Partial<LoginResult>;
      if (result.twoFactorToken) {
        setToken(result.twoFactorToken);
        setPassword("");
        return;
      }
      done();
    } catch {
      setError(secondStep ? codeErrorMessage(0) : loginErrorMessage(0));
    } finally {
      setBusy(false);
    }
  };

  const shown = waiting > 0 ? blockedMessage(waiting) : error;
  const hint = secondStep
    ? "Digite o código de 6 dígitos do app autenticador, ou um código de recuperação."
    : expired
      ? "Sua sessão expirou. Digite a senha para continuar."
      : "Digite a senha para abrir o escritório.";

  return (
    <main className="login" data-testid="login-screen">
      <form className="login__card" onSubmit={(event) => void submit(event)} aria-labelledby="login-title">
        <img className="login__logo" src="/cyno-tile.svg" alt="" width={64} height={64} />
        <h1 id="login-title" className={secondStep ? "login__title" : "login__title login__title--marca"}>
          {secondStep ? "Verificação em duas etapas" : "Cyno"}
        </h1>
        <p className="login__hint">{hint}</p>
        {secondStep ? (
          <>
            <label className="login__label" htmlFor="login-code">
              Código
            </label>
            <input
              id="login-code"
              className="ui-input login__input login__input--code login__input--plain"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              autoComplete="one-time-code"
              inputMode="text"
              spellCheck={false}
              autoFocus
              aria-invalid={shown ? true : undefined}
              aria-describedby={shown ? "login-error" : undefined}
              data-testid="login-code"
            />
          </>
        ) : (
          <>
            <label className="login__label" htmlFor="login-password">
              Senha
            </label>
            <div className="login__field">
              <input
                id="login-password"
                className="ui-input login__input"
                type={visible ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                autoComplete="current-password"
                autoFocus
                aria-invalid={shown ? true : undefined}
                aria-describedby={shown ? "login-error" : undefined}
                data-testid="login-password"
              />
              <button type="button" className="login__toggle" onClick={() => setVisible((value) => !value)} aria-pressed={visible} data-testid="login-toggle">
                {visible ? "Ocultar" : "Mostrar"}
              </button>
            </div>
          </>
        )}
        {shown && (
          <p id="login-error" className="ui-error login__error" role="alert" data-testid="login-error">
            {shown}
          </p>
        )}
        <button type="submit" className="ui-button login__submit" disabled={busy || waiting > 0 || (secondStep ? !code.trim() : !password)} data-testid="login-submit">
          {busy ? (secondStep ? "Verificando…" : "Entrando…") : secondStep ? "Verificar" : "Entrar"}
        </button>
        {secondStep && (
          <button
            type="button"
            className="login__link"
            onClick={() => {
              setToken(null);
              setCode("");
              setError(null);
            }}
            data-testid="login-back"
          >
            Voltar
          </button>
        )}
      </form>
    </main>
  );
}
