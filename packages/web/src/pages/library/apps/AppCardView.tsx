import type { AppCard, AppRun, InstallJob, LibraryConnector, LibrarySkillView } from "@cyno/shared";
import { useEffect, useRef, useState } from "react";
import { appsApi } from "../../../api/libraryApps";
import { useLibraryAppsStore } from "../../../store/libraryAppsStore";
import { useLibraryStore } from "../../../store/libraryStore";
import { useAsyncAction } from "../../../ui/useAsyncAction";
import { ConfirmDialog, ErrorText } from "../../../ui/widgets";
import { copyText } from "../../../ui/clipboard";
import { WhoUses } from "../LibraryConnectorsTab";
import { appView, formatBytes, formatDuration, formatMB, isBusy, jobProgress, PHASE_LABEL, REQUIREMENT_MARK, repoLabel, runsOfApp, VIEW_BADGE } from "./appsView";

/** O log do job: recolhível, ao vivo (linhas do socket), rolando até o fim. */
function JobLog({ jobId, live }: { jobId: string; live: boolean }) {
  const lines = useLibraryAppsStore((state) => state.logs[jobId]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    void useLibraryAppsStore.getState().loadLog(jobId);
  }, [jobId]);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines?.length]);
  return (
    <details className="app-log" data-testid={`app-log-${jobId}`}>
      <summary>
        Ver o log{live ? " ao vivo" : ""}
        {lines && <span className="ui-muted"> · {lines.length} linhas</span>}
      </summary>
      <pre ref={ref} className="app-log__text" tabIndex={0}>
        {(lines ?? []).join("\n") || "(sem linhas ainda)"}
      </pre>
    </details>
  );
}

function Steps({ job }: { job: InstallJob }) {
  return (
    <ol className="app-steps" data-testid="app-steps">
      {job.steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`app-step app-step--${step.status}`} data-status={step.status}>
          <span className="app-step__mark" aria-hidden="true">
            {step.status === "feito" ? "✓" : step.status === "andando" ? "…" : step.status === "falhou" ? "✗" : step.status === "precisa" ? "!" : "·"}
          </span>
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Progress({ job, onCancel }: { job: InstallJob; onCancel: () => void }) {
  const progress = jobProgress(job);
  return (
    <section className="app-progress" aria-label="Progresso" data-testid="app-progress">
      <div className="app-progress__head">
        <strong>{PHASE_LABEL[job.phase]}</strong>
        <span className="ui-muted">
          passo {Math.min(progress.done + 1, progress.total)} de {progress.total}
        </span>
      </div>
      <div className="app-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.ratio * 100)} aria-label="Andamento da instalação">
        <div className="app-bar__fill" style={{ width: `${Math.max(4, Math.round(progress.ratio * 100))}%` }} />
      </div>
      <Steps job={job} />
      <JobLog jobId={job.id} live />
      {job.kind !== "uninstall" && (
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onCancel} data-testid="app-cancel">
            Cancelar e limpar tudo
          </button>
        </div>
      )}
    </section>
  );
}

const RUN_STATE_LABEL: Record<AppRun["state"], string> = { "na-fila": "Na fila", rodando: "Rodando", concluida: "Concluída", falhou: "Falhou", cancelada: "Cancelada" };

/** Quem pediu a execução ("Clara, em Principal"); o teste do instalador não tem agente. */
const runWho = (run: AppRun) => (run.agentName ? `${run.agentName}${run.workspaceName ? `, em ${run.workspaceName}` : ""}` : "teste do instalador");

/** A fila do app (uma execução por vez): a que está rodando, quem espera e a última que terminou. */
function RunsPanel({ appId, runs }: { appId: string; runs: readonly AppRun[] }) {
  const { running, queued, last } = runsOfApp(runs, appId);
  if (!running && queued.length === 0 && !last) return <p className="lib-card__none ui-muted" data-testid={`app-runs-empty-${appId}`}>Nenhuma execução ainda. Quando um agente chamar uma ferramenta, ela aparece aqui.</p>;
  const cancel = (run: AppRun) => void appsApi.cancelRun(run.id).catch(() => undefined);
  return (
    <div className="app-runs" data-testid={`app-runs-${appId}`}>
      {running && (
        <div className="app-run app-run--running" data-testid={`app-run-${running.id}`} data-state="rodando">
          <div className="app-run__head">
            <strong>{RUN_STATE_LABEL.rodando}: {running.tool}</strong>
            <span className="ui-muted">{runWho(running)}</span>
            <button type="button" className="app-link" onClick={() => cancel(running)} data-testid={`app-run-cancel-${running.id}`}>
              cancelar
            </button>
          </div>
          <div className="app-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={running.progress ?? 0} aria-label="Andamento da execução">
            <div className="app-bar__fill" style={{ width: `${Math.max(4, running.progress ?? 4)}%` }} />
          </div>
          {running.line && <p className="app-run__line ui-muted">{running.progress !== undefined ? `${running.progress}% · ` : ""}{running.line}</p>}
        </div>
      )}
      {queued.map((run) => (
        <div key={run.id} className="app-run app-run--queued" data-testid={`app-run-${run.id}`} data-state="na-fila">
          <div className="app-run__head">
            <strong>Na fila, posição {run.queuePosition ?? "?"}: {run.tool}</strong>
            <span className="ui-muted">{runWho(run)}</span>
            <button type="button" className="app-link" onClick={() => cancel(run)} data-testid={`app-run-cancel-${run.id}`}>
              cancelar
            </button>
          </div>
        </div>
      ))}
      {last && (
        <div className={`app-run app-run--${last.state === "concluida" ? "ok" : "bad"}`} data-testid={`app-run-last-${appId}`} data-state={last.state}>
          <strong>
            Última: {RUN_STATE_LABEL[last.state]} · {last.tool}
            {last.ms !== undefined ? ` · ${formatDuration(last.ms)}` : ""}
          </strong>
          <span className="ui-muted">{runWho(last)}</span>
          {last.summary && <p className="app-run__line">{last.summary}</p>}
        </div>
      )}
    </div>
  );
}

type Props = { card: AppCard; connector?: LibraryConnector; stdioAllowed: boolean; onInstall: () => void; onGrant: (connector: LibraryConnector) => void; onGrantSkill?: (skill: LibrarySkillView) => void };

/** Um app do catálogo: o que faz, repositório, requisitos nesta máquina e, conforme o estado, as ações. */
export function AppCardView({ card, connector, stdioAllowed, onInstall, onGrant, onGrantSkill }: Props) {
  const { entry, app, job } = card;
  const view = appView(card);
  const badge = VIEW_BADGE[view];
  const flash = useLibraryAppsStore((state) => state.flash[entry.id]);
  const action = useAsyncAction();
  const [confirm, setConfirm] = useState<"uninstall" | "cancel" | null>(null);
  const [copied, setCopied] = useState(false);
  const runs = useLibraryAppsStore((state) => state.listing?.runs);
  const allSkills = useLibraryStore((state) => state.skills);
  const appSkills = (allSkills ?? []).filter((skill) => skill.origin.kind === "app" && skill.origin.appId === entry.id);
  const installed = view === "instalado-testado" || view === "instalado-problema";
  const isAppConnector = entry.provides.connector?.kind === "app";
  const needs = app?.needs ?? job?.needs;

  return (
    <li className="lib-card app-card" data-testid={`app-card-${entry.id}`} data-view={view}>
      <header className="lib-card__head">
        <div className="lib-card__title">
          <h3 className="lib-card__name">{entry.name}</h3>
          <p className="lib-card__target">
            <span className="lib-chip">{entry.license.spdx}</span>
            {entry.license.level !== "livre" && <span className="lib-chip app-chip--warn">licença com aviso</span>}
            <a className="app-repo" href={entry.repo} target="_blank" rel="noreferrer noopener" data-testid={`app-repo-${entry.id}`}>
              {repoLabel(entry.repo)} ↗
            </a>
          </p>
        </div>
        {card.update && view === "instalado-testado" && <span className="ui-badge ui-badge--attention">Atualização disponível</span>}
        <span className={`ui-badge ui-badge--${badge.tone}`} data-testid={`app-status-${entry.id}`}>
          {badge.label}
        </span>
      </header>

      <p className="lib-card__desc">{entry.summary}</p>

      {flash && (
        <p className="lib-card__reason" role="status" data-testid={`app-flash-${entry.id}`}>
          {flash}{" "}
          <button type="button" className="app-link" onClick={() => useLibraryAppsStore.getState().dismissFlash(entry.id)}>
            ok
          </button>
        </p>
      )}

      {!installed && !isBusy(view) && view !== "precisa-do-dono" && view !== "falhou" && (
        <div className="app-facts">
          <section aria-label="Requisitos nesta máquina">
            <h4 className="lib-card__label">Requisitos nesta máquina</h4>
            <ul className="app-reqs app-reqs--compact" data-testid={`app-reqs-${entry.id}`}>
              {card.requirements.map((requirement) => {
                const mark = REQUIREMENT_MARK[requirement.status];
                return (
                  <li key={`${requirement.kind}-${requirement.spec}`} className={`app-req app-req--${mark.tone}`} data-status={requirement.status} title={requirement.found}>
                    <span className="app-req__mark" aria-label={mark.word}>
                      {mark.mark}
                    </span>
                    <span className="app-req__label">{requirement.label}</span>
                    {requirement.found && <span className="app-req__found">{requirement.found}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-label="Tamanho">
            <h4 className="lib-card__label">Tamanho</h4>
            <p className="app-facts__p">
              {formatMB(entry.resources.diskMB)} de disco · {formatMB(entry.resources.ramMB)} de RAM em uso
            </p>
            {entry.resources.note && <p className="ui-muted app-facts__note">{entry.resources.note}</p>}
            {entry.warnings[0] && <p className="app-facts__warn">{entry.warnings[0]}</p>}
          </section>
        </div>
      )}

      {(view === "em-breve" || view === "em-avaliacao") && entry.pending && (
        <p className="lib-card__reason" data-testid={`app-pending-${entry.id}`}>
          {entry.pending}
        </p>
      )}

      {job && isBusy(view) && <Progress job={job} onCancel={() => setConfirm("cancel")} />}
      {view === "desinstalando" && !job && <p className="ui-muted">Removendo…</p>}

      {view === "precisa-do-dono" && needs && (
        <section className="app-needs" role="alert" data-testid="app-needs">
          <h4 className="app-needs__title">Precisa de você</h4>
          <p>{needs.reason} O Cyno nunca roda comandos com sudo sozinho: rode este no terminal do servidor e depois continue.</p>
          <div className="app-needs__cmd">
            <code data-testid="app-needs-command">{needs.command}</code>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              onClick={async () => {
                setCopied(await copyText(needs.command));
                setTimeout(() => setCopied(false), 2000);
              }}
              data-testid="app-needs-copy"
            >
              {copied ? "Copiado" : "Copiar comando"}
            </button>
          </div>
          <div className="ui-actions">
            <button type="button" className="ui-button" disabled={action.pending} onClick={() => void action.run(() => appsApi.resume(entry.id))} data-testid="app-resume">
              Já rodei, continuar
            </button>
            <button type="button" className="ui-button ui-button--secondary" onClick={() => setConfirm("uninstall")}>
              Desistir e limpar
            </button>
          </div>
          {job && (
            <>
              <Steps job={job} />
              <JobLog jobId={job.id} live={false} />
            </>
          )}
        </section>
      )}

      {view === "falhou" && (
        <section className="app-failed" role="alert" data-testid="app-failed">
          <h4 className="app-failed__title">{job?.kind === "uninstall" ? "A desinstalação não terminou" : "A instalação não terminou"}</h4>
          <p>{app?.error ?? job?.error}</p>
          <p className="ui-muted">Os passos que já deram certo não são refeitos: “Tentar de novo” continua de onde parou.</p>
          {job && (
            <>
              <Steps job={job} />
              <JobLog jobId={job.id} live={false} />
            </>
          )}
          <div className="ui-actions">
            {job?.kind !== "uninstall" && (
              <button type="button" className="ui-button" disabled={action.pending} onClick={() => void action.run(() => appsApi.resume(entry.id))} data-testid="app-retry">
                Tentar de novo
              </button>
            )}
            <button type="button" className="ui-button ui-button--danger" onClick={() => setConfirm("uninstall")} data-testid="app-uninstall">
              Desinstalar
            </button>
          </div>
        </section>
      )}

      {installed && app && (
        <>
          <section className={`app-result ${view === "instalado-testado" ? "app-result--ok" : "app-result--bad"}`} data-testid={`app-result-${entry.id}`}>
            <h4 className="app-result__title">{view === "instalado-testado" ? "Instalado e testado ✓" : "Instalado, mas o mini teste falhou"}</h4>
            {app.lastTest && (
              <p className="app-result__detail" data-testid={`app-test-detail-${entry.id}`}>
                {app.lastTest.detail}
              </p>
            )}
            <p className="ui-muted app-result__meta">
              {app.version}
              {app.lastTest && ` · teste em ${formatDuration(app.lastTest.ms)}`}
              {app.sizeBytes ? ` · ${formatBytes(app.sizeBytes)} em disco` : ""}
              {card.update && ` · atualização para ${card.update.to}`}
            </p>
            {view === "instalado-problema" && <p className="lib-card__reason lib-card__reason--attention">O conector foi desligado até o teste passar. Tente de novo; se continuar, desinstale e instale outra vez.</p>}
          </section>

          {connector && (
            <div className="app-connector">
              <section aria-label="Ferramentas">
                <h4 className="lib-card__label">Ferramentas</h4>
                <details className="lib-tools" data-testid={`app-tools-${entry.id}`}>
                  <summary>
                    {connector.status.tools.length} {connector.status.tools.length === 1 ? "ferramenta" : "ferramentas"}
                    {connector.weightTokens > 0 && <span className="ui-muted"> · ~{connector.weightTokens} tokens por turno</span>}
                  </summary>
                  <ul className="lib-tools__list">
                    {connector.status.tools.map((tool) => (
                      <li key={tool.name}>
                        <code>
                          {connector.toolPrefix}__{tool.name}
                        </code>
                        {tool.description && <span className="lib-tools__desc app-tool-desc">{tool.description}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
              <section aria-label="Quem usa">
                <h4 className="lib-card__label">Quem usa</h4>
                <WhoUses connector={connector} />
              </section>
            </div>
          )}
          {isAppConnector && (
            <section aria-label="Execuções" className="app-runs-section">
              <h4 className="lib-card__label">Execuções (uma por vez; as outras esperam na fila)</h4>
              <RunsPanel appId={entry.id} runs={runs ?? []} />
            </section>
          )}
          {appSkills.length > 0 && (
            <section aria-label="Skills do app" className="app-skills" data-testid={`app-skills-${entry.id}`}>
              <h4 className="lib-card__label">Skills do app · {appSkills.length} (só leitura; ninguém recebe sem você liberar)</h4>
              <ul className="app-skills__list">
                {appSkills.map((skill) => (
                  <li key={skill.id} className="app-skill" data-testid={`app-skill-${skill.id}`}>
                    <div className="app-skill__head">
                      <code>{skill.name}</code>
                      <span className="ui-muted app-skill__meta">{skill.files} {skill.files === 1 ? "arquivo" : "arquivos"} · ~{skill.indexTokens} tokens no índice</span>
                      {onGrantSkill && (
                        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => onGrantSkill(skill)} data-testid={`app-skill-grant-${skill.id}`}>
                          Liberar…
                        </button>
                      )}
                    </div>
                    <WhoUses connector={skill} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {entry.warnings.length > 0 && (
            <p className="app-facts__warn" data-testid={`app-warning-${entry.id}`}>
              {entry.warnings[0]}
            </p>
          )}
        </>
      )}

      {view === "disponivel" && (
        <footer className="lib-card__actions">
          <span className="ui-muted app-hint">{stdioAllowed ? "Nada é instalado até você clicar e confirmar o plano." : "Conectores locais desligados: veja o aviso no alto da página."}</span>
          <div className="ui-actions">
            <button type="button" className="ui-button ui-button--small" onClick={onInstall} data-testid={`app-install-${entry.id}`}>
              Instalar
            </button>
          </div>
        </footer>
      )}

      {installed && app && (
        <footer className="lib-card__actions">
          <span className="ui-muted app-hint">{connector ? "O conector já está na aba Conectores." : "O conector deste app sumiu: “Testar de novo” recria."}</span>
          <div className="ui-actions">
            {connector && (
              <button type="button" className="ui-button ui-button--small" onClick={() => onGrant(connector)} data-testid={`app-grant-${entry.id}`}>
                Liberar…
              </button>
            )}
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={action.pending} aria-busy={action.pending} onClick={() => void action.run(() => appsApi.test(entry.id))} data-testid={`app-retest-${entry.id}`}>
              {action.pending ? "Testando…" : "Testar de novo"}
            </button>
            {card.update && (
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={action.pending} onClick={() => void action.run(() => appsApi.update(entry.id))} data-testid={`app-update-${entry.id}`}>
                Atualizar
              </button>
            )}
            <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={() => setConfirm("uninstall")} data-testid={`app-uninstall-${entry.id}`}>
              Desinstalar
            </button>
          </div>
        </footer>
      )}
      <ErrorText>{action.error}</ErrorText>

      {confirm === "uninstall" && (
        <ConfirmDialog
          title={`Desinstalar ${entry.name}`}
          testId="confirm-uninstall-app"
          message={
            <p>
              Desinstalar <strong>{entry.name}</strong>? Os processos param, o conector e as liberações ({connector ? (connector.uses.length === 0 ? "ninguém usava" : `${connector.uses.length === 1 ? "1 workspace" : `${connector.uses.length} workspaces`}`) : "nenhuma"}) são removidos e a pasta do app é apagada
              {app?.sizeBytes ? ` (${formatBytes(app.sizeBytes)})` : ""}. Os runtimes compartilhados ficam se outro app usa.
            </p>
          }
          confirmLabel="Desinstalar"
          pendingLabel="Desinstalando…"
          onConfirm={() => appsApi.uninstall(entry.id)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "cancel" && (
        <ConfirmDialog
          title="Cancelar a instalação"
          testId="confirm-cancel-app"
          message={<p>Parar agora e apagar tudo o que esta instalação criou (a pasta do app, o conector e o que foi baixado só para ela)?</p>}
          confirmLabel="Cancelar e limpar"
          pendingLabel="Limpando…"
          onConfirm={() => appsApi.cancel(entry.id)}
          onClose={() => setConfirm(null)}
        />
      )}
    </li>
  );
}
