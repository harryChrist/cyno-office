import { assigneesOf, childrenOf, isAvulsas, isProjectOpen, leavesOf, PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, type Agent, type ForYouItem, type Project } from "@cyno/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForYouFocus } from "../../store/forYouFocus";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { ConfirmDialog, ErrorText, ProgressBar } from "../../ui/widgets";
import { JointPartPanel } from "../joint/JointCard";
import { ApprovalCard } from "./ApprovalCard";
import { ModeCard } from "./ModeCard";
import { PlanDecision } from "./PlanDecision";
import { ProjectControls } from "./ProjectControls";
import { DueForm } from "./TaskTree";
import { ActivityTab, DeliveriesTab } from "./ProjectTabs";
import { SprintsTab } from "./SprintsTab";
import { TaskPanel, itemsOfTask } from "./TaskPanel";
import { TaskTree } from "./TaskTree";
import { WorkBoard } from "./WorkBoard";
import { useIsMobile } from "./useIsMobile";
import { useTaskActions } from "./useTaskActions";
import { AvatarStack, Popover, PriorityFlag } from "./treeParts";
import { brasiliaShortDate } from "./workTime";
import { openText } from "./projectsView";
import { PROJECT_TABS, PROJECT_TAB_LABELS, workSub, type ProjectTab } from "./workRoute";
import { buildRows, buildWorkBoard, projectState } from "./workView";
import { api } from "../../api/client";
import { PageTabs } from "../PageTabs";
import { useAsyncAction } from "../../ui/useAsyncAction";

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
  const open = isProjectOpen(project);
  const editable = open && project.status !== "ajustando";
  const live = useMemo(() => ({ tasks: project.tasks.filter((task) => !task.archived) }), [project.tasks]);
  const leaves = useMemo(() => leavesOf(live), [live]);
  const done = leaves.filter((task) => task.status === "concluida" && !task.skipped).length;
  const counted = leaves.filter((task) => task.status !== "cancelada" && !(task.status === "concluida" && task.skipped)).length;
  const agentIds = useMemo(() => {
    const ids: string[] = [];
    for (const root of childrenOf(live)) for (const id of assigneesOf(live, root, Number.POSITIVE_INFINITY)) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [live]);
  const state = projectState(project);
  const planItem = forYou?.find((item) => item.status === "pendente" && item.kind === "plano" && item.projectId === project.id);
  const pending = useMemo(
    () => (forYou ?? []).filter((item) => item.status === "pendente" && item.kind !== "plano" && (item.projectId === project.id || project.tasks.some((task) => task.steps.some((step) => step.taskId !== undefined && step.taskId === item.taskId)))),
    [forYou, project],
  );
  const selected = taskRef ? project.tasks.find((task) => task.ref === taskRef && !task.archived) : undefined;
  const select = useCallback((ref: string) => go(project.id, "tarefas", ref), [project.id]);
  const closePanel = useCallback(() => go(project.id, tab), [project.id, tab]);
  const works = office?.tasks ?? [];

  // Quadro: só as folhas (a tela de antes, agora dentro da aba Tarefas).
  const board = useMemo(() => {
    const flat: Project = { ...project, tasks: leaves };
    return buildWorkBoard(buildRows([flat], forYou, new Date(now)));
  }, [project, leaves, forYou, now]);
  const boardAgents = agents;

  const convert = async (ref: string) => {
    const created = await actions.toProject(ref);
    if (created) go(created.id, "tarefas", "T1", true);
  };

  return (
    <div className={`ps${selected && tab === "tarefas" ? " ps--panel" : ""}`} data-testid="project-screen" data-project-id={project.id}>
      <BackButton />
      <ProjectHeader
        project={project}
        fixed={fixed}
        editable={editable}
        stateLabel={state.label}
        stateTone={state.tone}
        done={done}
        counted={counted}
        openCount={leaves.filter((task) => !["concluida", "cancelada", "falhou"].includes(task.status)).length}
        agentIds={agentIds}
        agents={agents}
        waiting={pending.length}
        onConvertToTask={() => setConverting("projeto")}
      />
      <PageTabs
        flush
        label="Seções do projeto"
        tabs={PROJECT_TABS.map((id) => ({ id, label: PROJECT_TAB_LABELS[id] }))}
        active={tab}
        onSelect={(id) => go(project.id, id)}
        testIdPrefix="project-tab"
        trailing={
          tab === "tarefas" ? (
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
        {tab === "tarefas" && (
          <>
            {project.status === "ajustando" && <p className="w-notice">O Maestro está ajustando o plano{project.feedback ? `: “${project.feedback}”` : "."} Espere ele terminar para mexer nas tarefas.</p>}
            {project.status === "proposto" && (
              <section className="w-plan" data-testid="work-plan-card">
                <h3 className="w-plan__title">Plano esperando OK{project.version > 1 ? ` · versão ${project.version}` : ""}</h3>
                <p className="w-plan__text">Nada começa antes da sua aprovação. Você pode ajustar as tarefas, os responsáveis e as sprints antes de aprovar{project.sprints?.length ? "; a primeira sprint começa na data dela (ou agora, se a data já passou)" : ""}.</p>
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
                  agents={agents}
                  workers={workers}
                  workspaceId={workspaceId}
                  now={now}
                  selectedRef={selected?.ref}
                  onSelect={select}
                  editable={editable}
                  canCreate={!fixed}
                  actions={actions}
                  {...(fixed ? { onConvert: (ref: string) => setConverting(ref) } : {})}
                />
              </>
            ) : (
              <WorkBoard columns={board} agents={boardAgents} now={now} onOpenCard={(card) => select(card.task.ref)} onOpenProject={() => document.querySelector('[data-testid="project-header"]')?.scrollIntoView({ block: "start", behavior: "smooth" })} />
            )}
          </>
        )}
        {tab === "sprints" && <SprintsTab project={project} agents={agents} editable={editable && !fixed} fixed={fixed} now={now} onOpenTask={select} />}
        {tab === "entregas" && <DeliveriesTab project={project} agents={agents} onOpenTask={select} />}
        {tab === "atividade" && <ActivityTab project={project} agents={agents} />}
      </div>

      {selected && tab === "tarefas" && (
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
        />
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
  fixed: boolean;
  editable: boolean;
  stateLabel: string;
  stateTone: string;
  done: number;
  counted: number;
  openCount: number;
  agentIds: readonly string[];
  agents: ReadonlyMap<string, Agent>;
  waiting: number;
  onConvertToTask: () => void;
};

function ProjectHeader({ project, fixed, editable, stateLabel, stateTone, done, counted, openCount, agentIds, agents, waiting, onConvertToTask }: HeaderProps) {
  const { error, run } = useAsyncAction();
  const mobile = useIsMobile();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [doneWhen, setDoneWhen] = useState<string | null>(null);
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
  const ratio = counted > 0 ? done / counted : 0;
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
                <ProgressBar value={ratio} label="Tarefas concluídas" />
                <span className="ps-fact__value">
                  {done}/{counted}
                </span>
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

        <ErrorText testId="project-header-error">{error}</ErrorText>
        {!fixed && (
          <details className="ps-more" data-testid="project-more">
            <summary>Começa em, ritmo, modo Automático e cancelar</summary>
            {editable && !planPending && (
              <div className="ps-controls">
                <ProjectControls project={project} slim />
              </div>
            )}
            <ModeCard project={project} editable={editable && !planPending} />
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
            {fixed ? <span className="ph-state ph-state--fixed">Projeto fixo</span> : <span className={`ph-state ph-state--${stateTone}`}>{stateLabel}</span>}
            {project.origin === "cyno" && <span className="w-kind w-kind--cyno">Pedido pelo Cyno</span>}
            {project.mode.kind === "automatico" && <span className="w-kind w-kind--auto">Automático</span>}
          </div>
        </div>
        <div className="ps-head__actions">
          {canEditHeader && project.tasks.filter((task) => !task.archived).length === 1 && (
            <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onConvertToTask} data-testid="project-to-task">
              Virar tarefa avulsa
            </button>
          )}
          {canEditHeader && (project.status === "ativo" || project.status === "pausado") && (
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              onClick={() => void run(() => api.updateProject(project.id, { status: project.status === "pausado" ? "ativo" : "pausado" }))}
              data-testid="work-pause"
            >
              {project.status === "pausado" ? "Retomar" : "Pausar"}
            </button>
          )}
        </div>
      </div>

      {mobile ? (
        <div className="ps-compact" data-testid="project-compact">
          {!fixed && counted > 0 && (
            <span className="ps-compact__progress" data-testid="project-progress-compact">
              <ProgressBar value={ratio} label="Tarefas concluídas" />
              <span className="ps-fact__value">
                {done}/{counted}
              </span>
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
    </header>
  );
}

