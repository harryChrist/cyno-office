import type { CreateGitCredentialBody, GitCredentialKind, GitCredentialView } from "@cyno/shared";
import { useCallback, useEffect, useId, useState } from "react";
import { gitApi } from "../../api/git";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { validateCredentialForm } from "./gitView";
import "./gitClone.css";

const KIND_LABELS: Record<GitCredentialKind, string> = {
  token: "Token (HTTPS)",
  ssh: "Chave SSH",
};

export type GitCredentialFormProps = {
  initialHost?: string;
  initialKind?: GitCredentialKind;
  onCreate: (body: CreateGitCredentialBody) => Promise<GitCredentialView | undefined>;
  onCancel: () => void;
};

/** Formulário para cadastrar token ou chave privada SSH; nunca exibe o segredo depois de salvar. */
export function GitCredentialForm({ initialHost = "", initialKind = "token", onCreate, onCancel }: GitCredentialFormProps) {
  const id = useId();
  const { pending, error, run, clearError } = useAsyncAction();
  const [kind, setKind] = useState<GitCredentialKind>(initialKind);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState(initialHost);
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const changeKind = (next: GitCredentialKind) => {
    if (next === kind) return;
    setKind(next);
    setSecret("");
    setLocalError(null);
    clearError();
  };

  const submit = async () => {
    const validation = validateCredentialForm({ label, host, kind, username, secret });
    if (validation) {
      setLocalError(validation);
      return;
    }
    setLocalError(null);
    const body: CreateGitCredentialBody = {
      label: label.trim(),
      host: host.trim(),
      kind,
      ...(kind === "token" && username.trim() ? { username: username.trim() } : {}),
      secret,
    };
    const created = await run(() => onCreate(body));
    if (created) {
      setSecret("");
      setLabel("");
      setUsername("");
    }
  };

  return (
    <form
      className="git-cred-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      data-testid="git-cred-form"
    >
      <div className="git-cred-form__kind" role="radiogroup" aria-label="Tipo de credencial" data-testid="git-cred-kind">
        {(Object.keys(KIND_LABELS) as GitCredentialKind[]).map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={kind === item}
            className={`git-cred-form__kind-btn${kind === item ? " git-cred-form__kind-btn--on" : ""}`}
            disabled={pending}
            onClick={() => changeKind(item)}
            data-testid={`git-cred-kind-${item}`}
          >
            {KIND_LABELS[item]}
          </button>
        ))}
      </div>

      <div className="git-cred-form__grid">
        <div className="git-field">
          <label htmlFor={`${id}-label`} className="git-field__label">
            Nome
          </label>
          <input
            id={`${id}-label`}
            className="ui-input"
            value={label}
            maxLength={80}
            placeholder="Ex.: GitHub pessoal"
            autoFocus
            onChange={(event) => {
              setLocalError(null);
              clearError();
              setLabel(event.currentTarget.value);
            }}
            data-testid="git-cred-label"
          />
        </div>
        <div className="git-field">
          <label htmlFor={`${id}-host`} className="git-field__label">
            Host
          </label>
          <input
            id={`${id}-host`}
            className="ui-input git-mono"
            value={host}
            maxLength={253}
            placeholder="github.com"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setLocalError(null);
              clearError();
              setHost(event.currentTarget.value);
            }}
            data-testid="git-cred-host"
          />
        </div>
      </div>

      {kind === "token" ? (
        <div className="git-cred-form__grid">
          <div className="git-field">
            <label htmlFor={`${id}-user`} className="git-field__label">
              Usuário (opcional)
            </label>
            <input
              id={`${id}-user`}
              className="ui-input"
              value={username}
              maxLength={120}
              placeholder="x-access-token"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => {
                setLocalError(null);
                clearError();
                setUsername(event.currentTarget.value);
              }}
              data-testid="git-cred-username"
            />
          </div>
          <div className="git-field">
            <label htmlFor={`${id}-token`} className="git-field__label">
              Token
            </label>
            <input
              id={`${id}-token`}
              type="password"
              className="ui-input git-mono"
              value={secret}
              autoComplete="new-password"
              placeholder="ghp_…"
              onChange={(event) => {
                setLocalError(null);
                clearError();
                setSecret(event.currentTarget.value);
              }}
              data-testid="git-cred-token"
            />
          </div>
        </div>
      ) : (
        <div className="git-field">
          <label htmlFor={`${id}-ssh`} className="git-field__label">
            Chave privada SSH
          </label>
          <textarea
            id={`${id}-ssh`}
            className="ui-input git-mono git-cred-form__textarea"
            rows={5}
            value={secret}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
            onChange={(event) => {
              setLocalError(null);
              clearError();
              setSecret(event.currentTarget.value);
            }}
            data-testid="git-cred-ssh-key"
          />
          <p className="git-field__hint">A chave fica guardada apenas no servidor (permissão 0600) e nunca volta para a tela.</p>
        </div>
      )}

      <ErrorText testId="git-cred-error">{localError ?? error}</ErrorText>

      <div className="git-cred-form__actions">
        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onCancel} disabled={pending} data-testid="git-cred-cancel">
          Cancelar
        </button>
        <button type="submit" className="ui-button ui-button--small" disabled={pending} aria-busy={pending} data-testid="git-cred-submit">
          {pending ? "Salvando…" : "Salvar credencial"}
        </button>
      </div>
    </form>
  );
}

export type GitCredentialsViewProps = {
  credentials: readonly GitCredentialView[];
  loading: boolean;
  loadError: string | null;
  adding: boolean;
  confirmDeleteId: string | null;
  deletingId: string | null;
  deleteError: string | null;
  onToggleAdd: () => void;
  onCancelAdd: () => void;
  onCreate: (body: CreateGitCredentialBody) => Promise<GitCredentialView | undefined>;
  onAskDelete: (id: string | null) => void;
  onConfirmDelete: (id: string) => void;
  onRetryLoad: () => void;
};

/** Visão pura do painel "Credenciais do git" (testável com renderToStaticMarkup). */
export function GitCredentialsView({
  credentials,
  loading,
  loadError,
  adding,
  confirmDeleteId,
  deletingId,
  deleteError,
  onToggleAdd,
  onCancelAdd,
  onCreate,
  onAskDelete,
  onConfirmDelete,
  onRetryLoad,
}: GitCredentialsViewProps) {
  return (
    <section className="settings__card git-creds" aria-labelledby="git-creds-title" data-testid="git-credentials-panel">
      <header className="git-creds__head">
        <div className="git-creds__head-text">
          <h4 id="git-creds-title" className="settings__card-title">
            Credenciais do git
          </h4>
          <p className="settings__card-hint">
            Tokens HTTPS e chaves SSH para clonar repositórios privados. O segredo fica só no servidor e nunca é exibido de volta.
          </p>
        </div>
        <button
          type="button"
          className="ui-button ui-button--small"
          aria-expanded={adding}
          onClick={onToggleAdd}
          data-testid="git-cred-add-toggle"
        >
          <span aria-hidden="true">{adding ? "−" : "+"}</span> {adding ? "Fechar" : "Nova credencial"}
        </button>
      </header>

      {loading ? (
        <p className="settings__card-hint" role="status" data-testid="git-creds-loading">
          Carregando credenciais…
        </p>
      ) : loadError ? (
        <div className="git-creds__error-row">
          <ErrorText testId="git-creds-load-error">{loadError}</ErrorText>
          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onRetryLoad}>
            Tentar de novo
          </button>
        </div>
      ) : credentials.length === 0 ? (
        <p className="git-creds__empty" data-testid="git-creds-empty">
          Nenhuma credencial salva. Repositórios públicos podem ser clonados sem credencial.
        </p>
      ) : (
        <ul className="git-creds__list" aria-label="Credenciais do git salvas" data-testid="git-creds-list">
          {credentials.map((cred) => {
            const confirming = confirmDeleteId === cred.id;
            const deleting = deletingId === cred.id;
            return (
              <li key={cred.id} className="git-cred-row" data-testid="git-cred-row" data-cred-id={cred.id}>
                <div className="git-cred-row__info">
                  <span className="git-cred-row__label">{cred.label}</span>
                  <span className="git-cred-row__badge">{cred.kind === "token" ? "Token" : "SSH"}</span>
                  <code className="git-cred-row__host">{cred.host}</code>
                  {cred.username && <span className="git-cred-row__meta">usuário: {cred.username}</span>}
                  <span className="git-cred-row__meta">segredo salvo</span>
                </div>
                <div className="git-cred-row__actions">
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        className="ui-button ui-button--ghost ui-button--small"
                        disabled={deleting}
                        onClick={() => onAskDelete(null)}
                        data-testid="git-cred-delete-cancel"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="ui-button ui-button--danger ui-button--small"
                        disabled={deleting}
                        aria-busy={deleting}
                        onClick={() => onConfirmDelete(cred.id)}
                        data-testid="git-cred-delete-confirm"
                      >
                        {deleting ? "Removendo…" : "Remover"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ui-button ui-button--ghost ui-button--small"
                      disabled={deletingId !== null}
                      onClick={() => onAskDelete(cred.id)}
                      aria-label={`Remover credencial ${cred.label}`}
                      data-testid="git-cred-delete"
                    >
                      Remover
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ErrorText testId="git-creds-delete-error">{deleteError}</ErrorText>

      {adding && <GitCredentialForm onCreate={onCreate} onCancel={onCancelAdd} />}
    </section>
  );
}

/** Painel "Credenciais do git" conectado à API (`/api/git/credentials`). */
export function GitCredentialsPanel({ onChanged }: { onChanged?: (credentials: GitCredentialView[]) => void }) {
  const [credentials, setCredentials] = useState<GitCredentialView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchCredentials = useCallback(async () => {
    try {
      const response = await gitApi.listCredentials();
      setCredentials(response.credentials);
      setLoadError(null);
      onChanged?.(response.credentials);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Não foi possível carregar as credenciais.");
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  useEffect(() => {
    let active = true;
    void gitApi
      .listCredentials()
      .then((response) => {
        if (!active) return;
        setCredentials(response.credentials);
        setLoadError(null);
        onChanged?.(response.credentials);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : "Não foi possível carregar as credenciais.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onChanged]);

  const retryLoad = () => {
    setLoading(true);
    setLoadError(null);
    void fetchCredentials();
  };

  const handleCreate = async (body: CreateGitCredentialBody): Promise<GitCredentialView> => {
    const response = await gitApi.createCredential(body);
    const next = [...credentials, response.credential];
    setCredentials(next);
    setAdding(false);
    onChanged?.(next);
    return response.credential;
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await gitApi.deleteCredential(id);
      const next = credentials.filter((item) => item.id !== id);
      setCredentials(next);
      setConfirmDeleteId(null);
      onChanged?.(next);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Não foi possível remover a credencial.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <GitCredentialsView
      credentials={credentials}
      loading={loading}
      loadError={loadError}
      adding={adding}
      confirmDeleteId={confirmDeleteId}
      deletingId={deletingId}
      deleteError={deleteError}
      onToggleAdd={() => setAdding((open) => !open)}
      onCancelAdd={() => setAdding(false)}
      onCreate={handleCreate}
      onAskDelete={setConfirmDeleteId}
      onConfirmDelete={(id) => void handleDelete(id)}
      onRetryLoad={retryLoad}
    />
  );
}
