import type { InstallPlan } from "@cyno/shared";
import { useEffect, useState } from "react";
import { describeError } from "../../../api/client";
import { appsApi } from "../../../api/libraryApps";
import { useAsyncAction } from "../../../ui/useAsyncAction";
import { ErrorText, Modal } from "../../../ui/widgets";
import { formatMB, REQUIREMENT_MARK, repoLabel } from "./appsView";

/**
 * "Instalar X": o plano montado por código a partir da receita fixada e desta máquina. Instalar baixa e
 * roda código da internet, então o clique em "Instalar" depois de ver isto é o OK do dono. Nada é
 * liberado a ninguém; licença restrita exige marcar "Li o aviso".
 */
export function InstallDialog({ appId, onClose }: { appId: string; onClose: () => void }) {
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const install = useAsyncAction();

  useEffect(() => {
    let alive = true;
    appsApi.plan(appId).then(
      (value) => alive && setPlan(value),
      (error: unknown) => alive && setLoadError(describeError(error)),
    );
    return () => {
      alive = false;
    };
  }, [appId]);

  const mustAccept = plan?.license.mustAccept ?? false;
  const canClick = Boolean(plan?.canInstall) && (!mustAccept || read) && !install.pending;

  const submit = async () => {
    const started = await install.run(() => appsApi.install(appId, { acceptLicense: read }));
    if (started) onClose();
  };

  return (
    <Modal title={plan ? `Instalar ${plan.name}` : "Instalar"} onClose={onClose} wide testId="app-install-dialog">
      <div className="app-plan">
        <ErrorText>{loadError}</ErrorText>
        {!plan && !loadError && (
          <p className="ui-muted" role="status">
            Conferindo esta máquina…
          </p>
        )}
        {plan && (
          <>
            <p className="app-plan__lead">{plan.summary}</p>
            <dl className="app-plan__facts">
              <div>
                <dt>Repositório</dt>
                <dd>
                  <a href={plan.repo} target="_blank" rel="noreferrer noopener" data-testid="app-plan-repo">
                    {repoLabel(plan.repo)}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Versão fixada</dt>
                <dd>{plan.version}</dd>
              </div>
              <div>
                <dt>Licença</dt>
                <dd>
                  {plan.license.url ? (
                    <a href={plan.license.url} target="_blank" rel="noreferrer noopener">
                      {plan.license.spdx}
                    </a>
                  ) : (
                    plan.license.spdx
                  )}
                </dd>
              </div>
              <div>
                <dt>Ocupa / usa</dt>
                <dd>
                  cerca de {formatMB(plan.diskMB)} de disco e {formatMB(plan.ramMB)} de RAM em uso
                </dd>
              </div>
            </dl>

            {plan.blockers.length > 0 && (
              <div className="app-plan__blockers" role="alert" data-testid="app-plan-blockers">
                <strong>Não dá para instalar agora</strong>
                <ul>
                  {plan.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
                {!plan.stdioAllowed && (
                  <p>
                    Os apps rodam como conectores locais (um comando nesta máquina). Para ligar, reinicie o servidor com a variável <code>CONNECTORS_STDIO=1</code> (por exemplo <code>CONNECTORS_STDIO=1 npm start</code>) e abra esta janela de novo. Só faça isso numa rede em que você confia.
                  </p>
                )}
              </div>
            )}

            <section>
              <h3 className="app-plan__h">Requisitos nesta máquina</h3>
              <ul className="app-reqs" data-testid="app-plan-requirements">
                {plan.requirements.map((requirement) => {
                  const mark = REQUIREMENT_MARK[requirement.status];
                  return (
                    <li key={`${requirement.kind}-${requirement.spec}`} className={`app-req app-req--${mark.tone}`} data-status={requirement.status}>
                      <span className="app-req__mark" aria-label={mark.word}>
                        {mark.mark}
                      </span>
                      <span className="app-req__label">{requirement.label}</span>
                      {requirement.found && <span className="app-req__found">{requirement.found}</span>}
                      {requirement.status === "falta" && requirement.sudoHint && <code className="app-req__cmd">{requirement.sudoHint}</code>}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section>
              <h3 className="app-plan__h">O que será baixado, e de onde</h3>
              <ul className="app-plan__list" data-testid="app-plan-downloads">
                {plan.downloads.map((download) => (
                  <li key={download.what + download.from}>
                    {download.what}
                    <span className="app-plan__from"> · {download.from}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="app-plan__h">O que o Cyno vai fazer, na ordem</h3>
              <ol className="app-plan__list" data-testid="app-plan-steps">
                {plan.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p className="ui-muted app-plan__note">
                Tudo dentro de <code>data/platform/apps/{plan.appId}/</code> e <code>data/platform/runtimes/</code>, sem sudo e sem mexer no sistema. {plan.note}
              </p>
            </section>

            <section>
              <h3 className="app-plan__h">O que entrega</h3>
              <p className="app-plan__p">{plan.provides}</p>
            </section>

            {(plan.warnings.length > 0 || plan.license.notice) && (
              <section className="app-plan__warn" data-testid="app-plan-warnings">
                <h3 className="app-plan__h">Avisos</h3>
                <ul>
                  {plan.license.notice && <li>{plan.license.notice}</li>}
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}

            {mustAccept && (
              <label className="app-plan__accept">
                <input type="checkbox" checked={read} onChange={(event) => setRead(event.currentTarget.checked)} data-testid="app-plan-accept" />
                Li o aviso de licença acima
              </label>
            )}
          </>
        )}
        <ErrorText testId="app-plan-error">{install.error}</ErrorText>
        <div className="ui-actions app-plan__actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="ui-button" disabled={!canClick} aria-busy={install.pending} onClick={() => void submit()} data-testid="app-plan-install">
            {install.pending ? "Iniciando…" : "Instalar"}
          </button>
        </div>
        {plan?.canInstall && <p className="ui-muted app-plan__ok">Clicar em Instalar é o seu OK: o Cyno baixa e roda código da internet, como descrito acima.</p>}
      </div>
    </Modal>
  );
}
