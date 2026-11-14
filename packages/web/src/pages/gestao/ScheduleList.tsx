import type { RoutineOverviewItem } from "@cyno/shared";
import { runView, scheduleLine, slotLabel } from "./gestaoView";

const RUNS_SHOWN = 2;

/**
 * Os horários da rotina ("Dias úteis · 9h, 13h, 18h → E-mail"), o próximo a rodar e as últimas
 * execuções (rodando, rodou, falhou, pulada). Só leitura: o formulário de horários é da tela de detalhe.
 */
export function ScheduleList({ item }: { item: RoutineOverviewItem }) {
  const { routine, next } = item;
  const runs = [...routine.lastRuns].reverse().slice(0, RUNS_SHOWN);
  if (routine.schedules.length === 0 && runs.length === 0) return null;
  const upcoming = next[0];
  return (
    <section className="sched" aria-label="Horários" data-testid="schedules">
      {routine.schedules.length > 0 && (
        <ul className="sched__list">
          {routine.schedules.map((schedule) => (
            <li key={schedule.id} className={`sched__row${schedule.enabled ? "" : " sched__row--off"}`} data-testid={`schedule-${schedule.id}`}>
              {scheduleLine(schedule)}
            </li>
          ))}
        </ul>
      )}
      {upcoming && (
        <p className="sched__next" data-testid="schedule-next">
          Próximo: {slotLabel(upcoming.slotKey)} · {upcoming.label}
        </p>
      )}
      {runs.length > 0 && (
        <ul className="sched__runs" aria-label="Últimas execuções" data-testid="schedule-runs">
          {runs.map((run) => {
            const view = runView(run);
            const schedule = routine.schedules.find((candidate) => candidate.id === run.scheduleId);
            return (
              <li key={run.id} className={`sched__run sched__run--${view.tone}`} data-outcome={run.outcome}>
                <span className="sched__run-when">{slotLabel(run.slotKey)}</span>
                <span className="sched__run-what">
                  {schedule ? `${schedule.label} · ` : ""}
                  {view.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
