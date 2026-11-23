import { isAvulsas, isProjectOpen, PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, type Agent, type ForYouItem, type Project, type UnitProgress } from "@cyno/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForYouFocus } from "../../store/forYouFocus";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { ConfirmDialog, ErrorText, Modal, ProgressBar, Switch } from "../../ui/widgets";
import { JointPartPanel } from "../joint/JointCard";
import { ApprovalCard } from "./ApprovalCard";
import { AvulsasCleanupDialog } from "./AvulsasCleanupDialog";
import { DeleteAvulsaTaskDialog, DeleteProjectDialog, DeleteTaskNodeDialog } from "./DeleteDialogs";
import { ModeCard } from "./ModeCard";
import { PlanDecision } from "./PlanDecision";
import { canDeleteProject } from "./projectDeleteView";
import { buildProjectIndex, type ProjectIndex } from "./projectIndex";
import { canCompleteProject, canReopenProject, COMPLETE_PROJECT_MESSAGE, COMPLETE_PROJECT_TITLE, isProjectEditable } from "./projectLifecycleView";
import { ProjectControls } from "./ProjectControls";
import { DueForm } from "./TaskTree";
import { ActivityTab, DeliveriesTab } from "./ProjectTabs";
import { SprintsTab } from "./SprintsTab";
import { TaskPanel, itemsOfTask } from "./TaskPanel";
import { TaskTree } from "./TaskTree";
import { WorkBoard } from "./WorkBoard";
import { useIsMobile } from "./useIsMobile";
import { useTaskActions, syncProjectResponse } from "./useTaskActions";
import { AvatarStack, Popover, PriorityFlag } from "./treeParts";
import { brasiliaShortDate } from "./workTime";
import { openText } from "./projectsView";
import { PACE_MAX_PER_DAY, paceBodyOf, paceFormOf, paceText, releaseSummaryText, todayKey, type PaceForm, type PaceStart } from "./releaseView";
import { PROJECT_TAB_LABELS, projectTabsFor, resolveProjectTab, workSub, type ProjectTab } from "./workRoute";
import { buildRows, buildWorkBoard, planCardCopy, projectApprovalBadge, projectState, unitProgressText, type WorkBoardColumn } from "./workView";
import { api } from "../../api/client";
import { PageTabs } from "../PageTabs";
import { useAsyncAction } from "../../ui/useAsyncAction";

const EMPTY_BOARD: WorkBoardColumn[] = [];

type ScreenProps = {
  project: Project | undefined;
  projectId: string;
  tab: ProjectTab;
  taskRef: string | undefined;
  agents: ReadonlyMap<string, Agent>;
  workers: readonly Agent[];
  forYou: readonly ForYouItem[] | null;
  workspaceId: string | null;
  now: number;
};

const go = (projectId: string, tab: ProjectTab, ref?: string, replace = false) => useNavStore.getState().go("trabalho", workSub({ view: "project", projectId, tab, ...(ref ? { ref } : {}) }), replace);

/** A tela de um projeto: cabeçalho (nome, objetivo, pronto quando, modo, prazo, prioridade, agentes, pausar) e as abas. */
export function ProjectScreen({ project, projectId, tab, taskRef, agents, workers, forYou, workspaceId, now }: ScreenProps) {
  if (!project) return <MissingProject key={projectId} />;
  return <ProjectBody key={project.id} project={project} tab={tab} taskRef={taskRef} agents={agents} workers={workers} forYou={forYou} workspaceId={workspaceId} now={now} />;
}

/** Projeto que ainda não chegou (recém-criado: o evento do servidor leva um instante) ou que não existe. */
function MissingProject() {
  const loaded = useOfficeStore((state) => state.office) !== null;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="ps" data-testid="project-screen-missing">
      <BackButton />
      <div className="w-empty">
        <p className="w-empty__title">{loaded && waited ? "Projeto não encontrado." : "Carregando o projeto…"}</p>
        {loaded && waited && <p className="w-empty__text">Ele pode ter sido apagado, ou o endereço está errado.</p>}
      </div>
    </div>
  );
}

function BackButton() {
  return (
    <button type="button" className="ps-back" onClick={() => useNavStore.getState().go("trabalho")} data-testid="project-back">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 3L5 8l5 5" />
      </svg>
      Projetos
    </button>
  );
}

type BodyProps = Omit<ScreenProps, "project" | "projectId"> & { project: Project };

function ProjectBody({ project, tab, taskRef, agents, workers, forYou, workspaceId, now }: BodyProps) {
  const fixed = isAvulsas(project);
  const progress = useOfficeStore((state) => state.progress);
  const office = useOfficeStore((state) => state.office);
  const types = useOfficeStore((state) => state.forYouTypes);
  const actions = useTaskActions(project.id);
  const [view, setView] = useState<"lista" | "quadro">("lista");
  const [converting, setConverting] = useState<string | "projeto" | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deletingTask, setDeletingTask] = useState<{ ref: string; title: string } | null>(null);
  const index = useMemo(() => buildProjectIndex(project.tasks), [project.tasks]);
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  const askDelete = useCallback((ref: string) => {
    const title = indexRef.current.tree.byRef.get(ref)?.title ?? ref;
    setDeletingTask({ ref, title });
  }, []);
  const open = isProjectOpen(project);
  const editable = isProjectEditable(project);
  // O cabeçalho conta módulos de primeiro nível ("3 de 8 módulos"); sem módulo, tarefas ("12 de 40 tarefas").
  const unit = index.unitProgress;
  const agentIds = index.agentIds;
  const openCount = index.openLeafCount;
  const state = projectState(project);
  const planItem = useMemo(() => forYou?.find((item) => item.status === "pendente" && item.kind === "plano" && item.projectId === project.id), [forYou, project.id]);
  const pending = useMemo(
    () => (forYou ?? []).filter((item) => item.status === "pendente" && item.kind !== "plano" && (item.projectId === project.id || (item.taskId !== undefined && index.stepTaskIds.has(item.taskId)))),
    [forYou, project.id, index.stepTaskIds],
  );
  const effectiveTab = resolveProjectTab(tab, project);
  const visibleTabs = useMemo(() => projectTabsFor(project).map((id) => ({ id, label: PROJECT_TAB_LABELS[id] })), [project]);
  useEffect(() => {
    if (tab !== effectiveTab) go(project.id, effectiveTab, taskRef, true);
  }, [project.id, tab, effectiveTab, taskRef]);
  const selected = taskRef ? index.tree.byRef.get(taskRef) : undefined;
  const select = useCallback((ref: string) => go(project.id, "tarefas", ref), [project.id]);
  const closePanel = useCallback(() => go(project.id, effectiveTab), [project.id, effectiveTab]);
  const onConvertToTask = useCallback(() => setConverting("projeto"), []);
  const onCleanup = useCallback(() => setCleaning(true), []);
  const onDeleteProject = useCallback(() => setDeletingProject(true), []);
  const onConvertRow = useCallback((ref: string) => setConverting(ref), []);
  const works = office?.tasks ?? [];
  const planCard = planCardCopy(project);
  const today = todayKey(now);

  // Quadro: só calcula quando a visão Quadro está aberta (na visão Lista não percorre as folhas nem reage ao relógio).
  const board = useMemo(() => {
    if (effectiveTab !== "tarefas" || view !== "quadro") return EMPTY_BOARD;
    const flat: Project = { ...project, tasks: [...index.leaves] };
    return buildWorkBoard(buildRows([flat], forYou, new Date(now)));
  }, [effectiveTab, view, project, index.leaves, forYou, now]);
  const boardAgents = agents;

  const convert = async (ref: string) => {
    const created = await actions.toProject(ref);
    if (created) go(created.id, "tarefas", "T1", true);
  };

  return (
    <div className={`ps${selected && effectiveTab === "tarefas" ? " ps--panel" : ""}`} data-testid="project-screen" data-project-id={project.id}>
      <BackButton />
      <ProjectHeader
        project={project}
        index={index}
        fixed={fixed}
        editable={editable}
        stateLabel={state.label}
        stateTone={state.tone}
        unit={unit}
        openCount={openCount}
        agentIds={agentIds}
        agents={agents}
        waiting={pending.length}
        today={today}
        onConvertToTask={onConvertToTask}
        onCleanup={onCleanup}
        onDelete={onDeleteProject}
      />
      <PageTabs
        flush
        label="Seções do projeto"
        tabs={visibleTabs}
        active={effectiveTab}
        onSelect={(id) => go(project.id, id)}
        testIdPrefix="project-tab"
        trailing={
          effectiveTab === "tarefas" ? (
            <div className="w-seg" role="group" aria-label="Visão das tarefas">
              <button type="button" aria-pressed={view === "lista"} onClick={() => setView("lista")} data-testid="work-view-lista">
                Lista
              </button>
              <button type="button" aria-pressed={view === "quadro"} onClick={() => setView("quadro")} data-testid="work-view-quadro">
                Quadro
              </button>
            </div>
          ) : undefined
        }
      />

      <div className="ps-content" role="tabpanel">
        {effectiveTab === "tarefas" && (
          <>
            {project.status === "ajustando" && <p className="w-notice">O Maestro está ajustando o plano{project.feedback ? `: “${project.feedback}”` : "."} Espere ele terminar para mexer nas tarefas.</p>}
            {project.status === "proposto" && (
              <section className="w-plan" data-testid="work-plan-card">
                <h3 className="w-plan__title">{planCard.title}</h3>
                <p className="w-plan__text">{planCard.text}</p>
                <PlanDecision plan={project} compact />
                {planItem && (
                  <button type="button" className="ui-link" onClick={() => useForYouFocus.getState().open(planItem.id)}>
                    Abrir em Aprovações
                  </button>
                )}
              </section>
            )}
            {project.origin === "cyno" && project.brief && (
              <details className="w-cyno__brief" data-testid="work-cyno-brief">
                <summary>Briefing do Cyno</summary>
                <pre className="w-cyno__brief-text">{project.brief}</pre>
              </details>
            )}
            <JointPartPanel project={project} />
            {pending.length > 0 && (
              <details className="ps-wait" data-testid="project-waiting">
                <summary>
                  Esperando você <span className="w-section__count">{pending.length}</span>
                  <span className="ps-wait__hint">aprovar ou recusar aqui mesmo</span>
                </summary>
                <div className="w-approvals ps-approvals">
                  {pending.map((item) => (
                    <ApprovalCard key={item.id} item={item} types={types} agentName={agents.get(item.agentId)?.name} now={now} />
                  ))}
                </div>
              </details>
            )}
            {view === "lista" ? (
              <>
                {fixed && (
                  <p className="ps-note" data-testid="avulsas-note">
                    As tarefas avulsas chegam pelo Maestro, uma por pedido simples. Para criar à mão, faça um projeto ou peça ao Maestro.
                  </p>
                )}
                <TaskTree
                  project={project}
                  index={index}
                  agents={agents}
                  workers={workers}
                  workspaceId={workspaceId}
                  now={now}
                  selectedRef={selected?.ref}
                  onSelect={select}
                  editable={editable}
                  canCreate={!fixed}
                  actions={actions}
                  onDelete={askDelete}
                  {...(fixed ? { onConvert: onConvertRow } : {})}
                />
              </>
            ) : (
              <WorkBoard columns={board} agents={boardAgents} now={now} onOpenCard={(card) => select(card.task.ref)} onOpenProject={() => document.querySelector('[data-testid="project-header"]')?.scrollIntoView({ block: "start", behavior: "smooth" })} />
            )}
          </>
        )}
        {effectiveTab === "sprints" && <SprintsTab project={project} agents={agents} editable={open && editable && !fixed} fixed={fixed} now={now} onOpenTask={select} />}
        {effectiveTab === "entregas" && <DeliveriesTab project={project} agents={agents} onOpenTask={select} />}
        {effectiveTab === "atividade" && <ActivityTab project={project} agents={agents} />}
      </div>

      {selected && effectiveTab === "tarefas" && (
        <TaskPanel
          key={`${project.id}:${selected.ref}`}
          project={project}
          task={selected}
          agents={agents}
          workers={workers}
          items={itemsOfTask(project, selected, forYou)}
          works={works}
          progress={progress}
          now={now}
          editable={editable}
          avulsa={fixed}
          actions={actions}
          onSelect={select}
          onClose={closePanel}
          onConvert={(ref) => void convert(ref)}
          onDelete={askDelete}
        />
      )}
      {cleaning && <AvulsasCleanupDialog onClose={() => setCleaning(false)} />}
      {deletingProject && (
        <DeleteProjectDialog
          project={project}
          onClose={() => setDeletingProject(false)}
          // Volta à lista de projetos (o projeto já saiu da lista pelo evento project:removed).
          onDeleted={() => useNavStore.getState().go("trabalho", "", true)}
        />
      )}
      {deletingTask && (
        fixed ? (
          <DeleteAvulsaTaskDialog
            projectId={project.id}
            taskRef={deletingTask.ref}
            title={deletingTask.title}
            onClose={() => setDeletingTask(null)}
            onDeleted={() => {
              if (taskRef === deletingTask.ref) closePanel();
            }}
          />
        ) : (
          <DeleteTaskNodeDialog
            project={project}
            taskRef={deletingTask.ref}
            onClose={() => setDeletingTask(null)}
            onDeleted={(refs) => {
              if (taskRef && refs.includes(taskRef)) closePanel();
            }}
          />
        )
      )}
      {converting && converting !== "projeto" && (
        <ConfirmDialog
          title="Transformar em projeto?"
          message={<p>A tarefa vira um projeto de uma tarefa só, com o mesmo agente e o que já foi feito. Aí dá para pausar, definir o ritmo e ligar o modo Automático.</p>}
          confirmLabel="Transformar em projeto"
          pendingLabel="Transformando…"
          tone="success"
          onConfirm={async () => {
            await convert(converting);
          }}
          onClose={() => setConverting(null)}
          testId="avulsas-convert-dialog"
        />
      )}
      {converting === "projeto" && (
        <ConfirmDialog
          title="Virar tarefa avulsa?"
          message={<p>O projeto some e a tarefa dele passa para as Avulsas (sem pausa, ritmo nem modo Automático). Só vale para projeto de uma tarefa só.</p>}
          confirmLabel="Virar tarefa avulsa"
          pendingLabel="Convertendo…"
          tone="success"
          onConfirm={async () => {
            const ok = await actions.toTask();
            if (!ok) throw new Error(actions.error ?? "Não deu para converter.");
            useNavStore.getState().go("trabalho", workSub({ view: "project", projectId: "avulsas", tab: "tarefas" }), true);
          }}
          onClose={() => setConverting(null)}
          testId="project-convert-dialog"
        />
      )}
    </div>
  );
}

type HeaderProps = {
  project: Project;
  index: ProjectIndex;
  fixed: boolean;
  editable: boolean;
  stateLabel: string;
  stateTone: string;
  unit: UnitProgress;
  openCount: number;
  agentIds: readonly string[];
  agents: ReadonlyMap<string, Agent>;
  waiting: number;
  today: string;
  onConvertToTask: () => void;
  /** Só no Avulsas: abre o "Limpar avulsas". */
  onCleanup: () => void;
  /** Só em projeto comum: abre "Apagar projeto". */
  onDelete: () => void;
};

const ProjectHeader = memo(function ProjectHeader({ project, index, fixed, editable, stateLabel, stateTone, unit, openCount, agentIds, agents, waiting, today, onConvertToTask, onCleanup, onDelete }: HeaderProps) {
  const { pending, error, run } = useAsyncAction();
  const mobile = useIsMobile();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [paceOpen, setPaceOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [doneWhen, setDoneWhen] = useState<string | null>(null);
  const open = isProjectOpen(project);
  const releaseSummary = fixed ? null : releaseSummaryText(project, index);
  const approvalBadge = fixed ? null : projectApprovalBadge(project.approval);
  const saveTitle = () => {
    const next = (title ?? "").trim();
    setTitle(null);
    if (next && next !== project.title) void run(() => api.updateProject(project.id, { title: next }));
  };
  const saveSummary = () => {
    const next = (summary ?? "").trim();
    setSummary(null);
    if (next !== (project.summary ?? "")) void run(() => api.updateProject(project.id, { summary: next || null }));
  };
  const saveDoneWhen = () => {
    const lines = (doneWhen ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    setDoneWhen(null);
    if (lines.join("\n") !== (project.doneWhen ?? []).map((item) => item.text).join("\n")) void run(() => api.updateProject(project.id, { doneWhen: lines }));
  };
  const planPending = project.status === "proposto" || project.status === "ajustando";
  const canEditHeader = editable && !fixed && !planPending;
  const counted = unit.total;
  const ratio = counted > 0 ? unit.done / counted : 0;
  const unitLabel = unit.unit === "modulos" ? "Módulos concluídos" : "Tarefas concluídas";
  const shown = agentIds.slice(0, 3);
  const detail = (
    <>
      {fixed ? (
          <p className="ps-head__text">Os pedidos simples do Maestro: uma tarefa por pedido, sem prazo próprio. Para pausar, definir ritmo ou ligar o modo Automático, transforme a tarefa em projeto.</p>
        ) : summary !== null ? (
          <textarea className="ui-input ps-head__summary" rows={2} value={summary} autoFocus aria-label="Objetivo do projeto" onChange={(event) => setSummary(event.currentTarget.value)} onBlur={saveSummary} data-testid="project-summary-input" />
        ) : project.summary ? (
          <p className="ps-head__text" data-testid="project-summary">
            {project.summary}
            {canEditHeader && (
              <button type="button" className="tp__edit" aria-label="Editar o objetivo" onClick={() => setSummary(project.summary ?? "")}>
                ✎
              </button>
            )}
          </p>
        ) : (
          canEditHeader && (
            <button type="button" className="ps-head__add" onClick={() => setSummary("")} data-testid="project-add-summary">
              + Objetivo do projeto
            </button>
          )
        )}

        {!fixed && (
          <div className="ps-done">
            {doneWhen !== null ? (
              <>
                <label className="ps-done__label" htmlFor="ps-done-input">
                  Pronto quando… <span className="ui-muted">· um item por linha</span>
                </label>
                <textarea id="ps-done-input" className="ui-input" rows={3} value={doneWhen} autoFocus onChange={(event) => setDoneWhen(event.currentTarget.value)} onBlur={saveDoneWhen} data-testid="project-donewhen-input" />
              </>
            ) : (project.doneWhen?.length ?? 0) > 0 ? (
              <>
                <p className="ps-done__label">
                  Pronto quando…
                  {canEditHeader && (
                    <button type="button" className="tp__edit" aria-label="Editar o pronto quando" onClick={() => setDoneWhen((project.doneWhen ?? []).map((item) => item.text).join("\n"))}>
                      ✎
                    </button>
                  )}
                </p>
                <ul className="w-done__list" data-testid="project-donewhen">
                  {project.doneWhen!.map((item) => (
                    <li key={item.id} className={item.met ? "w-done__item w-done__item--met" : "w-done__item"}>
                      <span aria-hidden="true">{item.met ? "✓" : "○"}</span>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              canEditHeader && (
                <button type="button" className="ps-head__add" onClick={() => setDoneWhen("")} data-testid="project-add-donewhen">
                  + Pronto quando…
                </button>
              )
            )}
          </div>
        )}

        <div className="ps-facts">
          <div className="ps-fact ps-fact--progress" data-testid="project-progress">
            <span className="ps-fact__label">Progresso</span>
            {fixed ? (
              <span className="ps-fact__value">{openText(openCount)}</span>
            ) : counted === 0 ? (
              <span className="ps-fact__value ui-muted">Sem tarefas</span>
            ) : (
              <span className="ps-fact__bar">
                <ProgressBar value={ratio} label={unitLabel} />
                <span className="ps-fact__value">{unitProgressText(unit)}</span>
              </span>
            )}
            {releaseSummary && (
              <span className="ps-fact__sub" data-testid="project-release-summary">
                {releaseSummary}
              </span>
            )}
          </div>
          <div className="ps-fact">
            <span className="ps-fact__label">Agentes</span>
            <span className="ps-fact__value">
              {shown.length === 0 ? <span className="ui-muted">Ninguém ainda</span> : <AvatarStack ids={shown} more={Math.max(0, agentIds.length - 3)} agents={agents} />}
              {shown.length > 0 && <span className="ps-fact__names">{shown.map((id) => agents.get(id)?.name ?? id).join(", ")}</span>}
            </span>
          </div>
          {!fixed && (
            <div className="ps-fact" data-testid="project-due">
              <span className="ps-fact__label">Prazo</span>
              {canEditHeader ? (
                <Popover
                  label="Prazo do projeto"
                  anchor={({ toggle, ref, open }) => (
                    <button type="button" ref={ref} className="tt-cellbtn tt-cellbtn--text ps-fact__btn" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} data-testid="project-due-btn">
                      {project.dueAt ? brasiliaShortDate(project.dueAt) : <span className="tt-none">+ Prazo</span>}
                    </button>
                  )}
                >
                  {(close) => <DueForm value={project.dueAt} onSave={(iso) => void run(() => api.updateProject(project.id, { dueAt: iso })).then(close)} />}
                </Popover>
              ) : (
                <span className="ps-fact__value">{project.dueAt ? brasiliaShortDate(project.dueAt) : "—"}</span>
              )}
            </div>
          )}
          {!fixed && (
            <div className="ps-fact" data-testid="project-priority">
              <span className="ps-fact__label">Prioridade</span>
              {canEditHeader ? (
                <Popover
                  label="Prioridade do projeto"
                  anchor={({ toggle, ref, open }) => (
                    <button type="button" ref={ref} className="tt-cellbtn tt-cellbtn--text ps-fact__btn" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} data-testid="project-priority-btn">
                      <PriorityFlag priority={project.priority} />
                    </button>
                  )}
                >
                  {(close) => (
                    <ul className="tt-pop__list">
                      {PROJECT_PRIORITIES.map((priority) => (
                        <li key={priority}>
                          <button type="button" className={`tt-pop__item${project.priority === priority ? " is-on" : ""}`} onClick={() => void run(() => api.updateProject(project.id, { priority })).then(close)}>
                            <PriorityFlag priority={priority} label={false} />
                            {PROJECT_PRIORITY_LABELS[priority]}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Popover>
              ) : (
                <span className="ps-fact__value">
                  <PriorityFlag priority={project.priority} />
                </span>
              )}
            </div>
          )}
          {!fixed && (
            <div className="ps-fact">
              <span className="ps-fact__label">Modo</span>
              <span className="ps-fact__value">{project.mode.kind === "automatico" ? "Automático" : "Pede OK"}</span>
            </div>
          )}
          {waiting > 0 && (
            <div className="ps-fact">
              <span className="ps-fact__label">Espera você</span>
              <span className="tt-badge tt-badge--wait">{waiting === 1 ? "1 aprovação ou pergunta" : `${waiting} aprovações ou perguntas`}</span>
            </div>
          )}
        </div>

        {!fixed && (
          <div className="ps-pace" data-testid="project-release-pace">
            <span className="ps-pace__text" data-testid="project-release-pace-text">
              {paceText(project, today, index)}
            </span>
            {canEditHeader && (
              <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => setPaceOpen(true)} data-testid="project-release-pace-btn">
                Mudar
              </button>
            )}
          </div>
        )}

        {!fixed && (
          <details className="ps-more" data-testid="project-more">
            <summary>Começa em, ritmo, modo Automático e cancelar</summary>
            {open && editable && !planPending && (
              <div className="ps-controls">
                <ProjectControls project={project} slim />
              </div>
            )}
            <ModeCard project={project} editable={open && editable && !planPending} />
          </details>
        )}
    </>
  );

  return (
    <header className={`ps-head${mobile ? " ps-head--compact" : ""}`} data-testid="project-header">
      <div className="ps-head__top">
        <div className="ps-head__titles">
          {title !== null ? (
            <input
              className="tt-input ps-head__titleinput"
              value={title}
              maxLength={120}
              autoFocus
              aria-label="Nome do projeto"
              onChange={(event) => setTitle(event.currentTarget.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveTitle();
                else if (event.key === "Escape") setTitle(null);
              }}
              data-testid="project-title-input"
            />
          ) : (
            <h2 className="ps-head__title" data-testid="project-title">
              {project.title}
              {canEditHeader && (
                <button type="button" className="tp__edit" aria-label="Renomear o projeto" onClick={() => setTitle(project.title)} data-testid="project-rename">
                  ✎
                </button>
              )}
            </h2>
          )}
          <div className="ps-head__tags">
            {fixed ? (
              <span className="ph-state ph-state--fixed" data-testid="project-state">
                Projeto fixo
              </span>
            ) : (
              <span className={`ph-state ph-state--${stateTone}`} data-testid="project-state">
                {stateLabel}
              </span>
            )}
            {project.origin === "cyno" && <span className="w-kind w-kind--cyno">Pedido pelo Cyno</span>}
            {project.mode.kind === "automatico" && <span className="w-kind w-kind--auto">Automático</span>}
            {approvalBadge && (
              <span className="w-kind w-kind--approval" title={approvalBadge.title} data-testid="project-approval-badge">
                {approvalBadge.label}
              </span>
            )}
          </div>
        </div>
        <div className="ps-head__actions">
          {open && canEditHeader && index.liveTasks.length === 1 && (
            <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onConvertToTask} data-testid="project-to-task">
              Virar tarefa avulsa
            </button>
          )}
          {canEditHeader && (project.status === "ativo" || project.status === "pausado") && (
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              disabled={pending}
              onClick={() => void run(async () => syncProjectResponse(await api.updateProject(project.id, { status: project.status === "pausado" ? "ativo" : "pausado" })))}
              data-testid="work-pause"
            >
              {project.status === "pausado" ? "Retomar" : "Pausar"}
            </button>
          )}
          {canCompleteProject(project) && (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => setCompleting(true)} data-testid="project-complete">
              Concluir projeto
            </button>
          )}
          {canReopenProject(project) && (
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              disabled={pending}
              onClick={() => void run(async () => syncProjectResponse(await api.reopenProject(project.id)))}
              data-testid="project-reopen"
            >
              {pending ? "Reabrindo…" : "Reabrir projeto"}
            </button>
          )}
          {fixed && (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onCleanup} data-testid="avulsas-cleanup">
              Limpar avulsas
            </button>
          )}
          {canDeleteProject(project) && (
            <button type="button" className="ui-button ui-button--ghost ui-button--small ps-head__delete" onClick={onDelete} data-testid="project-delete">
              Apagar projeto
            </button>
          )}
        </div>
      </div>

      <ErrorText testId="project-header-error">{error}</ErrorText>

      {mobile ? (
        <div className="ps-compact" data-testid="project-compact">
          {!fixed && counted > 0 && (
            <span className="ps-compact__progress" data-testid="project-progress-compact">
              <ProgressBar value={ratio} label={unitLabel} />
              <span className="ps-fact__value">{unitProgressText(unit)}</span>
              {releaseSummary && (
                <span className="ps-fact__sub" data-testid="project-release-summary-compact">
                  {releaseSummary}
                </span>
              )}
            </span>
          )}
          {fixed && <span className="ps-fact__value">{openText(openCount)}</span>}
          <button type="button" className="ps-compact__toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)} data-testid="project-details-toggle">
            Detalhes
            <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" style={{ transform: detailsOpen ? "rotate(90deg)" : undefined }}>
              <path d="M4 2l5 4-5 4z" />
            </svg>
          </button>
        </div>
      ) : null}
      {mobile && !detailsOpen ? null : detail}
      {paceOpen && <ReleasePaceDialog project={project} today={today} onClose={() => setPaceOpen(false)} />}
      {completing && (
        <ConfirmDialog
          title={COMPLETE_PROJECT_TITLE}
          message={<p>{COMPLETE_PROJECT_MESSAGE}</p>}
          confirmLabel="Concluir projeto"
          pendingLabel="Concluindo…"
          tone="success"
          onConfirm={async () => {
            syncProjectResponse(await api.completeProject(project.id));
          }}
          onClose={() => setCompleting(false)}
          testId="project-complete-dialog"
        />
      )}
    </header>
  );
});

/** Diálogo do ritmo de liberação automática (N tarefas ou módulos por dia). */
function ReleasePaceDialog({ project, today, onClose }: { project: Project; today: string; onClose: () => void }) {
  const [form, setForm] = useState<PaceForm>(() => paceFormOf(project.releasePace, today));
  const [localError, setLocalError] = useState<string | null>(null);
  const { pending, error, run } = useAsyncAction();

  const submit = async () => {
    setLocalError(null);
    const parsed = paceBodyOf(form, today);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    const ok = await run(async () => syncProjectResponse(await api.updateProject(project.id, { releasePace: parsed.releasePace })));
    if (ok) onClose();
  };

  const turnOff = async () => {
    setLocalError(null);
    const ok = await run(async () => syncProjectResponse(await api.updateProject(project.id, { releasePace: null })));
    if (ok) onClose();
  };

  const setStart = (start: PaceStart) => {
    setLocalError(null);
    setForm((current) => ({ ...current, start }));
  };

  return (
    <Modal title="Ritmo de liberação" onClose={onClose} testId="release-pace-dialog">
      <form
        className="rp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Switch
          label="Liberar automaticamente"
          checked={form.enabled}
          testId="pace-enabled"
          disabled={pending}
          onChange={(enabled) => {
            setLocalError(null);
            setForm((current) => ({ ...current, enabled }));
          }}
        />
        {form.enabled && (
          <>
            <div className="rp-form__row">
              <label className="rp-form__field">
                <span>Quantidade por dia</span>
                <input
                  className="ui-input ui-input--compact"
                  type="number"
                  min={1}
                  max={PACE_MAX_PER_DAY}
                  step={1}
                  value={form.perDay}
                  disabled={pending}
                  onChange={(event) => {
                    setLocalError(null);
                    setForm((current) => ({ ...current, perDay: event.currentTarget.value }));
                  }}
                  data-testid="pace-per-day"
                />
              </label>
              <label className="rp-form__field">
                <span>Unidade</span>
                <select
                  className="ui-input ui-input--compact"
                  value={form.unit}
                  disabled={pending}
                  onChange={(event) => setForm((current) => ({ ...current, unit: event.currentTarget.value as PaceForm["unit"] }))}
                  data-testid="pace-unit"
                >
                  <option value="tarefas">Tarefas</option>
                  <option value="modulos">Módulos</option>
                </select>
              </label>
            </div>
            <fieldset className="rp-form__start">
              <legend>Começa em</legend>
              <div className="rp-form__options">
                {(
                  [
                    ["hoje", "Hoje"],
                    ["amanha", "Amanhã"],
                    ["data", "Data"],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="rp-form__radio">
                    <input type="radio" name="release-pace-start" checked={form.start === value} disabled={pending} onChange={() => setStart(value)} data-testid={`pace-start-${value}`} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              {form.start === "data" && (
                <input
                  className="ui-input ui-input--compact rp-form__date"
                  type="date"
                  min={today}
                  value={form.date}
                  disabled={pending}
                  aria-label="Data de início"
                  onChange={(event) => {
                    setLocalError(null);
                    setForm((current) => ({ ...current, date: event.currentTarget.value }));
                  }}
                  data-testid="pace-start-date"
                />
              )}
            </fieldset>
          </>
        )}
        <p className="rp-form__hint">Pega os próximos itens pela prioridade e depois pela ordem da árvore. Os pré-requisitos entram junto e contam no total do dia.</p>
        <ErrorText testId="pace-error">{localError ?? error}</ErrorText>
        <div className="ui-actions">
          {project.releasePace && (
            <button type="button" className="ui-button ui-button--ghost" disabled={pending} onClick={() => void turnOff()} data-testid="pace-off">
              Desligar
            </button>
          )}
          <span className="w-grow" />
          <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={onClose} data-testid="pace-cancel">
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={pending} data-testid="pace-save">
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

