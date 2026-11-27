import { CYNO_MESSAGE_MAX, CYNO_STATUS_LABELS, engineBlockLabel, type CynoState } from "@cyno/shared";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../../../api/client";
import { useCynoStore } from "../../../store/cynoStore";
import { useFirstUseReviewStore } from "../../../store/firstUseReviewStore";
import { useNavStore } from "../../../store/navStore";
import { useAsyncAction } from "../../../ui/useAsyncAction";
import { hasErrors, LIMITS, validateWorkspaceForm } from "../../../ui/validation";
import { createWorkspaceBody, newWorkspaceValues } from "../../../ui/workspaceFormLogic";
import { settingsHash } from "../../settings/settingsView";
import { useEngineAccounts } from "../../settings/useEngineAccounts";
import { CynoModelPicker } from "../CynoModelPicker";
import { CynoPet } from "../CynoPet";
import { defaultAccountsConnected, FIRST_USE_SUGGESTIONS, onboardingState } from "../onboardingView";
import { withViewTransition } from "../viewTransition";
import { enterWorkspace } from "../WorkspaceCards";
import "./firstUse.css";

type FirstUseView = "a" | "c";

const ICON_PROPS = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Ícones de linha fina das sugestões, na mesma ordem de FIRST_USE_SUGGESTIONS (redes sociais, atendimento, pesquisa, código). */
const SUGGESTION_ICONS = [
  <svg key="social" {...ICON_PROPS}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </svg>,
  <svg key="support" {...ICON_PROPS}>
    <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
    <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
  </svg>,
  <svg key="search" {...ICON_PROPS}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.6-3.6" />
  </svg>,
  <svg key="code" {...ICON_PROPS}>
    <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
  </svg>,
];

type FirstUseScreenProps = {
  state: CynoState | null;
  now: Date;
};

function FirstUseHeader({
  state,
  now,
  showNewConversation,
}: {
  state: CynoState | null;
  now: Date;
  showNewConversation: boolean;
}) {
  const newConversation = useCynoStore((store) => store.newConversation);
  const status = state?.status ?? "sleeping";
  const statusLabel = state?.block ? `Cyno ${engineBlockLabel(state.block, now.getTime())}` : CYNO_STATUS_LABELS[status];
  // "Dormindo/Acordado" é estado interno do processo e não ajuda quem acabou de instalar: só aparece quando importa
  // (motor bloqueado, por exemplo por limite do plano, ou o Cyno trabalhando/acordando).
  const showStatus = Boolean(state?.block) || status === "working" || status === "waking";

  return (
    <header className="first-use__head">
      <div className="first-use__head-who">
        <span className="first-use__brand">Cyno</span>
        {showStatus && (
          <span
            className="first-use__pill first-use__pill--status"
            role="status"
            aria-live="polite"
            data-testid="cyno-status"
            data-status={status}
          >
            {statusLabel}
          </span>
        )}
      </div>
      <div className="first-use__head-actions">
        {state && <CynoModelPicker choice={state.choice} />}
        {showNewConversation && (
          <button
            type="button"
            className="first-use__pill first-use__pill--action"
            onClick={() => void newConversation()}
            disabled={!state || state.newConversation}
            title={
              state?.newConversation
                ? "A próxima mensagem já abre uma conversa nova"
                : "Começar uma conversa nova (o Cyno não lembra da atual)"
            }
            data-testid="cyno-new"
          >
            Nova conversa
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * Tela inteira de primeiro uso na página inicial do Cyno:
 * - Visão A (padrão): o Cyno conduz (mascote, campo grande, 4 atalhos e link para criar do zero).
 * - Visão C: "Comece em 3 passos" (contas reais, criação rápida de workspace e passo 3 bloqueado).
 */
export function FirstUseScreen({ state, now }: FirstUseScreenProps) {
  const [view, setView] = useState<FirstUseView>("a");
  const [draft, setDraft] = useState("");
  const [wsName, setWsName] = useState("");
  const [wsFieldError, setWsFieldError] = useState<string | null>(null);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const wsInputRef = useRef<HTMLInputElement>(null);
  const focusPromptRef = useRef(false);

  const titleId = useId();
  const promptId = useId();
  const ideasLabelId = useId();
  const wsInputId = useId();
  const wsErrorId = useId();

  const send = useCynoStore((store) => store.send);
  const sending = useCynoStore((store) => store.sending);
  const cynoError = useCynoStore((store) => store.error);
  const clearCynoError = useCynoStore((store) => store.clearError);
  const workspaceId = useNavStore((store) => store.workspaceId);
  const go = useNavStore((store) => store.go);

  const { accounts, loading: accountsLoading } = useEngineAccounts();
  const { pending: creating, error: createError, run: runCreate, clearError: clearCreateError } = useAsyncAction();

  // Na visão C, o passo 2 está sempre disponível para criar o workspace e o passo 3 permanece bloqueado.
  const stepsView = useMemo(
    () =>
      onboardingState({
        connected: defaultAccountsConnected(accounts),
        workspaces: 0,
        requests: 0,
      }),
    [accounts],
  );

  useEffect(() => {
    if (view === "a" && focusPromptRef.current) {
      focusPromptRef.current = false;
      promptRef.current?.focus();
    }
  }, [view]);

  const sendPrompt = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > CYNO_MESSAGE_MAX || sending) {
      if (!trimmed) promptRef.current?.focus();
      return;
    }
    if (cynoError) clearCynoError();
    const ok = await send(trimmed);
    if (ok) {
      setDraft("");
      // Mandou algo ao Cyno: abre o chat para ele aparecer trabalhando (e desliga o modo de revisão), com a caixa
      // descendo do centro para a base.
      withViewTransition(() => useFirstUseReviewStore.getState().openChat());
    }
  };

  // Sugestão: não envia; põe o começo da frase na caixa e deixa o cursor no fim para a pessoa completar.
  const fillPrompt = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const field = promptRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(text.length, text.length);
    });
  };

  const onPromptSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendPrompt(draft);
  };

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendPrompt(draft);
  };

  const onCreateWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;
    const found = validateWorkspaceForm({ name: wsName });
    if (hasErrors(found)) {
      setWsFieldError(found.name ?? "Dê um nome ao workspace.");
      wsInputRef.current?.focus();
      return;
    }
    setWsFieldError(null);
    const body = createWorkspaceBody({ ...newWorkspaceValues(), name: wsName }, null);
    const created = await runCreate(() => api.createWorkspace(body));
    if (created) {
      useFirstUseReviewStore.getState().stop();
      enterWorkspace(created.id);
    }
  };

  const openMotors = () => {
    useFirstUseReviewStore.getState().stop();
    go("configuracoes", "motores");
  };

  const backToCyno = () => {
    focusPromptRef.current = true;
    setView("a");
  };

  const motorsHref = settingsHash(workspaceId, "motores");
  const wsError = wsFieldError ?? createError;
  const mascotLabel = !state || state.status === "sleeping" ? "Mascote do Cyno dormindo" : "Mascote do Cyno";
  const step1Done = stepsView.steps.conta === "concluido";

  return (
    <div className="first-use" data-view={view} data-testid="first-use-screen">
      <FirstUseHeader state={state} now={now} showNewConversation={view === "a"} />

      {view === "a" ? (
        <section className="first-use__stage first-use__stage--a" aria-labelledby={titleId} data-testid="first-use-view-a">
          <div className="first-use__hero">
            <div className="first-use__mascot">
              <CynoPet status={state?.status} size="lg" px={76} label={mascotLabel} />
            </div>
            <h1 id={titleId} className="first-use__title first-use__title--a">
              Em que você quer trabalhar hoje?
            </h1>
            <p className="first-use__subtitle first-use__subtitle--a">
              Descreva o que precisa e eu preparo o workspace para você.
            </p>

            <form className="first-use__prompt-form" noValidate onSubmit={onPromptSubmit}>
              <label htmlFor={promptId} className="sr-only">
                O que você quer fazer
              </label>
              <div className="first-use__prompt-box">
                <textarea
                  ref={promptRef}
                  id={promptId}
                  className="first-use__prompt-input"
                  rows={1}
                  value={draft}
                  maxLength={CYNO_MESSAGE_MAX}
                  placeholder="Descreva o que você quer fazer…"
                  onChange={(event) => {
                    if (cynoError) clearCynoError();
                    setDraft(event.currentTarget.value);
                  }}
                  onKeyDown={onPromptKeyDown}
                  data-testid="first-use-prompt"
                />
                <button
                  type="submit"
                  className="first-use__primary-btn first-use__prompt-btn"
                  disabled={sending}
                  aria-label={sending ? "Enviando…" : "Criar workspace"}
                  title={sending ? "Enviando…" : "Criar workspace"}
                  data-testid="first-use-submit"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
              {cynoError && (
                <p className="first-use__error" role="alert" data-testid="first-use-cyno-error">
                  {cynoError}
                </p>
              )}
            </form>

            <p id={ideasLabelId} className="sr-only">
              Sugestões para começar
            </p>
            <div className="first-use__ideas" role="group" aria-labelledby={ideasLabelId}>
              {FIRST_USE_SUGGESTIONS.map((item, index) => (
                <button
                  key={item.label}
                  type="button"
                  className="first-use__idea-btn"
                  disabled={sending}
                  onClick={() => fillPrompt(item.prompt)}
                  data-testid="first-use-suggestion"
                >
                  <span className="first-use__idea-icon" aria-hidden="true">
                    {SUGGESTION_ICONS[index] ?? null}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>

            <div className="first-use__links">
              <button
                type="button"
                className="first-use__switch-link"
                onClick={() => setView("c")}
                data-testid="first-use-to-steps"
              >
                Prefiro configurar manualmente →
              </button>
            </div>
            <p className="first-use__footnote">As conversas com o Cyno usam a sua assinatura do Claude Code.</p>
          </div>
        </section>
      ) : (
        <section className="first-use__stage first-use__stage--c" aria-labelledby={titleId} data-testid="first-use-view-c">
          <div className="first-use__steps-wrap">
            <h1 id={titleId} className="first-use__title first-use__title--c">
              Primeiros passos
            </h1>
            <p className="first-use__subtitle first-use__subtitle--c">
              Três passos rápidos e o seu primeiro workspace estará pronto.
            </p>

            <div className="first-use__progress" data-testid="first-use-progress">
              <div
                className="first-use__progress-track"
                role="progressbar"
                aria-label="Progresso dos passos iniciais"
                aria-valuemin={0}
                aria-valuemax={stepsView.totalSteps}
                aria-valuenow={stepsView.completedCount}
              >
                <div className="first-use__progress-fill" style={{ width: `${stepsView.progressPercent}%` }} />
              </div>
              <span className="first-use__progress-text" data-testid="first-use-progress-text">
                {stepsView.completedCount} de {stepsView.totalSteps}
              </span>
            </div>

            <ol className="first-use__steps">
              <li
                className={`first-use__step ${step1Done ? "first-use__step--done" : "first-use__step--active"}`}
                data-testid="first-use-step-1"
                data-status={stepsView.steps.conta}
              >
                <div
                  className={`first-use__badge ${step1Done ? "first-use__badge--done" : "first-use__badge--active"}`}
                >
                  {step1Done ? (
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-label="Concluído"
                      role="img"
                    >
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  ) : (
                    "1"
                  )}
                </div>
                <div className="first-use__step-body">
                  <h2 className="first-use__step-title">Conectar uma conta</h2>
                  <div className="first-use__accounts">
                    {accountsLoading && accounts === null ? (
                      <span className="first-use__account-loading" role="status">
                        Verificando contas…
                      </span>
                    ) : (
                      stepsView.engines.map((engine) =>
                        engine.connected ? (
                          <span
                            key={engine.engine}
                            className="first-use__account-pill"
                            data-testid={`first-use-engine-${engine.engine}`}
                            data-connected="true"
                          >
                            <span className="first-use__account-dot first-use__account-dot--ok" aria-hidden="true" />
                            {engine.label} conectado
                          </span>
                        ) : (
                          <span
                            key={engine.engine}
                            className="first-use__account-pill first-use__account-pill--off"
                            data-testid={`first-use-engine-${engine.engine}`}
                            data-connected="false"
                          >
                            <span className="first-use__account-dot first-use__account-dot--off" aria-hidden="true" />
                            <span>{engine.label}</span>
                            <a
                              href={motorsHref}
                              className="first-use__account-login"
                              aria-label={`Entrar em ${engine.label}`}
                              onClick={(event) => {
                                event.preventDefault();
                                openMotors();
                              }}
                              data-testid={`first-use-engine-login-${engine.engine}`}
                            >
                              Entrar
                            </a>
                          </span>
                        ),
                      )
                    )}
                  </div>
                  <a
                    href={motorsHref}
                    className="first-use__manage-link"
                    onClick={(event) => {
                      event.preventDefault();
                      openMotors();
                    }}
                    data-testid="first-use-manage-accounts"
                  >
                    Gerenciar contas
                  </a>
                </div>
              </li>

              <li
                className="first-use__step first-use__step--active"
                data-testid="first-use-step-2"
                data-status={stepsView.steps.workspace}
              >
                <div className="first-use__badge first-use__badge--active" aria-hidden="true">
                  2
                </div>
                <div className="first-use__step-body">
                  <h2 className="first-use__step-title">Criar o primeiro workspace</h2>
                  <p className="first-use__step-desc">
                    Um workspace é um espaço separado para um projeto ou cliente, com um Maestro que coordena os agentes.
                  </p>
                  <form className="first-use__ws-form" noValidate onSubmit={(event) => void onCreateWorkspace(event)}>
                    <label htmlFor={wsInputId} className="sr-only">
                      Nome do workspace
                    </label>
                    <div className="first-use__ws-row">
                      <input
                        ref={wsInputRef}
                        id={wsInputId}
                        type="text"
                        className="first-use__ws-input"
                        value={wsName}
                        placeholder="Ex.: Instagram da cafeteria"
                        maxLength={LIMITS.workspaceName + 10}
                        aria-invalid={wsError ? "true" : undefined}
                        aria-describedby={wsError ? wsErrorId : undefined}
                        onChange={(event) => {
                          if (wsFieldError) setWsFieldError(null);
                          if (createError) clearCreateError();
                          setWsName(event.currentTarget.value);
                        }}
                        data-testid="first-use-ws-name"
                      />
                      <button
                        type="submit"
                        className="first-use__primary-btn first-use__ws-btn"
                        disabled={creating}
                        data-testid="first-use-ws-submit"
                      >
                        {creating ? "Criando…" : "Criar"}
                      </button>
                    </div>
                    {wsError && (
                      <p id={wsErrorId} className="first-use__error first-use__error--left" role="alert" data-testid="first-use-ws-error">
                        {wsError}
                      </p>
                    )}
                  </form>
                  <p className="first-use__step-alt">
                    Prefere conversar?{" "}
                    <button
                      type="button"
                      className="first-use__inline-link"
                      onClick={backToCyno}
                      data-testid="first-use-to-cyno"
                    >
                      Peça ao Cyno para montar por você
                    </button>
                  </p>
                </div>
              </li>

              <li
                className="first-use__step first-use__step--locked"
                data-testid="first-use-step-3"
                data-status={stepsView.steps.pedido}
              >
                <div className="first-use__badge first-use__badge--locked" aria-hidden="true">
                  3
                </div>
                <div className="first-use__step-body">
                  <h2 className="first-use__step-title first-use__step-title--locked">Fazer o primeiro pedido</h2>
                  <p className="first-use__step-desc first-use__step-desc--locked">
                    Depois de criar, descreva o que você precisa ao Maestro e acompanhe o trabalho.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>
      )}
    </div>
  );
}
