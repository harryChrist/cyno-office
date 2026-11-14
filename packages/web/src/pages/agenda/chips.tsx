import type { AgendaEvent, AgendaPostItem, AgendaRoutineItem } from "@cyno/shared";
import { eventTimeLabel, timeLabel, workspaceColor } from "./agendaTime";

/** Chip de um compromisso (Seu tempo) na célula do mês e na lista. */
export function EventChip({ event, nameOf, onOpen }: { event: AgendaEvent; nameOf: (workspace: string | undefined) => string; onOpen: (event: AgendaEvent) => void }) {
  return (
    <button
      type="button"
      className="ag-chip-event"
      style={{ ["--ws" as string]: workspaceColor(event.workspace) }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(event);
      }}
      title={`${event.title} · ${eventTimeLabel(event)}${event.workspace ? ` · ${nameOf(event.workspace)}` : ""}`}
      data-testid="agenda-event"
      data-id={event.id}
    >
      <span className="ag-chip-event__time">{timeLabel(event.start)}</span>
      <span className="ag-chip-event__title">{event.title}</span>
    </button>
  );
}

/** Chip de uma postagem (camada Postagens: só leitura, com a cor do workspace). */
export function PostChip({ post, onOpen }: { post: AgendaPostItem; onOpen: (post: AgendaPostItem) => void }) {
  return (
    <button
      type="button"
      className={`ag-chip-post${post.done ? " ag-chip-post--done" : ""}`}
      style={{ ["--ws" as string]: workspaceColor(post.workspace) }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(post);
      }}
      title={`${post.title} · ${post.workspaceName}${post.time ? ` · ${post.time}` : ""}`}
      data-testid="agenda-post"
    >
      {post.time && <span className="ag-chip-post__time">{post.time}</span>}
      <span className="ag-chip-post__title">{post.title}</span>
    </button>
  );
}

/** Chip de um horário de rotina (camada opcional, só leitura). */
export function RoutineChip({ routine }: { routine: AgendaRoutineItem }) {
  return (
    <span className="ag-chip-routine" title={`${routine.title} · ${routine.workspaceName}${routine.label ? ` · ${routine.label}` : ""}`} data-testid="agenda-routine">
      <span className="ag-chip-routine__time">{timeLabel(routine.at)}</span>
      <span className="ag-chip-routine__title">{routine.title}</span>
    </span>
  );
}
