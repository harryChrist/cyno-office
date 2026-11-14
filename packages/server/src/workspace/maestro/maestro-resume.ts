import { isActiveTaskStatus, isSeedId, subtasksOf, type OfficeState, type Task } from "@cyno/shared";
import type { MaestroCore } from "./maestro-core";
import type { MaestroForYou } from "./maestro-for-you";
import type { MaestroSession } from "./maestro-session";
import { restartResume } from "./maestro-text";
import type { MaestroTurns } from "./maestro-turns";

/** O que o boot do Maestro pede emprestado à classe `CliMaestro`. */
export type ResumeParts = {
  core: MaestroCore;
  enabled: (state: OfficeState) => boolean;
  submit: (task: Task) => void;
  session: MaestroSession;
  turns: MaestroTurns;
  forYou: MaestroForYou;
};

/** Boot: retoma os pedidos abertos (com um resumo das subtarefas, inclusive as que acabaram enquanto o server estava fora). */
export function resumeOpenRequests({ core, enabled, submit, session, turns, forYou }: ResumeParts): void {
  const { deps } = core;
  const state = deps.state.read();
  if (!enabled(state)) return;
  for (const task of state.tasks) {
    // Pedido fabricado pela semente do app de teste: não acorda o Maestro (seria um turno pago por um pedido inventado).
    if (!core.owns(state, task) || !isActiveTaskStatus(task.status) || isSeedId(task.id)) continue;
    const subtasks = subtasksOf(state.tasks, task.id);
    for (const subtask of subtasks) if (!isActiveTaskStatus(subtask.status)) turns.markNotified(subtask.id);
    if (task.status === "waiting_approval") {
      const pending = deps.state.readForYou().filter((candidate) => candidate.taskId === task.id && candidate.status === "pendente");
      const item = pending.at(-1);
      if (item) {
        // Plano para aprovar e questionário esperam o usuário sem acordar o Maestro; cada aprovação aberta é restaurada.
        for (const open of pending) if (open.kind === undefined || open.kind === "aprovacao") forYou.restorePending(task.id, open.id, open.why ?? open.text);
        core.setProgress(task, 0.5, item.why ?? "Esperando você");
        continue;
      }
      if (task.waiting) {
        core.setProgress(task, 0.5, task.waiting);
        continue;
      }
      core.setTask(state, task, { status: "in_progress" });
    }
    // Plano aprovado rodando (ou esperando ajuste): o servidor segue distribuindo; o Maestro é chamado no fim.
    if (deps.plans?.()?.holds(task.id)) {
      core.setProgress(task, 0.3, "Plano em andamento");
      continue;
    }
    if (task.status === "queued") {
      submit(task);
      continue;
    }
    const next = restartResume(task, subtasks, (agentId) => core.agentName(state, agentId));
    if ("wake" in next) {
      core.setProgress(task, 0.3, "Retomando depois de um reinício");
      session.push(task.id, next.wake);
      continue;
    }
    // Subtarefas ainda andando: o fim delas acorda o Maestro (sem turno pago só para dizer "reiniciou").
    if (next.notice) session.addNotice(next.notice);
    core.setProgress(task, 0.3, "Esperando as subtarefas");
  }
  deps.refreshStatus();
}
