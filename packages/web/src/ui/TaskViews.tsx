import type { Task } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../api/client";
import { useForYouFocus } from "../store/forYouFocus";
import { pendingItemForTask } from "../store/forYouItems";
import { useOfficeStore } from "../store/officeStore";
import type { TaskProgress } from "../store/taskProgress";
import { TaskCostChip } from "./AgentUsageChips";
import { formatDateTime, percent, ranWithLabel, TASK_STATUS_LABELS } from "./format";
import { useAsyncAction } from "./useAsyncAction";
import { Markdown } from "../ui/markdown/Markdown";
import { ErrorText, ProgressBar, StatusBadge } from "./widgets";

/** "Abrir em Aprovações": leva ao item pendente da tarefa (ou da subtarefa, no Maestro). */
function OpenInForYou({ taskId }: { taskId: string }) {
  const itemId = useOfficeStore((state) => pendingItemForTask(state.forYou, state.office?.tasks ?? [], taskId)?.id);
  if (!itemId) return null;
  return (
    <button type="button" className="ui-link approval__open" onClick={() => useForYouFocus.getState().open(itemId)} data-testid="task-open-foryou">
      Abrir em Aprovações
    </button>
  );
}

/**
 * Aprovar/Recusar uma tarefa em waiting_approval (atalho: decide o item ligado no "Para você",
 * sem editar o texto) e o link para abrir o item lá. Some quando o status muda (via WS).
 */
export function ApprovalButtons({ taskId, describedBy }: { taskId: string; describedBy?: string }) {
  const { pending, error, run } = useAsyncAction();
  // Depois de decidir, fica travado até o evento do WebSocket tirar a tarefa deste estado.
  const [decided, setDecided] = useState(false);
  const decide = async (approved: boolean) => {
    const ok = await run(async () => {
      await api.decideApproval(taskId, approved);
      return true;
    });
    if (ok) setDecided(true);
  };
  const disabled = pending || decided;
  return (
    <div className="approval" role="group" aria-label="Aprovação da tarefa">
      <button type="button" className="ui-button ui-button--success" onClick={() => void decide(true)} disabled={disabled} aria-describedby={describedBy} data-testid="task-approve">
        Aprovar
      </button>
      <button type="button" className="ui-button ui-button--danger" onClick={() => void decide(false)} disabled={disabled} aria-describedby={describedBy} data-testid="task-reject">
        Recusar
      </button>
      <OpenInForYou taskId={taskId} />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

type CurrentTaskProps = { task: Task; progress?: TaskProgress; queued: number };

/** Tarefa atual do agente: pedido, status, barra de progresso, última mensagem e aprovação. */
export function CurrentTask({ task, progress, queued }: CurrentTaskProps) {
  const promptId = useId();
  const waiting = task.status === "waiting_approval";
  return (
    <div className={`current-task${waiting ? " current-task--attention" : ""}`} data-testid="agent-current-task" data-task-id={task.id} data-status={task.status}>
      <div className="current-task__head">
        <StatusBadge status={task.status} label={TASK_STATUS_LABELS[task.status]} testId="agent-current-status" />
        <span className="ui-muted">{formatDateTime(task.createdAt)}</span>
      </div>
      <p id={promptId} className="current-task__prompt">
        {task.prompt}
      </p>
      {task.status !== "queued" && (
        <div className="current-task__progress">
          <ProgressBar value={progress?.progress ?? 0} label="Progresso da tarefa" testId="agent-progress" />
          <span className="current-task__percent">{percent(progress?.progress ?? 0)}</span>
        </div>
      )}
      {ranWithLabel(task) && (
        <p className="ui-muted" data-testid="agent-current-model">
          Rodando com {ranWithLabel(task)}
        </p>
      )}
      {task.routeReason && task.routeReason !== progress?.message && (
        <p className="ui-muted" data-testid="task-route-reason">
          Maestro: {task.routeReason}
        </p>
      )}
      {progress?.message && (
        <p className="current-task__message" data-testid="agent-progress-message">
          “{progress.message}”
        </p>
      )}
      {waiting && !progress?.message && <p className="current-task__message">{task.waiting ?? "O agente quer sua aprovação para continuar."}</p>}
      {waiting && <ApprovalButtons taskId={task.id} describedBy={promptId} />}
      {queued > 0 && <p className="ui-muted">+{queued} na fila</p>}
      <TaskCostChip taskId={task.id} />
    </div>
  );
}

/** Uma linha do histórico: status, data, pedido e o resultado (expansível). */
export function TaskHistoryItem({ task }: { task: Task }) {
  return (
    <li className="history-item" data-testid={`history-task-${task.id}`} data-task-id={task.id} data-status={task.status}>
      <div className="history-item__head">
        <StatusBadge status={task.status} label={TASK_STATUS_LABELS[task.status]} testId="history-status" />
        <time className="ui-muted" dateTime={task.createdAt}>
          {formatDateTime(task.createdAt)}
        </time>
      </div>
      <p className="history-item__prompt" title={task.prompt}>
        {task.prompt}
      </p>
      {task.routeReason && <p className="ui-muted">Maestro: {task.routeReason}</p>}
      <TaskCostChip taskId={task.id} />
      {ranWithLabel(task) && (
        <p className="ui-muted" data-testid="history-model">
          Rodou com {ranWithLabel(task)}
        </p>
      )}
      {task.result && (
        <details className="history-item__result">
          <summary>Resultado</summary>
          <div className="history-item__md" data-testid="history-result">
            <Markdown source={task.result} resolveWiki={() => null} headingOffset={3} className="md--compact" />
          </div>
        </details>
      )}
    </li>
  );
}
