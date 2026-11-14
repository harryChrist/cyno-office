import { sprintsInOrder, type Agent, type Project, type Sprint } from "@cyno/shared";
import { useId, useMemo, useState, type FormEvent, type PointerEvent } from "react";
import { useForYouFocus } from "../../store/forYouFocus";
import { useOfficeStore } from "../../store/officeStore";
import { ConfirmDialog, ErrorText, Modal, ProgressBar } from "../../ui/widgets";
import { DeliverySummary } from "./DeliverySummary";
import { canDragToSprint, sprintDrop, type SprintVerdict } from "./dragRules";
import { deliveryView } from "./deliveryView";
import { buildSprintLanes, buildTimeline, loadText, looseOpenCount, shortSprintName, SPRINT_STATUS_LABEL, sprintDates, type LaneTask, type SprintLane } from "./sprintsView";
import { TREE_STATUS_LABEL } from "./taskTreeView";
import { AvatarStack, StatusIcon } from "./treeParts";
import { DragGhost, usePointerDrag } from "./usePointerDrag";
import { useIsMobile } from "./useIsMobile";
import { useSprintActions, type SprintActions } from "./useSprintActions";
import { useTaskActions } from "./useTaskActions";
import { brasiliaNote, fromBrasiliaInput, toBrasiliaInput } from "./workTime";

const WEEK = 7 * 86_400_000;

type SprintDrop = { lane: string; verdict: SprintVerdict };

type TabProps = {
  project: Project;
  agents: ReadonlyMap<string, Agent>;
  /** O projeto aceita mudanças (não terminou, não está sendo refeito, não é o Avulsas). */
  editable: boolean;
  /** O Avulsas não tem sprints. */
  fixed: boolean;
  now: number;
  onOpenTask: (ref: string) => void;
};

/**
 * Aba Sprints: a linha do tempo no topo e as sprints em faixas, na ordem do tempo (a ativa em destaque, as
 * fechadas recolhidas), cada uma com as tarefas dela, mais a faixa "Sem sprint". Sem arrastar: para mover uma
 * tarefa de sprint, use o menu da linha na aba Tarefas ("Mover para sprint…").
 */
export function SprintsTab({ project, agents, editable, fixed, now, onOpenTask }: TabProps) {
  const actions = useSprintActions(project.id);
  const taskActions = useTaskActions(project.id);
  const mobile = useIsMobile();
  const [notice, setNotice] = useState<string | null>(null);
  // Arrastar uma tarefa de uma faixa para outra muda a sprint dela (sprint fechada não aceita). No celular fica o menu.
  const drag = usePointerDrag<SprintDrop>({
    enabled: editable && !fixed && !mobile,
    hit: (point, id) => {
      const lane = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-lane]");
      const target = lane?.dataset.lane;
      if (!lane || !target) return null;
      return { lane: target, verdict: sprintDrop(project, id, target === "none" ? null : target) };
    },
    accepts: (drop) => drop.verdict.ok,
    onDrop: (id, drop) => {
      if (!drop.verdict.ok) {
        if (drop.verdict.reason) setNotice(drop.verdict.reason);
        return;
      }
      void taskActions.move(id, { sprintId: drop.verdict.sprintId });
    },
  });
  const dragStart = (task: LaneTask, event: PointerEvent<HTMLElement>) => {
    if (editable && !fixed && canDragToSprint(project, task.task.ref)) drag.start(task.task.ref, task.task.title, event);
  };
  const dropClass = (laneId: string) => {
    const drop = drag.session?.verdict;
    if (!drop || drop.lane !== laneId) return "";
    return drop.verdict.ok ? " sp-lane--drop" : drop.verdict.reason ? " sp-lane--drop-no" : " sp-lane--drop-same";
  };
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; sprint: Sprint } | null>(null);
  const [deleting, setDeleting] = useState<Sprint | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { lanes, loose } = useMemo(() => buildSprintLanes(project, now), [project, now]);
  const timeline = useMemo(() => buildTimeline(project, now), [project, now]);

  if (fixed) {
    return (
      <div className="pt-empty" data-testid="sprints-fixed">
        <p className="pt-empty__title">As tarefas avulsas não têm sprints</p>
        <p className="pt-empty__text">Cada pedido simples vira uma tarefa e anda sozinha. Para dividir um trabalho em semanas, crie um projeto.</p>
      </div>
    );
  }

  if (lanes.length === 0) {
    return (
      <div className="pt-empty sp-empty" data-testid="sprints-empty">
        <p className="pt-empty__title">Este projeto ainda não tem sprints</p>
        <p className="pt-empty__text">
          Uma sprint é uma fatia de tempo do projeto, em geral uma semana, com um objetivo de uma frase. Cada tarefa entra numa sprint e os agentes só trabalham nas tarefas da sprint que está ativa. O que não ficar pronto passa sozinho para a sprint seguinte. Sem sprints, o projeto anda como sempre: tudo o que está pronto pode começar.
        </p>
        {editable && (
          <button type="button" className="ui-button" onClick={() => setDialog({ mode: "create" })} data-testid="sprint-create-first">
            Criar a primeira sprint
          </button>
        )}
        {dialog && <SprintDialog project={project} now={now} dialog={dialog} actions={actions} onClose={() => setDialog(null)} />}
      </div>
    );
  }

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="sp" data-testid="sprints-tab">
      <div className="sp-bar">
        <p className="sp-bar__text">
          {lanes.length === 1 ? "1 sprint" : `${lanes.length} sprints`} · os agentes só trabalham nas tarefas da sprint ativa
        </p>
        {editable && (
          <button type="button" className="ui-button ui-button--small" onClick={() => setDialog({ mode: "create" })} data-testid="sprint-create">
            + Nova sprint
          </button>
        )}
      </div>
      <ErrorText testId="sprints-error">{actions.error ?? taskActions.error}</ErrorText>
      {notice && (
        <p className="tt-notice" role="status" data-testid="sprints-drop-notice">
          {notice}
        </p>
      )}
      <DragGhost session={drag.session} reason={drag.session?.verdict && !drag.session.verdict.verdict.ok ? drag.session.verdict.verdict.reason || null : null} />

      {timeline && (
        <div className="sp-line" data-testid="sprint-timeline" aria-label="Linha do tempo das sprints">
          <div className="sp-line__track">
            {timeline.blocks.map((block) => (
              <span key={block.id} className={`sp-line__block sp-line__block--${block.status}`} style={{ left: `${block.left}%`, width: `${block.width}%` }} title={`${block.name} · ${block.range} · ${SPRINT_STATUS_LABEL[block.status]}`} data-testid={`sprint-block-${block.id}`}>
                <span className="sp-line__label">
                  {block.label}
                  {block.progress.total > 0 && <span className="sp-line__prog"> · {block.progress.done}/{block.progress.total}</span>}
                </span>
                <span className="sp-line__dates">{block.range}</span>
              </span>
            ))}
            {timeline.today !== null && (
              <span className="sp-line__today" style={{ left: `${timeline.today}%` }} data-testid="sprint-today" title="Hoje">
                <span className="sp-line__today-text">hoje</span>
              </span>
            )}
          </div>
          <div className="sp-line__ends" aria-hidden="true">
            <span>{timeline.from}</span>
            <span>{timeline.to}</span>
          </div>
        </div>
      )}

      <div className="sp-grid">
        {lanes.map((lane) => (
          <Lane
            key={lane.sprint.id}
            lane={lane}
            project={project}
            agents={agents}
            editable={editable}
            collapsed={lane.sprint.status === "fechada" && !expanded.has(lane.sprint.id)}
            onToggle={() => toggle(lane.sprint.id)}
            actions={actions}
            onEdit={() => setDialog({ mode: "edit", sprint: lane.sprint })}
            onDelete={() => setDeleting(lane.sprint)}
            onOpenTask={onOpenTask}
            dropClass={dropClass(lane.sprint.id)}
            onDragStart={dragStart}
            draggingRef={drag.session?.id}
          />
        ))}
        <section className={`sp-lane sp-lane--loose${dropClass("none")}`} data-lane="none" data-testid="sprint-lane-none">
          <header className="sp-lane__head">
            <div className="sp-lane__titles">
              <h3 className="sp-lane__name">Sem sprint</h3>
              <p className="sp-lane__meta">{loose.tasks.length === 1 ? "1 tarefa" : `${loose.tasks.length} tarefas`}</p>
            </div>
          </header>
          {loose.tasks.length === 0 ? (
            <p className="sp-lane__none">Nenhuma tarefa solta: tudo está numa sprint.</p>
          ) : (
            <>
              <p className="sp-lane__goal">O agente não começa tarefa sem sprint enquanto o projeto usa sprints. Mande-as para uma sprint no menu da linha, na aba Tarefas.</p>
              <TaskList tasks={loose.tasks} agents={agents} onOpenTask={onOpenTask} onDragStart={dragStart} draggingRef={drag.session?.id} />
            </>
          )}
        </section>
      </div>

      {dialog && <SprintDialog project={project} now={now} dialog={dialog} actions={actions} onClose={() => setDialog(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Apagar ${deleting.name}?`}
          message={<p>{lanes.find((lane) => lane.sprint.id === deleting.id)?.tasks.length ? "As tarefas dela voltam para “sem sprint”." : "A sprint está vazia."} Isso não apaga tarefa nenhuma.</p>}
          confirmLabel="Apagar a sprint"
          pendingLabel="Apagando…"
          onConfirm={async () => {
            const ok = await actions.remove(deleting.id);
            if (!ok) throw new Error(actions.error ?? "Não deu para apagar a sprint.");
          }}
          onClose={() => setDeleting(null)}
          testId="sprint-delete-dialog"
        />
      )}
    </div>
  );
}

type LaneProps = {
  lane: SprintLane;
  project: Project;
  agents: ReadonlyMap<string, Agent>;
  editable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  actions: SprintActions;
  onEdit: () => void;
  onDelete: () => void;
  onOpenTask: (ref: string) => void;
  dropClass: string;
  onDragStart: (task: LaneTask, event: PointerEvent<HTMLElement>) => void;
  draggingRef: string | undefined;
};

function Lane({ lane, project, agents, editable, collapsed, onToggle, actions, onEdit, onDelete, onOpenTask, dropClass, onDragStart, draggingRef }: LaneProps) {
  const { sprint, progress } = lane;
  const counted = progress.total;
  const closed = sprint.status === "fechada";
  const closing = sprint.status === "fechando";
  const delivery = closed || closing ? deliveryView(project, sprint) : null;
  // O cartão da entrega continua em Aprovações depois de decidido: dá para reabri-lo daqui.
  const hasCard = useOfficeStore((state) => closed && sprint.forYouId !== undefined && (state.forYou ?? []).some((item) => item.id === sprint.forYouId));
  const canDelete = sprint.status === "planejada" || lane.tasks.length === 0;
  // Plano ainda esperando o OK (ou sendo refeito): nada começa antes de aprovar.
  const awaitingPlan = project.status === "proposto" || project.status === "ajustando";
  const hasActive = project.sprints?.some((candidate) => candidate.status === "ativa") ?? false;
  return (
    <section className={`sp-lane sp-lane--${sprint.status}${dropClass}`} data-lane={sprint.id} data-testid={`sprint-lane-${sprint.id}`} data-status={sprint.status}>
      <header className="sp-lane__head">
        <div className="sp-lane__titles">
          <h3 className="sp-lane__name" title={sprint.name}>
            {sprint.name}
          </h3>
          <p className="sp-lane__meta">
            <span className={`sp-state sp-state--${sprint.status}`}>{SPRINT_STATUS_LABEL[sprint.status]}</span>
            <span data-testid={`sprint-dates-${sprint.id}`}>{sprintDates(sprint)}</span>
            {lane.day && (
              <span className="sp-lane__day" data-testid={`sprint-day-${sprint.id}`}>
                dia {lane.day.day} de {lane.day.days}
              </span>
            )}
          </p>
        </div>
        {closed && (
          <button type="button" className="sp-lane__toggle" aria-expanded={!collapsed} onClick={onToggle} data-testid={`sprint-toggle-${sprint.id}`}>
            {collapsed ? (delivery ? "Ver a entrega" : "Ver tarefas") : "Recolher"}
          </button>
        )}
      </header>
      {sprint.goal && <p className="sp-lane__goal">Objetivo: {sprint.goal}</p>}
      {lane.load.length > 0 && !closed && (
        <p className="sp-lane__load" data-testid={`sprint-load-${sprint.id}`} title="Tarefas abertas por agente nesta sprint">
          <span className="sp-lane__load-label">Carga</span> {loadText(lane.load, (id) => agents.get(id)?.name ?? id)}
        </p>
      )}
      <div className="sp-lane__progress" data-testid={`sprint-progress-${sprint.id}`}>
        {counted === 0 ? (
          <span className="sp-lane__none">{closed ? "Nenhuma tarefa concluída nela" : "Sem tarefas ainda"}</span>
        ) : (
          <>
            <ProgressBar value={progress.done / counted} label={`Tarefas concluídas em ${sprint.name}`} />
            <span className="sp-lane__count">
              {progress.done}/{counted}
            </span>
          </>
        )}
      </div>
      {closing && (
        <div className="sp-wait" data-testid={`sprint-waiting-${sprint.id}`}>
          <p className="sp-wait__text">Esperando o seu OK na entrega</p>
          {delivery && <p className="sp-wait__sub">{delivery.headline.replace(`${sprint.name} fechou: `, "")}</p>}
          {sprint.forYouId && (
            <button type="button" className="ui-button ui-button--small" onClick={() => useForYouFocus.getState().open(sprint.forYouId!)} data-testid={`sprint-open-card-${sprint.id}`}>
              Abrir a entrega
            </button>
          )}
        </div>
      )}
      {closed && delivery && (
        <div className="sp-done" data-testid={`sprint-delivery-${sprint.id}`}>
          <p className="sp-done__line" data-testid={`sprint-delivery-line-${sprint.id}`}>
            <strong>{delivery.done.length}</strong> {delivery.done.length === 1 ? "entregue" : "entregues"} · <strong>{delivery.carried.length}</strong> {delivery.carried.length === 1 ? "sobrou" : "sobraram"}
            {delivery.failed.length > 0 && <> ({delivery.failed.length} {delivery.failed.length === 1 ? "falhou" : "falharam"})</>}
          </p>
          <p className="sp-done__dates">{[delivery.range, delivery.closedLabel].filter(Boolean).join(" · ")}</p>
          {hasCard && (
            <button type="button" className="ui-link sp-done__card" onClick={() => useForYouFocus.getState().open(sprint.forYouId!)} data-testid={`sprint-reopen-card-${sprint.id}`}>
              Reabrir o cartão da entrega
            </button>
          )}
          {delivery.decision && (
            <p className={`sp-done__decision sp-done__decision--${delivery.decision.tone}`} data-testid={`sprint-decision-${sprint.id}`}>
              Entrega {delivery.decision.text}
            </p>
          )}
        </div>
      )}
      {closed && lane.carriedOut > 0 && !delivery && (
        <p className="sp-lane__note" data-testid={`sprint-carried-${sprint.id}`}>
          {lane.carriedOut === 1 ? "1 tarefa sobrou e passou adiante." : `${lane.carriedOut} tarefas sobraram e passaram adiante.`}
        </p>
      )}
      {!collapsed && closed && delivery && <DeliverySummary project={project} sprint={sprint} agents={agents} onOpenTask={onOpenTask} testId={`sprint-summary-${sprint.id}`} />}
      {!collapsed && !(closed && delivery) && lane.tasks.length > 0 && <TaskList tasks={lane.tasks} agents={agents} onOpenTask={onOpenTask} onDragStart={onDragStart} draggingRef={draggingRef} />}
      {editable && (sprint.status === "planejada" || sprint.status === "ativa") && (
        <footer className="sp-lane__actions">
          {sprint.status === "planejada" && awaitingPlan && (
            <span className="sp-lane__wait" data-testid={`sprint-start-wait-${sprint.id}`}>Começa depois que você aprovar o plano</span>
          )}
          {sprint.status === "planejada" && !awaitingPlan && (
            <button type="button" className="ui-button ui-button--small" disabled={actions.busy} onClick={() => void actions.start(sprint.id)} data-testid={`sprint-start-${sprint.id}`} title={hasActive ? "Fecha a sprint ativa (o que sobrou vem para esta) e começa esta agora" : "Começa esta sprint agora"}>
              Começar agora
            </button>
          )}
          {sprint.status === "ativa" && (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={actions.busy} onClick={() => void actions.close(sprint.id)} data-testid={`sprint-close-${sprint.id}`} title="O que sobrou passa para a próxima sprint">
              Fechar agora
            </button>
          )}
          <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onEdit} data-testid={`sprint-edit-${sprint.id}`}>
            Editar
          </button>
          {canDelete && (
            <button type="button" className="ui-button ui-button--ghost ui-button--small sp-danger" onClick={onDelete} data-testid={`sprint-delete-${sprint.id}`}>
              Apagar
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function TaskList({ tasks, agents, onOpenTask, onDragStart, draggingRef }: { tasks: readonly LaneTask[]; agents: ReadonlyMap<string, Agent>; onOpenTask: (ref: string) => void; onDragStart: (task: LaneTask, event: PointerEvent<HTMLElement>) => void; draggingRef: string | undefined }) {
  return (
    <ul className="sp-tasks">
      {tasks.map((entry) => {
        const { task, status, assignees, path, carried } = entry;
        return (
        <li key={task.ref}>
          <button type="button" className={`sp-task${status === "concluida" ? " is-done" : ""}${draggingRef === task.ref ? " is-dragging" : ""}`} onClick={() => onOpenTask(task.ref)} onPointerDown={(event) => onDragStart(entry, event)} data-testid={`sprint-task-${task.ref}`}>
            <StatusIcon status={status} size={15} />
            <span className="sp-task__text">
              <span className="sp-task__title" title={task.title}>
                {task.title}
              </span>
              <span className="sp-task__sub">
                <span className={`sp-task__status sp-task__status--${status}`}>{TREE_STATUS_LABEL[status]}</span>
                {carried && <span className="sp-carried">↩ veio da {carried}</span>}
                {path && <span className="sp-task__path">{path}</span>}
              </span>
            </span>
            <span className="sp-task__who">
              <AvatarStack ids={assignees} more={0} agents={agents} />
            </span>
          </button>
        </li>
        );
      })}
    </ul>
  );
}

type DialogProps = { project: Project; now: number; dialog: { mode: "create" } | { mode: "edit"; sprint: Sprint }; actions: SprintActions; onClose: () => void };

/** Criar e editar sprint: nome, objetivo e datas (horário de Brasília). Sem datas, o servidor sugere uma semana depois da última. */
function SprintDialog({ project, now, dialog, actions, onClose }: DialogProps) {
  const id = useId();
  const sprint = dialog.mode === "edit" ? dialog.sprint : undefined;
  const last = useMemo(() => sprintsInOrder(project).at(-1), [project]);
  const suggestedStart = useMemo(() => {
    const end = last ? Date.parse(last.endAt) : NaN;
    return Number.isNaN(end) ? now : end;
  }, [last, now]);
  const [name, setName] = useState(sprint?.name ?? `Sprint ${(project.sprints?.length ?? 0) + 1}`);
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [start, setStart] = useState(toBrasiliaInput(sprint?.startAt ?? new Date(suggestedStart).toISOString()));
  const [end, setEnd] = useState(toBrasiliaInput(sprint?.endAt ?? new Date(suggestedStart + WEEK).toISOString()));
  const [adopt, setAdopt] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loose = sprint ? 0 : looseOpenCount(project);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const startAt = fromBrasiliaInput(start);
    const endAt = fromBrasiliaInput(end);
    if (!name.trim()) return setProblem("Dê um nome à sprint.");
    if (!startAt || !endAt) return setProblem("Preencha o começo e o fim.");
    if (Date.parse(endAt) <= Date.parse(startAt)) return setProblem("O fim precisa ser depois do começo.");
    const ok = sprint
      ? await actions.update(sprint.id, { name: name.trim(), goal: goal.trim() || null, startAt, endAt })
      : await actions.create({ name: name.trim(), ...(goal.trim() ? { goal: goal.trim() } : {}), startAt, endAt, ...(adopt ? { adoptOpen: true } : {}) });
    if (ok) onClose();
  };

  return (
    <Modal title={sprint ? `Editar ${shortSprintName(sprint.name)}` : "Nova sprint"} onClose={onClose} testId="sprint-dialog">
      <form className="w-new" onSubmit={(event) => void submit(event)}>
        <div className="w-new__field">
          <label htmlFor={`${id}-n`}>Nome</label>
          <input id={`${id}-n`} className="ui-input" value={name} maxLength={60} autoFocus onChange={(event) => setName(event.currentTarget.value)} data-testid="sprint-name" />
        </div>
        <div className="w-new__field">
          <label htmlFor={`${id}-g`}>Objetivo (uma frase)</label>
          <textarea id={`${id}-g`} className="ui-input" rows={2} value={goal} maxLength={400} placeholder="Ex.: entrar no app com e-mail e senha" onChange={(event) => setGoal(event.currentTarget.value)} data-testid="sprint-goal" />
        </div>
        <div className="sp-dates">
          <div className="w-new__field">
            <label htmlFor={`${id}-s`}>Começa{brasiliaNote()}</label>
            <input id={`${id}-s`} className="ui-input" type="datetime-local" value={start} onChange={(event) => setStart(event.currentTarget.value)} data-testid="sprint-start-input" />
          </div>
          <div className="w-new__field">
            <label htmlFor={`${id}-e`}>Termina{brasiliaNote()}</label>
            <input id={`${id}-e`} className="ui-input" type="datetime-local" value={end} onChange={(event) => setEnd(event.currentTarget.value)} data-testid="sprint-end-input" />
          </div>
        </div>
        {loose > 0 && (
          <label className="sp-adopt">
            <input type="checkbox" checked={adopt} onChange={(event) => setAdopt(event.currentTarget.checked)} data-testid="sprint-adopt" />
            <span>Pôr nesta sprint as {loose === 1 ? "1 tarefa aberta que está" : `${loose} tarefas abertas que estão`} sem sprint</span>
          </label>
        )}
        <ErrorText>{problem ?? actions.error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="ui-button" disabled={actions.busy} data-testid="sprint-save">
            {actions.busy ? "Salvando…" : sprint ? "Salvar" : "Criar sprint"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
