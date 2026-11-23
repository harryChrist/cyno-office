import {
  ENGINE_LABELS,
  type AccountEngine,
  type EngineAccountView,
  type EngineInstallJob,
  type EngineInstallPlan,
  type EngineStatus,
} from "@cyno/shared";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../api/client";
import { copyText } from "../../ui/clipboard";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import {
  accountDisplayLabel,
  accountKey,
  accountLoginActionLabel,
  accountLoginBadge,
  ACCOUNT_DELETE_WARNING,
  ACCOUNTS_HELP_LINE,
  engineAccountsSummaryBadge,
  engineInstallState,
  groupAccountsByEngine,
  isDefaultAccount,
  MAX_ACCOUNT_LABEL_LENGTH,
  validateAccountLabel,
  type EngineAccountsGroup,
} from "./engineAccountsView";
import { LoginTerminal } from "./LoginTerminal";
import { Seal } from "./SettingsOption";
import { useEngineAccounts } from "./useEngineAccounts";
import "./engineAccounts.css";

type LoginTarget = {
  engine: AccountEngine;
  accountId: string;
  label: string;
};

/** Linha de comando com botão de copiar (mesmo padrão da instalação em OneShotSection). */
function InstallCopyLine({ text, testId }: { text: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="oneshot__copy">
      <pre className="oneshot__code" data-testid={testId}>
        {text}
      </pre>
      <button
        type="button"
        className="ui-button ui-button--ghost ui-button--small"
        onClick={() => {
          void copyText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

/** Bloco de instalação de Claude Code / Antigravity quando o motor ainda não está instalado no servidor. */
function AccountEngineInstall({
  engine,
  label,
  status,
  onInstalled,
}: {
  engine: AccountEngine;
  label: string;
  status: EngineStatus;
  onInstalled: () => void;
}) {
  const [plan, setPlan] = useState<EngineInstallPlan | null>(null);
  const [busy, setBusy] = useState<"plan" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveJob, setLiveJob] = useState<EngineInstallJob | undefined>();
  const job = liveJob && liveJob.engine === engine ? liveJob : status.installJob;

  // Polling leve da saída do instalador (igual à OneShotSection); só redetecta tudo ao terminar.
  useEffect(() => {
    if (job?.status !== "running") return;
    const timer = setInterval(() => {
      void api.getEngineInstall(engine).then(
        (response) => {
          if (!response.job) return;
          setLiveJob(response.job);
          if (response.job.status !== "running") {
            clearInterval(timer);
            onInstalled();
          }
        },
        () => undefined,
      );
    }, 1500);
    return () => clearInterval(timer);
  }, [job?.status, engine, onInstalled]);

  const openPlan = async () => {
    setBusy("plan");
    setError(null);
    try {
      const response = await api.getEngineInstallPlan(engine);
      setPlan(response.plan);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };

  const confirmInstall = async () => {
    setBusy("install");
    setError(null);
    try {
      const response = await api.installEngine(engine);
      setPlan(null);
      setLiveJob(response.job);
      if (response.job.status !== "running") {
        onInstalled();
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="eacc-install" data-testid={`accounts-install-${engine}`}>
      <p className="eacc-install__note">
        O {label} não está instalado neste servidor. Instale o motor antes de entrar nas contas.
      </p>
      {!plan && job?.status !== "running" && (
        <div>
          <button
            type="button"
            className="ui-button ui-button--small"
            onClick={() => void openPlan()}
            disabled={busy !== null}
            aria-busy={busy === "plan"}
            data-testid={`accounts-install-plan-${engine}`}
          >
            {busy === "plan" ? "Montando o plano…" : "Instalar"}
          </button>
        </div>
      )}
      {plan && (
        <div className="oneshot__plan" data-testid={`accounts-plan-${engine}`}>
          <p>
            <strong>{plan.title}</strong>
          </p>
          <p className="oneshot__label">Comando exato</p>
          <InstallCopyLine text={plan.command} testId={`accounts-plan-command-${engine}`} />
          <p>
            <span className="oneshot__label">Precisa de sudo: </span>
            <strong>{plan.needsSudo ? "sim" : "não"}</strong>. {plan.sudoNote}
          </p>
          {plan.touches.length > 0 && (
            <>
              <p className="oneshot__label">Mexe fora da pasta de instalação</p>
              <ul>
                {plan.touches.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <details className="oneshot__more">
            <summary>Ver o que acontece, o que baixa e onde instala</summary>
            <p className="oneshot__label">O que acontece</p>
            <ul>
              {plan.steps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="oneshot__label">O que baixa</p>
            <ul>
              {plan.downloads.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>
              <span className="oneshot__label">Onde instala: </span>
              {plan.destination}
            </p>
            {plan.unverified.map((line) => (
              <p key={line} className="oneshot__unverified">
                Não verificado com o programa de verdade: {line}
              </p>
            ))}
          </details>
          <div className="engine-card__actions">
            <button
              type="button"
              className="ui-button ui-button--small"
              onClick={() => void confirmInstall()}
              disabled={busy !== null}
              aria-busy={busy === "install"}
              data-testid={`accounts-install-confirm-${engine}`}
            >
              {busy === "install" ? "Iniciando…" : "Confirmar e instalar"}
            </button>
            <button
              type="button"
              className="ui-button ui-button--ghost ui-button--small"
              onClick={() => setPlan(null)}
              disabled={busy !== null}
              data-testid={`accounts-install-cancel-${engine}`}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
      {job && (
        <div className="oneshot__job" data-testid={`accounts-install-job-${engine}`} data-status={job.status}>
          <p className="oneshot__label">
            {job.status === "running"
              ? "Instalando…"
              : job.status === "done"
                ? "Instalação concluída"
                : `A instalação falhou${job.error ? `: ${job.error}` : ""}`}
          </p>
          <pre className="oneshot__code oneshot__code--log">{job.log.slice(-14).join("\n")}</pre>
        </div>
      )}
      <ErrorText testId={`accounts-install-error-${engine}`}>{error}</ErrorText>
    </div>
  );
}

export type EngineAccountsCardProps = {
  group: EngineAccountsGroup;
  status?: EngineStatus;
  onLogin: (target: LoginTarget) => void;
  onCreate: (engine: AccountEngine, label: string) => Promise<unknown>;
  onRename: (id: string, label: string) => Promise<unknown>;
  onAskDelete: (account: EngineAccountView) => void;
  onInstalled: () => void;
};

/** Cartão de contas de um motor (Claude Code ou Antigravity): conta padrão, contas extras e adicionar conta. */
export function EngineAccountsCard({
  group,
  status,
  onLogin,
  onCreate,
  onRename,
  onAskDelete,
  onInstalled,
}: EngineAccountsCardProps) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const installState = engineInstallState(status);
  const notInstalled = installState === "not_installed";
  const summaryBadge = engineAccountsSummaryBadge(group, installState);

  const items: EngineAccountView[] = [
    ...(group.defaultAccount ? [group.defaultAccount] : []),
    ...group.extraAccounts,
  ];

  const handleAddSubmit = async () => {
    const check = validateAccountLabel(newLabel);
    if (!check.ok) {
      setAddError(check.error);
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await onCreate(group.engine, check.value);
      setNewLabel("");
      setAdding(false);
    } catch (failure) {
      setAddError(describeError(failure));
    } finally {
      setAddBusy(false);
    }
  };

  const startRename = (account: EngineAccountView) => {
    setRenamingId(account.id);
    setRenameValue(account.label);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
    setRenameError(null);
  };

  const handleRenameSubmit = async (id: string) => {
    const check = validateAccountLabel(renameValue);
    if (!check.ok) {
      setRenameError(check.error);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await onRename(id, check.value);
      cancelRename();
    } catch (failure) {
      setRenameError(describeError(failure));
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <section
      className="settings__card eacc-card"
      aria-labelledby={`eacc-title-${group.engine}`}
      data-testid={`accounts-card-${group.engine}`}
    >
      <header className="eacc-card__head">
        <h4 id={`eacc-title-${group.engine}`} className="settings__card-title">
          {group.label}
        </h4>
        <span className={`ui-badge ui-badge--${summaryBadge.tone}`} data-testid={`accounts-summary-${group.engine}`}>
          {summaryBadge.label}
        </span>
        <Seal kind="plataforma" />
      </header>

      {notInstalled && status && (
        <AccountEngineInstall
          engine={group.engine}
          label={group.label}
          status={status}
          onInstalled={onInstalled}
        />
      )}

      <ul className="eacc-list" aria-label={`Contas do ${group.label}`} data-testid={`accounts-list-${group.engine}`}>
        {items.map((account) => {
          const isDefault = isDefaultAccount(account);
          const displayLabel = accountDisplayLabel(account);
          const badge = accountLoginBadge(account.loggedIn);
          const loginButtonLabel = accountLoginActionLabel(account.loggedIn);
          const isRenaming = !isDefault && renamingId === account.id;
          return (
            <li
              key={accountKey(account)}
              className={`eacc-item${isDefault ? " eacc-item--default" : ""}`}
              data-testid={`account-item-${group.engine}-${account.id}`}
              data-default={isDefault ? "true" : "false"}
              data-logged-in={account.loggedIn ? "true" : "false"}
            >
              {isRenaming ? (
                <form
                  className="eacc-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleRenameSubmit(account.id);
                  }}
                >
                  <label className="sr-only" htmlFor={`rename-account-${account.id}`}>
                    Novo apelido da conta
                  </label>
                  <input
                    id={`rename-account-${account.id}`}
                    type="text"
                    className="ui-input"
                    value={renameValue}
                    maxLength={MAX_ACCOUNT_LABEL_LENGTH}
                    autoFocus
                    disabled={renameBusy}
                    onChange={(event) => setRenameValue(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                    data-testid={`account-rename-input-${account.id}`}
                  />
                  <button
                    type="submit"
                    className="ui-button ui-button--small"
                    disabled={renameBusy}
                    data-testid={`account-rename-save-${account.id}`}
                  >
                    {renameBusy ? "Salvando…" : "Salvar"}
                  </button>
                  <button
                    type="button"
                    className="ui-button ui-button--ghost ui-button--small"
                    onClick={cancelRename}
                    disabled={renameBusy}
                    data-testid={`account-rename-cancel-${account.id}`}
                  >
                    Cancelar
                  </button>
                  <ErrorText testId={`account-rename-error-${account.id}`}>{renameError}</ErrorText>
                </form>
              ) : (
                <div className="eacc-item__row">
                  <div className="eacc-item__info">
                    <span className="eacc-item__name" data-testid={`account-label-${group.engine}-${account.id}`}>
                      {displayLabel}
                    </span>
                    <span
                      className={`ui-badge ui-badge--${badge.tone}`}
                      data-testid={`account-status-${group.engine}-${account.id}`}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div className="eacc-item__actions">
                    <button
                      type="button"
                      className={`ui-button ui-button--small${account.loggedIn ? " ui-button--secondary" : ""}`}
                      disabled={notInstalled}
                      title={
                        notInstalled
                          ? `Instale o ${group.label} primeiro.`
                          : `${loginButtonLabel} em ${displayLabel} (${group.label})`
                      }
                      aria-label={`${loginButtonLabel} na conta ${displayLabel} do ${group.label}`}
                      onClick={() =>
                        onLogin({
                          engine: group.engine,
                          accountId: account.id,
                          label: displayLabel,
                        })
                      }
                      data-testid={`account-login-${group.engine}-${account.id}`}
                    >
                      {loginButtonLabel}
                    </button>
                    {!isDefault && (
                      <>
                        <button
                          type="button"
                          className="ui-button ui-button--secondary ui-button--small"
                          aria-label={`Renomear conta ${displayLabel} do ${group.label}`}
                          onClick={() => startRename(account)}
                          data-testid={`account-rename-${account.id}`}
                        >
                          Renomear
                        </button>
                        <button
                          type="button"
                          className="ui-button ui-button--danger ui-button--small"
                          aria-label={`Apagar conta ${displayLabel} do ${group.label}`}
                          onClick={() => onAskDelete(account)}
                          data-testid={`account-delete-${account.id}`}
                        >
                          Apagar
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="eacc-add">
        {adding ? (
          <form
            className="eacc-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddSubmit();
            }}
          >
            <label className="sr-only" htmlFor={`add-account-${group.engine}`}>
              Apelido da nova conta do {group.label}
            </label>
            <input
              id={`add-account-${group.engine}`}
              type="text"
              className="ui-input"
              value={newLabel}
              placeholder="Apelido da conta (ex.: Trabalho, Pessoal)"
              maxLength={MAX_ACCOUNT_LABEL_LENGTH}
              autoFocus
              disabled={addBusy}
              onChange={(event) => setNewLabel(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAdding(false);
                  setNewLabel("");
                  setAddError(null);
                }
              }}
              data-testid={`accounts-add-input-${group.engine}`}
            />
            <button
              type="submit"
              className="ui-button ui-button--small"
              disabled={addBusy}
              data-testid={`accounts-add-submit-${group.engine}`}
            >
              {addBusy ? "Criando…" : "Criar conta"}
            </button>
            <button
              type="button"
              className="ui-button ui-button--ghost ui-button--small"
              disabled={addBusy}
              onClick={() => {
                setAdding(false);
                setNewLabel("");
                setAddError(null);
              }}
              data-testid={`accounts-add-cancel-${group.engine}`}
            >
              Cancelar
            </button>
            <ErrorText testId={`accounts-add-error-${group.engine}`}>{addError}</ErrorText>
          </form>
        ) : (
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--small eacc-add__trigger"
            onClick={() => {
              setAdding(true);
              setAddError(null);
            }}
            data-testid={`accounts-add-${group.engine}`}
          >
            Adicionar conta
          </button>
        )}
      </div>
    </section>
  );
}

export type EngineAccountsPanelProps = {
  /** Estado dos motores compartilhado com `EnginesPanel` (para saber se Claude/Antigravity estão instalados). */
  statuses?: readonly EngineStatus[] | null;
  /** Avisa o `EnginesPanel` para atualizar a detecção após instalar um motor ou concluir um login. */
  onEnginesChanged?: () => void;
};

/**
 * Painel "Contas" em Configurações › Motores:
 * gerencia a conta padrão e contas extras do Claude Code e do Antigravity,
 * com instalação pelo servidor quando o motor ainda não está instalado e login pelo mini terminal.
 */
export function EngineAccountsPanel({ statuses, onEnginesChanged }: EngineAccountsPanelProps) {
  const { accounts, loading, error, refresh, createAccount, renameAccount, deleteAccount } = useEngineAccounts();
  const [loginTarget, setLoginTarget] = useState<LoginTarget | null>(null);
  const [deleting, setDeleting] = useState<EngineAccountView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = groupAccountsByEngine(accounts);
  const statusOf = (engine: AccountEngine) => statuses?.find((item) => item.id === engine);

  const handleInstalled = useCallback(() => {
    onEnginesChanged?.();
    void refresh();
  }, [onEnginesChanged, refresh]);

  const handleLoginSuccess = useCallback(() => {
    setLoginTarget((current) => {
      if (current) {
        setNotice(`Conta "${current.label}" (${ENGINE_LABELS[current.engine]}) conectada.`);
      }
      return null;
    });
    void refresh();
    onEnginesChanged?.();
  }, [refresh, onEnginesChanged]);

  return (
    <div className="settings__groups" data-testid="settings-accounts">
      <div className="settings__toolbar">
        <p className="settings__card-hint" data-testid="accounts-help">
          {ACCOUNTS_HELP_LINE}
        </p>
        <button
          type="button"
          className="ui-button ui-button--secondary ui-button--small"
          onClick={() => {
            setNotice(null);
            void refresh();
          }}
          disabled={loading}
          aria-busy={loading}
          data-testid="accounts-refresh"
        >
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>

      {notice && (
        <p className="eacc-status" role="status" data-testid="accounts-notice">
          {notice}
        </p>
      )}
      <ErrorText testId="accounts-error">{error}</ErrorText>

      {accounts === null && loading ? (
        <p className="settings__card-hint" role="status">
          Carregando as contas dos motores…
        </p>
      ) : (
        <div className="eacc-grid">
          {groups.map((group) => (
            <EngineAccountsCard
              key={group.engine}
              group={group}
              status={statusOf(group.engine)}
              onLogin={(target) => {
                setNotice(null);
                setLoginTarget(target);
              }}
              onCreate={createAccount}
              onRename={renameAccount}
              onAskDelete={setDeleting}
              onInstalled={handleInstalled}
            />
          ))}
        </div>
      )}

      {loginTarget && (
        <LoginTerminal
          engine={loginTarget.engine}
          accountId={loginTarget.accountId}
          accountLabel={loginTarget.label}
          onClose={() => setLoginTarget(null)}
          onSuccess={handleLoginSuccess}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Apagar conta "${deleting.label}"`}
          message={
            <p>
              Tem certeza que deseja apagar a conta <strong>{deleting.label}</strong> ({ENGINE_LABELS[deleting.engine]})?{" "}
              {ACCOUNT_DELETE_WARNING}
            </p>
          }
          confirmLabel="Apagar conta"
          pendingLabel="Apagando…"
          onConfirm={() => deleteAccount(deleting.id)}
          onClose={() => setDeleting(null)}
          testId="account-delete-dialog"
        />
      )}
    </div>
  );
}
