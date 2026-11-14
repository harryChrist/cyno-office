import { AGENDA_TIMEZONE, type AgendaEvent, type AgendaPostItem } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { useAgendaStore } from "../../store/agendaStore";
import { useNavStore } from "../../store/navStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { buildMonthGrid, formatMonthTitle, gridRange, monthOf, shiftMonth } from "../calendar/calendarDates";
import { AgendaEventDialog } from "./AgendaEventDialog";
import { AvailabilityDialog } from "./AvailabilityDialog";
import { addDayKeys, applyView, DEFAULT_LAYERS, minutesOfDay, todayKey, weekKeys, weekTitle, workspaceColor, type DateKey, type Layers } from "./agendaTime";
import { describeAvailability } from "./availabilityForm";
import { ListView } from "./ListView";
import { MonthView } from "./MonthView";
import { PostDialog } from "./PostDialog";
import { WeekView } from "./WeekView";
import "./agenda.css";

type View = "semana" | "mes" | "lista";
const VIEW_LABELS: Record<View, string> = { semana: "Semana", mes: "Mês", lista: "Lista" };
/** Dias da lista (hoje incluído). */
const LIST_DAYS = 21;

type Dialog =
  | { kind: "create"; date: DateKey; startMinutes?: number }
  | { kind: "edit"; id: string }
  | { kind: "post"; post: AgendaPostItem }
  | { kind: "availability" };

/** Agora, atualizado a cada 30 s (vira o dia, mexe a linha de "agora"). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Celular: a lista é a visão padrão. */
function defaultView(): View {
  try {
    return window.matchMedia("(max-width: 720px)").matches ? "lista" : "semana";
  } catch {
    return "semana";
  }
}

/**
 * "Sua agenda": o tempo do dono, uma só para a plataforma inteira. Camadas: Seu tempo (conferido pelo
 * servidor), Postagens de cada workspace (só leitura) e Rotinas (opcional). Aberta por `#/agenda/<ws>`, já filtrada nele.
 */
export function AgendaPage() {
  // `#/agenda/<ws>` abre já filtrada nesse workspace (o antigo `#/<ws>/calendario`). Mudar o filtro recomeça a página.
  const filter = useNavStore((state) => (state.sub ? decodeURIComponent(state.sub.split("/")[0]!) : null));
  return <AgendaView key={filter ?? "all"} initialWorkspace={filter} />;
}

function AgendaView({ initialWorkspace }: { initialWorkspace: string | null }) {
  const now = useNow();
  const zone = AGENDA_TIMEZONE;
  const today = todayKey(now, zone);
  const [view, setView] = useState<View>(defaultView);
  const [anchor, setAnchor] = useState<DateKey>(today);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [workspace, setWorkspace] = useState<string | null>(initialWorkspace);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const { events, posts, routines, availability, workspaces, status, error } = useAgendaStore();
  const known = useWorkspaceStore((state) => state.workspaces);
  const go = useNavStore((state) => state.go);

  const month = monthOf(anchor);
  const grid = useMemo(() => buildMonthGrid(month, today), [month.year, month.month, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => weekKeys(anchor), [anchor]);
  const range = useMemo(() => {
    if (view === "semana") return { from: days[0]!, to: days[6]! };
    if (view === "mes") return gridRange(grid);
    return { from: today, to: addDayKeys(today, LIST_DAYS - 1) };
  }, [view, days, grid, today]);

  useEffect(() => useAgendaStore.getState().connect(), []);
  useEffect(() => {
    void useAgendaStore.getState().load({ ...range, routines: layers.routines });
  }, [range.from, range.to, layers.routines]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => new Map([...(known ?? []).map((item) => [item.id, item.name] as const), ...workspaces.map((item) => [item.id, item.name] as const)]), [known, workspaces]);
  const nameOf = (id: string | undefined) => (id ? (names.get(id) ?? id) : "");
  const shown = useMemo(() => applyView({ events, posts, routines }, { workspace, layers }), [events, posts, routines, workspace, layers]);

  const step = (direction: -1 | 1) => {
    if (view === "mes") setAnchor(`${shiftMonthKey(month, direction)}-01`);
    else setAnchor(addDayKeys(anchor, direction * (view === "semana" ? 7 : LIST_DAYS)));
  };
  const title = view === "mes" ? formatMonthTitle(month) : view === "semana" ? weekTitle(days) : "Próximos dias";
  const editing = dialog?.kind === "edit" ? events.find((event) => event.id === dialog.id) : undefined;
  const open = (event: AgendaEvent) => setDialog({ kind: "edit", id: event.id });
  const create = (date: DateKey, startMinutes?: number) => setDialog({ kind: "create", date, ...(startMinutes !== undefined ? { startMinutes } : {}) });
  const nowMinutes = minutesOfDay(now.getTime(), zone);

  return (
    <section className="page page--agenda page--fill" aria-labelledby="page-title-agenda" data-testid="page-agenda">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-agenda" className="page__title">
            Sua agenda
          </h2>
          <p className="page__subtitle">O que toma o seu tempo, de todos os workspaces, sem choque de horário.</p>
        </div>
      </header>

      <div className="ag-toolbar">
        <div className="ag-toolbar__nav">
          <button type="button" className="ui-button ui-button--secondary ag-arrow" aria-label="Anterior" onClick={() => step(-1)} data-testid="agenda-prev">
            ‹
          </button>
          <h3 className="ag-toolbar__title" aria-live="polite" data-testid="agenda-title">
            {title}
          </h3>
          <button type="button" className="ui-button ui-button--secondary ag-arrow" aria-label="Próximo" onClick={() => step(1)} data-testid="agenda-next">
            ›
          </button>
          <button type="button" className="ui-button ui-button--secondary" onClick={() => setAnchor(today)} data-testid="agenda-today">
            Hoje
          </button>
        </div>
        <div className="ag-segment" role="tablist" aria-label="Visão">
          {(Object.keys(VIEW_LABELS) as View[]).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className="ag-segment__tab" onClick={() => setView(id)} data-testid={`agenda-view-${id}`}>
              {VIEW_LABELS[id]}
            </button>
          ))}
        </div>
        <div className="ag-toolbar__actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={() => setDialog({ kind: "availability" })} data-testid="agenda-availability">
            Disponibilidade
          </button>
          <button type="button" className="ui-button" onClick={() => create(anchor < today ? today : anchor)} data-testid="agenda-new">
            + Compromisso
          </button>
        </div>
      </div>

      <div className="ag-filters">
        <label className="ag-filter">
          <span className="ag-filter__label">Workspace</span>
          <select className="ui-input ag-filter__select" value={workspace ?? ""} onChange={(e) => setWorkspace(e.currentTarget.value || null)} data-testid="agenda-workspace">
            <option value="">Todos os workspaces</option>
            {[...names].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="ag-layers" role="group" aria-label="Camadas">
          <LayerToggle label="Seu tempo" swatch="mine" on={layers.mine} onChange={(on) => setLayers({ ...layers, mine: on })} testId="agenda-layer-mine" />
          <LayerToggle label="Postagens" swatch="posts" on={layers.posts} onChange={(on) => setLayers({ ...layers, posts: on })} testId="agenda-layer-posts" />
          <LayerToggle label="Rotinas" swatch="routines" on={layers.routines} onChange={(on) => setLayers({ ...layers, routines: on })} testId="agenda-layer-routines" />
        </div>
        {workspace && (
          <div className="ag-chip" data-testid="agenda-scope">
            <span className="ag-chip__dot" style={{ background: workspaceColor(workspace) }} />
            Só {nameOf(workspace)}
            <button type="button" className="ag-chip__clear" onClick={() => (initialWorkspace ? go("agenda") : setWorkspace(null))} aria-label="Ver todos os workspaces" data-testid="agenda-scope-clear">
              ×
            </button>
          </div>
        )}
        <p className="ag-toolbar__status" role="status">
          {status === "loading" ? "Carregando…" : ""}
        </p>
      </div>

      {status === "error" && (
        <div className="ag-error" role="alert">
          <span>Não deu para carregar a agenda: {error}</span>
          <button type="button" className="ui-button ui-button--small ui-button--secondary" onClick={() => void useAgendaStore.getState().reload()}>
            Tentar de novo
          </button>
        </div>
      )}

      <div className="ag-body">
        {view === "semana" && (
          <WeekView days={days} today={today} nowMinutes={nowMinutes} data={shown} availability={availability} nameOf={nameOf} onCreate={create} onOpen={open} onOpenPost={(post) => setDialog({ kind: "post", post })} onPickDay={(day) => { setAnchor(day); setView("mes"); }} />
        )}
        {view === "mes" && <MonthView grid={grid} today={today} data={shown} nameOf={nameOf} onCreate={create} onOpen={open} onOpenPost={(post) => setDialog({ kind: "post", post })} onShowDay={(day) => { setAnchor(day); setView("semana"); }} />}
        {view === "lista" && <ListView from={range.from} days={LIST_DAYS} today={today} data={shown} nameOf={nameOf} onOpen={open} onOpenPost={(post) => setDialog({ kind: "post", post })} onCreate={() => create(today)} />}
      </div>

      <p className="ag-footer" data-testid="agenda-summary">
        {availability ? `Você está disponível: ${describeAvailability(availability)}.` : ""}
      </p>

      {dialog?.kind === "create" && availability && <AgendaEventDialog key={`new-${dialog.date}-${dialog.startMinutes ?? ""}`} date={dialog.date} startMinutes={dialog.startMinutes} availability={availability} workspaces={[...names].map(([id, name]) => ({ id, name }))} defaultWorkspace={workspace ?? ""} nameOf={nameOf} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && editing && availability && <AgendaEventDialog key={editing.id} event={editing} date={editing.start.slice(0, 10)} availability={availability} workspaces={[...names].map(([id, name]) => ({ id, name }))} defaultWorkspace="" nameOf={nameOf} onClose={() => setDialog(null)} />}
      {dialog?.kind === "post" && <PostDialog post={dialog.post} onClose={() => setDialog(null)} />}
      {dialog?.kind === "availability" && availability && <AvailabilityDialog availability={availability} onClose={() => setDialog(null)} />}
    </section>
  );
}

function shiftMonthKey(month: { year: number; month: number }, delta: number): string {
  const next = shiftMonth(month, delta);
  return `${next.year}-${String(next.month + 1).padStart(2, "0")}`;
}

function LayerToggle({ label, swatch, on, onChange, testId }: { label: string; swatch: "mine" | "posts" | "routines"; on: boolean; onChange: (on: boolean) => void; testId: string }) {
  return (
    <button type="button" className={`ag-layer${on ? " ag-layer--on" : ""}`} aria-pressed={on} onClick={() => onChange(!on)} data-testid={testId}>
      <span className={`ag-swatch ag-swatch--${swatch}`} aria-hidden="true" />
      {label}
    </button>
  );
}
