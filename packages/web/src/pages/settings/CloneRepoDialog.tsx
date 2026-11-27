import type { CreateGitCredentialBody, GitCloneJob, GitCredentialView } from "@cyno/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { gitApi } from "../../api/git";
import { ErrorText, Modal, ProgressBar } from "../../ui/widgets";
import { GitCredentialForm } from "./GitCredentialsPanel";
import {
  cloneStatusText,
  credentialOptionLabel,
  expectedCredentialKind,
  suggestHostFromUrl,
  suggestRepoName,
  validateCloneNameClient,
  validateCloneUrlClient,
} from "./gitView";
import "./gitClone.css";

const POLL_INTERVAL_MS = 600;

export type CloneRepoDialogContentProps = {
  url: string;
  name: string;
  branch: string;
  credentialId: string;
  credentials: readonly GitCredentialView[];
  loadingCreds: boolean;
  credsError: string | null;
  addingCred: boolean;
  submitting: boolean;
  formError: string | null;
  job: GitCloneJob | null;
  onUrlChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onCredentialChange: (value: string) => void;
  onToggleAddCred: () => void;
  onCreateCred: (body: CreateGitCredentialBody) => Promise<GitCredentialView | undefined>;
  onSubmit: () => void;
  onReset: () => void;
  onClose: () => void;
};

/** Conteúdo puro da janela "Clonar repositório" (testável com renderToStaticMarkup). */
export function CloneRepoDialogContent({
  url,
  name,
  branch,
  credentialId,
  credentials,
  loadingCreds,
  credsError,
  addingCred,
  submitting,
  formError,
  job,
  onUrlChange,
  onNameChange,
  onBranchChange,
  onCredentialChange,
  onToggleAddCred,
  onCreateCred,
  onSubmit,
  onReset,
  onClose,
}: CloneRepoDialogContentProps) {
  const id = useId();
  const running = job?.status === "running";
  const done = job?.status === "done";
  const failed = job?.status === "error";
  const locked = submitting || running;
  const suggestedHost = suggestHostFromUrl(url);
  const suggestedKind = expectedCredentialKind(url) ?? "token";

  return (
    <div className="git-clone" data-testid="clone-repo-dialog-content">
      <p className="git-clone__intro">
        Cole a URL de um repositório público ou privado. O Cyno clona dentro dos dados dele e cadastra a pasta neste workspace.
      </p>

      <form
        className="git-clone__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        data-testid="clone-repo-form"
      >
        <div className="git-field">
          <label htmlFor={`${id}-url`} className="git-field__label">
            URL do repositório
          </label>
          <input
            id={`${id}-url`}
            className="ui-input git-mono"
            value={url}
            disabled={locked || done}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="https://github.com/organizacao/repositorio.git ou git@github.com:org/repo.git"
            aria-invalid={Boolean(formError)}
            onChange={(event) => onUrlChange(event.currentTarget.value)}
            data-testid="clone-repo-url"
          />
        </div>

        <div className="git-clone__cred-row">
          <div className="git-field git-clone__cred-select">
            <label htmlFor={`${id}-cred`} className="git-field__label">
              Credencial
            </label>
            <select
              id={`${id}-cred`}
              className="ui-input"
              value={credentialId}
              disabled={locked || done || loadingCreds}
              onChange={(event) => onCredentialChange(event.currentTarget.value)}
              data-testid="clone-repo-credential"
            >
              <option value="">Sem credencial (repositório público)</option>
              {credentials.map((cred) => (
                <option key={cred.id} value={cred.id}>
                  {credentialOptionLabel(cred)}
                </option>
              ))}
            </select>
          </div>
          {!done && (
            <button
              type="button"
              className="ui-button ui-button--ghost ui-button--small git-clone__new-cred-btn"
              disabled={locked}
              aria-expanded={addingCred}
              onClick={onToggleAddCred}
              data-testid="clone-repo-new-cred"
            >
              {addingCred ? "Fechar" : "+ Nova credencial"}
            </button>
          )}
        </div>

        {credsError && <ErrorText testId="clone-repo-creds-error">{credsError}</ErrorText>}

        <div className="git-clone__grid">
          <div className="git-field">
            <label htmlFor={`${id}-name`} className="git-field__label">
              Nome da pasta (opcional)
            </label>
            <input
              id={`${id}-name`}
              className="ui-input"
              value={name}
              maxLength={80}
              disabled={locked || done}
              placeholder={suggestRepoName(url)}
              onChange={(event) => onNameChange(event.currentTarget.value)}
              data-testid="clone-repo-name"
            />
          </div>
          <div className="git-field">
            <label htmlFor={`${id}-branch`} className="git-field__label">
              Branch (opcional)
            </label>
            <input
              id={`${id}-branch`}
              className="ui-input git-mono"
              value={branch}
              maxLength={120}
              disabled={locked || done}
              placeholder="padrão do repositório"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => onBranchChange(event.currentTarget.value)}
              data-testid="clone-repo-branch"
            />
          </div>
        </div>

        <ErrorText testId="clone-repo-error">{formError}</ErrorText>

        {!done && (
          <div className="git-clone__actions">
            <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onClose} data-testid="clone-repo-cancel">
              Cancelar
            </button>
            <button
              type="submit"
              className="ui-button ui-button--small"
              disabled={locked || !url.trim()}
              aria-busy={locked}
              data-testid="clone-repo-submit"
            >
              {running ? "Clonando…" : submitting ? "Iniciando…" : "Clonar repositório"}
            </button>
          </div>
        )}
      </form>

      {addingCred && !done && !locked && (
        <div className="git-clone__inline-cred" data-testid="clone-repo-inline-cred">
          <GitCredentialForm
            initialHost={suggestedHost}
            initialKind={suggestedKind}
            onCreate={onCreateCred}
            onCancel={onToggleAddCred}
          />
        </div>
      )}

      {job && (
        <div className="git-clone__progress-box" data-testid="clone-repo-progress" data-status={job.status}>
          <div className="git-clone__status-row" role="status" aria-live="polite">
            <span className={`git-clone__status git-clone__status--${job.status}`} data-testid="clone-repo-status">
              {cloneStatusText(job)}
            </span>
          </div>

          {running &&
            (job.progress !== undefined ? (
              <ProgressBar value={job.progress / 100} label="Progresso do clone" testId="clone-repo-bar" />
            ) : (
              <div className="git-clone__indeterminate" role="progressbar" aria-label="Clonando repositório" data-testid="clone-repo-bar">
                <div className="git-clone__indeterminate-bar" />
              </div>
            ))}

          {done && job.result && (
            <div className={job.result.folderWarning ? "git-clone__banner git-clone__banner--warn" : "git-clone__banner git-clone__banner--ok"} role="status" data-testid="clone-repo-result">
              <strong className="git-clone__banner-title">
                {job.result.folderWarning ? "Repositório clonado, mas a pasta não pôde ser cadastrada" : "Pasta cadastrada"}
              </strong>
              {job.result.folderWarning && <p className="git-clone__banner-text">{job.result.folderWarning}</p>}
              <p className="git-clone__banner-path">
                <code>{job.result.path}</code>
              </p>
            </div>
          )}

          {failed && job.error && <ErrorText testId="clone-repo-job-error">{job.error}</ErrorText>}

          {job.log.length > 0 && (
            <pre className="git-clone__log" role="log" aria-live="polite" data-testid="clone-repo-log">
              {job.log.join("\n")}
            </pre>
          )}

          {(done || failed) && (
            <div className="git-clone__actions">
              {failed && (
                <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onReset} data-testid="clone-repo-retry">
                  Tentar de novo
                </button>
              )}
              <button type="button" className="ui-button ui-button--small" onClick={onClose} autoFocus={done} data-testid="clone-repo-done">
                {done ? "Concluir" : "Fechar"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Janela modal para clonar um repositório git e cadastrá-lo no workspace. */
export function CloneRepoDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [credentials, setCredentials] = useState<GitCredentialView[]>([]);
  const [loadingCreds, setLoadingCreds] = useState(true);
  const [credsError, setCredsError] = useState<string | null>(null);
  const [addingCred, setAddingCred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<GitCloneJob | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    void gitApi
      .listCredentials()
      .then((res) => {
        if (!aliveRef.current) return;
        setCredentials(res.credentials);
      })
      .catch((error) => {
        if (!aliveRef.current) return;
        setCredsError(error instanceof Error ? error.message : "Não foi possível carregar as credenciais.");
      })
      .finally(() => {
        if (aliveRef.current) setLoadingCreds(false);
      });
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Polling do andamento enquanto o job estiver em execução.
  const pollingJobId = job?.status === "running" ? job.id : null;
  useEffect(() => {
    if (!pollingJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await gitApi.getClone(pollingJobId);
        if (!cancelled && aliveRef.current) {
          setJob(response.job);
        }
      } catch (error) {
        if (!cancelled && aliveRef.current) {
          setFormError(error instanceof Error ? error.message : "Erro ao acompanhar o progresso do clone.");
        }
      }
    };
    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollingJobId]);

  const handleCreateCred = useCallback(async (body: CreateGitCredentialBody): Promise<GitCredentialView> => {
    const response = await gitApi.createCredential(body);
    setCredentials((prev) => [...prev, response.credential]);
    setCredentialId(response.credential.id);
    setAddingCred(false);
    return response.credential;
  }, []);

  const handleSubmit = async () => {
    const urlError = validateCloneUrlClient(url);
    if (urlError) {
      setFormError(urlError);
      return;
    }
    const nameError = validateCloneNameClient(name);
    if (nameError) {
      setFormError(nameError);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const response = await gitApi.startClone({
        url: url.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(credentialId ? { credentialId } : {}),
        addToWorkspace: workspaceId,
      });
      if (aliveRef.current) {
        setJob(response.job);
        setAddingCred(false);
      }
    } catch (error) {
      if (aliveRef.current) {
        setFormError(error instanceof Error ? error.message : "Não foi possível iniciar o clone.");
      }
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  };

  return (
    <Modal title="Clonar repositório" onClose={onClose} wide testId="clone-repo-modal">
      <CloneRepoDialogContent
        url={url}
        name={name}
        branch={branch}
        credentialId={credentialId}
        credentials={credentials}
        loadingCreds={loadingCreds}
        credsError={credsError}
        addingCred={addingCred}
        submitting={submitting}
        formError={formError}
        job={job}
        onUrlChange={(value) => {
          setFormError(null);
          setUrl(value);
        }}
        onNameChange={(value) => {
          setFormError(null);
          setName(value);
        }}
        onBranchChange={(value) => {
          setFormError(null);
          setBranch(value);
        }}
        onCredentialChange={(value) => {
          setFormError(null);
          setCredentialId(value);
        }}
        onToggleAddCred={() => setAddingCred((open) => !open)}
        onCreateCred={handleCreateCred}
        onSubmit={() => void handleSubmit()}
        onReset={() => {
          setJob(null);
          setFormError(null);
        }}
        onClose={onClose}
      />
    </Modal>
  );
}
