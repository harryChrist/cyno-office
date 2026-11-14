import {
  agentFieldsFromChoice,
  findMaestroRoom,
  gridKey,
  LOBBY_GRID_POSITION,
  MAESTRO,
  MAESTRO_AVATAR,
  RESERVED_ROOM_IDS,
  uniqueSlug,
  type Avatar,
  type GridPosition,
  type ModelChoice,
  type Room,
  type Task,
} from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import type { OfficeStructure } from "../../store/files";
import { findFreeCell } from "./grid";

/** Células vizinhas do lobby, na ordem de preferência para a Sala do Maestro. */
const NEXT_TO_LOBBY: GridPosition[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
].map((d) => ({ x: LOBBY_GRID_POSITION.x + d.x, y: LOBBY_GRID_POSITION.y + d.y }));

function maestroCell(rooms: Room[]): GridPosition {
  const taken = new Set(rooms.map((room) => gridKey(room.gridPosition)));
  return NEXT_TO_LOBBY.find((cell) => !taken.has(gridKey(cell))) ?? findFreeCell(rooms);
}

export type EnsureMaestroInput = {
  office: OfficeStructure;
  /** Histórico de tarefas: ids de times/agentes que já apareceram nele não são reaproveitados. */
  tasks?: Task[];
  /** Ids que o quarto não pode usar (ex.: pastas de Cérebro já no disco). */
  takenRoomIds?: Iterable<string>;
  /**
   * Motor/modelo/esforço do Maestro, se ele for criado agora (workspace novo: o padrão `maestro` do
   * workspace). Ausente = simulado (workspaces antigos migrados não mudam de motor sozinhos).
   */
  maestro?: ModelChoice;
  /** Nome, aparência e instruções do Maestro, se ele for criado agora (ausentes = os padrões). */
  profile?: MaestroProfile;
};

/** O que o usuário escolhe do Maestro ao criar o workspace (o id do agente não muda com o nome). */
export type MaestroProfile = { name?: string; avatar?: Avatar; instructions?: string };

/**
 * Garante a Sala do Maestro (quarto `kind: "maestro"`, ao lado do lobby e com porta para ele),
 * o time interno "Gerência" e o agente Maestro. Função pura: devolve o escritório completo
 * (cópia) e `changed` se algo foi criado. Serve para o seed, para workspaces novos e para a
 * migração de workspaces antigos.
 */
export function ensureMaestro({ office, tasks = [], takenRoomIds = [], maestro, profile }: EnsureMaestroInput): {
  office: OfficeStructure;
  changed: boolean;
} {
  const next = structuredClone(office);
  let changed = false;

  let room = findMaestroRoom(next);
  if (!room) {
    room = {
      id: uniqueSlug(MAESTRO.roomId, [...next.rooms.map((r) => r.id), ...takenRoomIds], RESERVED_ROOM_IDS),
      kind: "maestro",
      name: MAESTRO.roomName,
      theme: MAESTRO.roomTheme,
      gridPosition: maestroCell(next.rooms),
      readsGlobalBrain: true,
      readsBrainsOf: [],
    };
    next.rooms.push(room);
    changed = true;
  }

  let team = next.teams.find((candidate) => candidate.roomId === room.id);
  if (!team) {
    const takenTeams = [...next.teams.map((t) => t.id), ...tasks.map((task) => task.teamId)];
    team = { id: uniqueSlug(`${room.id} gerencia`, takenTeams), roomId: room.id, name: MAESTRO.teamName, focus: MAESTRO.teamFocus };
    next.teams.push(team);
    changed = true;
  }

  const teamIds = new Set(next.teams.filter((t) => t.roomId === room.id).map((t) => t.id));
  if (!next.agents.some((agent) => teamIds.has(agent.teamId))) {
    const takenAgents = [...next.agents.map((a) => a.id), ...tasks.flatMap((task) => (task.agentId ? [task.agentId] : []))];
    next.agents.push({
      id: uniqueSlug(MAESTRO.agentId, takenAgents),
      teamId: team.id,
      name: profile?.name?.trim() || MAESTRO.agentName,
      role: MAESTRO.role,
      instructions: profile?.instructions?.trim() || MAESTRO.instructions,
      avatar: { ...(profile?.avatar ?? MAESTRO_AVATAR) },
      status: "idle",
      ...(maestro ? agentFieldsFromChoice(maestro) : {}),
    });
    changed = true;
  }
  return { office: next, changed };
}

/** Mensagens das regras da Sala do Maestro (todas 409). */
export const MAESTRO_RULES = {
  deleteRoom: "A Sala do Maestro não pode ser excluída",
  teamInRoom: "A Sala do Maestro não tem times normais",
  moveTeam: "A Gerência fica sempre na Sala do Maestro",
  deleteTeam: "A Gerência não pode ser excluída",
  agentInRoom: "A Sala do Maestro tem só o Maestro",
  moveAgent: "O Maestro não troca de time",
  changeRole: "O papel do Maestro não muda",
  deleteAgent: "O Maestro não pode ser excluído",
} as const;

export function maestroConflict(message: string): HttpError {
  return new HttpError(409, message);
}
