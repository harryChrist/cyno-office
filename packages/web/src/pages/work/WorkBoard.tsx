import { type Agent } from "@cyno/shared";
import { useId } from "react";
import { countLabel } from "../../ui/format";
import { AgentTag } from "./Agent";
import { DeliveryHead } from "./DeliveryHead";
import { deadlineOf, spanLabel, taskState, type WorkBoardColumn, type WorkCard } from "./workView";

type BoardProps = {
  columns: readonly WorkBoardColumn[];
  agents: ReadonlyMap<string, Agent>;
  now: number;
  onOpenCard: (card: WorkCard) => void;
  onOpenProject: (projectId: string) => void;
};

function Card({ card, agents, now, onOpenCard, onOpenProject }: { card: WorkCard } & Omit<BoardProps, "columns">) {
  const { task, project } = card;
  const agentId = task.steps[task.current]?.agentId ?? task.ownerId;
  const state = taskState(task);
  const deadline = deadlineOf({ dueAt: task.dueAt ?? project.dueAt, status: project.status }, now);
  const done = task.steps.filter((step) => step.status === "feita").length;
  return (
    <article className={`w-card w-card--${card.column}`} data-testid={`work-card-${project.id}-${task.ref}`} data-task-ref={task.ref} data-status={task.status}>
      <button type="button" className="w-card__open" onClick={() => onOpenCard(card)} aria-haspopup="dialog" title={task.title}>
        <span className="w-card__title">{task.title}</span>
      </button>
      <p className="w-card__project">
        <span className={`w-prio w-prio--${task.priority}`} role="img" aria-label={`Prioridade ${task.priority}`} />
        <button type="button" className="ui-link" onClick={() => onOpenProject(project.id)}>
          {project.kind === "projeto" ? `${task.ref} · ${project.title}` : "Tarefa avulsa"}
        </button>
      </p>
      {card.column === "done" && task.result && <DeliveryHead text={task.result} className="dh--card" testId="work-card-delivery" />}
      <AgentTag agent={agents.get(agentId)} fallback={agentId} />
      <p className="w-card__meta">
        {card.column === "blocked" && (
          <span className="w-chip w-chip--block" title={card.block?.note ?? task.failure}>
            {card.paused ? "Projeto pausado" : task.status === "falhou" ? "Falhou" : (card.block?.label ?? state.label)}
            {card.block?.since ? ` · há ${spanLabel(now - Date.parse(card.block.since))}` : ""}
          </span>
        )}
        {card.column === "waiting" && <span className="w-chip w-chip--wait">Esperando você</span>}
        {task.steps.length > 1 && (
          <span className="w-chip">
            Etapa {Math.min(done + 1, task.steps.length)} de {task.steps.length}
          </span>
        )}
        {task.status === "backlog" && task.dependsOn.length > 0 && <span className="w-chip">Depois de {task.dependsOn.join(", ")}</span>}
        {deadline && card.column !== "done" && <span className={`w-chip w-chip--due w-chip--due-${deadline.state}`}>Prazo {deadline.label}</span>}
      </p>
      {task.failure && card.column === "blocked" && <p className="w-card__note w-card__note--error">{task.failure}</p>}
    </article>
  );
}

function Column({ column, ...rest }: { column: WorkBoardColumn } & Omit<BoardProps, "columns">) {
  const titleId = useId();
  return (
    <section className={`w-col w-col--${column.id}`} aria-labelledby={titleId} data-testid={`work-col-${column.id}`}>
      <header className="w-col__head">
        <h3 id={titleId} className="w-col__title">
          {column.title}
        </h3>
        <span className="w-col__count" aria-label={countLabel(column.count, "tarefa", "tarefas")} data-testid={`work-col-count-${column.id}`}>
          {column.count}
        </span>
      </header>
      {column.cards.length === 0 ? (
        <p className="w-col__empty">Nada aqui</p>
      ) : (
        <ul className="w-col__list">
          {column.cards.map((card) => (
            <li key={card.key}>
              <Card card={card} {...rest} />
            </li>
          ))}
          {column.count > column.cards.length && <li className="w-col__more">Mostrando as {column.cards.length} mais recentes de {column.count}.</li>}
        </ul>
      )}
    </section>
  );
}

/** Quadro: A fazer, Fazendo, Esperando você, Parada e Feita; os cartões são tarefas (de projetos e avulsas). */
export function WorkBoard({ columns, ...rest }: BoardProps) {
  return (
    <div className="w-board" data-testid="work-board">
      {columns.map((column) => (
        <Column key={column.id} column={column} {...rest} />
      ))}
    </div>
  );
}
