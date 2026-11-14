import type { Agent, Avatar, OfficeState, Room, Task } from "./types";

/**
 * Sala do Maestro: um quarto especial (`kind: "maestro"`) que todo workspace tem, ao lado do
 * lobby e com porta para ele. Tem só o time interno "Gerência" e um agente, o Maestro, que
 * enxerga o Cérebro de todos os quartos do workspace (veja buildContext).
 */
export const MAESTRO = {
  roomId: "sala-do-maestro",
  roomName: "Sala do Maestro",
  roomTheme: "terracotta",
  teamName: "Gerência",
  teamFocus: "coordenar os times do workspace",
  agentId: "maestro",
  agentName: "Maestro",
  role: "maestro",
  instructions:
    "Você é o Maestro do workspace: conhece todas as salas e times, divide os pedidos em tarefas e escolhe quem faz cada uma.",
} as const;

/** Visual marcante: cabelo branco, camisa vinho, cachecol e calça escura. */
export const MAESTRO_AVATAR: Avatar = {
  skin: "tone3",
  hair: "short",
  hairColor: "cloud",
  shirt: "wine",
  pants: "charcoal",
  accessory: "scarf",
};

type Structure = Pick<OfficeState, "rooms" | "teams" | "agents">;

export const isMaestroRoom = (room: Pick<Room, "kind">): boolean => room.kind === "maestro";

/** A Sala do Maestro do escritório (ou undefined se ainda não existe). */
export function findMaestroRoom(office: Pick<Structure, "rooms">): Room | undefined {
  return office.rooms.find(isMaestroRoom);
}

/** Ids dos times que ficam na Sala do Maestro (na prática, só a "Gerência"). */
export function maestroTeamIds(office: Pick<Structure, "rooms" | "teams">): Set<string> {
  const room = findMaestroRoom(office);
  return new Set(office.teams.filter((team) => room && team.roomId === room.id).map((team) => team.id));
}

/** O agente é o Maestro (está num time da Sala do Maestro)? */
export function isMaestroAgent(office: Pick<Structure, "rooms" | "teams">, agent: Pick<Agent, "teamId">): boolean {
  return maestroTeamIds(office).has(agent.teamId);
}

/** O agente Maestro do escritório (ou undefined se ainda não existe). */
export function findMaestroAgent(office: Structure): Agent | undefined {
  const teams = maestroTeamIds(office);
  return office.agents.find((agent) => teams.has(agent.teamId));
}

/**
 * A tarefa é o registro de um pedido do Maestro (`role: "request"`)? Essas não passam pelo runner: o
 * Maestro faz a triagem, delega e fecha quando o trabalho termina. Regra antiga (compat com dados
 * sem `role`): atribuída ao Maestro e sem `projectId`.
 */
export function isMaestroTask(office: Structure, task: Pick<Task, "agentId" | "projectId"> & { role?: Task["role"] }): boolean {
  if (task.role === "request") return true;
  if (task.role !== undefined || task.projectId !== undefined || task.agentId === undefined) return false;
  return findMaestroAgent(office)?.id === task.agentId;
}

/** Tarefas (etapas) de um projeto, em ordem de criação. */
export function stepsOf<T extends Pick<Task, "projectId">>(tasks: readonly T[], projectId: string): T[] {
  return tasks.filter((task) => task.projectId === projectId);
}

/** @deprecated use `stepsOf`. */
export const subtasksOf = stepsOf;

/** Textos fixos do fluxo do Maestro (server e web usam os mesmos). */
export const MAESTRO_TEXTS = {
  /** Pergunta da tarefa que ficou "esperando você" porque o workspace não tem time. */
  noTeam: "Não há time para isso: crie uma sala e um time",
  /** Há times, mas nenhum com agentes. */
  noAgents: "Nenhum time tem agentes: adicione um agente a um time",
  triage: "Analisando o pedido…",
  delegated: (team: string) => `Delegada ao time ${team}`,
  waitingTeam: (team: string) => `O time ${team} pede sua aprovação`,
  review: (team: string) => `Revisando a entrega do time ${team}`,
  /** Começo do status que abre o log de um pedido que o próprio Maestro abriu numa conversa (`open_request`). */
  openedByMaestro: "Pedido aberto pelo Maestro",
} as const;
