import { isActiveTaskStatus, subtasksOf, type Agent, type OfficeState, type Room, type Task, type Team } from "@cyno/shared";

/** Uma tarefa que o Maestro coordena, com a subtarefa (a mais recente) e quem está nela. */
export type Coordination = {
  task: Task;
  subtask?: Task;
  team?: Team;
  room?: Room;
  agent?: Agent;
};

export function coordinationOf(office: OfficeState, task: Task): Coordination {
  const subtask = subtasksOf(office.tasks, task.id).at(-1);
  if (!subtask) return { task };
  return {
    task,
    subtask,
    team: office.teams.find((team) => team.id === subtask.teamId),
    room: office.rooms.find((room) => room.id === subtask.roomId),
    agent: office.agents.find((agent) => agent.id === subtask.agentId),
  };
}

/** Tarefas ativas que o Maestro coordena, mais antigas primeiro. */
export function coordinatedTasks(office: OfficeState, maestroId: string): Coordination[] {
  return office.tasks
    .filter((task) => task.agentId === maestroId && task.projectId === undefined && isActiveTaskStatus(task.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((task) => coordinationOf(office, task));
}

/** O que a caixa de tarefa diz sobre um pedido enviado ao Maestro. */
export type MaestroFeedback =
  | { kind: "sent" }
  | { kind: "delegated"; teamName: string; reason?: string; agent?: Agent; status: Task["status"] }
  | { kind: "waiting"; question: string };

export function maestroFeedback(office: OfficeState | null, taskId: string): MaestroFeedback {
  const task = office?.tasks.find((candidate) => candidate.id === taskId);
  if (!office || !task) return { kind: "sent" };
  const { subtask, team, agent } = coordinationOf(office, task);
  if (subtask) return { kind: "delegated", teamName: team?.name ?? subtask.teamId, reason: task.routeReason, agent, status: task.status };
  if (task.status === "waiting_approval" && task.routeReason) return { kind: "waiting", question: task.routeReason };
  return { kind: "sent" };
}
