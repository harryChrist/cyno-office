import { isAvulsas, isProjectOpen, type Agent, type ForYouItem, type Project } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, describeError } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import {
  activeCount,
  ALL,
  collectEntries,
  facetOptions,
  filterEntries,
  FILTER_KEYS,
  FILTER_LABELS,
  flatten,
  GROUP_BYS,
  GROUP_LABELS,
  groupEntries,
  NO_TASK_FILTERS,
  parseTaskFilters,
  serializeTaskFilters,
  SORT_BYS,
  SORT_LABELS,
  useful,
  visibleRange,
  type FilterKey,
  type GroupBy,
  type Option,
  type SortBy,
  type TaskEntry,
  type TaskFilters,
} from "./allTasksView";
import { TaskPanel, itemsOfTask } from "./TaskPanel";
import { AssigneeCell, DueCell, PrioCell, SprintCell, type CellActions } from "./TaskTree";
import { TREE_STATUS_LABEL } from "./taskTreeView";
import { AvatarStack, PriorityFlag, StatusIcon } from "./treeParts";
import { useIsMobile } from "./useIsMobile";
import { useTaskActions } from "./useTaskActions";
import { WorkTabs } from "./WorkTabs";
import { workSub } from "./workRoute";
import "./allTasks.css";

type Props = {
  projects: readonly Project[];
  forYou: readonly ForYouItem[] | null;
  agents: ReadonlyMap<string, Agent>;
  workers: readonly Agent[];
  now: number;
  query: string;
  /** Painel aberto (do endereço). */
  panel: { projectId: string; ref: string } | null;
};

/** Altura fixa de cada item (a lista só desenha o que está à vista). */
const HEIGHTS = { desktop: { head: 34, row: 46 }, mobile: { head: 34, row: 82 } } as const;

const go = (route: Parameters<typeof workSub>[0], replace = false) => useNavStore.getState().go("trabalho", workSub(route), replace);

/** A aba "Todas as tarefas": a lista de todas as tarefas-folha dos projetos, com filtros, grupos e ordem no endereço. */
export function AllTasks({ projects, forYou, agents, workers, now, query, panel }: Props) {
  const mobile = useIsMobile();
  const loading = useOfficeStore((state) => state.office) === null;
  const filters = useMemo(() => parseTaskFilters(query), [query]);
  const nameOf = useCallback((id: string) => agents.get(id)?.name ?? id, [agents]);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  const setFilters = useCallback(
    (next: TaskFilters) => {
      go({ view: "tasks", query: serializeTaskFilters(next), ...(panel ? { projectId: panel.projectId, ref: panel.ref } : {}) }, true);
    },
    [panel],
  );

  const entries = useMemo(() => collectEntries(projects, now), [projects, now]);
  const shown = useMemo(() => filterEntries(entries, filters, nameOf), [entries, filters, nameOf]);
  const groups = useMemo(() => groupEntries(shown, filters.group, filters.sort, nameOf), [shown, filters.group, filters.sort, nameOf]);
  const items = useMemo(() => flatten(groups), [groups]);
  const options = useMemo(() => Object.fromEntries(FILTER_KEYS.map((key) => [key, facetOptions(entries, filters, key, nameOf)])) as Record<FilterKey, Option[]>, [entries, filters, nameOf]);

  const editable = useCallback((entry: TaskEntry) => isProjectOpen(entry.project) && entry.project.status !== "ajustando", []);
  const cellActions = useCallback(
    (projectId: string): CellActions => ({
      update: async (ref, body) => {
        setError(null);
        try {
          await api.updateProjectTask(projectId, ref, body);
          return true;
        } catch (caught) {
          setError(describeError(caught));
          return false;
        }
      },
      move: async (ref, body) => {
        setError(null);
        try {
          await api.moveProjectTask(projectId, ref, body);
          return true;
        } catch (caught) {
          setError(describeError(caught));
          return false;
        }
      },
    }),
    [],
  );
  const open = useCallback((entry: TaskEntry) => go({ view: "tasks", query, projectId: entry.project.id, ref: entry.task.ref }), [query]);

  const total = entries.length;
  const openPanel = panel ? { project: projects.find((project) => project.id === panel.projectId), ref: panel.ref } : null;
  const selectedKey = panel ? `${panel.projectId}:${panel.ref}` : null;

  return (
    <div className={`at${panel ? " at--panel" : ""}`} data-testid="all-tasks">
      <header className="page__header page__header--row">
        <div className="page__heading">
          <h2 id="page-title-trabalho" className="page__title">
            Projetos e tarefas
          </h2>
          <p className="page__subtitle">Todas as tarefas de todos os projetos, num lugar só. Clique numa tarefa para abrir.</p>
        </div>
      </header>
      <WorkTabs active="tarefas" />

      <TaskFilterBar filters={filters} onChange={setFilters} options={options} mobile={mobile} sheet={sheet} onSheet={setSheet} shownCount={shown.length} total={total} />
      <ErrorText testId="all-tasks-error">{error}</ErrorText>

      {loading ? (
        <p className="page__empty">Carregando as tarefas…</p>
      ) : shown.length === 0 ? (
        <div className="w-empty at-empty" data-testid="all-tasks-empty">
          {total === 0 ? (
            <>
              <p className="w-empty__title">Nenhuma tarefa ainda.</p>
              <p className="w-empty__text">As tarefas aparecem aqui assim que houver um projeto ou um pedido ao Maestro.</p>
            </>
          ) : (
            <>
              <p className="w-empty__title">Nenhuma tarefa com esses filtros.</p>
              <button type="button" className="ui-button ui-button--secondary" onClick={() => setFilters({ ...NO_TASK_FILTERS, group: filters.group, sort: filters.sort })} data-testid="all-tasks-clear-empty">
                Limpar os filtros
              </button>
            </>
          )}
        </div>
      ) : (
        <VirtualList items={items} mobile={mobile} agents={agents} workers={workers} selectedKey={selectedKey} editable={editable} cellActions={cellActions} onOpen={open} />
      )}

      {openPanel && <PanelHost project={openPanel.project} refName={openPanel.ref} projects={projects} forYou={forYou} agents={agents} workers={workers} now={now} query={query} />}
    </div>
  );
}

// ---------- A lista (só o que está à vista) ----------

type ListProps = {
  items: ReturnType<typeof flatten>;
  mobile: boolean;
  agents: ReadonlyMap<string, Agent>;
  workers: readonly Agent[];
  selectedKey: string | null;
  editable: (entry: TaskEntry) => boolean;
  cellActions: (projectId: string) => CellActions;
  onOpen: (entry: TaskEntry) => void;
};

function VirtualList({ items, mobile, agents, workers, selectedKey, editable, cellActions, onOpen }: ListProps) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const heights = mobile ? HEIGHTS.mobile : HEIGHTS.desktop;

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setView({ top: node.scrollTop, height: node.clientHeight || 600 });
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  // Lista nova (outro filtro): volta ao topo.
  const first = items[0]?.key;
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
  }, [first, items.length]);

  const range = useMemo(() => visibleRange(items, heights, view.top, view.height), [items, heights, view.top, view.height]);
  const slice = items.slice(range.start, range.end);
  const rows = items.filter((item) => item.kind === "row").length;

  return (
    <div className="at-list" data-testid="all-tasks-list" data-total={rows}>
      {!mobile && (
        <div className="at-head" aria-hidden="true">
          <span>Tarefa</span>
          <span>Estado</span>
          <span>Responsáveis</span>
          <span>Sprint</span>
          <span>Data</span>
          <span>Prioridade</span>
        </div>
      )}
      <div className="at-scroll" ref={box} data-testid="all-tasks-scroll">
        <div className="at-space" style={{ height: range.total }}>
          <ul className="at-rows" style={{ transform: `translateY(${range.offset}px)` }} role="list" data-rendered={slice.length}>
            {slice.map((item) =>
              item.kind === "head" ? (
                <li key={item.key} className="at-group" style={{ height: heights.head }} data-testid="all-tasks-group">
                  <span className="at-group__label">{item.label}</span>
                  <span className="at-group__count">{item.count}</span>
                </li>
              ) : (
                <TaskLine key={item.key} entry={item.entry} mobile={mobile} height={heights.row} agents={agents} workers={workers} selected={selectedKey === item.entry.key} editable={editable(item.entry)} actions={cellActions(item.entry.project.id)} onOpen={onOpen} />
              ),
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

type LineProps = {
  entry: TaskEntry;
  mobile: boolean;
  height: number;
  agents: ReadonlyMap<string, Agent>;
  workers: readonly Agent[];
  selected: boolean;
  editable: boolean;
  actions: CellActions;
  onOpen: (entry: TaskEntry) => void;
};

function TaskLine({ entry, mobile, height, agents, workers, selected, editable, actions, onOpen }: LineProps) {
  const { task, project } = entry;
  const cellRow = { ref: task.ref, node: task, assignees: entry.assignees.slice(0, 3), moreAssignees: Math.max(0, entry.assignees.length - 3), due: entry.due, carried: task.carriedFrom ? "x" : undefined, status: entry.status };
  const editableCells = editable && !mobile && !entry.finished;
  const hasSprints = (project.sprints?.length ?? 0) > 0 && !isAvulsas(project);
  const key = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(entry);
    }
  };
  const sprintText = entry.sprint ? entry.sprint.id : null;
  return (
    <li
      className={`at-row${selected ? " is-selected" : ""}${entry.finished ? " is-done" : ""}`}
      style={{ height }}
      tabIndex={0}
      onClick={() => onOpen(entry)}
      onKeyDown={key}
      data-testid={`all-task-${project.id}-${task.ref}`}
      data-status={entry.status}
    >
      <div className="at-name">
        <StatusIcon status={entry.status} />
        <span className="at-name__text">
          <span className="at-title" title={task.title}>
            {task.title}
          </span>
          <span className="at-path" title={entry.path}>
            {entry.path}
          </span>
        </span>
      </div>
      {mobile ? (
        <div className="at-meta">
          <span className={`at-state at-state--${entry.status}`}>{TREE_STATUS_LABEL[entry.status]}</span>
          <AvatarStack ids={cellRow.assignees} more={cellRow.moreAssignees} agents={agents} />
          {sprintText && <span className="tt-sprint">{sprintText}</span>}
          {entry.due && <span className={`tt-due at-due at-due--${entry.due.tone}`}>{entry.due.label}</span>}
          <PriorityFlag priority={task.priority} label={false} />
        </div>
      ) : (
        <>
          <div className="at-cell">
            <span className={`at-state at-state--${entry.status}`}>{TREE_STATUS_LABEL[entry.status]}</span>
          </div>
          <div className="at-cell" onClick={editableCells ? (event) => event.stopPropagation() : undefined} data-testid={`all-resp-${project.id}-${task.ref}`}>
            {editableCells ? <AssigneeCell row={cellRow} agents={agents} workers={workers} actions={actions} /> : <AvatarStack ids={cellRow.assignees} more={cellRow.moreAssignees} agents={agents} />}
          </div>
          <div className="at-cell" onClick={editableCells && hasSprints ? (event) => event.stopPropagation() : undefined} data-testid={`all-sprint-${project.id}-${task.ref}`}>
            {editableCells && hasSprints ? <SprintCell row={cellRow} project={project} actions={actions} /> : sprintText ? <span className="tt-sprint">{sprintText}</span> : <span className="tt-none">—</span>}
          </div>
          <div className={`at-cell at-due${entry.due ? ` at-due--${entry.due.tone}` : ""}`} onClick={editableCells ? (event) => event.stopPropagation() : undefined} data-testid={`all-due-${project.id}-${task.ref}`}>
            {editableCells ? <DueCell row={cellRow} actions={actions} /> : entry.due ? <span className="tt-due" title={entry.due.title}>{entry.due.label}</span> : <span className="tt-none">—</span>}
          </div>
          <div className="at-cell" onClick={editableCells ? (event) => event.stopPropagation() : undefined} data-testid={`all-prio-${project.id}-${task.ref}`}>
            {editableCells ? <PrioCell row={cellRow} actions={actions} /> : <PriorityFlag priority={task.priority} />}
          </div>
        </>
      )}
    </li>
  );
}

// ---------- Filtros ----------

type BarProps = {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  options: Record<FilterKey, Option[]>;
  mobile: boolean;
  sheet: boolean;
  onSheet: (open: boolean) => void;
  shownCount: number;
  total: number;
};

/** Um menu compacto: o botão mostra o valor escolhido ("Estado: Em andamento"); as contagens só aparecem com o menu aberto. */
function Menu({ label, options, value, onChange, testId, counts = true, off = ALL, showValue = false }: { label: string; options: readonly Option[]; value: string; onChange: (value: string) => void; testId: string; counts?: boolean; off?: string; showValue?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const current = options.find((option) => option.value === value);
  const on = value !== off && current !== undefined;
  return (
    <div className="at-fmenu" ref={box}>
      <button type="button" className={`at-fmenu__btn${on ? " at-fmenu__btn--on" : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={testId}>
        {on || (showValue && current) ? `${label}: ${current!.label}` : label}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" className="at-fmenu__chev">
          <path d="M2 4l4 4 4-4z" />
        </svg>
      </button>
      {open && (
        <ul className="at-fmenu__list" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li key={option.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="at-fmenu__opt"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                data-testid={`${testId}-${option.value}`}
              >
                <span>{option.label}</span>
                {counts && <span className="at-fmenu__n">{option.count}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const GROUP_OPTIONS: Option[] = GROUP_BYS.map((value) => ({ value, label: GROUP_LABELS[value], count: 0 }));
const SORT_OPTIONS: Option[] = SORT_BYS.map((value) => ({ value, label: SORT_LABELS[value], count: 0 }));

function TaskFilterBar({ filters, onChange, options, mobile, sheet, onSheet, shownCount }: BarProps) {
  const set = (patch: Partial<TaskFilters>) => onChange({ ...filters, ...patch });
  const shownKeys = FILTER_KEYS.filter((key) => useful(options[key], filters[key]));
  const on = FILTER_KEYS.filter((key) => filters[key] !== ALL);
  const count = activeCount(filters);
  const clear = () => onChange({ ...NO_TASK_FILTERS, group: filters.group, sort: filters.sort, showDone: filters.showDone });
  const labelOf = (key: FilterKey) => options[key].find((option) => option.value === filters[key])?.label ?? filters[key];

  const search = (
    <label className="at-search">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input className="ui-input" type="search" value={filters.q} onChange={(event) => set({ q: event.currentTarget.value })} placeholder="Buscar tarefa" aria-label="Buscar tarefa" data-testid="all-tasks-search" />
    </label>
  );
  const shortcuts = (
    <>
      <button type="button" className="at-pill" aria-pressed={filters.waiting} onClick={() => set({ waiting: !filters.waiting })} data-testid="all-tasks-waiting">
        Esperando você
      </button>
      <button type="button" className="at-pill" aria-pressed={filters.late} onClick={() => set({ late: !filters.late })} data-testid="all-tasks-late">
        Atrasadas
      </button>
    </>
  );
  const done = (
    <label className="at-switch">
      <input type="checkbox" role="switch" checked={filters.showDone} onChange={(event) => set({ showDone: event.currentTarget.checked })} data-testid="all-tasks-show-done" />
      <span className="at-switch__track" aria-hidden="true" />
      <span>Mostrar concluídas</span>
    </label>
  );

  return (
    <div className="at-bar" data-testid="all-tasks-filters">
      <div className="at-bar__row">
        {search}
        {!mobile && (
          <>
            {shownKeys.map((key) => (
              <Menu key={key} label={FILTER_LABELS[key]} options={options[key]} value={filters[key]} onChange={(value) => set({ [key]: value } as Partial<TaskFilters>)} testId={`all-tasks-filter-${key}`} />
            ))}
            {shortcuts}
            <span className="at-bar__spacer" />
            <Menu label="Agrupar" options={GROUP_OPTIONS} value={filters.group} onChange={(value) => set({ group: value as GroupBy })} testId="all-tasks-group-by" counts={false} off="nada" />
            <Menu label="Ordenar" options={SORT_OPTIONS} value={filters.sort} onChange={(value) => set({ sort: value as SortBy })} testId="all-tasks-sort" counts={false} off="prioridade" />
          </>
        )}
        {mobile && (
          <button type="button" className={`at-fmenu__btn${count > 0 ? " at-fmenu__btn--on" : ""}`} onClick={() => onSheet(true)} data-testid="all-tasks-filters-open">
            Filtros{count > 0 ? ` (${count})` : ""}
          </button>
        )}
      </div>
      {(
        <div className="at-active" data-testid="all-tasks-active">
          <span className="at-active__count" data-testid="all-tasks-count">
            {shownCount === 1 ? "1 tarefa" : `${shownCount} tarefas`}
          </span>
          {on.map((key) => (
            <button key={key} type="button" className="at-chip" onClick={() => set({ [key]: ALL } as Partial<TaskFilters>)} aria-label={`Tirar o filtro ${FILTER_LABELS[key]}: ${labelOf(key)}`} data-testid={`all-tasks-chip-${key}`}>
              {FILTER_LABELS[key]}: {labelOf(key)}
              <span aria-hidden="true">×</span>
            </button>
          ))}
          {filters.waiting && (
            <button type="button" className="at-chip" onClick={() => set({ waiting: false })} aria-label="Tirar o filtro Esperando você">
              Esperando você <span aria-hidden="true">×</span>
            </button>
          )}
          {filters.late && (
            <button type="button" className="at-chip" onClick={() => set({ late: false })} aria-label="Tirar o filtro Atrasadas">
              Atrasadas <span aria-hidden="true">×</span>
            </button>
          )}
          {count > 0 && (
            <button type="button" className="ui-link" onClick={clear} data-testid="all-tasks-clear">
              Limpar
            </button>
          )}
          {!mobile && <span className="at-bar__spacer" />}
          {!mobile && done}
        </div>
      )}
      {sheet && (
        <div className="at-sheet" role="dialog" aria-label="Filtros" data-testid="all-tasks-sheet">
          <button type="button" className="at-sheet__backdrop" aria-label="Fechar filtros" onClick={() => onSheet(false)} />
          <div className="at-sheet__panel">
            <h3 className="at-sheet__title">Filtros</h3>
            {shownKeys.map((key) => (
              <label key={key} className="at-sheet__field">
                <span>{FILTER_LABELS[key]}</span>
                <select className="ui-input" value={filters[key]} onChange={(event) => set({ [key]: event.currentTarget.value } as Partial<TaskFilters>)}>
                  {options[key].map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="at-sheet__field">
              <span>Agrupar por</span>
              <select className="ui-input" value={filters.group} onChange={(event) => set({ group: event.currentTarget.value as GroupBy })}>
                {GROUP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="at-sheet__field">
              <span>Ordenar por</span>
              <select className="ui-input" value={filters.sort} onChange={(event) => set({ sort: event.currentTarget.value as SortBy })}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="at-sheet__pills">{shortcuts}</div>
            {done}
            <div className="at-sheet__actions">
              <button type="button" className="ui-button ui-button--secondary" onClick={clear}>
                Limpar
              </button>
              <button type="button" className="ui-button" onClick={() => onSheet(false)}>
                Pronto
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- O painel da tarefa ----------

type PanelHostProps = { project: Project | undefined; refName: string; projects: readonly Project[]; forYou: readonly ForYouItem[] | null; agents: ReadonlyMap<string, Agent>; workers: readonly Agent[]; now: number; query: string };

function PanelHost({ project, refName, forYou, agents, workers, now, query }: PanelHostProps) {
  if (!project) return null;
  const task = project.tasks.find((candidate) => candidate.ref === refName && !candidate.archived);
  if (!task) return null;
  return <PanelBody key={`${project.id}:${task.ref}`} project={project} task={task} forYou={forYou} agents={agents} workers={workers} now={now} query={query} />;
}

function PanelBody({ project, task, forYou, agents, workers, now, query }: { project: Project; task: Project["tasks"][number]; forYou: readonly ForYouItem[] | null; agents: ReadonlyMap<string, Agent>; workers: readonly Agent[]; now: number; query: string }) {
  const actions = useTaskActions(project.id);
  const progress = useOfficeStore((state) => state.progress);
  const office = useOfficeStore((state) => state.office);
  const [converting, setConverting] = useState<string | null>(null);
  const close = useCallback(() => go({ view: "tasks", query }), [query]);
  const select = useCallback((ref: string) => go({ view: "tasks", query, projectId: project.id, ref }), [project.id, query]);
  return (
    <>
      <TaskPanel
        project={project}
        task={task}
        agents={agents}
        workers={workers}
        items={itemsOfTask(project, task, forYou)}
        works={office?.tasks ?? []}
        progress={progress}
        now={now}
        editable={isProjectOpen(project) && project.status !== "ajustando"}
        avulsa={isAvulsas(project)}
        actions={actions}
        onSelect={select}
        onClose={close}
        onConvert={(ref) => setConverting(ref)}
      />
      {converting && (
        <ConfirmDialog
          title="Transformar em projeto?"
          message={<p>A tarefa vira um projeto de uma tarefa só, com o mesmo agente e o que já foi feito. Aí dá para pausar, definir o ritmo e ligar o modo Automático.</p>}
          confirmLabel="Transformar em projeto"
          pendingLabel="Transformando…"
          tone="success"
          onConfirm={async () => {
            const created = await actions.toProject(converting);
            if (created) useNavStore.getState().go("trabalho", workSub({ view: "project", projectId: created.id, tab: "tarefas", ref: "T1" }), true);
          }}
          onClose={() => setConverting(null)}
          testId="all-tasks-convert-dialog"
        />
      )}
    </>
  );
}
