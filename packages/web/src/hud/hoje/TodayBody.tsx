import type { TodayAgendaItem, TodayDone, TodayProject, TodayView } from "@cyno/shared";
import { useState, type ReactNode } from "react";
import { useWorkPanelStore } from "../../agentWork/workPanelStore";
import { openProject } from "../../pages/work/openProject";
import { useForYouFocus } from "../../store/forYouFocus";
import { useGestaoFocus } from "../../store/gestaoFocus";
import { openMedia } from "../../store/navTargets";
import { useNavStore } from "../../store/navStore";
import { useAgentLogStore } from "../../store/agentLogStore";
import { useOfficeStore } from "../../store/officeStore";
import { percent } from "../../ui/format";
import {
  blockLabel,
  changeLabel,
  doneKindLabel,
  EMPTY_TEXT,
  elapsedLabel,
  goalLabel,
  goalStatusLabel,
  goalTone,
  hourLabel,
  routineTimeline,
  SECTION_TITLES,
  sectionCounts,
  stageLabel,
  TODAY_SECTIONS,
  trimTimeline,
  waitingLabel,
  withLivePhrases,
  type NowRowView,
  withLiveProgress,
  workedLabel,
  type RoutineRow,
  type TodaySectionId,
} from "./todayView";

/** Para onde cada linha leva. Na página do Cyno (vários workspaces) troca de workspace antes de abrir. */
function enter(workspace: string | undefined): void {
  if (workspace && workspace !== useNavStore.getState().workspaceId) useNavStore.getState().setWorkspace(workspace);
}
const go = {
  project: (workspace: string | undefined, id: string) => {
    enter(workspace);
    openProject(id);
  },
  routine: (workspace: string | undefined, id: string) => {
    enter(workspace);
    useGestaoFocus.getState().open(id);
  },
  forYou: (workspace: string | undefined, id?: string) => {
    enter(workspace);
    if (id) useForYouFocus.getState().open(id);
    else useNavStore.getState().go("para-voce");
  },
  agenda: () => useNavStore.getState().go("agenda"),
  media: (workspace: string | undefined) => {
    openMedia(workspace);
  },
  agent: (workspace: string | undefined, agentId: string) => {
    enter(workspace);
    useWorkPanelStore.getState().openAgent(agentId);
  },
};

type Tone = "run" | "ok" | "warn" | "danger" | "muted" | "queue";

function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span className={`hj-dot hj-dot--${tone}${pulse ? " hj-dot--pulse" : ""}`} aria-hidden="true" />;
}

function Chevron() {
  return (
    <svg className="hj-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function Row({ onOpen, lead, children, right, testId, tone }: { onOpen: () => void; lead?: ReactNode; children: ReactNode; right?: ReactNode; testId?: string; tone?: Tone }) {
  return (
    <li className={`hj-row${tone ? ` hj-row--${tone}` : ""}`} {...(testId ? { "data-testid": testId } : {})}>
      <button type="button" className="hj-row__open" onClick={onOpen}>
        {lead}
        <span className="hj-row__text">{children}</span>
        {right}
        <Chevron />
      </button>
    </li>
  );
}

function Section({ id, count, empty, hideEmpty, children }: { id: TodaySectionId; count: number; empty: string; hideEmpty: boolean; children: ReactNode }) {
  if (count === 0) {
    if (hideEmpty) return null;
    return (
      <section className="hj-section hj-section--empty" aria-label={SECTION_TITLES[id]} data-testid={`hoje-${id}`} data-empty="true">
        <h3 className="hj-section__title">{SECTION_TITLES[id]}</h3>
        <p className="hj-section__empty">{empty}</p>
      </section>
    );
  }
  return (
    <section className="hj-section" aria-label={SECTION_TITLES[id]} data-testid={`hoje-${id}`}>
      <h3 className="hj-section__title">
        {SECTION_TITLES[id]}
        <span className="hj-section__count">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function NowRow({ row, now, workspace }: { row: NowRowView; now: Date; workspace: string | undefined }) {
  const percentLabel = row.progress !== undefined ? percent(row.progress) : undefined;
  return (
    <Row
      testId={`hoje-now-${row.taskId}`}
      tone={row.queued ? "queue" : "run"}
      onOpen={() => (row.routineId ? go.routine(workspace, row.routineId) : row.projectId ? go.project(workspace, row.projectId) : row.agentId ? go.agent(workspace, row.agentId) : go.forYou(workspace))}
      lead={<Dot tone={row.queued ? "queue" : "run"} pulse={!row.queued} />}
      right={<span className="hj-row__meta">{row.queued ? "na fila" : (percentLabel ?? elapsedLabel(row.since, now))}</span>}
    >
      <span className="hj-row__title">
        {row.agent && <b className="hj-agent">{row.agent}</b>} {row.title}
      </span>
      {(row.projectTitle || row.routineId || ((row.phrase || row.message) && !row.queued)) && (
        <span className="hj-row__sub">
          {row.projectTitle && <span className="hj-tag">{row.projectTitle}</span>}
          {row.routineId && <span className="hj-tag hj-tag--routine">rotina</span>}
          {row.phrase && !row.queued ? (
            <span className="hj-row__note hj-row__phrase" data-testid={`hoje-now-phrase-${row.taskId}`}>
              <span aria-hidden="true">{row.phrase.icon}</span> {row.phrase.text}
            </span>
          ) : (
            row.message && !row.queued && <span className="hj-row__note">{row.message}</span>
          )}
        </span>
      )}
      {row.progress !== undefined && !row.queued && (
        <span className="hj-bar" role="img" aria-label={`Progresso: ${percentLabel}`}>
          <span className="hj-bar__fill" style={{ width: `${Math.round(row.progress * 100)}%` }} />
        </span>
      )}
    </Row>
  );
}

function ProjectRow({ project, workspace }: { project: TodayProject; workspace: string | undefined }) {
  const hours = workedLabel(project);
  const tone: Tone = project.blocked ? (project.blocked.type === "falha" ? "danger" : "warn") : project.status === "pausado" ? "muted" : "run";
  return (
    <Row testId={`hoje-project-${project.id}`} tone={tone} onOpen={() => go.project(workspace, project.id)} lead={<Dot tone={tone} />}>
      <span className="hj-row__title">{project.title}</span>
      <span className="hj-row__sub">
        <span>{stageLabel(project)}</span>
        {project.next && <span className="hj-next">próximo: {project.next}</span>}
      </span>
      {(project.blocked || project.atRisk || project.deliveryWaiting || hours) && (
        <span className="hj-row__chips">
          {project.blocked && <span className={`hj-chip hj-chip--${project.blocked.type === "falha" ? "danger" : "warn"}`}>{blockLabel(project.blocked)}</span>}
          {project.atRisk && <span className="hj-chip hj-chip--danger">prazo em risco</span>}
          {project.deliveryWaiting && (
            <span className="hj-chip hj-chip--warn" data-testid={`hoje-delivery-${project.id}`}>
              Entrega da {project.deliveryWaiting.split(" · ")[0]} espera você
            </span>
          )}
          {hours && <span className="hj-chip">{hours} hoje</span>}
        </span>
      )}
    </Row>
  );
}

const ROUTINE_MARK: Record<RoutineRow["state"], { mark: string; tone: Tone }> = {
  ran: { mark: "✓", tone: "ok" },
  failed: { mark: "✕", tone: "danger" },
  running: { mark: "●", tone: "run" },
  upcoming: { mark: "○", tone: "muted" },
  skipped: { mark: "–", tone: "muted" },
};

function RoutineLine({ row, workspace }: { row: RoutineRow; workspace: string | undefined }) {
  const { mark, tone } = ROUTINE_MARK[row.state];
  return (
    <Row testId={`hoje-routine-${row.routineId}-${row.state}`} tone={tone} onOpen={() => go.routine(workspace, row.routineId)} lead={<span className={`hj-mark hj-mark--${tone}${row.state === "running" ? " hj-mark--pulse" : ""}`} aria-hidden="true">{mark}</span>}>
      <span className={`hj-row__title${row.state === "upcoming" ? " hj-row__title--soft" : ""}`}>{row.label}</span>
      {row.detail && <span className="hj-row__sub">{row.detail}</span>}
    </Row>
  );
}

/** As rotinas do dia numa lista só; o excesso (muitos horários) recolhe atrás de "Mostrar mais". */
function RoutineList({ rows, workspace }: { rows: RoutineRow[]; workspace: string | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const { rows: shown, hidden } = trimTimeline(rows, expanded);
  return (
    <>
      <ul className="hj-list">
        {shown.map((row) => (
          <RoutineLine key={row.key} row={row} workspace={workspace} />
        ))}
      </ul>
      {(hidden > 0 || expanded) && (
        <button type="button" className="hj-more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} data-testid="hoje-routines-more">
          {expanded ? "Mostrar menos" : `Mostrar mais ${hidden}`}
        </button>
      )}
    </>
  );
}

export function AgendaRow({ item, showWorkspace }: { item: TodayAgendaItem; showWorkspace: boolean }) {
  return (
    <Row testId={`hoje-agenda-${item.id}`} onOpen={() => go.agenda()} lead={<span className="hj-time">{hourLabel(item.start)}</span>} right={<span className="hj-row__meta">até {hourLabel(item.end)}</span>}>
      <span className="hj-row__title">{item.title}</span>
      {showWorkspace && item.workspaceName && <span className="hj-row__sub">{item.workspaceName}</span>}
    </Row>
  );
}

function DoneRow({ item, workspace }: { item: TodayDone; workspace: string | undefined }) {
  return (
    <Row
      testId={`hoje-done-${item.id}`}
      tone="ok"
      onOpen={() => (item.kind === "midia" ? go.media(workspace) : go.project(workspace, item.projectId ?? item.id))}
      lead={<span className="hj-mark hj-mark--ok" aria-hidden="true">✓</span>}
      right={<span className="hj-row__meta">{hourLabel(item.at)}</span>}
    >
      <span className="hj-row__title">{item.title}</span>
      <span className="hj-row__sub">
        {doneKindLabel(item)}
        {item.projectTitle ? ` · ${item.projectTitle}` : ""}
      </span>
      {item.headline && (
        <span className="hj-row__sub hj-row__delivery" data-testid={`hoje-done-headline-${item.id}`} title={item.summary}>
          {item.headline}
        </span>
      )}
    </Row>
  );
}

/**
 * O corpo do painel "Hoje" de um workspace: as seções do esboço, cada linha clicável. `workspace`
 * (página do Cyno) faz cada clique trocar de workspace antes de abrir; `hideEmpty` esconde as seções
 * sem nada (no painel lateral elas ficam recolhidas, com um texto curto).
 */
export function TodayBody({ view, now, workspace, hideEmpty = false, showAgenda = true }: { view: TodayView; now: Date; workspace?: string; hideEmpty?: boolean; showAgenda?: boolean }) {
  const progress = useOfficeStore((state) => state.progress);
  const logs = useAgentLogStore((state) => state.byAgent);
  const nowRows = withLivePhrases(workspace ? view.now : withLiveProgress(view.now, progress), logs, now.getTime());
  const counts = sectionCounts(view);
  const routines = routineTimeline(view.routines);
  const only = (id: TodaySectionId) => (id === "agenda" && !showAgenda ? 0 : counts[id]);
  const sections: Record<TodaySectionId, ReactNode> = {
    agora: <ul className="hj-list">{nowRows.map((row) => <NowRow key={row.taskId} row={row} now={now} workspace={workspace} />)}</ul>,
    projetos: <ul className="hj-list">{view.projects.map((project) => <ProjectRow key={project.id} project={project} workspace={workspace} />)}</ul>,
    rotinas: <RoutineList rows={routines} workspace={workspace} />,
    acompanhamentos: (
      <ul className="hj-list">
        {view.changes.map((change) => (
          <Row key={`${change.routineId}-${change.item}-${change.at}`} testId={`hoje-change-${change.routineId}`} tone={change.alert ? "warn" : undefined} onOpen={() => go.routine(workspace, change.routineId)} lead={<Dot tone={change.alert ? "warn" : "ok"} />}>
            <span className="hj-row__title">{changeLabel(change)}</span>
            <span className="hj-row__sub">{change.title}</span>
          </Row>
        ))}
      </ul>
    ),
    metas: (
      <ul className="hj-list">
        {view.goals.map((goal) => {
          const tone = goalTone(goal);
          return (
            <Row key={goal.routineId} testId={`hoje-goal-${goal.routineId}`} tone={tone} onOpen={() => go.routine(workspace, goal.routineId)} lead={<Dot tone={tone} />} right={<span className={`hj-chip hj-chip--${tone}`}>{goalStatusLabel(goal)}</span>}>
              <span className="hj-row__title">{goalLabel(goal)}</span>
              <span className="hj-row__sub">{goal.blocked ? `parada: ${goal.blocked}` : goal.period === "week" ? "na semana" : "no mês"}</span>
            </Row>
          );
        })}
      </ul>
    ),
    agenda: <ul className="hj-list">{view.agenda.map((item) => <AgendaRow key={item.id} item={item} showWorkspace={false} />)}</ul>,
    feito: <ul className="hj-list">{view.done.map((item) => <DoneRow key={item.id} item={item} workspace={workspace} />)}</ul>,
  };
  return (
    <>
      {TODAY_SECTIONS.map((id) => (
        <Section key={id} id={id} count={only(id)} empty={EMPTY_TEXT[id]} hideEmpty={hideEmpty}>
          {sections[id]}
        </Section>
      ))}
    </>
  );
}

/** "Esperando você: 3 →" e os mais antigos; leva ao Para você do workspace. */
export function WaitingLine({ view, workspace, compact = false }: { view: Pick<TodayView, "waiting">; workspace?: string; compact?: boolean }) {
  const { count, oldest } = view.waiting;
  return (
    <div className="hj-waiting" data-testid="hoje-waiting" data-count={count}>
      <button type="button" className={`hj-waiting__main${count > 0 ? " hj-waiting__main--on" : ""}`} onClick={() => go.forYou(workspace ?? oldest[0]?.workspace)}>
        <span>{waitingLabel(count)}</span>
        {count > 0 && <span aria-hidden="true">→</span>}
      </button>
      {count > 0 && !compact && (
        <ul className="hj-waiting__list">
          {oldest.map((item) => (
            <li key={item.id}>
              <button type="button" className="hj-waiting__item" onClick={() => go.forYou(item.workspace ?? workspace, item.id)} title={item.title}>
                <span className="hj-waiting__title">{item.title}</span>
                <span className="hj-row__meta">{item.agent ? `${item.agent} · ` : ""}{hourLabel(item.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
