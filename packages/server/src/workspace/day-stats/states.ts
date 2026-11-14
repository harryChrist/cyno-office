import { taskState, type AgentTerminalInfo, type Project, type Task } from "@cyno/shared";
import type { DesiredSpan } from "./state-clock";

/**
 * O estado de cada tarefa agora, a partir do que o servidor sabe (tarefas, projetos, terminais): é o que o
 * relógio de estados compara com os trechos abertos. Só entram as tarefas que contam (`taskState` != null) e
 * que têm um agente.
 */
export function currentStates(input: { tasks: readonly Task[]; projects: readonly Project[]; terminals: Readonly<Record<string, AgentTerminalInfo>> }): DesiredSpan[] {
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const out: DesiredSpan[] = [];
  for (const task of input.tasks) {
    if (!task.agentId) continue;
    const project = task.work ? projects.get(task.work.projectId) : undefined;
    const planTask = task.work ? project?.tasks.find((candidate) => candidate.ref === task.work!.ref) : undefined;
    const state = taskState({ task, ...(project ? { project } : {}), ...(planTask ? { planTask } : {}), ...(input.terminals[task.agentId] ? { terminal: input.terminals[task.agentId]!.status } : {}) });
    if (!state) continue;
    out.push({
      taskId: task.id,
      state,
      agentId: task.agentId,
      ...(task.work ? { projectId: task.work.projectId } : {}),
      ...(planTask?.sprintId ? { sprintId: planTask.sprintId } : {}),
    });
  }
  return out;
}
