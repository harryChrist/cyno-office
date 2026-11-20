import { AGENT_EFFORTS, EFFORT_LABELS, fileReachNotice, PROGRAM_PROVIDER_KIND_LABELS, type EngineInstallJob, type EngineInstallPlan, type EngineStatus, type EngineVerifyResult, type OneShotAccountBody, type OneShotEngineId } from "@cyno/shared";
import { useEffect, useState } from "react";
import { api, describeError } from "../../api/client";
import { AccountModelPicker } from "../../ui/AccountModelPicker";
import { UNLISTED_HINT } from "../../ui/modelSearch";
import { ErrorText } from "../../ui/widgets";
import { copyText } from "../../ui/clipboard";
import { checkGlyph, currentStep, FREE_LIMIT_NOTE, KEY_SAFETY_NOTE, keyLine, PROGRAM_ACCOUNT_NOTE, paidModelWarning, priceLine, spentLine, stepGlyph, STEP_STATE_LABEL, stepView, verifyGroups, verifyHeadline } from "./oneShotView";

/** O comando com o botão de copiar ao lado. */
function CopyLine({ text, testId }: { text: string; testId?: string }) {
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

type Props = { engine: EngineStatus; now: number; onStatus: (engines: EngineStatus[]) => void };

/**
 * O passo a passo do OpenClaw e do Hermes: Instalar (plano e confirmação), Conta (chave do OpenRouter ou a configuração do próprio programa), Modelo e Verificar.
 * Cada etapa mostra o estado (feito, falta, com erro) e o botão de ação na etapa da vez; as já feitas deixam trocar.
 */
export function OneShotSection({ engine, now, onStatus }: Props) {
  const steps = engine.steps ?? [];
  const current = currentStep(steps);
  const stateOf = (id: string) => steps.find((step) => step.id === id)?.state ?? "todo";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<EngineInstallPlan | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<EngineVerifyResult | null>(null);
  const [liveJob, setLiveJob] = useState<EngineInstallJob | undefined>();
  const job = liveJob && liveJob.engine === engine.id ? liveJob : engine.installJob;

  // Enquanto instala, só a saída da instalação se atualiza sozinha (rota leve: o estado completo roda o `--version` dos programas, e o do Hermes sobe Python).
  // A detecção completa acontece uma vez, quando a instalação acaba.
  useEffect(() => {
    if (job?.status !== "running") return;
    const timer = setInterval(() => {
      void api.getEngineInstall(engine.id).then(
        (response) => {
          if (!response.job) return;
          setLiveJob(response.job);
          if (response.job.status !== "running") {
            clearInterval(timer);
            void api.getEngineStatus().then((all) => {
              onStatus(all.engines);
              setLiveJob(undefined);
            }, () => undefined);
          }
        },
        () => undefined,
      );
    }, 1500);
    return () => clearInterval(timer);
  }, [job?.status, engine.id, onStatus]);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };
  const reload = async () => onStatus((await api.getEngineStatus()).engines);

  const chosen = engine.choices?.model ?? "";
  const verify = verifyResult ?? engine.verify ?? null;
  const paid = paidModelWarning(engine);
  const spent = spentLine(engine.spent, now);
  const isOpenClaw = engine.id === "openclaw";

  const openPlan = () => run("plan", async () => setPlan((await api.getEngineInstallPlan(engine.id)).plan));
  const install = () =>
    run("install", async () => {
      await api.installEngine(engine.id);
      setPlan(null);
      await reload();
    });
  const saveKey = () =>
    run("key", async () => {
      const saved = await api.setOpenRouterKey(keyValue.trim());
      setKeyWarning(saved.warning ?? null);
      setKeyValue("");
      setReplacing(false);
      await reload();
    });
  const removeKey = () =>
    run("key", async () => {
      await api.removeOpenRouterKey();
      setKeyWarning(null);
      await reload();
    });
  const programMode = engine.account?.mode === "program";
  const setup = engine.programSetup;
  const chooseAccount = (change: OneShotAccountBody) => run("account", async () => onStatus((await api.setEngineAccount(engine.id, change)).engines));
  const detectProgram = () =>
    run("detect", async () => {
      await api.detectEngineProgram(engine.id);
      await reload();
    });
  const chooseGateways = (count: number) => run("gateways", async () => onStatus((await api.setEngineChoices(engine.id, { maxGateways: count })).engines));
  const reachWarning = fileReachNotice(engine.id as OneShotEngineId, engine.fence, engine.account);
  const chooseFence = (on: boolean) => run("fence", async () => onStatus((await api.setEngineChoices(engine.id, { fence: on })).engines));
  const chooseModel = (model: string | null) => run("model", async () => onStatus((await api.setEngineChoices(engine.id, { model })).engines));
  const chooseEffort = (effort: (typeof AGENT_EFFORTS)[number] | null) => run("effort", async () => onStatus((await api.setEngineChoices(engine.id, { effort })).engines));
  const verifyNow = (confirm: boolean) =>
    run(confirm ? "turn" : "verify", async () => {
      setVerifyResult((await api.verifyEngine(engine.id, confirm)).result);
      await reload();
      setVerifyResult(null);
    });

  // A etapa da vez fica aberta; as feitas recolhem numa linha (clicar reabre); as próximas ficam esmaecidas.
  const [reopened, setReopened] = useState<ReadonlySet<string>>(new Set());
  const toggleStep = (id: string) =>
    setReopened((currentSet) => {
      const next = new Set(currentSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const viewOf = (step: (typeof steps)[number]) => stepView(step, current?.id, reopened.has(step.id));
  const stepOpen = (id: string) => {
    const step = steps.find((candidate) => candidate.id === id);
    return step ? viewOf(step) === "open" : false;
  };

  return (
    <div className="oneshot" data-testid={`oneshot-${engine.id}`}>
      {engine.fence && (
        <div className="oneshot__fence" data-testid="oneshot-fence" data-active={engine.fence.active ? "true" : "false"}>
          <label className="oneshot__fence-toggle">
            <input type="checkbox" checked={engine.fence.enabled} disabled={busy !== null || !engine.fence.available} onChange={(event) => void chooseFence(event.currentTarget.checked)} data-testid="oneshot-fence-toggle" />
            <span>Cercar os arquivos do agente</span>
          </label>
          <p className={`oneshot__fence-state${engine.fence.active ? " oneshot__fence-state--on" : ""}`} data-testid="oneshot-fence-state">
            {engine.fence.active ? "Ativa: o agente só alcança a pasta dele." : !engine.fence.available ? "Indisponível neste computador." : engine.fence.enabled ? "Sem cerca neste motor e nesta conta." : "Desligada: o agente alcança o que o seu usuário alcança."}
            {!engine.fence.active && engine.fence.reason ? ` ${engine.fence.reason}` : ""}
            {engine.fence.active && engine.fence.abi ? ` (Landlock, ABI ${engine.fence.abi})` : ""}
          </p>
        </div>
      )}
      {reachWarning && (
        <p className={engine.fence?.active ? "oneshot__note" : "oneshot__paid"} role="note" data-testid="oneshot-file-reach-warning">
          <strong>Alcance dos arquivos.</strong> {reachWarning}
        </p>
      )}
      <h5 className="oneshot__title">Passo a passo</h5>
      <ol className="oneshot__steps">
        {steps.map((step) => {
          const view = viewOf(step);
          const foldable = step.state === "done";
          const head = (
            <>
              <span className="oneshot__glyph" aria-hidden="true">
                {stepGlyph(step.state)}
              </span>
              <strong>{step.label}</strong>
              {foldable && step.detail && view === "folded" && <span className="oneshot__summary">{step.detail}</span>}
              <span className="oneshot__state">{STEP_STATE_LABEL[step.state]}</span>
            </>
          );
          return (
          <li key={step.id} className={`oneshot__step oneshot__step--${step.state} oneshot__step--${view}`} data-testid={`oneshot-step-${step.id}`} data-state={step.state} data-view={view} aria-current={step.id === current?.id ? "step" : undefined}>
            {foldable ? (
              <button type="button" className="oneshot__step-head oneshot__step-toggle" aria-expanded={view === "open"} aria-controls={`oneshot-body-${engine.id}-${step.id}`} onClick={() => toggleStep(step.id)} data-testid={`oneshot-toggle-${step.id}`}>
                {head}
                <span className="oneshot__chevron" aria-hidden="true" />
              </button>
            ) : (
              <div className="oneshot__step-head">{head}</div>
            )}
            <div id={`oneshot-body-${engine.id}-${step.id}`} hidden={view !== "open"} className="oneshot__step-body">
            {step.detail && !(foldable && view === "folded") && <p className="oneshot__detail">{step.detail}</p>}

            {step.id === "install" && stepOpen("install") && stateOf("install") !== "done" && (
              <div className="oneshot__body">
                {!plan && job?.status !== "running" && (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => void openPlan()} disabled={busy !== null} data-testid="oneshot-install-plan">
                    {busy === "plan" ? "Montando o plano…" : "Instalar…"}
                  </button>
                )}
                {plan && (
                  <div className="oneshot__plan" data-testid="oneshot-plan">
                    <p>
                      <strong>{plan.title}</strong>
                    </p>
                    <p className="oneshot__label">Comando exato</p>
                    <CopyLine text={plan.command} testId="oneshot-plan-command" />
                    <p data-testid="oneshot-plan-sudo">
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
                    <details className="oneshot__more" data-testid="oneshot-plan-details">
                      <summary>Ver o que acontece, o que baixa e o que não foi verificado</summary>
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
                      <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => void install()} disabled={busy !== null} data-testid="oneshot-install-confirm">
                        {busy === "install" ? "Iniciando…" : "Confirmar e instalar"}
                      </button>
                      <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => setPlan(null)} data-testid="oneshot-install-cancel">
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
                {job && (
                  <div className="oneshot__job" data-testid="oneshot-job" data-status={job.status}>
                    <p className="oneshot__label">{job.status === "running" ? "Instalando…" : job.status === "done" ? "Instalação concluída" : `A instalação falhou${job.error ? `: ${job.error}` : ""}`}</p>
                    <pre className="oneshot__code oneshot__code--log">{job.log.slice(-14).join("\n")}</pre>
                  </div>
                )}
              </div>
            )}

            {step.id === "key" && stepOpen("key") && (
              <div className="oneshot__body" data-testid="oneshot-account">
                {/* Com a cerca ativa o texto do topo do cartão já diz o alcance; aqui ele só se repete quando é um aviso (sem cerca). */}
                {reachWarning && !engine.fence?.active && (
                  <p className="oneshot__paid" role="note" data-testid="oneshot-account-file-reach-warning">
                    {reachWarning}
                  </p>
                )}
                <div className="mpick__filters" role="group" aria-label="Forma de conta">
                  <button type="button" className="mpick__chip" aria-pressed={!programMode} onClick={() => void chooseAccount({ mode: "openrouter" })} disabled={busy !== null} data-testid="oneshot-account-openrouter">
                    Chave do OpenRouter pelo painel
                  </button>
                  <button type="button" className="mpick__chip" aria-pressed={programMode} onClick={() => void chooseAccount({ mode: "program" })} disabled={busy !== null} data-testid="oneshot-account-program">
                    Configuração do próprio programa
                  </button>
                </div>
                {!programMode && (
                  <>
                    <p className="oneshot__hint">O jeito mais fácil. A chave fica isolada na pasta do Cyno.</p>
                    <p className="oneshot__detail" data-testid="oneshot-key-line">
                      {keyLine(engine.openrouterKey, now)}
                    </p>
                    {(!engine.openrouterKey?.configured || replacing) && (
                      <form
                        className="oneshot__form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveKey();
                        }}
                      >
                        <label className="oneshot__label" htmlFor={`or-key-${engine.id}`}>
                          Chave do OpenRouter
                        </label>
                        <input id={`or-key-${engine.id}`} className="ui-input" type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={keyValue} onChange={(event) => setKeyValue(event.currentTarget.value)} data-testid="oneshot-key-input" />
                        <button type="submit" className="ui-button ui-button--primary ui-button--small" disabled={busy !== null || keyValue.trim().length < 10} data-testid="oneshot-key-save">
                          {busy === "key" ? "Guardando…" : "Guardar"}
                        </button>
                        {replacing && (
                          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => setReplacing(false)}>
                            Cancelar
                          </button>
                        )}
                      </form>
                    )}
                    {engine.openrouterKey?.configured && !replacing && (
                      <div className="engine-card__actions">
                        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setReplacing(true)} data-testid="oneshot-key-replace">
                          Trocar
                        </button>
                        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => void removeKey()} disabled={busy !== null} data-testid="oneshot-key-remove">
                          Remover
                        </button>
                      </div>
                    )}
                    {keyWarning && (
                      <p className="oneshot__paid" role="alert" data-testid="oneshot-key-warning">
                        {keyWarning}
                      </p>
                    )}
                    <details className="settings__more">
                      <summary>Segurança da chave</summary>
                      <p>
                        {KEY_SAFETY_NOTE} Ela vai ao programa só por variável de ambiente, em cada turno. Gere a chave em openrouter.ai, em Keys.
                      </p>
                    </details>
                  </>
                )}
                {programMode && setup && (
                  <div className="oneshot__program" data-testid="oneshot-program">
                    <p className="oneshot__hint">{PROGRAM_ACCOUNT_NOTE}</p>
                    <p className="oneshot__label">Onde fica a configuração</p>
                    <div className="mpick__filters" role="group" aria-label="Onde fica a configuração">
                      <button type="button" className="mpick__chip" aria-pressed={engine.account?.location === "personal"} onClick={() => void chooseAccount({ location: "personal" })} disabled={busy !== null} data-testid="oneshot-location-personal">
                        A pessoal do dono ({setup.personalDir})
                      </button>
                      <button type="button" className="mpick__chip" aria-pressed={engine.account?.location === "cyno"} onClick={() => void chooseAccount({ location: "cyno" })} disabled={busy !== null} data-testid="oneshot-location-cyno">
                        A do Cyno (pasta isolada)
                      </button>
                    </div>
                    <p className="oneshot__hint" data-testid="oneshot-location-line">
                      {engine.account?.location === "personal" ? `O programa lê o que você já ligou em ${setup.personalDir}.` : `O programa lê a pasta isolada do Cyno (${setup.cynoDir}); você liga as contas nela pelo terminal.`}
                    </p>

                    <p className="oneshot__label">O que o programa tem ligado</p>
                    {engine.program ? (
                      <div data-testid="oneshot-providers" data-ok={String(engine.program.ok)}>
                        {engine.program.ok ? (
                          engine.program.providers.length > 0 ? (
                            <ul className="oneshot__providers">
                              {engine.program.providers.map((provider) => (
                                <li key={provider.provider} data-testid={`oneshot-provider-${provider.provider}`}>
                                  <strong>{provider.provider}</strong> · {PROGRAM_PROVIDER_KIND_LABELS[provider.kind]}
                                  {provider.profiles ? ` · ${provider.profiles} ${provider.profiles === 1 ? "perfil" : "perfis"}` : ""}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="oneshot__detail">Nenhum provedor ligado nesta pasta.</p>
                          )
                        ) : (
                          <p className="oneshot__paid" role="status">
                            Não consegui ler o estado do programa: {engine.program.error}
                          </p>
                        )}
                        {engine.program.defaultModel && (
                          <p className="oneshot__detail">
                            Modelo padrão do programa: <code>{engine.program.defaultModel}</code>
                          </p>
                        )}
                        {engine.program.missing && engine.program.missing.length > 0 && <p className="oneshot__detail">Usado pelo programa, mas sem conta ligada: {engine.program.missing.join(", ")}.</p>}
                        <details className="settings__more">
                          <summary>Como isso é lido</summary>
                          <p>
                            Lido pelo comando de estado do próprio programa (<code>{engine.program.command}</code>), só o nome, o tipo e a contagem: nenhum segredo é lido nem mostrado.
                            {engine.program.verified ? "" : " Formato lido do código-fonte, não verificado com o programa de verdade."}
                          </p>
                        </details>
                      </div>
                    ) : (
                      <p className="oneshot__detail">Ainda não li o estado do programa.</p>
                    )}
                    <div className="engine-card__actions">
                      <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => void detectProgram()} disabled={busy !== null} aria-busy={busy === "detect"} data-testid="oneshot-detect">
                        {busy === "detect" ? "Lendo…" : engine.program ? "Ler de novo" : "Ler o que está ligado"}
                      </button>
                    </div>

                    <p className="oneshot__label">Para ligar ou trocar contas, rode no seu terminal</p>
                    <ul className="oneshot__commands" data-testid="oneshot-commands">
                      {setup.commands.map((command) => (
                        <li key={command}>
                          <pre className="oneshot__code">{command}</pre>
                          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => void navigator.clipboard?.writeText(command)} data-testid="oneshot-command-copy">
                            Copiar
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="oneshot__hint">O Cyno não roda esses comandos nem lê os segredos do programa.</p>
                    <details className="oneshot__more">
                      <summary>O que o Cyno escreve nesta forma</summary>
                      <ul data-testid="oneshot-writes">
                        {setup.writes.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
              </div>
            )}

            {step.id === "model" && stepOpen("model") && (
              <div className="oneshot__body">
                <label className="oneshot__label" htmlFor={`or-model-${engine.id}`}>
                  Modelo padrão
                </label>
                <AccountModelPicker
                  engine={engine.id as OneShotEngineId}
                  account={engine.account}
                  version={`${engine.account?.mode}-${engine.account?.location}`}
                  testId="oneshot-model"
                  inputId={`or-model-${engine.id}`}
                  value={chosen}
                  unlisted={engine.choices?.unlisted}
                  onChoose={(id) => void chooseModel(id)}
                  onClear={() => void chooseModel(null)}
                  now={now}
                  disabled={busy !== null}
                />
                {chosen && (
                  <p className="oneshot__detail" data-testid="oneshot-model-price">
                    {programMode ? "O custo depende do provedor do modelo e aparece em Gastos quando o programa informa." : priceLine(engine.modelPrice)}
                    {!programMode && engine.choices?.unlisted ? ` · ${UNLISTED_HINT}` : ""}
                  </p>
                )}
                {paid && (
                  <p className="oneshot__paid" role="status" data-testid="oneshot-paid-warning">
                    {paid}
                  </p>
                )}
                {programMode ? (
                  <p className="oneshot__hint">Sem escolha, vale o padrão do programa{engine.program?.defaultModel ? ` (${engine.program.defaultModel})` : ""}. Use o formato provedor/modelo.</p>
                ) : (
                  <p className="oneshot__hint">{FREE_LIMIT_NOTE}</p>
                )}
                {isOpenClaw && (
                  <div className="oneshot__form">
                    <label className="oneshot__label" htmlFor="or-effort">
                      Esforço de raciocínio
                    </label>
                    <select id="or-effort" className="ui-input" value={engine.choices?.effort ?? ""} onChange={(event) => void chooseEffort((event.currentTarget.value || null) as (typeof AGENT_EFFORTS)[number] | null)} disabled={busy !== null} data-testid="oneshot-effort">
                      <option value="">Padrão do programa</option>
                      {AGENT_EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>
                          {EFFORT_LABELS[effort]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {step.id === "verify" && (
              <div className="oneshot__body">
                {stateOf("install") === "done" || verify ? (
                  <button type="button" className={`ui-button ui-button--small ${current?.id === "verify" ? "ui-button--primary" : "ui-button--secondary"}`} onClick={() => void verifyNow(false)} disabled={busy !== null} aria-busy={busy === "verify"} data-testid="oneshot-verify">
                    {busy === "verify" ? "Verificando…" : verify ? "Verificar de novo" : "Verificar"}
                  </button>
                ) : (
                  <p className="oneshot__hint">Instale o programa primeiro.</p>
                )}
                {verify && (
                  <div className="oneshot__verify" data-testid="oneshot-verify-result" data-ok={verify.ok}>
                    <p className="oneshot__label" data-testid="oneshot-verify-headline">
                      {verifyHeadline(verify, now)}
                    </p>
                    {(() => {
                      const groups = verifyGroups(verify.checks);
                      const item = (check: (typeof verify.checks)[number]) => (
                        <li key={check.id} className={`oneshot__check oneshot__check--${check.ok === true ? "ok" : check.ok === false ? "bad" : "skip"}`} data-testid={`oneshot-check-${check.id}`} data-ok={String(check.ok)}>
                          <span className="oneshot__check-line">
                            <span className="oneshot__check-glyph" aria-hidden="true">
                              {checkGlyph(check)}
                            </span>
                            <span>
                              {check.label}
                              {check.detail && <span className="oneshot__hint"> — {check.detail}</span>}
                            </span>
                          </span>
                          {check.ok !== true && check.fix && <span className="oneshot__fix">O que fazer: {check.fix}</span>}
                        </li>
                      );
                      return (
                        <>
                          {(groups.failed.length > 0 || groups.skipped.length > 0) && <ul className="oneshot__checks oneshot__checks--attention">{[...groups.failed, ...groups.skipped].map(item)}</ul>}
                          {groups.passed.length > 0 && (
                            <details className="oneshot__more oneshot__passed" open={groups.failed.length === 0 && groups.skipped.length === 0} data-testid="oneshot-passed">
                              <summary>{groups.passed.length === 1 ? "1 conferência passou" : `${groups.passed.length} conferências passaram`}</summary>
                              <ul className="oneshot__checks">{groups.passed.map(item)}</ul>
                            </details>
                          )}
                        </>
                      );
                    })()}
                    {verify.pendingTurn && (
                      <div className="oneshot__confirm" data-testid="oneshot-turn-confirm">
                        <p>{verify.pendingTurn.notice}</p>
                        <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => void verifyNow(true)} disabled={busy !== null} aria-busy={busy === "turn"} data-testid="oneshot-turn-run">
                          {busy === "turn" ? "Rodando o turno…" : "Confirmar e rodar o turno de teste"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            </div>
          </li>
          );
        })}
      </ol>
      {engine.gateways && (
        <div className="oneshot__gateways" data-testid="oneshot-gateways">
          <label className="oneshot__label" htmlFor={`gateways-${engine.id}`}>
            Agentes ao mesmo tempo
          </label>
          <select id={`gateways-${engine.id}`} className="ui-input" value={engine.gateways.max} disabled={busy !== null} onChange={(event) => void chooseGateways(Number(event.currentTarget.value))} data-testid="oneshot-gateways-max">
            {[...new Set([1, 2, 3, 4, 6, 8, engine.gateways.max])].sort((a, b) => a - b).map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
          <p className="oneshot__hint" data-testid="oneshot-gateways-line">
            Cada agente em turno usa um gateway do Hermes (~270 MB). Os que passam do teto esperam na fila.
            {` Agora: ${engine.gateways.inUse} em uso${engine.gateways.waiting > 0 ? `, ${engine.gateways.waiting} esperando vaga` : ""}.`}
          </p>
        </div>
      )}
      {spent && (
        <p className="oneshot__detail" data-testid="oneshot-spent">
          {spent}
        </p>
      )}
      <ErrorText testId="oneshot-error">{error}</ErrorText>
      {engine.unverified && engine.unverified.length > 0 && (
        <details className="oneshot__unverified" data-testid="oneshot-unverified">
          <summary>O que foi provado e o que não foi provado com o programa de verdade</summary>
          <ul>
            {engine.unverified.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
