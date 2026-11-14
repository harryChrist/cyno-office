import type { RoutineDetail, RoutineOverviewItem } from "@cyno/shared";
import { formatAgo, formatDateTime } from "../../ui/format";
import { useNavStore } from "../../store/navStore";
import { GoalProgress } from "./GoalCard";
import { GIcon } from "./GIcon";
import { WEEKDAY_OPTIONS } from "./scheduleForm";
import { DECISION_LABELS, STAGE_LABELS, VIA_LABELS, costText, formatBrl, entryLabel, groupEntriesByWeek, shortUrl, weekLabel } from "./gestaoView";
import { HISTORY_MARKS, counterCells, periodHistoryLine, periodView, usdRate } from "./routineView";

type Props = { item: RoutineOverviewItem; detail: RoutineDetail | null };

const newestFirst = <T extends { at: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => b.at.localeCompare(a.at));
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/** Parte do detalhe que é só da Meta: período atual, contadores, entregues, histórico dos períodos e o porquê do vigia. */
export function MetaPanel({ item, detail }: Props) {
  const { routine } = item;
  const go = useNavStore((state) => state.go);
  const view = periodView(item);
  const delivered = detail?.entries.filter((entry) => entry.periodKey === item.periodKey && entry.stage === "entregue") ?? [];
  const waiting = detail?.entries.filter((entry) => entry.periodKey === item.periodKey && entry.stage === "registrado") ?? [];
  const weeks = detail ? groupEntriesByWeek(detail.entries).filter((week) => week.periodKey !== item.periodKey) : [];
  const preferred = WEEKDAY_OPTIONS.filter((day) => item.preferredDays.includes(day.value));

  return (
    <>
      <section className="gdetail__section" aria-label="Período atual" data-testid="meta-period">
        <h4 className="gdetail__h">{item.period === "month" ? "Este mês" : "Esta semana"}</h4>
        <div className="mper">
          <div className="mper__nums">
            <span className="mper__big">
              {item.delivered}
              <span className="mper__of">/{routine.target}</span>
            </span>
            <span className={`pace pace--${view.tone}`} data-testid="meta-headline">
              {view.headline}
            </span>
          </div>
          <GoalProgress item={item} />
          <p className="goal__progress-text" data-testid="meta-lines">
            {view.lines.join(" · ")}
          </p>
          {routine.skipPeriods.includes(item.periodKey) && <p className="goal__muted">Este período foi pulado: o vigia não cobra.</p>}
          <p className="goal__muted">
            {item.daysLeft <= 0 ? "Termina hoje" : item.daysLeft === 1 ? "Falta 1 dia" : `Faltam ${item.daysLeft} dias`}
            {preferred.length > 0 ? ` · dias preferidos: ${preferred.map((day) => day.short).join(", ")}` : ""}
            {item.stopOnHit ? " · para ao bater o alvo" : " · segue depois de bater o alvo"}
          </p>
        </div>
        <dl className="mcount" data-testid="meta-counters">
          {counterCells(item.stats).map((cell) => (
            <div key={cell.label} className="mcount__cell">
              <dt>{cell.label}</dt>
              <dd>{cell.value}</dd>
            </div>
          ))}
          <div className="mcount__cell">
            <dt>Em preparo</dt>
            <dd>{item.inFlight + item.pending}</dd>
          </div>
        </dl>
        {item.prepareFactor > 1 && <p className="goal__muted">Prepara {item.prepareFactor}x mais opções do que o alvo e você escolhe as melhores em Aprovações; as que sobram são dispensadas ao bater o alvo.</p>}
        <p className="goal__muted">{costText(item.cost, routine.unit, item.period)}</p>
      </section>

      <section className="gdetail__section" aria-label="Itens entregues" data-testid="meta-delivered">
        <h4 className="gdetail__h">Entregues neste período</h4>
        {!detail && <p className="goal__muted">Carregando…</p>}
        {detail && delivered.length === 0 && waiting.length === 0 && <p className="goal__muted">Nada entregue ainda.</p>}
        <ul className="glist">
          {[...newestFirst(delivered), ...newestFirst(waiting)].map((entry) => (
            <li key={entry.id} className="glist__item">
              <span className={`stage stage--${entry.stage}`}>{STAGE_LABELS[entry.stage]}</span>
              {isWebUrl(entry.url) ? (
                <a className="glist__link" href={entry.url} target="_blank" rel="noopener noreferrer">
                  {shortUrl(entry.url)}
                  <GIcon name="link" size={12} />
                </a>
              ) : (
                <span className="glist__link">{entryLabel(entry)}</span>
              )}
              {entry.note && <span className="glist__note">{entry.note}</span>}
              <span className="glist__when">{formatAgo(entry.at)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="gdetail__section" aria-label="Períodos anteriores" data-testid="meta-history">
        <h4 className="gdetail__h">Períodos anteriores</h4>
        {item.history.length === 0 && <p className="goal__muted">Nenhum período fechado ainda.</p>}
        <ul className="mhist">
          {[...item.history].reverse().map((point) => {
            const mark = HISTORY_MARKS[point.outcome];
            return (
              <li key={point.periodKey} className={`mhist__row mhist__row--${mark.tone}`}>
                <span className="mhist__mark" aria-hidden="true">
                  {mark.mark}
                </span>
                <span className="mhist__when">{weekLabel(point.periodKey)}</span>
                <span className="mhist__what">
                  {mark.label} · {periodHistoryLine(point, (usd) => formatBrl(usd * usdRate(item.cost)))}
                </span>
              </li>
            );
          })}
        </ul>
        {weeks.length > 0 && (
          <details className="mhist__more">
            <summary>Itens dos períodos anteriores</summary>
            {weeks.map((week) => (
              <div key={week.periodKey} className="gweek">
                <h5 className="gweek__title">{weekLabel(week.periodKey)}</h5>
                <ul className="glist">
                  {week.entries.map((entry) => (
                    <li key={entry.id} className="glist__item">
                      <span className={`stage stage--${entry.stage}`}>{STAGE_LABELS[entry.stage]}</span>
                      <span className="glist__link">{entryLabel(entry)}</span>
                      <span className="glist__when">{formatAgo(entry.at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
        )}
      </section>

      {detail && (
        <>
          <section className="gdetail__section" aria-label="Execuções" data-testid="detail-executions">
            <h4 className="gdetail__h">Ações recentes no site</h4>
            {detail.executions.length === 0 && <p className="goal__muted">Nenhuma ação executada ainda.</p>}
            <ul className="glist">
              {newestFirst(detail.executions).slice(0, 8).map((execution) => (
                <li key={execution.id} className="glist__item">
                  <span className="stage stage--exec">{execution.label}</span>
                  <span className="glist__note">{VIA_LABELS[execution.via]}</span>
                  {execution.taskId && (
                    <button type="button" className="ui-link glist__task" onClick={() => go("trabalho")}>
                      {execution.taskId}
                    </button>
                  )}
                  <span className="glist__when">{formatDateTime(execution.at)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="gdetail__section" aria-label="Decisões do vigia" data-testid="detail-decisions">
            <h4 className="gdetail__h">Por que fez isso</h4>
            {detail.decisions.length === 0 && <p className="goal__muted">O vigia ainda não tomou nenhuma decisão.</p>}
            <ol className="gdecisions">
              {newestFirst(detail.decisions).slice(0, 10).map((decision, index) => (
                <li key={`${decision.at}-${index}`} className={`gdecision gdecision--${decision.kind}`}>
                  <span className="gdecision__kind">{DECISION_LABELS[decision.kind]}</span>
                  <span className="gdecision__reason">{decision.reason}</span>
                  <span className="glist__when">{formatDateTime(decision.at)}</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </>
  );
}
