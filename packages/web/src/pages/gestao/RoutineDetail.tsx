import { ROUTINE_KIND_LABELS, ROUTINE_TYPE_LABELS, describeDays, type NextSlot, type RoutineDetail as RoutineDetailData, type RoutineOverviewItem } from "@cyno/shared";
import { useEffect, useState } from "react";
import { api, describeError } from "../../api/client";
import { useRoutinesStore } from "../../store/routinesStore";
import { useNavStore } from "../../store/navStore";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { noLinkNote } from "./gestaoView";
import { ModeCardView } from "../work/ModeCard";
import { openProject } from "../work/openProject";
import { GIcon, KindIcon } from "./GIcon";
import { MetaPanel } from "./MetaPanel";
import { TrackingPanel } from "./TrackingPanel";
import { useAgentName, useRoutineModeRequest } from "./gestaoHooks";
import { ownerLabel, slotLabel } from "./gestaoView";
import { isPausedItem, modeCardState, modeView, routineActions, runLine, scheduleRows, skipLabel, stateText, typeLine } from "./routineView";

type Props = { item: RoutineOverviewItem; onClose: () => void; onEdit: () => void };

const RUNS_SHOWN = 15;

/**
 * Painel de detalhe de uma rotina (gaveta dentro da Gestão): o que é comum aos dois tipos (estado, modo,
 * horários, próximas execuções, histórico de execuções, Pausar/Retomar/Encerrar) e, embaixo, a parte da
 * Meta (período, entregues, períodos anteriores) ou do Acompanhamento (itens e mudanças).
 */
export function RoutineDetailPanel({ item, onClose, onEdit }: Props) {
  const { routine } = item;
  const version = useRoutinesStore((state) => state.version);
  const go = useNavStore((state) => state.go);
  const agentName = useAgentName();
  const [detail, setDetail] = useState<RoutineDetailData | null>(null);
  const [next, setNext] = useState<NextSlot[]>(item.next);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runNote, setRunNote] = useState<Record<string, string>>({});
  const isMeta = routine.type === "meta";

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getRoutine(routine.id), api.getRoutineNext(routine.id, 5)])
      .then(([loaded, upcoming]) => {
        if (cancelled) return;
        setDetail(loaded);
        setNext(upcoming.next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [routine.id, version]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = async (body: Parameters<typeof api.updateRoutine>[1]) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.updateRoutine(routine.id, body);
      await useRoutinesStore.getState().load();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.retryRoutine(routine.id);
      await useRoutinesStore.getState().load();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };
  const runNow = async (scheduleId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const { run } = await api.runRoutineSchedule(routine.id, scheduleId);
      setRunNote((notes) => ({ ...notes, [scheduleId]: run.outcome === "pulada" ? `Não rodou: ${run.skipReason ?? "pulada"}` : run.outcome === "falhou" ? `Falhou: ${run.summary ?? ""}` : "Execução iniciada" }));
      await useRoutinesStore.getState().load();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };
  const actions = routineActions(item);
  const ended = routine.status === "encerrada" || routine.status === "proposta";
  const nextSkipped = routine.skipPeriods.some((key) => key > item.periodKey);
  const firstRunOf = (scheduleId: string) => item.firstRuns?.find((first) => first.scheduleId === scheduleId)?.text;
  const mode = modeView(routine);
  const modeRequest = useRoutineModeRequest(routine.id);
  const modeCard = modeCardState(routine);
  const rows = scheduleRows(routine.schedules, agentName, describeDays);
  const runs = (detail?.runs ?? [...routine.lastRuns].reverse()).slice(0, RUNS_SHOWN);
  const paused = isPausedItem(item);

  return (
    <aside className="gdetail" aria-label={`Detalhes de ${routine.title}`} data-testid="goal-detail" data-type={routine.type}>
      <header className="gdetail__head">
        <span className="goal__kind">{isMeta ? <KindIcon kind={routine.kind} /> : <GIcon name="inbox" size={16} />}</span>
        <div className="gdetail__heading">
          <h3 className="gdetail__title">{routine.title}</h3>
          <p className="goal__owner">
            {routine.id} · {typeLine(item)} · {ownerLabel(item)}
            {isMeta && routine.site ? ` · ${routine.site}` : ""}
          </p>
          {mode.auto && (
            <span className="approval approval--auto" data-testid="detail-auto-badge">
              Automático
            </span>
          )}
        </div>
        <button type="button" className="ui-icon-button" aria-label="Fechar detalhes" onClick={onClose} data-testid="goal-detail-close">
          ×
        </button>
      </header>

      <div className="gdetail__body">
        <section className="gdetail__section" aria-label="Estado" data-testid="detail-state">
          <div className="gdetail__row rstate">
            <span className={`rstate__badge${paused ? " rstate__badge--paused" : ""}`} data-testid="detail-status">
              {stateText(item)}
            </span>
            <span className={`approval${mode.auto ? " approval--auto" : ""}`} data-testid="detail-mode">
              {mode.label}
            </span>
            <span className="goal__muted">
              {ROUTINE_TYPE_LABELS[routine.type]}
              {isMeta ? ` · ${ROUTINE_KIND_LABELS[routine.kind]}` : ""}
            </span>
          </div>
          <p className="goal__muted" data-testid="detail-mode-hint">
            <strong>{mode.label}:</strong> {mode.hint} Quem muda o modo é só você, no cartão Modo abaixo.
          </p>
          <div className="rstate__actions">
            {actions.pause && (
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void patch({ status: "pausada" })} data-testid="detail-pause">
                <GIcon name="pause" size={13} />
                Pausar
              </button>
            )}
            {actions.resume && (
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void patch({ status: "ativa", pausedUntil: null })} data-testid="detail-resume">
                <GIcon name="play" size={13} />
                Retomar
              </button>
            )}
            {actions.skip && (
              <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={busy} onClick={() => void patch({ skipThisPeriod: true })} data-testid="detail-skip">
                <GIcon name="skip" size={13} />
                {skipLabel(item.period)}
              </button>
            )}
            {isMeta && !ended && !nextSkipped && (
              <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={busy} onClick={() => void patch({ skipNextPeriod: true })} data-testid="detail-skip-next">
                <GIcon name="skip" size={13} />
                {item.period === "month" ? "Pular o próximo mês" : "Pular a próxima semana"}
              </button>
            )}
            {isMeta && !ended && nextSkipped && (
              <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={busy} onClick={() => void patch({ skipNextPeriod: false })} data-testid="detail-unskip-next">
                Voltar a cobrar {item.period === "month" ? "o próximo mês" : "a próxima semana"}
              </button>
            )}
            {actions.unskip && (
              <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={busy} onClick={() => void patch({ skipThisPeriod: false })} data-testid="detail-unskip">
                Voltar a cobrar
              </button>
            )}
            <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onEdit} data-testid="detail-edit">
              Editar
            </button>
            {actions.end && (
              <button type="button" className="ui-button ui-button--ghost ui-button--small rstate__end" disabled={busy} onClick={() => setConfirmEnd(true)} data-testid="detail-end">
                Encerrar
              </button>
            )}
          </div>
          {routine.blocked && (
            <div className="rblocked" role="status" data-testid="detail-blocked">
              <p className="rblocked__text">
                <strong>{routine.blocked.reason}.</strong> {routine.blocked.attempts} tentativas seguidas sem entrega: o vigia parou de tentar para não gastar à toa.
              </p>
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void retry()} data-testid="detail-retry">
                Tentar de novo
              </button>
            </div>
          )}
          {noLinkNote(item.approvedNoLink) && (
            <p className="rstate__note" data-testid="detail-no-link">
              {noLinkNote(item.approvedNoLink)}: só conta como entregue o que tem link registrado. O vigia cobra do agente só o registro, sem preparar opções novas.
            </p>
          )}
          {ended && routine.status === "encerrada" && (
            <button type="button" className="ui-button ui-button--ghost ui-button--small rstate__end" disabled={busy} onClick={() => setConfirmDelete(true)} data-testid="detail-delete">
              Apagar
            </button>
          )}
          <ErrorText>{actionError}</ErrorText>
        </section>

        <ModeCardView
          mode={routine.mode}
          modeProposal={routine.modeProposal}
          autoUsage={routine.autoUsage}
          paused={modeCard.paused}
          open={modeCard.open}
          closed={false}
          send={modeRequest.send}
          pending={modeRequest.pending}
          error={modeRequest.error}
          subject="esta rotina"
          pausedText="A rotina está pausada: nada é aprovado sozinho até você retomar."
        />

        <section className="gdetail__section" aria-label="Horários" data-testid="detail-schedules">
          <h4 className="gdetail__h">Horários</h4>
          {rows.length === 0 ? (
            <p className="goal__muted">Sem horários: esta meta roda só pelo vigia do ritmo.</p>
          ) : (
            <ul className="stree">
              {rows.map((row) => (
                <li key={row.id} className={`stree__row${row.off ? " stree__row--off" : ""}`} data-testid={`detail-schedule-${row.id}`}>
                  <span className="stree__when">
                    {row.when}
                    {row.off && <span className="stree__tag">desligado</span>}
                  </span>
                  <span className="stree__arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="stree__what">
                    {row.what}
                    {(row.agent || row.scope) && <span className="stree__meta"> · {[row.agent ? `com ${row.agent}` : null, row.scope].filter(Boolean).join(" · ")}</span>}
                    {firstRunOf(row.id) && (
                      <span className="stree__meta stree__first" data-testid={`first-run-${row.id}`}>
                        {" "}
                        · {firstRunOf(row.id)}
                      </span>
                    )}
                    {runNote[row.id] && <span className="stree__meta" data-testid={`run-note-${row.id}`}> · {runNote[row.id]}</span>}
                  </span>
                  {!row.off && routine.status === "ativa" && !paused && !routine.blocked && (
                    <button type="button" className="ui-button ui-button--ghost ui-button--small stree__run" disabled={busy} onClick={() => void runNow(row.id)} data-testid={`run-now-${row.id}`}>
                      <GIcon name="play" size={12} />
                      Rodar agora
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {next.length > 0 && !paused && (
            <div className="snext" data-testid="detail-next">
              <span className="snext__title">Próximas execuções</span>
              <ul className="snext__list">
                {next.map((slot) => (
                  <li key={`${slot.scheduleId}-${slot.slotKey}`}>
                    <span className="snext__when">{slotLabel(slot.slotKey)}</span> {slot.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {paused && rows.length > 0 && <p className="goal__muted">Pausada: nenhum horário roda até você retomar.</p>}
        </section>

        {error && <ErrorText>{error}</ErrorText>}

        {isMeta ? <MetaPanel item={item} detail={detail} /> : <TrackingPanel routineId={routine.id} />}

        <section className="gdetail__section" aria-label="Execuções dos horários" data-testid="detail-runs">
          <h4 className="gdetail__h">Execuções dos horários</h4>
          {runs.length === 0 && <p className="goal__muted">{isMeta && rows.length === 0 ? "Esta meta não tem horários: o vigia cobra o agente quando ela atrasa (veja “Por que fez isso”)." : "Nenhuma execução ainda."}</p>}
          <ol className="runs">
            {runs.map((run) => {
              const line = runLine(run, routine.schedules);
              return (
                <li key={run.id} className={`runs__row runs__row--${line.tone}`} data-outcome={run.outcome} data-testid={`run-${run.id}`}>
                  <span className="runs__when">{line.when}</span>
                  <span className="runs__what">
                    {line.schedule && <strong>{line.schedule} · </strong>}
                    {line.label}
                    {line.changes && <span className="runs__changes">{line.changes}</span>}
                    {line.detail && (
                      <details className="runs__detail" data-testid={`run-detail-${run.id}`}>
                        <summary>Ver o texto completo</summary>
                        <pre className="runs__full">{line.detail}</pre>
                      </details>
                    )}
                  </span>
                  {line.projectId ? (
                    <button type="button" className="ui-link runs__link" onClick={() => openProject(line.projectId!)} data-testid={`run-open-${run.id}`}>
                      Ver tarefa
                    </button>
                  ) : line.taskId ? (
                    <button type="button" className="ui-link runs__link" onClick={() => go("trabalho")}>
                      Ver tarefa
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        {routine.instruction && (
          <section className="gdetail__section" aria-label="Instruções">
            <h4 className="gdetail__h">Instruções gerais</h4>
            <p className="gdetail__instruction-text">{routine.instruction}</p>
          </section>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Apagar rotina"
          message={`“${routine.title}” será apagada de vez, com os itens e o histórico (links, decisões e resultados). Os projetos e tarefas que ela já executou ficam como estão. Isso não dá para desfazer.`}
          confirmLabel="Apagar"
          pendingLabel="Apagando…"
          onConfirm={() => api.deleteRoutine(routine.id).then(() => useRoutinesStore.getState().load()).then(onClose)}
          onClose={() => setConfirmDelete(false)}
          testId="detail-delete-confirm"
        />
      )}
      {confirmEnd && (
        <ConfirmDialog
          title="Encerrar rotina"
          message={`“${routine.title}” para de rodar e sai das telas${isMeta ? "" : "; os itens ativos viram encerrados"}. O histórico fica guardado.`}
          confirmLabel="Encerrar"
          pendingLabel="Encerrando…"
          onConfirm={() => api.updateRoutine(routine.id, { status: "encerrada" }).then(() => useRoutinesStore.getState().load())}
          onClose={() => setConfirmEnd(false)}
          testId="detail-end-confirm"
        />
      )}
    </aside>
  );
}
