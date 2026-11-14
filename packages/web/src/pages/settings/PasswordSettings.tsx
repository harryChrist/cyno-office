import { AUTH_SET_PASSWORD_COMMAND, AUTH_STATUS_PATH, type AuthStatus } from "@cyno/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiRequestError, describeError } from "../../api/client";
import { changePasswordErrorMessage, validateNewPassword } from "../../auth/authView";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { SecuritySettings } from "./SecuritySettings";
import { OptionHead, StateBadge } from "./SettingsOption";

/** Troca de senha: atual + nova duas vezes. A senha atual errada volta como 403 (não derruba a sessão). */
function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    const invalid = validateNewPassword(current, next, repeat);
    setError(invalid);
    if (invalid) return;
    setPending(true);
    try {
      await api.changePassword({ current, next });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? changePasswordErrorMessage(caught.status, describeError(caught)) : describeError(caught));
    } finally {
      setPending(false);
      setCurrent("");
      setNext("");
      setRepeat("");
    }
  };

  return (
    <form className="settings__card settings__password-form" onSubmit={(event) => void submit(event)} data-testid="settings-password-form">
      <OptionHead title="Trocar a senha" seal="plataforma" line="Trocar a senha desconecta todos os outros aparelhos. Este continua aberto." />
      <label className="settings__password-field">
        <span>Senha atual</span>
        <input className="ui-input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.currentTarget.value)} data-testid="settings-password-current" />
      </label>
      <label className="settings__password-field">
        <span>Nova senha</span>
        <input className="ui-input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.currentTarget.value)} data-testid="settings-password-next" />
      </label>
      <label className="settings__password-field">
        <span>Repita a nova senha</span>
        <input className="ui-input" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.currentTarget.value)} data-testid="settings-password-repeat" />
      </label>
      <ErrorText testId="settings-password-error">{error}</ErrorText>
      {done && (
        <p className="settings__password-ok" role="status" data-testid="settings-password-done">
          Senha trocada. Os outros aparelhos foram desconectados.
        </p>
      )}
      <div>
        <button type="submit" className="ui-button" disabled={pending || !current || !next || !repeat} data-testid="settings-password-save">
          {pending ? "Trocando…" : "Trocar senha"}
        </button>
      </div>
    </form>
  );
}

/**
 * Seção "Acesso": a senha que protege o app (uma só). A primeira senha nasce na configuração inicial
 * (código do log do servidor) ou pelo comando do servidor; aqui se troca a senha, liga o 2FA e vê os bloqueios.
 */
export function PasswordSettings() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const leave = useAsyncAction();

  useEffect(() => {
    let alive = true;
    fetch(AUTH_STATUS_PATH, { cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => response.json() as Promise<AuthStatus>)
      .then((next) => alive && setStatus(next))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // Depois de sair, recarrega: a tela de login volta e nenhum dado da sessão fica na memória da página.
  const signOut = (all: boolean) => void leave.run(async () => (all ? api.logoutAll() : api.logout())).then(() => window.location.reload());

  if (failed) return <ErrorText testId="settings-password-error">Não foi possível ler o estado da senha.</ErrorText>;
  if (!status) {
    return (
      <p className="settings__card-hint" role="status">
        Lendo o acesso…
      </p>
    );
  }

  if (!status.enabled) {
    return (
      <div className="settings__groups" data-testid="settings-password">
        <section className="settings__card settings__card--warn" data-testid="settings-password-open">
          <OptionHead
            title="Senha do app"
            seal="plataforma"
            state={<StateBadge tone="warn">Desligada · o app está aberto</StateBadge>}
            line="Este servidor roda com CYNO_AUTH=off (só para desenvolvimento e testes): qualquer pessoa com o link consegue abrir o app e mexer em tudo. Defina uma senha no servidor:"
          />
          <code className="settings__command" data-testid="settings-password-command">
            {AUTH_SET_PASSWORD_COMMAND}
          </code>
          <p className="settings__card-hint">Rode no terminal do servidor. Vale na hora, sem reiniciar. Sem CYNO_AUTH=off, o app nunca fica aberto: na primeira vez ele pede o código de configuração que aparece no log do servidor.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="settings__groups" data-testid="settings-password">
      <section className="settings__card" data-testid="settings-password-on">
        <OptionHead
          title="Senha do app"
          seal="plataforma"
          state={<StateBadge tone="on">Ligada · protegido</StateBadge>}
          line="O app pede a senha em cada aparelho novo e lembra dele por 30 dias de uso. Desligada, qualquer pessoa com o link entra."
        />
        <div className="settings__password-actions">
          <button type="button" className="ui-button ui-button--secondary" disabled={leave.pending} onClick={() => signOut(false)} data-testid="settings-password-logout">
            Sair
          </button>
          <button type="button" className="ui-button ui-button--secondary" disabled={leave.pending} onClick={() => signOut(true)} data-testid="settings-password-logout-all">
            Sair de todos os aparelhos
          </button>
        </div>
        <ErrorText testId="settings-password-leave-error">{leave.error}</ErrorText>
      </section>
      <ChangePasswordForm />
      <SecuritySettings />
    </div>
  );
}
