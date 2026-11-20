import { isScriptRunning, SCRIPT_LIMITS, type ScriptRun } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { useScriptsStore } from "../../store/scriptsStore";
import { copyText } from "../../ui/clipboard";
import { ConfirmDialog } from "../../ui/widgets";
import { ScriptTerminal } from "./ScriptTerminal";
import { durationText, groupRuns, parseScriptSub, runNotices, runningCount, sizeLabel, statusText, statusTone, type StatusTone } from "./scriptsView";
import "./scripts.css";

const BADGE_TONES: Record<StatusTone, string> = { live: "busy", ok: "success", danger: "danger", warn: "attention", muted: "neutral" };

/** Relógio de 1 s, só enquanto há script rodando (a duração dele anda). */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function StatusBadge({ run }: { run: ScriptRun }) {
  return (
    <span className={`ui-badge ui-badge--${BADGE_TONES[statusTone(run.status)]}`} data-testid="scripts-status">
      {statusText(run)}
    </span>
  );
}

function ScriptRow({ run, selected, now, onOpen }: { run: ScriptRun; selected: boolean; now: number; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`scripts-row${selected ? " scripts-row--selected" : ""}`}
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        data-testid="scripts-row"
        data-script-id={run.id}
        data-status={run.status}
      >
        <span className="scripts-row__top">
          <span className={`scripts-dot scripts-dot--${statusTone(run.status)}`} aria-hidden="true" />
          <span className="scripts-row__title">{run.title}</span>
          <span className="scripts-row__time">{durationText(run, now)}</span>
        </span>
        <span className="scripts-row__meta">
          {run.agentName} · {statusText(run)}
        </span>
        <span className="scripts-row__last">{run.lastLine || (isScriptRunning(run) ? "Sem saída ainda" : "Sem saída")}</span>
      </button>
    </li>
  );
}

function ScriptList({ runs, selectedId, now, onOpen }: { runs: ScriptRun[]; selectedId: string | null; now: number; onOpen: (id: string) => void }) {
  const { running, finished } = useMemo(() => groupRuns(runs), [runs]);
  const section = (title: string, items: ScriptRun[], testId: string, hint?: string) =>
    items.length > 0 && (
      <section className="scripts-list__group" aria-label={title} data-testid={testId}>
        <h3 className="scripts-list__title">
          {title} <span className="scripts-list__count">{items.length}</span>
        </h3>
        {hint && <p className="scripts-list__hint">{hint}</p>}
        <ul className="scripts-list__rows">
          {items.map((run) => (
            <ScriptRow key={run.id} run={run} selected={run.id === selectedId} now={now} onOpen={() => onOpen(run.id)} />
          ))}
        </ul>
      </section>
    );
  return (
    <div className="scripts-list" data-testid="scripts-list">
      {section("Rodando agora", running, "scripts-running")}
      {section("Terminados", finished, "scripts-finished", `Somem cerca de ${SCRIPT_LIMITS.finishedTtlMinutes} minutos depois de terminar.`)}
    </div>
  );
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="scripts-command" data-testid="scripts-command">
      <summary>Comando</summary>
      <div className="scripts-command__body">
        <pre className="scripts-command__code">{command}</pre>
        <button
          type="button"
          className="ui-button ui-button--secondary ui-button--small"
          onClick={() => {
            void copyText(command).then((ok) => {
              setCopied(ok);
              window.setTimeout(() => setCopied(false), 1800);
            });
          }}
          data-testid="scripts-copy"
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
    </details>
  );
}

function ScriptViewer({ run, workspaceId, now, onBack }: { run: ScriptRun; workspaceId: string; now: number; onBack: () => void }) {
  const [follow, setFollow] = useState(true);
  const [asking, setAsking] = useState(false);
  const notices = runNotices(run);
  const stop = useCallback(async () => {
    const updated = await api.stopScript(run.id);
    useScriptsStore.getState().apply({ type: "script:updated", run: updated });
  }, [run.id]);

  return (
    <section className="scripts-viewer" aria-label={`Script ${run.title}`} data-testid="scripts-viewer" data-script-id={run.id}>
      <header className="scripts-viewer__head">
        <button type="button" className="ui-button ui-button--secondary ui-button--small scripts-back" onClick={onBack} data-testid="scripts-back">
          Voltar
        </button>
        <div className="scripts-viewer__heading">
          <h3 className="scripts-viewer__title">{run.title}</h3>
          <p className="scripts-viewer__meta">
            <span>{run.agentName}</span>
            <StatusBadge run={run} />
            <span>{durationText(run, now)}</span>
            <span>{sizeLabel(run.bytes)} de saída</span>
          </p>
          <p className="scripts-viewer__cwd" title={run.cwd}>
            Pasta: <code>{run.cwd}</code>
          </p>
        </div>
        <div className="scripts-viewer__actions">
          {isScriptRunning(run) && (
            <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={() => setAsking(true)} data-testid="scripts-stop">
              Parar
            </button>
          )}
          <a className="ui-button ui-button--secondary ui-button--small" href={api.scriptDownloadUrl(run.id)} download data-testid="scripts-download">
            Baixar saída
          </a>
          <button type="button" className={`ui-button ui-button--small ${follow ? "ui-button--primary" : "ui-button--secondary"}`} aria-pressed={follow} onClick={() => setFollow((value) => !value)} data-testid="scripts-follow">
            Seguir o fim
          </button>
        </div>
      </header>
      {notices.map((text) => (
        <p key={text} className="scripts-notice" role="status" data-testid="scripts-notice">
          {text}
        </p>
      ))}
      <CommandBlock command={run.command} />
      <ScriptTerminal workspaceId={workspaceId} scriptId={run.id} follow={follow} onFollowChange={setFollow} />
      {asking && (
        <ConfirmDialog
          title={`Parar "${run.title}"?`}
          message={
            <>
              <p>O comando é interrompido agora. O que já foi escrito na saída continua guardado.</p>
              <p>Feito isso, não dá para retomar de onde parou.</p>
            </>
          }
          confirmLabel="Parar o script"
          pendingLabel="Parando…"
          testId="scripts-stop-dialog"
          confirmTestId="scripts-stop-confirm"
          onConfirm={stop}
          onClose={() => setAsking(false)}
        />
      )}
    </section>
  );
}

/**
 * Página "Scripts dos agentes": os comandos demorados que os agentes pedem ao servidor (download, crawler, build).
 * Lista à esquerda (rodando agora, depois terminados) e a saída ao vivo à direita, num terminal só de leitura. O
 * script aberto vai no endereço (`#/<ws>/scripts/<id>`). No celular, a lista ocupa a tela e o toque abre o script.
 */
export function ScriptsPage() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const sub = useNavStore((state) => state.sub);
  const go = useNavStore((state) => state.go);
  const runs = useScriptsStore((state) => state.runs);
  const error = useScriptsStore((state) => state.error);
  const selectedId = parseScriptSub(sub);

  // Rede de segurança: o retrato e os eventos já mantêm a lista; isto cobre um evento perdido.
  useEffect(() => {
    void useScriptsStore.getState().load();
  }, [workspaceId]);

  const list = runs ?? [];
  const live = runningCount(list) > 0;
  const now = useNowWhile(live);
  const selected = selectedId ? list.find((run) => run.id === selectedId) : undefined;
  const open = (id: string) => go("scripts", id);
  const back = () => go("scripts");

  let viewer;
  if (selected && workspaceId) viewer = <ScriptViewer key={selected.id} run={selected} workspaceId={workspaceId} now={now} onBack={back} />;
  else if (selectedId && runs !== null) {
    viewer = (
      <div className="scripts-placeholder" data-testid="scripts-missing">
        <p>
          O script {selectedId} não está mais na lista. Um script terminado some cerca de {SCRIPT_LIMITS.finishedTtlMinutes} minutos depois de terminar.
        </p>
        <button type="button" className="ui-button ui-button--secondary ui-button--small scripts-back" onClick={back} data-testid="scripts-back">
          Voltar
        </button>
      </div>
    );
  } else if (selectedId) viewer = <p className="scripts-placeholder">Carregando o script…</p>;
  else viewer = <p className="scripts-placeholder scripts-placeholder--idle">Escolha um script na lista para ver a saída dele.</p>;

  return (
    <section className="page page--scripts page--fill" aria-labelledby="page-title-scripts" data-testid="scripts-page" data-view={selectedId ? "viewer" : "list"}>
      <header className="page__header page__header--row scripts-header">
        <div className="page__heading">
          <h2 className="page__title" id="page-title-scripts">
            Scripts dos agentes
          </h2>
          <p className="page__subtitle">Os comandos demorados que os agentes rodam pelo escritório (downloads, crawlers, builds), com a saída ao vivo.</p>
        </div>
      </header>
      {error && runs === null && (
        <p className="page__empty" role="alert">
          Não deu para carregar os scripts: {error}
        </p>
      )}
      {runs === null && !error && <p className="page__empty">Carregando os scripts…</p>}
      {runs !== null && list.length === 0 && (
        <p className="page__empty" data-testid="scripts-empty">
          Nenhum script rodando. Quando um agente rodar um comando demorado pelo escritório, ele aparece aqui com a saída ao vivo e some cerca de {SCRIPT_LIMITS.finishedTtlMinutes} minutos depois de terminar.
        </p>
      )}
      {list.length > 0 && (
        <div className="scripts-layout">
          <aside className="scripts-side" aria-label="Scripts">
            <ScriptList runs={list} selectedId={selectedId} now={now} onOpen={open} />
          </aside>
          <div className="scripts-main">{viewer}</div>
        </div>
      )}
    </section>
  );
}
