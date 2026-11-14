import {
  BRAIN_SOURCE_LABELS,
  isActiveTaskStatus,
  LOBBY_ID,
  type Agent,
  type BrainContext,
  type BrainSourceKind,
  type OfficeState,
  type Task,
  type Team,
  type Room,
} from "@cyno/shared";
import type { Focus } from "../store/viewStore";

export type AgentDetails = { agent: Agent; team: Team | undefined; room: Room | undefined };

export function findAgentDetails(office: OfficeState, agentId: string): AgentDetails | null {
  const agent = office.agents.find((current) => current.id === agentId);
  if (!agent) return null;
  const team = office.teams.find((current) => current.id === agent.teamId);
  const room = team ? office.rooms.find((current) => current.id === team.roomId) : undefined;
  return { agent, team, room };
}

/** Mais recentes primeiro (createdAt desc; desempate por id desc). Não muda a lista original. */
export function newestFirst(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function agentTasks(tasks: readonly Task[], agentId: string): Task[] {
  return newestFirst(tasks.filter((task) => task.agentId === agentId));
}

export type CurrentWork = { task: Task | null; queued: number };

/**
 * A tarefa "atual" de um agente: a que espera aprovação, senão a em andamento, senão a mais
 * antiga da fila (é a próxima a rodar). `queued` conta as que esperam na fila além dela.
 */
export function currentWork(tasks: readonly Task[], agentId: string): CurrentWork {
  const mine = tasks.filter((task) => task.agentId === agentId && isActiveTaskStatus(task.status));
  const oldestFirst = [...mine].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const task =
    oldestFirst.find((t) => t.status === "waiting_approval") ??
    oldestFirst.find((t) => t.status === "in_progress") ??
    oldestFirst.find((t) => t.status === "queued") ??
    null;
  const queued = mine.filter((t) => t.status === "queued" && t !== task).length;
  return { task, queued };
}

export type TeamWithAgents = { team: Team; agents: Agent[] };

export function roomTeams(office: OfficeState, roomId: string): TeamWithAgents[] {
  return office.teams
    .filter((team) => team.roomId === roomId)
    .map((team) => ({ team, agents: office.agents.filter((agent) => agent.teamId === team.id) }));
}

export type RoomShortcut = { id: string; name: string };

/** Atalhos de navegação: lobby primeiro e depois os quartos, na ordem do grid (linha, coluna). */
export function roomShortcuts(rooms: readonly Room[]): RoomShortcut[] {
  const sorted = [...rooms]
    .sort((a, b) => a.gridPosition.y - b.gridPosition.y || a.gridPosition.x - b.gridPosition.x || a.name.localeCompare(b.name, "pt-BR"))
    .map((room) => ({ id: room.id, name: room.name }));
  return [{ id: LOBBY_ID, name: "Lobby" }, ...sorted];
}

export function isFocusedOn(focus: Focus, id: string): boolean {
  return focus.kind === "room" && focus.id === id;
}

/** Lista completa de Cérebros lidos por `room` depois de ligar/desligar `otherId`. */
export function toggledReads(room: Room, otherId: string, on: boolean): string[] {
  const others = room.readsBrainsOf.filter((id) => id !== otherId);
  return on ? [...others, otherId] : others;
}

/** `notes`: o que entra no contexto (fixas + notas escolhidas); `omitted`: notas visíveis que ficaram de fora (o agente busca). */
export type BrainSourceSummary = { kind: BrainSourceKind; id: string; label: string; name: string; notes: string[]; omitted: number };
export type BrainSummary = {
  sources: BrainSourceSummary[];
  /** O que o quarto NÃO enxerga, e por quê (para deixar o isolamento explícito). */
  hidden: { id: string; name: string; reason: string }[];
  totalNotes: number;
};

/** Resume o preview do Cérebro: fontes vistas (com nº de notas) e fontes que ficam de fora. */
export function summarizeBrain(context: BrainContext, room: Room, rooms: readonly Room[]): BrainSummary {
  const sources = context.sources.map((source) => ({
    kind: source.kind,
    id: source.id,
    label: BRAIN_SOURCE_LABELS[source.kind],
    name: source.name,
    notes: source.notes.map((note) => note.title || note.file),
    omitted: source.omitted?.length ?? 0,
  }));
  const seen = new Set(context.sources.filter((source) => source.kind !== "lobby").map((source) => source.id));
  const hidden: BrainSummary["hidden"] = [];
  if (!context.sources.some((source) => source.kind === "lobby")) {
    hidden.push({ id: LOBBY_ID, name: "Lobby (Cérebro global)", reason: "não lê o Cérebro global" });
  }
  for (const other of rooms) {
    if (other.id === room.id || seen.has(other.id)) continue;
    hidden.push({ id: other.id, name: other.name, reason: "fora da lista de Cérebros lidos" });
  }
  return { sources, hidden, totalNotes: sources.reduce((sum, source) => sum + source.notes.length, 0) };
}

/** Times e agentes que um quarto perde ao ser excluído (para a confirmação). */
export function roomFootprint(office: OfficeState, roomId: string): { teams: number; agents: number; activeTasks: number } {
  const teamIds = new Set(office.teams.filter((team) => team.roomId === roomId).map((team) => team.id));
  return {
    teams: teamIds.size,
    agents: office.agents.filter((agent) => teamIds.has(agent.teamId)).length,
    activeTasks: office.tasks.filter((task) => task.roomId === roomId && isActiveTaskStatus(task.status)).length,
  };
}

/** O que some ao excluir um time: os agentes dele e as tarefas ativas do time (canceladas). */
export function teamFootprint(office: OfficeState, teamId: string): { agents: Agent[]; activeTasks: number } {
  return {
    agents: office.agents.filter((agent) => agent.teamId === teamId),
    activeTasks: office.tasks.filter((task) => task.teamId === teamId && isActiveTaskStatus(task.status)).length,
  };
}

export type TeamGroup = { room: Room; teams: Team[] };

/** Times agrupados por quarto (na ordem do grid), para escolher o time de um agente. */
export function teamsByRoom(office: OfficeState): TeamGroup[] {
  const order = roomShortcuts(office.rooms).map((room) => room.id);
  return order.flatMap((id) => {
    const room = office.rooms.find((current) => current.id === id);
    const teams = office.teams.filter((team) => team.roomId === id);
    return room && teams.length > 0 ? [{ room, teams }] : [];
  });
}

/** Junta nomes em pt-BR: "Ana", "Ana e Bia", "Ana, Bia e Caio". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}
