import type { SecurityFailure, SecurityState, TwoFactorSetup } from "@cyno/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiRequestError, describeError } from "../../api/client";
import { formatWait } from "../../auth/authView";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";

/** Relógio de 1 s para as contagens regressivas dos bloqueios. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const KIND_LABELS: Record<SecurityFailure["kind"], string> = { senha: "Senha errada", codigo: "Código errado", configuracao: "Código de configuração errado" };

const formatWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function errorText(caught: unknown): string {
  return caught instanceof ApiRequestError ? caught.message : describeError(caught);
}

/** Ativar a verificação em duas etapas: QR + segredo, confirma com um código, mostra os códigos de recuperação uma vez. */
function EnableTwoFactor({ onEnabled, onDone }: { onEnabled: () => void; onDone: () => void }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const begin = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await api.twoFactorSetup();
      setSetup(next);
      // O QR é gerado aqui no navegador (a biblioteca só carrega agora): o segredo nunca vai para um serviço de fora.
      const { toDataURL } = await import("qrcode");
      setQr(await toDataURL(next.uri, { margin: 1, width: 192, errorCorrectionLevel: "M" }));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.twoFactorEnable(code.trim());
      onEnabled();
      setRecovery(result.recoveryCodes);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
      setCode("");
    }
  };

  if (recovery) {
    return (
      <div className="sec__stack" data-testid="settings-2fa-recovery">
        <p className="settings__password-ok" role="status">
          Ligada. Guarde estes códigos de recuperação: cada um vale uma vez e não aparecem de novo.
        </p>
        <ul className="sec__codes" aria-label="Códigos de recuperação">
          {recovery.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        <div className="settings__password-actions">
          <button
            type="button"
            className="ui-button ui-button--secondary"
            onClick={() => void navigator.clipboard?.writeText(recovery.join("\n")).then(() => setCopied(true))}
            data-testid="settings-2fa-copy"
          >
            {copied ? "Copiado" : "Copiar os códigos"}
          </button>
          <button type="button" className="ui-button" onClick={onDone} data-testid="settings-2fa-saved">
            Guardei os códigos
          </button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="sec__stack">
        <div>
          <button type="button" className="ui-button" disabled={pending} onClick={() => void begin()} data-testid="settings-2fa-start">
            {pending ? "Preparando…" : "Ativar verificação em duas etapas"}
          </button>
        </div>
        <ErrorText testId="settings-2fa-error">{error}</ErrorText>
      </div>
    );
  }

  return (
    <form className="sec__stack" onSubmit={(event) => void confirm(event)} data-testid="settings-2fa-setup">
      <p className="settings__card-hint">Leia o QR com um app autenticador e digite o código de 6 dígitos que ele mostrar.</p>
      <details className="settings__more">
        <summary>Quais apps servem</summary>
        <p>Google Authenticator, Authy, 1Password ou qualquer app de códigos. Sem câmera, digite o segredo abaixo no app.</p>
      </details>
      <div className="sec__qr-row">
        {qr ? <img className="sec__qr" src={qr} alt="QR code da verificação em duas etapas" width={192} height={192} data-testid="settings-2fa-qr" /> : <div className="sec__qr sec__qr--empty" aria-hidden />}
        <div className="sec__stack">
          <span className="settings__card-hint">Segredo (se não puder ler o QR)</span>
          <code className="settings__command" data-testid="settings-2fa-secret">
            {setup.secret}
          </code>
        </div>
      </div>
      <label className="settings__password-field">
        <span>Código de 6 dígitos</span>
        <input className="ui-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.currentTarget.value)} data-testid="settings-2fa-code" />
      </label>
      <ErrorText testId="settings-2fa-error">{error}</ErrorText>
      <div className="settings__password-actions">
        <button type="submit" className="ui-button" disabled={pending || !code.trim()} data-testid="settings-2fa-confirm">
          {pending ? "Conferindo…" : "Confirmar e ativar"}
        </button>
        <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={() => setSetup(null)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** Desligar o 2FA: pede a senha e um código (do app ou de recuperação). */
function DisableTwoFactor({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.twoFactorDisable({ password, code: code.trim() });
      onDone();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
      setPassword("");
      setCode("");
    }
  };

  if (!open) {
    return (
      <div>
        <button type="button" className="ui-button ui-button--secondary" onClick={() => setOpen(true)} data-testid="settings-2fa-disable-open">
          Desativar…
        </button>
      </div>
    );
  }
  return (
    <form className="settings__password-form" onSubmit={(event) => void submit(event)} data-testid="settings-2fa-disable-form">
      <label className="settings__password-field">
        <span>Senha</span>
        <input className="ui-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} data-testid="settings-2fa-disable-password" />
      </label>
      <label className="settings__password-field">
        <span>Código do app ou de recuperação</span>
        <input className="ui-input" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.currentTarget.value)} data-testid="settings-2fa-disable-code" />
      </label>
      <ErrorText testId="settings-2fa-error">{error}</ErrorText>
      <div className="settings__password-actions">
        <button type="submit" className="ui-button" disabled={pending || !password || !code.trim()} data-testid="settings-2fa-disable-confirm">
          {pending ? "Desativando…" : "Desativar"}
        </button>
        <button type="button" className="ui-button ui-button--secondary" onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function BlockedIps({ state, reload }: { state: SecurityState; reload: () => void }) {
  const now = useNow();
  const unblock = useAsyncAction();
  const active = state.blocks.filter((block) => Date.parse(block.until) > now);
  return (
    <section className="settings__card" data-testid="settings-blocks">
      <OptionHead
        title="IPs bloqueados"
        seal="plataforma"
        state={<StateBadge tone={active.length > 0 ? "warn" : "off"}>{active.length > 0 ? `${active.length} bloqueado${active.length > 1 ? "s" : ""}` : "Nenhum agora"}</StateBadge>}
        line="Cinco senhas ou códigos errados bloqueiam o IP por 15 minutos."
      />
      <details className="settings__more">
        <summary>Saiba mais</summary>
        <p>Cada novo bloqueio em 24 horas dobra o tempo. Reiniciar o servidor não libera.</p>
      </details>
      {active.length > 0 && (
        <ul className="sec__list">
          {active.map((block) => (
            <li key={block.ip} className="sec__row" data-testid="settings-block-row">
              <code>{block.ip}</code>
              <span className="settings__card-hint">
                libera em {formatWait((Date.parse(block.until) - now) / 1000)} · {block.attempts} tentativas
              </span>
              <button type="button" className="ui-button ui-button--secondary" disabled={unblock.pending} onClick={() => void unblock.run(() => api.unblockIp(block.ip)).then(reload)} data-testid="settings-unblock">
                Desbloquear
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText testId="settings-unblock-error">{unblock.error}</ErrorText>
      <h5 className="sec__subtitle">Últimas tentativas erradas</h5>
      {state.failures.length === 0 ? (
        <p className="settings__card-hint">Nenhuma tentativa errada registrada.</p>
      ) : (
        <ul className="sec__list" data-testid="settings-failures">
          {state.failures.slice(0, 12).map((failure, index) => (
            <li key={`${failure.at}-${index}`} className="sec__row sec__row--plain">
              <code>{failure.ip}</code>
              <span className="settings__card-hint">{KIND_LABELS[failure.kind]}</span>
              <span className="settings__card-hint sec__when">{formatWhen(failure.at)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="settings__card-hint">Seu IP: {state.yourIp}</p>
    </section>
  );
}

/** Segurança do acesso: verificação em duas etapas, IPs bloqueados e últimas tentativas erradas. */
export function SecuritySettings() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  const reload = useCallback(() => {
    api.getSecurity().then(
      (next) => {
        setState(next);
        setError(null);
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 20_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (error && !state) return <ErrorText testId="settings-security-error">{error}</ErrorText>;
  if (!state) {
    return (
      <p className="settings__card-hint" role="status">
        Lendo a segurança…
      </p>
    );
  }

  return (
    <>
      <section className="settings__card" data-testid="settings-2fa">
        <OptionHead
          title="Verificação em duas etapas"
          seal="plataforma"
          state={<StateBadge tone={state.twoFactor ? "on" : "off"}>{state.twoFactor ? "Ligada" : "Desligada"}</StateBadge>}
          line="Depois da senha, o login pede um código do app autenticador. Recomendada se o app está na internet."
        />
        {state.twoFactor && !enabling ? (
          <>
            <p className="settings__card-hint" data-testid="settings-2fa-remaining">
              {state.recoveryRemaining} {state.recoveryRemaining === 1 ? "código de recuperação restante" : "códigos de recuperação restantes"}.
            </p>
            <details className="settings__more">
              <summary>Perdeu o celular e os códigos?</summary>
              <p>
                No servidor, rode: <code>npm run auth:reset-2fa -w @cyno/server</code>
              </p>
            </details>
            <DisableTwoFactor onDone={reload} />
          </>
        ) : (
          <EnableTwoFactor
            onEnabled={() => setEnabling(true)}
            onDone={() => {
              setEnabling(false);
              reload();
            }}
          />
        )}
      </section>
      <BlockedIps state={state} reload={reload} />
    </>
  );
}
