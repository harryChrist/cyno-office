import type { AgendaEvent, AgendaPostItem } from "@cyno/shared";
import { addDayKeys, dayLabel, eventsOfDay, eventTimeLabel, postsOfDay, routinesOfDay, timeLabel, workspaceColor, type AgendaData, type DateKey } from "./agendaTime";

type Props = {
  from: DateKey;
  days: number;
  today: DateKey;
  data: AgendaData;
  nameOf: (workspace: string | undefined) => string;
  onOpen: (event: AgendaEvent) => void;
  onOpenPost: (post: AgendaPostItem) => void;
  onCreate: () => void;
};

/** Lista dos próximos dias (a visão do celular): só os dias que têm algo, com todas as camadas ligadas. */
export function ListView({ from, days, today, data, nameOf, onOpen, onOpenPost, onCreate }: Props) {
  const groups = Array.from({ length: days }, (_, index) => addDayKeys(from, index))
    .map((day) => ({ day, events: eventsOfDay(data.events, day), posts: postsOfDay(data.posts, day), routines: routinesOfDay(data.routines, day) }))
    .filter((group) => group.events.length + group.posts.length + group.routines.length > 0);
  if (groups.length === 0) {
    return (
      <div className="ag-list ag-list--empty" data-testid="agenda-list">
        <p className="ag-list__empty">Nada marcado para os próximos {days} dias.</p>
        <button type="button" className="ui-button" onClick={onCreate}>
          + Compromisso
        </button>
      </div>
    );
  }
  return (
    <div className="ag-list" data-testid="agenda-list">
      {groups.map((group) => (
        <section key={group.day} className="ag-list__day" aria-label={dayLabel(group.day, today)}>
          <h4 className="ag-list__heading">{dayLabel(group.day, today)}</h4>
          <ul className="ag-list__items">
            {group.events.map((event) => (
              <li key={event.id}>
                <button type="button" className="ag-row ag-row--event" style={{ ["--ws" as string]: workspaceColor(event.workspace) }} onClick={() => onOpen(event)} data-testid="agenda-event" data-id={event.id}>
                  <span className="ag-row__time">{eventTimeLabel(event)}</span>
                  <span className="ag-row__main">
                    <span className="ag-row__title">{event.title}</span>
                    <span className="ag-row__meta">{event.workspace ? `Marcado por ${event.by.name ?? nameOf(event.workspace)} · ${nameOf(event.workspace)}` : "Marcado por você"}</span>
                  </span>
                </button>
              </li>
            ))}
            {group.posts.map((post) => (
              <li key={post.id}>
                <button type="button" className="ag-row ag-row--post" style={{ ["--ws" as string]: workspaceColor(post.workspace) }} onClick={() => onOpenPost(post)} data-testid="agenda-post">
                  <span className="ag-row__time">{post.time ?? "Dia todo"}</span>
                  <span className="ag-row__main">
                    <span className="ag-row__title">{post.title}</span>
                    <span className="ag-row__meta">Postagem · {post.workspaceName}</span>
                  </span>
                </button>
              </li>
            ))}
            {group.routines.map((routine) => (
              <li key={`${routine.routineId}-${routine.at}`}>
                <div className="ag-row ag-row--routine" data-testid="agenda-routine">
                  <span className="ag-row__time">{timeLabel(routine.at)}</span>
                  <span className="ag-row__main">
                    <span className="ag-row__title">{routine.title}</span>
                    <span className="ag-row__meta">Rotina · {routine.workspaceName}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
