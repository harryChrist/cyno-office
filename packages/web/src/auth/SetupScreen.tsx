import { AUTH_SETUP_PATH } from "@cyno/shared";
import { useState, type FormEvent } from "react";
import { useAuthStore } from "./authStore";
import { blockedMessage, formatSetupCode, setupErrorMessage, validateSetup } from "./authView";
import { retryAfterOf, useCountdown } from "./useCountdown";
import "./login.css";

/**
 * Primeira instalação: o servidor ainda não tem senha e o app está fechado. Quem tem acesso ao
 * terminal/log do servidor lê o código de configuração e cria a senha aqui; o código vale uma vez.
 */
export function SetupScreen() {
  const loggedIn = useAuthStore((state) => state.loggedIn);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, startWaiting] = useCountdown();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || waiting > 0) return;
    const invalid = validateSetup(code, password, repeat);
    setError(invalid);
    if (invalid) return;
    setBusy(true);
    try {
      const response = await fetch(AUTH_SETUP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code, password }),
      });
      if (response.ok) return loggedIn();
      if (response.status === 429) {
        startWaiting(await retryAfterOf(response));
        setError(null);
      } else {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(setupErrorMessage(response.status, body.error ?? "Não foi possível criar a senha"));
      }
    } catch {
      setError(setupErrorMessage(0, ""));
    } finally {
      setBusy(false);
    }
  };

  const shown = waiting > 0 ? blockedMessage(waiting) : error;

  return (
    <main className="login" data-testid="setup-screen">
      <form className="login__card" onSubmit={(event) => void submit(event)} aria-labelledby="setup-title">
        <img className="login__logo" src="/cyno-tile.svg" alt="" width={64} height={64} />
        <h1 id="setup-title" className="login__title">
          Criar a senha
        </h1>
        <p className="login__hint">Primeiro acesso a este Cyno. No servidor, rode o comando abaixo para ver o código de configuração.</p>
        <code className="login__log-hint">npm run auth:code · no Docker: docker compose exec cyno npm run auth:code</code>
        <label className="login__label" htmlFor="setup-code">
          Código de configuração
        </label>
        <input
          id="setup-code"
          className="ui-input login__input login__input--code"
          value={code}
          onChange={(event) => setCode(formatSetupCode(event.currentTarget.value))}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          data-testid="setup-code"
        />
        <label className="login__label" htmlFor="setup-password">
          Senha (mínimo 8 caracteres)
        </label>
        <div className="login__field">
          <input
            id="setup-password"
            className="ui-input login__input"
            type={visible ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            autoComplete="new-password"
            data-testid="setup-password"
          />
          <button type="button" className="login__toggle" onClick={() => setVisible((value) => !value)} aria-pressed={visible}>
            {visible ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        <label className="login__label" htmlFor="setup-repeat">
          Repita a senha
        </label>
        <input
          id="setup-repeat"
          className="ui-input login__input login__input--plain"
          type={visible ? "text" : "password"}
          value={repeat}
          onChange={(event) => setRepeat(event.currentTarget.value)}
          autoComplete="new-password"
          data-testid="setup-repeat"
        />
        {shown && (
          <p className="ui-error login__error" role="alert" data-testid="setup-error">
            {shown}
          </p>
        )}
        <button type="submit" className="ui-button login__submit" disabled={busy || waiting > 0 || !code || !password || !repeat} data-testid="setup-submit">
          {busy ? "Criando…" : "Criar a senha e entrar"}
        </button>
      </form>
    </main>
  );
}
