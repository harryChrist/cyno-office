import { childrenOf, forYouKind, isLeaf, joinNames, receiversOf, PROJECT_PRIORITIES, PROJECT_PRIORITY_LABELS, pathOf, flowStatusOf, blockedText, deadDependencies, isBlockedLeaf, pendencySummary, treeProgress, type Agent, type ForYouItem, type Project, type ProjectPriority, type ProjectTask, type Task } from "@cyno/shared";
import { useEffect, useId, useMemo, useState } from "react";
import { useWorkPanelStore } from "../../agentWork/workPanelStore";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useViewStore } from "../../store/viewStore";
import type { TaskProgress } from "../../store/taskProgress";
import { useActivityStore } from "../../ui/activity";
import { formatDateTime, percent, ranWithLabel } from "../../ui/format";
import { ApprovalButtons } from "../../ui/TaskViews";
import { ConfirmDialog, ErrorText, ProgressBar, StatusBadge } from "../../ui/widgets";
import { DeliveryHead } from "./DeliveryHead";
import { Markdown } from "../../ui/markdown/Markdown";
import { AgentAvatar, AgentTag } from "./Agent";
import { ApprovalCard } from "./ApprovalCard";
import { HISTORY_LABELS, statusHistory, statusLabel, taskError } from "./board";
import { DueForm, LabelsForm } from "./TaskTree";
import { DependsField, FlowBlock } from "./FlowBlock";
import { TREE_STATUS_LABEL } from "./taskTreeView";
import { StatusIcon } from "./treeParts";
import type { TaskActions } from "./useTaskActions";
import { STEP_MARK_GLYPH, STEP_MARK_LABEL, stepMark, taskState } from "./workView";
import { brasiliaDateTime, brasiliaNote } from "./workTime";

const noWiki = () => null;

type PanelProps = {
  project: Project;
  task: ProjectTask;
  agents: ReadonlyMap<string, Agent>;
  workers: readonly Agent[];
  /** Itens pendentes do Para você desta tarefa (aprovações e perguntas). */
  items: readonly ForYouItem[];
  works: readonly Task[];
  progress: Readonly<Record<string, TaskProgress | undefined>>;
  now: number;
  editable: boolean;
  /** Tarefa do Avulsas: pausar, ritmo e modo Automático pedem "Transformar em projeto". */
  avulsa: boolean;
  actions: TaskActions;
  onSelect: (ref: string) => void;
  onClose: () => void;
  onConvert: (ref: string) => void;
};

/** A folha já começou (não dá para trocar o responsável nem o briefing)? */
const started = (task: ProjectTask): boolean => (task.status !== "backlog" && task.status !== "a_fazer") || task.steps.some((step) => step.status !== "pendente" || step.taskId !== undefined);

/**
 * Painel da tarefa (abre à direita; no celular, folha de baixo para cima): descrição, passos e quem faz cada um,
 * o que espera você (aprovar e recusar ali mesmo), a entrega e o histórico. Edita responsável, prazo,
 * prioridade e etiquetas (é por aqui que o celular edita).
 */
export function TaskPanel({ project, task, agents, workers, items, works, progress, now, editable, avulsa, actions, onSelect, onClose, onConvert }: PanelProps) {
  const titleId = useId();
  const types = useOfficeStore((state) => state.forYouTypes);
  const [stepIndex, setStepIndex] = useState(() => Math.min(task.current, Math.max(0, task.steps.length - 1)));
  const [asking, setAsking] = useState<null | "pausar" | "ritmo" | "automatico">(null);
  const status = flowStatusOf(project, task);
  const path = pathOf(project, task.ref).slice(0, -1);
  const leaf = isLeaf(project, task);
  const children = childrenOf({ tasks: project.tasks.filter((candidate) => !candidate.archived) }, task.ref);
  const locked = started(task);
  const step = task.steps[stepIndex];
  const work = step?.taskId ? works.find((candidate) => candidate.id === step.taskId) : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]") && !document.querySelector(".tt-pop")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="tp-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="tp" aria-labelledby={titleId} data-testid="task-panel" data-ref={task.ref}>
        <header className="tp__head">
          <div className="tp__titles">
            <p className="tp__eyebrow">
              {path.length > 0 ? `${path.map((node) => node.title).join(" › ")} · ` : ""}
              {task.ref}
              {task.group ? " · entregável" : ""}
            </p>
            <TitleEditor id={titleId} title={task.title} editable={editable} onSave={(title) => void actions.update(task.ref, { title })} />
          </div>
          <button type="button" className="ui-icon-button" aria-label="Fechar" onClick={onClose} data-testid="task-panel-close">
            ×
          </button>
        </header>
        <div className="tp__body">
          <div className="tp__state">
            <StatusIcon status={status} />
            <span className={`tp__statetext tp__statetext--${status}`}>{TREE_STATUS_LABEL[status]}</span>
            {task.skipped && <span className="ui-badge ui-badge--neutral">Pulada</span>}
            {leaf && task.rework.count > 0 && (
              <span className="ui-badge ui-badge--attention" title={task.rework.last?.reason}>
                Retrabalho {task.rework.count}x
              </span>
            )}
          </div>
          {leaf && isBlockedLeaf(project, task) && (
            <div className="tp__blocked" role="alert" data-testid="task-panel-blocked">
              <p className="tp__line">
                <strong>{blockedText(project, task)}</strong>. Ela não roda sozinha: o resultado de que precisa não existe. Escolha o que fazer:
              </p>
              <div className="tp__blocked-actions">
                {deadDependencies(project, task).map((dep) => (
                  <span key={dep.ref} className="tp__blocked-group">
                    {editable && (
                      <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={actions.busy} onClick={() => void actions.update(dep.ref, { status: "refazer" })} data-testid={`task-panel-redo-${dep.ref}`}>
                        Refazer “{dep.title}”
                      </button>
                    )}
                    {editable && task.dependsOn.includes(dep.ref) && (
                      <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={actions.busy} onClick={() => void actions.update(task.ref, { dependsOn: task.dependsOn.filter((ref) => ref !== dep.ref) })} data-testid={`task-panel-unlink-${dep.ref}`}>
                        Tirar a dependência de “{dep.title}”
                      </button>
                    )}
                  </span>
                ))}
                {editable && (
                  <button type="button" className="ui-button ui-button--ghost ui-button--small" disabled={actions.busy} onClick={() => void actions.cancel(task.ref)} data-testid="task-panel-cancel-blocked">
                    Cancelar esta tarefa
                  </button>
                )}
              </div>
            </div>
          )}
          {!leaf && status === "esperando_voce" && pendencySummary(project, task) && (
            <p className="tp__blocked tp__line" role="status" data-testid="task-panel-pendency">
              <strong>Com pendência: {pendencySummary(project, task)!.text}.</strong> A tarefa não conclui sozinha: abra as subtarefas para refazer, tirar a dependência ou cancelar.
            </p>
          )}
          {leaf && receiversOf(project, task.ref).length > 0 && (
            <p className="tp__line" data-testid="task-panel-receivers">
              <strong>O resultado vai para</strong>: {joinNames(receiversOf(project, task.ref).map((other) => `${other.ownerId ? (agents.get(other.ownerId)?.name ?? other.ownerId) : "sem responsável"} (${other.title})`))}
            </p>
          )}
          <ErrorText testId="task-panel-error">{actions.error}</ErrorText>

          {leaf && items.length > 0 && (
            <section className="tp__section" aria-label="Esperando você">
              <h3 className="tp__h">
                Esperando você <span className="tp__count">{items.length}</span>
              </h3>
              <div className="w-approvals">
                {items.map((item) => (
                  <ApprovalCard key={item.id} item={item} types={types} agentName={agents.get(item.agentId)?.name} now={now} />
                ))}
              </div>
            </section>
          )}


          {editable && (
            <section className="tp__fields" aria-label="Detalhes">
              {leaf && (
                <label className="tp__field">
                  <span>Responsável</span>
                  <select
                    className="ui-input ui-input--compact"
                    value={task.ownerId}
                    disabled={locked || avulsa || actions.busy}
                    onChange={(event) => void actions.update(task.ref, { assignee: event.currentTarget.value || null })}
                    data-testid="task-panel-assignee"
                  >
                    <option value="">Sem responsável</option>
                    {workers.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} · {agent.role}
                      </option>
                    ))}
                  </select>
                  {locked && <small className="tp__hint">A tarefa já começou: o responsável não muda.</small>}
                </label>
              )}
              {!task.group && (
                <DependsField project={project} task={task} agents={agents} actions={actions} locked={(leaf && locked) || avulsa} />
              )}
              {!task.group && !children.length && (
                <label className="tp__field">
                  <span>Prioridade</span>
                  <select className="ui-input ui-input--compact" value={task.priority} disabled={actions.busy} onChange={(event) => void actions.update(task.ref, { priority: event.currentTarget.value as ProjectPriority })} data-testid="task-panel-priority">
                    {PROJECT_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {PROJECT_PRIORITY_LABELS[priority]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {leaf && (
                <div className="tp__field tp__field--wide">
                  <span>Prazo{brasiliaNote()}</span>
                  <DueForm label={false} key={task.dueAt ?? "-"} value={task.dueAt} onSave={(iso) => void actions.update(task.ref, { dueAt: iso })} />
                </div>
              )}
              {!task.group && (
                <div className="tp__field tp__field--wide">
                  <span>Etiquetas</span>
                  <LabelsForm row={{ ref: task.ref, node: task }} project={project} actions={actions} />
                </div>
              )}
            </section>
          )}

          {!editable && leaf && task.dueAt && (
            <p className="tp__line">
              <strong>Prazo</strong>: {brasiliaDateTime(task.dueAt)}
            </p>
          )}

          {avulsa && leaf && editable && (
            <section className="tp__section" aria-label="Controles da tarefa avulsa">
              <h3 className="tp__h">Pausar, ritmo e modo</h3>
              <p className="tp__text">A tarefa avulsa não pausa, não tem ritmo próprio nem modo Automático. Para isso, ela precisa ser um projeto.</p>
              <div className="tp__actions">
                {(["pausar", "ritmo", "automatico"] as const).map((kind) => (
                  <button key={kind} type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setAsking(kind)} data-testid={`task-panel-${kind}`}>
                    {kind === "pausar" ? "Pausar" : kind === "ritmo" ? "Ritmo" : "Modo Automático"}
                  </button>
                ))}
              </div>
            </section>
          )}

          {!task.group && !leaf && <FlowBlock project={project} mother={task} agents={agents} onSelect={onSelect} />}

          {task.group && (
            <section className="tp__section" aria-label="O que tem dentro">
              <h3 className="tp__h">
                Dentro {(() => {
                  const { done, total } = treeProgress(project, task.ref);
                  return total > 0 ? <span className="tp__count">{done} de {total} concluídas</span> : null;
                })()}
              </h3>
              {children.length === 0 ? (
                <p className="tp__text">Nada aqui ainda. Use “Adicionar” na árvore.</p>
              ) : (
                <ul className="tp__children">
                  {children.map((child) => (
                    <li key={child.ref}>
                      <button type="button" className="tp__child" onClick={() => onSelect(child.ref)}>
                        <StatusIcon status={flowStatusOf(project, child)} />
                        <span className="tp__child__title">{child.title}</span>
                        {child.ownerId && <AgentAvatar agent={agents.get(child.ownerId)} />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {leaf && (
            <>
              <BriefingField key={task.briefing} task={task} editable={editable && !locked && !avulsa} onSave={(briefing) => void actions.update(task.ref, { briefing })} />
              {task.doneWhen.length > 0 && (
                <section className="tp__section" aria-label="Pronto quando">
                  <h3 className="tp__h">Pronto quando…</h3>
                  <ul className="w-done__list">
                    {task.doneWhen.map((item) => (
                      <li key={item.id} className={item.met ? "w-done__item w-done__item--met" : "w-done__item"}>
                        <span aria-hidden="true">{item.met ? "✓" : "○"}</span>
                        <span className="sr-only">{item.met ? "Cumprido: " : "Falta: "}</span>
                        <span>{item.text}</span>
                        {item.note && <span className="ui-muted"> · {item.note}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="tp__section" aria-label="Passos">
                <h3 className="tp__h">
                  Passos <span className="tp__count">{task.steps.length}</span>
                </h3>
                <ol className="tp__steps" data-testid="task-panel-steps">
                  {task.steps.map((candidate, index) => {
                    const mark = stepMark(task, index);
                    return (
                      <li key={index} className={`tp__step tp__step--${mark}${index === stepIndex ? " is-on" : ""}`} data-mark={mark}>
                        <button type="button" className="tp__stepbtn" onClick={() => setStepIndex(index)} aria-pressed={index === stepIndex} title={candidate.what}>
                          <span className="tp__stepmark" aria-hidden="true">
                            {STEP_MARK_GLYPH[mark]}
                          </span>
                          <AgentAvatar agent={agents.get(candidate.agentId)} />
                          <span className="tp__steptext">
                            <span className="tp__stepagent">{agents.get(candidate.agentId)?.name ?? (candidate.agentId || "Sem responsável")}</span>
                            <span className="tp__stepwhat">{candidate.what}</span>
                          </span>
                          <span className="tp__stepstate">{STEP_MARK_LABEL[mark]}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                {step && (work || step.result || step.status !== "pendente") && <StepDetail task={task} stepIndex={stepIndex} work={work} agent={agents.get(step.agentId)} progress={work ? progress[work.id] : undefined} now={now} />}
              </section>

              {task.status === "concluida" && task.result && !work && (
                <section className="tp__section" aria-label="Entrega">
                  <h3 className="tp__h">Entrega</h3>
                  <DeliveryHead text={task.result} />
                  <div className="w-drawer__pre">
                    <Markdown source={task.result} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
                  </div>
                </section>
              )}
              {task.failure && !work && (
                <section className="tp__section">
                  <h3 className="tp__h">Erro</h3>
                  <pre className="w-drawer__pre w-drawer__pre--error">{task.failure}</pre>
                </section>
              )}
            </>
          )}
        </div>
        {leaf && (step?.agentId ?? "") !== "" && (
          <footer className="tp__foot">
            <AgentLinks agent={agents.get(step!.agentId)} onClose={onClose} />
          </footer>
        )}
      </aside>
      {asking && (
        <ConfirmDialog
          title="Transformar em projeto?"
          message={
            <p>
              {asking === "pausar" ? "A tarefa avulsa não pausa." : asking === "ritmo" ? "A tarefa avulsa não tem ritmo próprio." : "O modo Automático vale para projeto, não para tarefa avulsa."} Ao transformar em projeto, ela vira um projeto de uma tarefa só (com o mesmo agente e o que já foi feito), e aí dá para pausar, definir o ritmo e ligar o Automático.
            </p>
          }
          confirmLabel="Transformar em projeto"
          pendingLabel="Transformando…"
          tone="success"
          onConfirm={async () => {
            onConvert(task.ref);
          }}
          onClose={() => setAsking(null)}
          testId="task-panel-convert-dialog"
        />
      )}
    </>
  );
}

function TitleEditor({ id, title, editable, onSave }: { id: string; title: string; editable: boolean; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(title);
  if (!editing) {
    return (
      <h2 id={id} className="tp__title" data-testid="task-panel-title">
        {title}
        {editable && (
          <button type="button" className="tp__edit" aria-label="Renomear" onClick={() => (setText(title), setEditing(true))} data-testid="task-panel-rename">
            ✎
          </button>
        )}
      </h2>
    );
  }
  const finish = (save: boolean) => {
    setEditing(false);
    if (save && text.trim() && text.trim() !== title) onSave(text.trim());
  };
  return (
    <input
      id={id}
      className="tt-input tp__titleinput"
      value={text}
      maxLength={120}
      autoFocus
      aria-label="Nome da tarefa"
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
    />
  );
}

function BriefingField({ task, editable, onSave }: { task: ProjectTask; editable: boolean; onSave: (briefing: string) => void }) {
  const [text, setText] = useState(task.briefing);
  if (!editable && !task.briefing) return null;
  return (
    <section className="tp__section" aria-label="Descrição">
      <h3 className="tp__h">Descrição</h3>
      {editable ? (
        <textarea
          className="ui-input tp__briefing"
          rows={4}
          value={text}
          placeholder="O que precisa ser feito"
          onChange={(event) => setText(event.currentTarget.value)}
          onBlur={() => text.trim() !== task.briefing.trim() && onSave(text)}
          data-testid="task-panel-briefing"
        />
      ) : (
        <p className="tp__text tp__text--clamp">{task.briefing}</p>
      )}
    </section>
  );
}

/** Quem faz o passo, o que faz, andamento, resultado ou erro e o histórico (o que a gaveta da etapa mostrava). */
function StepDetail({ task, stepIndex, work, agent, progress, now }: { task: ProjectTask; stepIndex: number; work: Task | undefined; agent: Agent | undefined; progress: TaskProgress | undefined; now: number }) {
  const entries = useActivityStore((state) => state.entries);
  const history = useMemo(() => (work ? statusHistory(work, entries) : []), [work, entries]);
  const step = task.steps[stepIndex];
  const state = taskState(task);
  const error = work ? taskError(work) : undefined;
  const today = new Date(now);
  const running = work && (work.status === "in_progress" || work.status === "waiting_approval");
  const ran = work ? ranWithLabel(work) : null;
  if (!step) return null;
  return (
    <div className="tp__detail" data-testid="work-step-detail">
      <div className="w-drawer__who">
        <AgentTag agent={agent} fallback={step.agentId || "Sem responsável"} />
        {work ? <StatusBadge status={work.status} label={statusLabel(work.status)} testId="work-step-status" /> : <span className={`ui-badge ui-badge--${state.tone}`}>{state.label}</span>}
      </div>
      {ran && (
        <p className="w-drawer__line">
          <strong>Modelo</strong>: {ran}
        </p>
      )}
      {running && work && (
        <div aria-label="Andamento">
          <div className="current-task__progress">
            <ProgressBar value={progress?.progress ?? 0} label="Progresso da etapa" />
            <span className="current-task__percent">{percent(progress?.progress ?? 0)}</span>
          </div>
          {progress?.message && <p className="current-task__message">“{progress.message}”</p>}
          {work.status === "waiting_approval" && (
            <>
              {!progress?.message && <p className="current-task__message">{work.waiting ?? "O agente quer sua aprovação para continuar."}</p>}
              <ApprovalButtons taskId={work.id} />
            </>
          )}
        </div>
      )}
      {work?.status === "done" && work.result && (
        <>
          <h4 className="tp__h2">Resultado</h4>
          <DeliveryHead text={work.result} />
          <div className="w-drawer__pre" data-testid="work-step-result">
            <Markdown source={work.result} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
          </div>
        </>
      )}
      {!work && step.result && (
        <>
          <h4 className="tp__h2">Resultado</h4>
          <DeliveryHead text={step.result} />
          <div className="w-drawer__pre">
            <Markdown source={step.result} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
          </div>
        </>
      )}
      {error && (
        <>
          <h4 className="tp__h2">Erro</h4>
          <pre className="w-drawer__pre w-drawer__pre--error" data-testid="work-step-error">
            {error}
          </pre>
        </>
      )}
      {work && history.length > 0 && (
        <>
          <h4 className="tp__h2">Histórico</h4>
          <ol className="w-history" data-testid="work-step-history">
            {history.map((entry) => (
              <li key={entry.key} className={`w-history__step w-history__step--${entry.kind}`}>
                <span>{HISTORY_LABELS[entry.kind]}</span>
                <time dateTime={entry.at}>{formatDateTime(entry.at, today)}</time>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function AgentLinks({ agent, onClose }: { agent: Agent | undefined; onClose: () => void }) {
  return (
    <>
      <button type="button" className="ui-button ui-button--small" disabled={!agent} onClick={() => agent && useWorkPanelStore.getState().openAgent(agent.id)} data-testid="work-step-log">
        Ver o trabalho do agente
      </button>
      <button
        type="button"
        className="ui-button ui-button--secondary ui-button--small"
        disabled={!agent}
        onClick={() => {
          if (!agent) return;
          onClose();
          useNavStore.getState().go("office");
          useViewStore.getState().select({ kind: "agent", id: agent.id });
        }}
        data-testid="work-step-office"
      >
        Ver no escritório
      </button>
    </>
  );
}

/** Itens pendentes do Para você que pertencem a esta tarefa. */
export function itemsOfTask(project: Project, task: ProjectTask, forYou: readonly ForYouItem[] | null | undefined): ForYouItem[] {
  return (forYou ?? []).filter(
    (item) =>
      item.status === "pendente" &&
      forYouKind(item) !== "plano" &&
      ((item.projectId === project.id && item.taskRef === task.ref) || (item.taskId !== undefined && task.steps.some((step) => step.taskId === item.taskId))),
  );
}

