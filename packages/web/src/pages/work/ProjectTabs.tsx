import { leavesOf, type Agent, type Project, type ProjectTask } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { useMediaStore } from "../../store/mediaStore";
import { formatDateTime } from "../../ui/format";
import { MediaThumb } from "../media/MediaParts";
import { Markdown } from "../../ui/markdown/Markdown";
import { AgentTag } from "./Agent";
import { DeliverySummary } from "./DeliverySummary";
import { deliveryGroups, type DeliveryGroup } from "./deliveryView";
import { SPRINT_STATUS_LABEL } from "./sprintsView";
import { projectApprovalBadge, projectTimeline, workedLabel } from "./workView";

const noWiki = () => null;

/** Os resultados das tarefas entregues (o texto de cada uma, com quem fez e quando). */
function ResultsList({ tasks, agents, onOpenTask }: { tasks: readonly ProjectTask[]; agents: ReadonlyMap<string, Agent>; onOpenTask: (ref: string) => void }) {
  const nameOf = (task: ProjectTask) => task.steps.at(-1)?.agentId ?? task.ownerId;
  return (
    <ul className="pt-results">
      {tasks.map((task) => (
        <li key={task.ref} className="pt-result" data-testid={`delivery-${task.ref}`}>
          <div className="pt-result__head">
            <button type="button" className="ui-link pt-result__title" onClick={() => onOpenTask(task.ref)}>
              {task.title}
            </button>
            <AgentTag agent={agents.get(nameOf(task))} fallback={nameOf(task)} />
            {task.finishedAt && <time dateTime={task.finishedAt}>{formatDateTime(task.finishedAt)}</time>}
          </div>
          <div className="pt-result__body">
            <Markdown source={task.result ?? ""} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Aba Entregas: o que já foi entregue (tarefas concluídas com resultado) e as mídias ligadas às tarefas do projeto.
 * Projeto com sprints: agrupada por sprint (a mais recente primeiro), cada grupo com o resumo de entrega da sprint
 * (quando ela já fechou) e os resultados; projeto sem sprints segue a lista de sempre.
 */
export function DeliveriesTab({ project, agents, onOpenTask }: { project: Project; agents: ReadonlyMap<string, Agent>; onOpenTask: (ref: string) => void }) {
  const media = useMediaStore((state) => state.items);
  const ensure = useMediaStore((state) => state.ensureLoaded);
  useEffect(() => ensure(), [ensure]);
  const leaves = useMemo(() => leavesOf({ tasks: project.tasks.filter((task) => !task.archived) }), [project.tasks]);
  const groups = useMemo(() => deliveryGroups(project), [project]);
  const delivered = useMemo(() => groups.reduce((sum, group) => sum + group.tasks.length, 0), [groups]);
  const taskIds = useMemo(() => new Set(leaves.flatMap((task) => task.steps.flatMap((step) => (step.taskId ? [step.taskId] : [])))), [leaves]);
  const files = useMemo(() => (media ?? []).filter((item) => (item.taskId && taskIds.has(item.taskId)) || (item.rootTaskId && (taskIds.has(item.rootTaskId) || item.rootTaskId === project.id))), [media, taskIds, project.id]);
  const bySprint = groups.some((group) => group.sprint !== null);
  // Por sprint, a mídia de cada entrega já aparece no resumo da sprint: aqui ficam só as soltas (sem entrega no resumo).
  const inSummaries = useMemo(() => new Set(groups.flatMap((group) => (group.view?.done ?? []).flatMap((entry) => entry.taskIds ?? []))), [groups]);
  const looseFiles = useMemo(() => (bySprint ? files.filter((item) => !((item.taskId && inSummaries.has(item.taskId)) || (item.rootTaskId && inSummaries.has(item.rootTaskId)))) : files), [bySprint, files, inSummaries]);

  if (groups.length === 0 && files.length === 0) {
    return (
      <div className="pt-empty" data-testid="deliveries-empty">
        <p className="pt-empty__title">Nada entregue ainda</p>
        <p className="pt-empty__text">Quando uma tarefa terminar, o resultado dela aparece aqui, junto com as imagens e os arquivos que os agentes geraram.</p>
      </div>
    );
  }
  return (
    <div className="pt-deliveries" data-testid="deliveries-tab">
      {looseFiles.length > 0 && (
        <section aria-label="Mídias e arquivos">
          <h3 className="pt-h">
            Mídias e arquivos <span className="tp__count">{looseFiles.length}</span>
          </h3>
          <ul className="pt-media">
            {looseFiles.map((item) => (
              <li key={item.id}>
                <button type="button" className="pt-media__item" onClick={() => useMediaStore.getState().open(item.id)} title={`${item.title} (abrir na Mídia)`}>
                  <MediaThumb item={item} className="pt-media__thumb" />
                  <span className="pt-media__title">{item.title || item.fileName}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!bySprint && delivered > 0 && (
        <section aria-label="Tarefas entregues">
          <h3 className="pt-h">
            Tarefas entregues <span className="tp__count">{delivered}</span>
          </h3>
          <ResultsList tasks={groups[0]!.tasks} agents={agents} onOpenTask={onOpenTask} />
        </section>
      )}
      {bySprint &&
        groups.map((group, index) => (
          <SprintDeliveries key={group.key} group={group} project={project} agents={agents} onOpenTask={onOpenTask} defaultOpen={index === 0} />
        ))}
    </div>
  );
}

/** Uma sprint na aba Entregas: o nome, o estado, o resumo de entrega e os resultados das tarefas entregues nela. */
function SprintDeliveries({ group, project, agents, onOpenTask, defaultOpen }: { group: DeliveryGroup; project: Project; agents: ReadonlyMap<string, Agent>; onOpenTask: (ref: string) => void; defaultOpen: boolean }) {
  const { sprint, view, tasks } = group;
  const [open, setOpen] = useState(defaultOpen);
  const name = sprint?.name ?? "Sem sprint";
  return (
    <section className="dg" aria-label={name} data-testid={`delivery-group-${group.key}`} data-open={open}>
      <header className="dg__head">
        <h3 className="dg__name">{name}</h3>
        {sprint && <span className={`sp-state sp-state--${sprint.status}`}>{SPRINT_STATUS_LABEL[sprint.status]}</span>}
        <span className="tp__count">{tasks.length === 1 ? "1 entregue" : `${tasks.length} entregues`}</span>
        <button type="button" className="sp-lane__toggle dg__toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)} data-testid={`delivery-toggle-${group.key}`}>
          {open ? "Recolher" : "Abrir"}
        </button>
      </header>
      {view?.decision && (
        <p className={`dg__decision dg__decision--${view.decision.tone === "returned" ? "returned" : "ok"}`}>Entrega {view.decision.text}</p>
      )}
      {sprint?.status === "fechando" && <p className="dg__decision dg__decision--returned">Esperando o seu OK na entrega (em Aprovações)</p>}
      {open && (
        <>
          {sprint && view && <DeliverySummary project={project} sprint={sprint} agents={agents} onOpenTask={onOpenTask} testId={`delivery-summary-${sprint.id}`} />}
          {tasks.length > 0 && (
            <details className="dg__results">
              <summary>Resultados completos ({tasks.length})</summary>
              <ResultsList tasks={tasks} agents={agents} onOpenTask={onOpenTask} />
            </details>
          )}
          {tasks.length === 0 && !view && <p className="dv__none">Nenhuma tarefa entregue aqui ainda.</p>}
        </>
      )}
    </section>
  );
}

/** Aba Atividade: a linha do tempo do projeto por dia (criado, aprovado, entregas, repasses, prazo e horas trabalhadas). */
export function ActivityTab({ project, agents }: { project: Project; agents: ReadonlyMap<string, Agent> }) {
  const days = projectTimeline(project, (id) => agents.get(id)?.name ?? id);
  const approvalBadge = projectApprovalBadge(project.approval);
  const badgeNode = approvalBadge ? (
    <div className="pt-approval" data-testid="activity-approval-badge">
      <span className="w-kind w-kind--approval" title={approvalBadge.title}>
        {approvalBadge.label}
      </span>
    </div>
  ) : null;
  if (days.length === 0) {
    return (
      <div className="pt-activity">
        {badgeNode}
        <div className="pt-empty">
          <p className="pt-empty__title">Sem atividade ainda</p>
        </div>
      </div>
    );
  }
  return (
    <div className="pt-activity">
      {badgeNode}
      <ol className="w-timeline pt-timeline" data-testid="work-timeline">
        {[...days].reverse().map((day) => {
          const [year, month, date] = day.day.split("-");
          return (
            <li key={day.day} className="w-timeline__day">
              <span className="w-timeline__date">
                {date}/{month}
                <small>{year}</small>
              </span>
              <div className="w-timeline__body">
                <ul className="w-timeline__entries">
                  {day.entries.map((entry, index) => (
                    <li key={index} className={`w-timeline__entry w-timeline__entry--${entry.kind}`}>
                      <span className="w-timeline__dot" aria-hidden="true" />
                      <span title={entry.title}>{entry.text}</span>
                      <time dateTime={entry.at}>{formatDateTime(entry.at).slice(-5)}</time>
                    </li>
                  ))}
                </ul>
                {day.workedMs > 0 && <p className="w-timeline__worked">{workedLabel(day.workedMs)} trabalhadas</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
