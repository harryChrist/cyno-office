import type { AgendaEvent, AgendaPostItem } from "@cyno/shared";
import { WEEKDAYS, type GridDay } from "../calendar/calendarDates";
import { EventChip, PostChip, RoutineChip } from "./chips";
import { eventsOfDay, postsOfDay, routinesOfDay, type AgendaData, type DateKey } from "./agendaTime";

/** Quantos itens a célula do dia mostra antes do "+N". */
const MAX_PER_DAY = 3;

type Props = {
  grid: GridDay[][];
  today: DateKey;
  data: AgendaData;
  nameOf: (workspace: string | undefined) => string;
  onCreate: (date: DateKey) => void;
  onOpen: (event: AgendaEvent) => void;
  onOpenPost: (post: AgendaPostItem) => void;
  onShowDay: (date: DateKey) => void;
};

/** Visão do mês: os compromissos em destaque, depois as postagens (cor do workspace) e as rotinas. */
export function MonthView({ grid, today, data, nameOf, onCreate, onOpen, onOpenPost, onShowDay }: Props) {
  return (
    <div className="ag-month" role="grid" aria-label="Mês" data-testid="agenda-month">
      <div className="ag-month__row ag-month__row--head" role="row">
        {WEEKDAYS.map((weekday) => (
          <div key={weekday.short} className="ag-month__weekday" role="columnheader">
            {weekday.short}
          </div>
        ))}
      </div>
      {grid.map((week) => (
        <div key={week[0]!.key} className="ag-month__row" role="row">
          {week.map((day) => {
            const mine = eventsOfDay(data.events, day.key);
            const entries = [
              ...mine.map((event) => ({ kind: "event" as const, event })),
              ...postsOfDay(data.posts, day.key).map((post) => ({ kind: "post" as const, post })),
              ...routinesOfDay(data.routines, day.key).map((routine) => ({ kind: "routine" as const, routine })),
            ];
            const shown = entries.slice(0, MAX_PER_DAY);
            return (
              <div
                key={day.key}
                role="gridcell"
                className={`ag-mday${day.inMonth ? "" : " ag-mday--out"}${day.isToday ? " ag-mday--today" : ""}${day.key < today ? " ag-mday--past" : ""}`}
                onClick={() => onCreate(day.key < today ? today : day.key)}
                data-testid="agenda-mday"
                data-day={day.key}
              >
                <span className="ag-mday__num">{day.day}</span>
                <div className="ag-mday__list">
                  {shown.map((entry) =>
                    entry.kind === "event" ? (
                      <EventChip key={`${entry.event.id}-${day.key}`} event={entry.event} nameOf={nameOf} onOpen={onOpen} />
                    ) : entry.kind === "post" ? (
                      <PostChip key={entry.post.id} post={entry.post} onOpen={onOpenPost} />
                    ) : (
                      <RoutineChip key={`${entry.routine.routineId}-${entry.routine.at}`} routine={entry.routine} />
                    ),
                  )}
                  {entries.length > MAX_PER_DAY && (
                    <button
                      type="button"
                      className="ag-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowDay(day.key);
                      }}
                      aria-label={`Mais ${entries.length - MAX_PER_DAY} itens em ${day.key}`}
                    >
                      +{entries.length - MAX_PER_DAY}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
