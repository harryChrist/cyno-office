import type { AgendaEvent, AgendaPostItem, Availability } from "@cyno/shared";
import { useEffect, useMemo, useRef } from "react";
import { PostChip, RoutineChip } from "./chips";
import { availabilityBands, daySegments, eventTimeLabel, layoutLanes, postsOfDay, routinesOfDay, timeLabel, visibleHours, workspaceColor, type AgendaData, type DateKey } from "./agendaTime";

/** Altura de uma hora na grade da semana (px). */
export const HOUR_PX = 52;
const WEEKDAY_SHORT = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
/** Quantos posts/rotinas cabem na faixa de cima de cada dia antes do "+N". */
const STRIP_MAX = 3;

type Props = {
  days: DateKey[];
  today: DateKey;
  nowMinutes: number;
  data: AgendaData;
  availability: Availability | null;
  nameOf: (workspace: string | undefined) => string;
  onCreate: (date: DateKey, startMinutes?: number) => void;
  onOpen: (event: AgendaEvent) => void;
  onOpenPost: (post: AgendaPostItem) => void;
  onPickDay: (day: DateKey) => void;
};

/** Visão da semana: colunas por dia, horas na vertical, disponibilidade sombreada e os compromissos por faixa. */
export function WeekView({ days, today, nowMinutes, data, availability, nameOf, onCreate, onOpen, onOpenPost, onPickDay }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useMemo(
    () =>
      days.map((day) => ({
        day,
        items: layoutLanes(daySegments(data.events, day)),
        bands: availability ? availabilityBands(availability, day) : [],
        posts: postsOfDay(data.posts, day),
        routines: routinesOfDay(data.routines, day),
      })),
    [days, data, availability],
  );
  const hours = useMemo(
    () =>
      visibleHours(
        columns.flatMap((column) => column.items.flatMap((item) => [item.startMin, item.endMin])),
        columns.flatMap((column) => column.bands),
      ),
    [columns],
  );
  const rows = Array.from({ length: hours.to - hours.from }, (_, index) => hours.from + index);
  const bodyHeight = rows.length * HOUR_PX;
  const hasStrip = columns.some((column) => column.posts.length + column.routines.length > 0);

  // Ao abrir (ou mudar a semana), rola até o começo do expediente.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const firstBand = columns.flatMap((column) => column.bands).reduce<number | null>((top, band) => (top === null ? band.from : Math.min(top, band.from)), null);
    const target = ((firstBand ?? 8 * 60) / 60 - hours.from - 0.5) * HOUR_PX;
    node.scrollTop = Math.max(0, target);
  }, [columns, hours.from]);

  const pick = (day: DateKey, event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains("ag-band")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = hours.from * 60 + ((event.clientY - rect.top) / HOUR_PX) * 60;
    onCreate(day, Math.max(0, Math.min(23 * 60 + 30, Math.round(minutes / 30) * 30)));
  };

  return (
    <div className="ag-week" data-testid="agenda-week">
      <div className="ag-week__head" style={{ paddingRight: "var(--ag-scrollbar, 0px)" }}>
        <div className="ag-week__corner" />
        {columns.map(({ day }) => (
          <button key={day} type="button" className={`ag-dayhead${day === today ? " ag-dayhead--today" : ""}`} onClick={() => onPickDay(day)} aria-label={`Ver o mês a partir de ${day}`} data-testid="agenda-dayhead" data-day={day}>
            <span className="ag-dayhead__week">{WEEKDAY_SHORT[new Date(`${day}T12:00:00Z`).getUTCDay()]}</span>
            <span className="ag-dayhead__num">{Number(day.slice(8, 10))}</span>
          </button>
        ))}
      </div>
      {hasStrip && (
        <div className="ag-week__strip" data-testid="agenda-strip">
          <div className="ag-week__corner ag-week__corner--label">Postagens</div>
          {columns.map(({ day, posts, routines }) => {
            const all = [...posts.map((post) => ({ kind: "post" as const, post })), ...routines.map((routine) => ({ kind: "routine" as const, routine }))];
            const shown = all.slice(0, STRIP_MAX);
            return (
              <div key={day} className="ag-strip__cell">
                {shown.map((entry) =>
                  entry.kind === "post" ? <PostChip key={entry.post.id} post={entry.post} onOpen={onOpenPost} /> : <RoutineChip key={`${entry.routine.routineId}-${entry.routine.at}`} routine={entry.routine} />,
                )}
                {all.length > STRIP_MAX && (
                  <button type="button" className="ag-more" onClick={() => onPickDay(day)}>
                    +{all.length - STRIP_MAX}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="ag-week__scroll" ref={scroller}>
        <div className="ag-week__body" style={{ height: bodyHeight }}>
          <div className="ag-gutter" aria-hidden="true">
            {rows.map((hour) => (
              <div key={hour} className="ag-gutter__hour" style={{ height: HOUR_PX }}>
                <span>{String(hour).padStart(2, "0")}:00</span>
              </div>
            ))}
          </div>
          {columns.map(({ day, items, bands }) => (
            <div key={day} className={`ag-col${day === today ? " ag-col--today" : ""}`} style={{ height: bodyHeight, ["--hour" as string]: `${HOUR_PX}px` }} onClick={(event) => pick(day, event)} role="group" aria-label={`Dia ${day}`} data-testid="agenda-col" data-day={day}>
              {bands.map((band) => (
                <div key={`${band.from}-${band.to}`} className="ag-band" style={{ top: Math.max(0, ((band.from - hours.from * 60) / 60) * HOUR_PX), height: (Math.min(band.to, hours.to * 60) - Math.max(band.from, hours.from * 60)) / 60 * HOUR_PX }} data-testid="agenda-band" />
              ))}
              {day === today && nowMinutes >= hours.from * 60 && nowMinutes <= hours.to * 60 && <div className="ag-now" style={{ top: ((nowMinutes - hours.from * 60) / 60) * HOUR_PX }} aria-hidden="true" />}
              {items.map((item) => {
                const top = ((item.startMin - hours.from * 60) / 60) * HOUR_PX;
                const height = Math.max(22, ((item.endMin - item.startMin) / 60) * HOUR_PX - 2);
                const width = 100 / item.lanes;
                const compact = height < 40;
                return (
                  <button
                    key={`${item.event.id}-${item.startMin}`}
                    type="button"
                    className={`ag-event${compact ? " ag-event--compact" : ""}${item.continuesBefore ? " ag-event--cont-before" : ""}${item.continuesAfter ? " ag-event--cont-after" : ""}`}
                    style={{ top, height, left: `calc(${item.lane * width}% + 2px)`, width: `calc(${width}% - 4px)`, ["--ws" as string]: workspaceColor(item.event.workspace) }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(item.event);
                    }}
                    title={`${item.event.title} · ${eventTimeLabel(item.event)}${item.event.workspace ? ` · ${nameOf(item.event.workspace)}` : ""}`}
                    data-testid="agenda-event"
                    data-id={item.event.id}
                  >
                    <span className="ag-event__title">{item.event.title}</span>
                    <span className="ag-event__meta">
                      {timeLabel(item.event.start)}
                      {item.event.workspace && !compact ? ` · ${nameOf(item.event.workspace)}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
