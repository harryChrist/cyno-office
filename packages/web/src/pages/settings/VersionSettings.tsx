import { useEffect, useState } from "react";
import { useVersionStore, watchVersion } from "../../store/versionStore";
import { copyText } from "../../ui/clipboard";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";
import {
  checkStatusView,
  commitLine,
  commitRows,
  DIRTY_NOTE,
  downloadConfirmText,
  hiddenCommits,
  howtoView,
  INSTALL_GUIDES,
  jobFailureText,
  lastCheckedText,
  restartNoticeView,
  sourceNote,
  updateActionView,
  type CheckTone,
  type RestartGuide,
  type RestartNoticeView,
} from "../../version/versionView";
import "../../version/version.css";

const TONE_TO_BADGE: Record<CheckTone, "on" | "off" | "value" | "warn"> = {
  ok: "on",
  warn: "warn",
  off: "off",
  idle: "value",
};

/** Um comando com o botão de copiar ao lado. */
function CommandLine({ command, note, testId }: { command: string; note: string; testId: string }) {
  return (
    <li className="version__step">
      <span className="version__step-note">{note}</span>
      <CommandBox command={command} testId={testId} />
    </li>
  );
}

/** O comando em caixa de código e o botão Copiar. */
function CommandBox({ command, testId }: { command: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="version__cmd">
      <code className="version__code" data-testid={testId}>
        {command}
      </code>
      <button
        type="button"
        className="ui-button ui-button--ghost ui-button--small"
        aria-label={`Copiar o comando ${command}`}
        onClick={() => {
          void copyText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </span>
  );
}

/** O log curto do download, recolhido. */
function JobDetails({ log }: { log: string[] }) {
  if (log.length === 0) return null;
  return (
    <details className="version__details" data-testid="settings-version-job-details">
      <summary>Ver detalhes</summary>
      <pre className="version__log" tabIndex={0} aria-label="Registro do download">
        {log.join("\n")}
      </pre>
    </details>
  );
}

function OtherWays({ guides }: { guides: RestartGuide[] }) {
  return (
    <details className="version__details" data-testid="settings-version-other-ways">
      <summary>Outros jeitos de rodar</summary>
      <div className="version__ways">
        {guides.map((guide) => (
          <div key={guide.id} className="version__way" data-testid={`settings-version-way-${guide.id}`}>
            <h5 className="version__guide-title">{guide.title}</h5>
            <p className="settings__card-hint">{guide.lead}</p>
            <CommandBox command={guide.command} testId={`settings-version-way-cmd-${guide.id}`} />
          </div>
        ))}
      </div>
    </details>
  );
}

/** O aviso em destaque: falta reiniciar (baixado pelo botão ou à mão), com o comando do jeito de rodar em primeiro lugar. */
function RestartNotice({ view, log }: { view: RestartNoticeView; log: string[] }) {
  return (
    <section className={`settings__card version__restart version__restart--${view.tone}`} role="status" aria-labelledby="version-restart-title" data-testid="settings-version-restart">
      <h4 className="version__restart-title" id="version-restart-title">
        {view.title}
      </h4>
      <p className="settings__card-hint">{view.detail}</p>
      {view.beforeCommand && (
        <ol className="version__steps">
          <CommandLine note={view.beforeCommand.note} command={view.beforeCommand.command} testId="settings-version-restart-before" />
        </ol>
      )}
      <div className="version__restart-main">
        <span className="version__step-note">
          <strong>{view.primary.title}.</strong> {view.primary.lead}
        </span>
        <CommandBox command={view.primary.command} testId="settings-version-restart-cmd" />
      </div>
      <p className="version__warning" data-testid="settings-version-restart-warning">
        {view.warning}
      </p>
      <OtherWays guides={view.others} />
      <JobDetails log={log} />
    </section>
  );
}

/** O botão "Baixar atualização" e o que vem com ele: confirmação, motivo do bloqueio, andamento e falha. */
function UpdateAction({ branch }: { branch: string }) {
  const data = useVersionStore((state) => state.data);
  const update = useVersionStore((state) => state.update);
  const [confirming, setConfirming] = useState(false);
  const view = updateActionView(data);
  const job = data?.update.job ?? null;
  const failure = jobFailureText(job);
  const confirm = downloadConfirmText(branch);
  return (
    <div className="version__action" data-testid="settings-version-action">
      {view.kind === "download" && (
        <button type="button" className="ui-button" onClick={() => setConfirming(true)} data-testid="settings-version-download">
          {view.label}
        </button>
      )}
      {view.kind === "blocked" && (
        <div className="version__blocked">
          <button type="button" className="ui-button" disabled aria-describedby="version-blocked-reason" data-testid="settings-version-download">
            {view.label}
          </button>
          <p className="version__reason" id="version-blocked-reason" data-testid="settings-version-blocked-reason">
            {view.reason}
          </p>
        </div>
      )}
      {view.kind === "running" && (
        <div className="version__blocked">
          <button type="button" className="ui-button" disabled aria-busy="true" data-testid="settings-version-download">
            {view.label}
          </button>
          <p className="version__reason" role="status" data-testid="settings-version-progress">
            {view.progress}
          </p>
        </div>
      )}
      {view.kind === "docker" && (
        <p className="settings__notice" data-testid="settings-version-docker-note">
          Nesta instalação a atualização é feita no computador hospedeiro. Os comandos estão em Como atualizar, logo abaixo.
        </p>
      )}
      {failure && view.kind !== "running" && (
        <div className="version__failure" role="alert" data-testid="settings-version-job-failure">
          <p className="ui-error">{failure}</p>
          <JobDetails log={job?.log ?? []} />
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          confirmLabel="Baixar"
          pendingLabel="Baixando…"
          tone="success"
          testId="settings-version-download-confirm"
          onConfirm={update}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/**
 * Seção "Versão e atualizações": a versão instalada (do package.json e dos commits), se o ramo estável do GitHub tem
 * commits novos, o botão que baixa a atualização e o aviso de reinício. O app baixa só com um clique e nunca reinicia sozinho.
 */
export function VersionSettings() {
  const data = useVersionStore((state) => state.data);
  const error = useVersionStore((state) => state.error);
  const checking = useVersionStore((state) => state.checking);
  const check = useVersionStore((state) => state.check);
  useEffect(() => watchVersion(), []);

  if (!data) {
    return (
      <div className="settings__groups">
        <ErrorText testId="settings-version-error">{error}</ErrorText>
        {!error && (
          <p className="settings__card-hint" role="status">
            Lendo a versão…
          </p>
        )}
      </div>
    );
  }

  const { version, check: state } = data;
  const status = checkStatusView(state);
  const note = sourceNote(version);
  const hidden = hiddenCommits(state);
  const busy = checking || state.checking;
  const restart = restartNoticeView(data.update);
  const howto = howtoView(data);
  const guides = [...INSTALL_GUIDES].sort((a, b) => howto.order.indexOf(a.id) - howto.order.indexOf(b.id));
  return (
    <div className="settings__groups version" data-testid="settings-version">
      {restart && <RestartNotice view={restart} log={data.update.job?.log ?? []} />}
      <section className="settings__card" data-testid="settings-version-installed">
        <OptionHead
          title="Versão instalada"
          line="O que roda neste servidor agora."
          seal="plataforma"
          state={<StateBadge tone="value">{version.label.split(" · ").slice(0, 2).join(" · ")}</StateBadge>}
        />
        <dl className="version__rows">
          {commitRows(version).map((row) => (
            <div key={row.id} className="version__row" data-testid={`settings-version-${row.id}`}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {version.dirty && (
          <p className="settings__notice" role="note" data-testid="settings-version-dirty">
            {DIRTY_NOTE}
          </p>
        )}
        {note && <p className="settings__card-hint">{note}</p>}
      </section>

      <section className="settings__card" data-testid="settings-version-check">
        <OptionHead
          title="Atualizações no GitHub"
          line={`Compara esta instalação com o ramo ${state.branch} do repositório de origem. Verificar não baixa nada.`}
          seal="plataforma"
          state={
            <StateBadge tone={TONE_TO_BADGE[status.tone]} testId="settings-version-state">
              {status.title}
            </StateBadge>
          }
        />
        {status.detail && (
          <p className="settings__card-hint" data-testid="settings-version-detail">
            {status.detail}
          </p>
        )}
        <div className="version__toolbar">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} aria-busy={busy} onClick={() => void check()} data-testid="settings-version-check-now">
            {busy ? "Verificando…" : "Verificar agora"}
          </button>
          <span className="version__when" role="status" data-testid="settings-version-when">
            {lastCheckedText(state)}
            {!state.auto ? " · verificação automática desligada" : ""}
          </span>
        </div>
        <ErrorText testId="settings-version-error">{error}</ErrorText>
        <UpdateAction branch={state.branch} />

        {state.status === "update-available" && (
          <div className="version__news" data-testid="settings-version-news">
            <h5 className="version__news-title">O que mudou</h5>
            {state.commits && state.commits.length > 0 ? (
              <ul className="version__commits">
                {state.commits.map((commit) => {
                  const line = commitLine(commit);
                  return (
                    <li key={commit.hash} className="version__commit" data-testid="settings-version-commit">
                      <span className="version__commit-subject">{line.subject}</span>
                      <span className="version__commit-meta">{line.meta}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="settings__card-hint" data-testid="settings-version-no-list">
                A lista de novidades não está disponível (ela só aparece com repositório público ou quando os commits já estão nesta máquina).
              </p>
            )}
            {hidden > 0 && (
              <p className="settings__card-hint">
                E mais {hidden} {hidden === 1 ? "commit mais antigo" : "commits mais antigos"}.
              </p>
            )}
            {state.commitsUrl && (
              <a className="ui-link" href={state.commitsUrl} target="_blank" rel="noreferrer noopener" data-testid="settings-version-link">
                Ver os commits no GitHub
              </a>
            )}
          </div>
        )}
      </section>

      <section className="settings__card" data-testid="settings-version-howto">
        <OptionHead title="Como atualizar" line={howto.intro} seal="plataforma" />
        <details className="version__details version__details--manual" open={howto.open} data-testid="settings-version-manual">
          <summary>Atualizar à mão</summary>
          <div className="version__guides">
            {guides.map((guide) => (
              <div key={guide.id} className="version__guide" data-testid={`settings-version-guide-${guide.id}`}>
                <h5 className="version__guide-title">{guide.title}</h5>
                <p className="settings__card-hint">{guide.hint}</p>
                <ol className="version__steps">
                  {guide.steps.map((step, index) => (
                    <CommandLine key={step.command} note={step.note} command={step.command} testId={`settings-version-cmd-${guide.id}-${index}`} />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
