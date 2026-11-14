import type { OfficeState } from "@cyno/shared";
import { useMemo } from "react";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { coordinatedTasks, type Coordination } from "./maestro";
import { CurrentTask } from "./TaskViews";

function Delegation({ item }: { item: Coordination }) {
  const select = useViewStore((state) => state.select);
  const { subtask, team, room, agent } = item;
  if (!subtask) return null;
  return (
    <p className="ui-muted" data-testid="maestro-delegation">
      Com o time {team?.name ?? subtask.teamId}
      {room ? ` (${room.name})` : ""}
      {agent && (
        <>
          {" · "}
          <button type="button" className="ui-link" onClick={() => select({ kind: "agent", id: agent.id })}>
            {agent.name}
          </button>
        </>
      )}
    </p>
  );
}

/** Painel do Maestro: as tarefas que ele está coordenando (triagem, delegada, esperando você, revisão). */
export function MaestroCoordination({ office, maestroId }: { office: OfficeState; maestroId: string }) {
  const items = useMemo(() => coordinatedTasks(office, maestroId), [office, maestroId]);
  const progress = useOfficeStore((state) => state.progress);
  return (
    <section className="panel-section" aria-labelledby="maestro-coordination-title">
      <h3 id="maestro-coordination-title" className="panel-section__title">
        Coordenando <span className="ui-muted">({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p className="ui-muted ui-empty" data-testid="agent-no-task">
          Nada agora. Peça algo pela caixa de tarefa: o Maestro escolhe o time.
        </p>
      ) : (
        <ol className="history" data-testid="maestro-coordination">
          {items.map((item) => (
            <li key={item.task.id} className="maestro-coordination__item">
              <CurrentTask task={item.task} progress={progress[item.task.id]} queued={0} />
              <Delegation item={item} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
