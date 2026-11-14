import type { WaitingItem } from "@cyno/shared";
import { useEffect } from "react";
import { useAgendaStore } from "../../store/agendaStore";
import { useForYouFocus } from "../../store/forYouFocus";
import { useNavStore } from "../../store/navStore";
import { addDayKeys, compactDayLabel, dayKeyOf, eventTimeLabel, todayKey, upcomingEvents, workspaceColor } from "../agenda/agendaTime";
import "./cynoHome.css";

/** Quantos compromissos a aba mostra. */
const AGENDA_NEXT = 8;
/** Quanto adiante o bloco busca (a lista mostra só os primeiros). */
const AGENDA_AHEAD_DAYS = 30;

/** Carrega os próximos 30 dias da agenda (o painel lateral precisa dos números mesmo com outra aba aberta). */
export function useAgendaLoad(now: Date): void {
  const from = todayKey(now);
  useEffect(() => {
    void useAgendaStore.getState().load({ from, to: addDayKeys(from, AGENDA_AHEAD_DAYS), routines: false });
  }, [from]);
}

/**
 * "Sua agenda": os próximos compromissos que tomam o seu tempo, de todos os workspaces, e o caminho
 * para ver tudo. Vem do `agendaStore`, que o websocket do Cyno mantém ao vivo.
 */
export function AgendaNext({ now, limit = AGENDA_NEXT }: { now: Date; limit?: number }) {
  const events = useAgendaStore((state) => state.events);
  const workspaces = useAgendaStore((state) => state.workspaces);
  const status = useAgendaStore((state) => state.status);
  const go = useNavStore((state) => state.go);
  const today = todayKey(now);
  const next = upcomingEvents(events, now, limit);
  const nameOf = (id: string | undefined) => workspaces.find((workspace) => workspace.id === id)?.name ?? id ?? "";
  return (
    <section className="hstrip__panel agenda-next" aria-labelledby="agenda-title" data-testid="agenda-next">
      <header className="hstrip__head">
        <h3 className="hstrip__title" id="agenda-title">
          Sua agenda
        </h3>
        <button type="button" className="ui-button ui-button--ghost agenda-next__all" onClick={() => go("agenda")} data-testid="agenda-see-all">
          Ver tudo
        </button>
      </header>
      {status === "idle" || (status === "loading" && events.length === 0) ? (
        <p className="agenda-next__empty">Carregando…</p>
      ) : status === "error" && events.length === 0 ? (
        <p className="agenda-next__empty">Não deu para carregar a agenda agora.</p>
      ) : next.length === 0 ? (
        <div className="agenda-next__empty" data-testid="agenda-next-empty">
          <p className="agenda-next__empty-title">Nenhum compromisso marcado</p>
          <p className="agenda-next__empty-text">Reuniões, calls e gravações marcadas pelos agentes, ou por você, aparecem aqui, sem choque de horário entre os workspaces.</p>
        </div>
      ) : (
        <ul className="agenda-next__list">
          {next.map((event) => {
            const day = dayKeyOf(event.start);
            return (
              <li key={event.id}>
                <button type="button" className="agenda-next__item" style={{ ["--ws" as string]: workspaceColor(event.workspace) }} onClick={() => go("agenda")} data-testid="agenda-next-item" data-id={event.id}>
                  <span className="agenda-next__when">
                    <span className="agenda-next__day">{compactDayLabel(day, today)}</span>
                    <span className="agenda-next__time">{eventTimeLabel(event)}</span>
                  </span>
                  <span className="agenda-next__main">
                    <span className="agenda-next__title">{event.title}</span>
                    <span className="agenda-next__meta">{event.workspace ? `${event.by.name ? `${event.by.name} · ` : ""}${nameOf(event.workspace)}` : "Marcado por você"}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Abre o item no "Para você" do workspace certo (o foco no item vem do `useForYouFocus`). */
export function openWaiting(item: Pick<WaitingItem, "workspace" | "id">): void {
  useNavStore.getState().setWorkspace(item.workspace);
  useForYouFocus.getState().open(item.id);
}
