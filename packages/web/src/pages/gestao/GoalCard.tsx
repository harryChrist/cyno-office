import type { RoutineOverviewItem } from "@cyno/shared";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { api, describeError } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { useRoutinesStore } from "../../store/routinesStore";
import { ConfirmDialog } from "../../ui/widgets";
import { ActionNote, useActionNote } from "./ActionControls";
import { targetNote, targetStep } from "./actionsView";
import { GIcon, KindIcon } from "./GIcon";
import "./actions.css";
import { ScheduleList } from "./ScheduleList";
import { PACE_VIEW, OUTCOME_VIEW, approvalView, costText, expectedPct, metaSummary, nextDispatchText, noLinkNote, ownerLabel, progressSplit, projectionView, registeredNote, statsText, trackingText, weekLabel } from "./gestaoView";
import { isPausedItem, routineActions, skipLabel, typeLine } from "./routineView";

type Props = {
  item: RoutineOverviewItem;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
};

/** Selo de ritmo: ícone + texto + cor (nunca só a cor). */
export function PaceBadge({ pace }: { pace: RoutineOverviewItem["pace"] }) {
  const view = PACE_VIEW[pace];
  return (
    <span className={`pace pace--${view.tone}`} data-testid="goal-pace" data-pace={pace}>
      <GIcon name={view.icon} size={13} />
      {view.label}
    </span>
  );
}

/** "Precisa do meu OK" / "Age sozinho", com a explicação da lista de rótulos liberados. */
export function ApprovalChip({ routine }: { routine: RoutineOverviewItem["routine"] }) {
  const view = approvalView(routine);
  const tipId = useId();
  return (
    <span className={`approval${view.short ? " approval--auto" : ""}`} data-testid="goal-approval">
      {view.label}
      <span className="tip">
        <button type="button" className="tip__btn" aria-label={`Sobre “${view.label}”`} aria-describedby={tipId}>
          <GIcon name="info" size={13} />
        </button>
        <span id={tipId} role="tooltip" className="tip__pop">
          {view.hint}
        </span>
      </span>
    </span>
  );
}

/** Selo do tipo Acompanhamento (no lugar do ritmo, que só a meta tem). */
function TypeBadge({ paused }: { paused: boolean }) {
  return (
    <span className={`pace pace--${paused ? "muted" : "info"}`} data-testid="goal-type">
      <GIcon name={paused ? "pause" : "check"} size={13} />
      {paused ? "Pausado" : "Acompanhando"}
    </span>
  );
}

/** Pontinhos dos últimos períodos: ✓ bateu, ✗ não bateu, ⏸ pulada (do mais antigo ao mais novo). */
export function HistoryDots({ history }: { history: RoutineOverviewItem["history"] }) {
  if (history.length === 0) return <span className="goal__muted">Sem períodos fechados ainda</span>;
  return (
    <ul className="dots" aria-label="Últimos períodos">
      {history.map((point) => {
        const view = OUTCOME_VIEW[point.outcome];
        const stats = statsText(point);
        return (
          <li key={point.periodKey} className={`dot dot--${view.tone}`} title={`${weekLabel(point.periodKey)}: ${view.label} (${point.delivered} de ${point.target})${stats ? ` · ${stats}` : ""}`}>
            <span aria-hidden="true">{view.mark}</span>
            <span className="sr-only">{`${weekLabel(point.periodKey)}: ${view.label}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Barra de progresso: entregue sólido, registrado ainda não entregue listrado, traço do esperado. */
export function GoalProgress({ item }: { item: RoutineOverviewItem }) {
  const { deliveredPct, registeredPct } = progressSplit(item.delivered, item.registered + item.inFlight, item.routine.target);
  const expected = expectedPct(item.expected, item.routine.target);
  return (
    <div
      className="gbar"
      role="progressbar"
      aria-label={`Progresso de ${item.routine.title}`}
      aria-valuemin={0}
      aria-valuemax={item.routine.target}
      aria-valuenow={item.delivered}
      aria-valuetext={`${item.delivered} de ${item.routine.target} entregues`}
    >
      <span className="gbar__done" style={{ width: `${deliveredPct}%` }} />
      <span className="gbar__reg" style={{ left: `${deliveredPct}%`, width: `${registeredPct}%` }} />
      {item.expected > 0 && item.expected < item.routine.target && <span className="gbar__expected" style={{ left: `${expected}%` }} title={`Esperado até agora: ${item.expected}`} />}
    </div>
  );
}

/** Menu ⋯ do cartão: editar e encerrar. */
function MoreMenu({ onEdit, onArchive, disabled, canEnd }: { onEdit: () => void; onArchive: () => void; disabled: boolean; canEnd: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="gmenu">
      <button type="button" className="ui-button ui-button--ghost ui-button--small gmenu__btn" aria-label="Mais ações" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={disabled} data-testid="goal-more">
        <GIcon name="more" size={16} />
      </button>
      {open && (
        <div className="gmenu__list" role="menu">
          <button type="button" role="menuitem" className="gmenu__item" onClick={() => { setOpen(false); onEdit(); }} data-testid="goal-edit">
            Editar
          </button>
          {canEnd && (
            <button type="button" role="menuitem" className="gmenu__item gmenu__item--danger" onClick={() => { setOpen(false); onArchive(); }} data-testid="goal-archive">
              Encerrar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Cartão de uma rotina (Meta ou Acompanhamento): resumo, horários e as ações rápidas. Clicar abre o detalhe. */
export function GoalCard({ item, selected, onOpen, onEdit }: Props) {
  const { routine } = item;
  const go = useNavStore((state) => state.go);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const targetAction = useActionNote();
  // Acompanhamento não tem meta nem ritmo: o cartão mostra o resumo dos itens, horários e execuções.
  const isMeta = routine.type === "meta";
  const paused = isPausedItem(item);
  const skipped = routine.skipPeriods.includes(item.periodKey);
  const actions = routineActions(item);
  const registered = registeredNote(item.registered);
  const projection = isMeta ? projectionView(item) : null;
  const titleId = useId();

  const patch = async (body: Parameters<typeof api.updateRoutine>[1]) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateRoutine(routine.id, body);
      await useRoutinesStore.getState().load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <article className={`goal${selected ? " goal--selected" : ""}`} aria-labelledby={titleId} data-testid={`goal-${routine.id}`} data-pace={item.pace} data-type={routine.type} onClick={onOpen}>
      <header className="goal__top">
        <span className="goal__kind" title={routine.kind}>
          <KindIcon kind={routine.kind} />
        </span>
        <div className="goal__heading">
          <h3 id={titleId} className="goal__title">
            <button type="button" className="goal__open" onClick={(event) => { stop(event); onOpen(); }} aria-haspopup="dialog">
              {routine.title}
            </button>
          </h3>
          <p className="goal__owner">{typeLine(item)} · {ownerLabel(item)}{routine.site && isMeta ? ` · ${routine.site}` : ""}</p>
        </div>
        {isMeta ? <PaceBadge pace={item.pace} /> : <TypeBadge paused={paused} />}
      </header>

      {isMeta && (
        <div className="goal__progress">
          <GoalProgress item={item} />
          <p className="goal__progress-text" data-testid="goal-progress-text">{metaSummary(item)}</p>
          {projection && (
            <p className={`goal__projection goal__projection--${projection.tone}`} title={projection.detail} data-testid="goal-projection">
              {projection.text}
            </p>
          )}
          {(routine.status === "ativa" || routine.status === "pausada") && (
            <div className="goal__target" onClick={stop} data-testid="goal-target">
              <span className="goal__target-label" title="Muda a meta daqui para a frente (vale já nesta semana); as semanas fechadas não mudam">
                Meta {item.period === "month" ? "do mês" : "da semana"}: {routine.target}
              </span>
              {([-1, 1] as const).map((delta) => {
                const step = targetStep(routine, delta);
                return (
                  <button
                    key={delta}
                    type="button"
                    className="ui-button ui-button--secondary ui-button--small goal__step"
                    disabled={step.disabled || targetAction.busy}
                    title={step.hint}
                    aria-label={step.hint}
                    onClick={() =>
                      void targetAction.run(async () => {
                        await api.updateRoutine(routine.id, { target: step.next });
                        await useRoutinesStore.getState().load();
                      }, targetNote(step.next, item.period))
                    }
                    data-testid={delta === 1 ? "goal-target-up" : "goal-target-down"}
                  >
                    {step.label}
                  </button>
                );
              })}
              <ActionNote note={targetAction.note} testId="goal-target-note" />
            </div>
          )}
          {item.stats.prepared > 0 && <p className="goal__registered" data-testid="goal-stats">{statsText(item.stats)}</p>}
          {registered && <p className="goal__registered">+ {registered}</p>}
          {noLinkNote(item.approvedNoLink) && (
            <p className="goal__registered goal__registered--warn" data-testid="goal-no-link">
              {noLinkNote(item.approvedNoLink)}
            </p>
          )}
        </div>
      )}

      <ApprovalChip routine={routine} />
      {routine.blocked && (
        <p className="goal__blocked" role="status" data-testid="goal-blocked">
          {routine.blocked.reason}. O vigia parou de tentar.
        </p>
      )}

      {!isMeta && item.tracking && (
        <p className="goal__tracking" data-testid="tracking-summary">
          {trackingText(item.tracking)}
        </p>
      )}

      <ScheduleList item={item} />

      <dl className="goal__facts">
        <div>
          <dt>Próxima cobrança</dt>
          <dd>{skipped && isMeta ? `${item.period === "month" ? "Mês pulado" : "Semana pulada"}: sem cobrança` : paused ? "Pausada: sem cobrança" : nextDispatchText(item.nextDispatch)}</dd>
        </div>
        {isMeta && (
          <>
            <div>
              <dt>{item.period === "month" ? "Meses" : "Semanas"}</dt>
              <dd>
                <HistoryDots history={item.history} />
              </dd>
            </div>
            <div>
              <dt>Custo</dt>
              <dd>{costText(item.cost, routine.unit, item.period)}</dd>
            </div>
          </>
        )}
        {item.openTask && (
          <div>
            <dt>Tarefa aberta</dt>
            <dd>
              <button type="button" className="ui-link" onClick={(event) => { stop(event); go("trabalho"); }} data-testid="goal-task">
                {item.openTask.id}
              </button>
              <span className="goal__muted"> · {item.openTask.status === "in_progress" ? "em andamento" : item.openTask.status === "waiting_approval" ? "esperando aprovação" : "na fila"}</span>
            </dd>
          </div>
        )}
      </dl>

      {error && <p className="ui-error" role="alert">{error}</p>}

      <footer className="goal__actions" onClick={stop}>
        {(actions.pause || actions.resume) && (
          <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={busy} onClick={() => void patch(actions.resume ? { status: "ativa", pausedUntil: null } : { status: "pausada" })} data-testid="goal-pause">
            <GIcon name={actions.resume ? "play" : "pause"} size={13} />
            {actions.resume ? "Retomar" : "Pausar"}
          </button>
        )}
        {(actions.skip || actions.unskip) && (
          <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={busy} onClick={() => void patch({ skipThisPeriod: !skipped })} data-testid="goal-skip">
            <GIcon name="skip" size={13} />
            {skipped ? "Voltar a cobrar" : skipLabel(item.period)}
          </button>
        )}
        <span className="goal__actions-space" />
        <MoreMenu disabled={busy} canEnd={actions.end} onEdit={onEdit} onArchive={() => setConfirmArchive(true)} />
      </footer>
      {confirmArchive && (
        <div onClick={stop}>
        <ConfirmDialog
          title="Encerrar rotina"
          message={`“${routine.title}” para de rodar e sai das telas. O histórico fica guardado.`}
          confirmLabel="Encerrar"
          pendingLabel="Encerrando…"
          onConfirm={() => api.updateRoutine(routine.id, { status: "encerrada" }).then(() => useRoutinesStore.getState().load())}
          onClose={() => setConfirmArchive(false)}
          testId="goal-archive-confirm"
        />
        </div>
      )}
    </article>
  );
}
