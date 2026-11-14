import { isReservedRoomId, isSafeId } from "./ids";
import type { GridPosition, OfficeState } from "./types";

/** O lobby ocupa a célula (0,0) do grid. */
export const LOBBY_GRID_POSITION: Readonly<GridPosition> = { x: 0, y: 0 };

export function gridKey(position: GridPosition): string {
  return `${position.x},${position.y}`;
}

export function isLobbyCell(position: GridPosition): boolean {
  return position.x === LOBBY_GRID_POSITION.x && position.y === LOBBY_GRID_POSITION.y;
}

type OfficeStructure = Pick<OfficeState, "rooms" | "teams" | "agents">;

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

/**
 * Regras estruturais do escritório (além dos schemas zod). Retorna a lista de
 * violações em pt-BR; vazia = estado válido.
 */
export function findOfficeRuleViolations(office: OfficeStructure): string[] {
  const problems: string[] = [];
  const collections = { quarto: office.rooms, time: office.teams, agente: office.agents };
  for (const [label, items] of Object.entries(collections)) {
    const ids = items.map((item) => item.id);
    for (const id of findDuplicates(ids)) problems.push(`${label} com id repetido: "${id}"`);
    for (const id of ids.filter((value) => !isSafeId(value))) {
      problems.push(`${label} com id inválido: "${id}"`);
    }
  }

  const roomsById = new Map(office.rooms.map((ws) => [ws.id, ws]));
  const occupied = new Map<string, string>();
  for (const ws of office.rooms) {
    if (isReservedRoomId(ws.id)) problems.push(`quarto usa id reservado: "${ws.id}"`);
    if (isLobbyCell(ws.gridPosition)) problems.push(`quarto "${ws.id}" ocupa a célula do lobby (0,0)`);
    const key = gridKey(ws.gridPosition);
    const owner = occupied.get(key);
    if (owner) problems.push(`quartos "${owner}" e "${ws.id}" ocupam a mesma célula (${key})`);
    else occupied.set(key, ws.id);

    for (const id of findDuplicates(ws.readsBrainsOf)) {
      problems.push(`quarto "${ws.id}" repete o Cérebro lido "${id}"`);
    }
    for (const otherId of ws.readsBrainsOf) {
      if (otherId === ws.id) problems.push(`quarto "${ws.id}" lista o próprio Cérebro em readsBrainsOf`);
      else if (!roomsById.has(otherId)) problems.push(`quarto "${ws.id}" lê o Cérebro de um quarto inexistente "${otherId}"`);
    }
  }

  const maestroRooms = office.rooms.filter((room) => room.kind === "maestro");
  if (maestroRooms.length > 1) {
    problems.push(`mais de uma Sala do Maestro: ${maestroRooms.map((room) => `"${room.id}"`).join(", ")}`);
  }

  const teamIds = new Set(office.teams.map((team) => team.id));
  for (const team of office.teams) {
    if (!roomsById.has(team.roomId)) {
      problems.push(`time "${team.id}" aponta para quarto inexistente "${team.roomId}"`);
    }
  }
  for (const agent of office.agents) {
    if (!teamIds.has(agent.teamId)) {
      problems.push(`agente "${agent.id}" aponta para time inexistente "${agent.teamId}"`);
    }
  }
  return problems;
}
