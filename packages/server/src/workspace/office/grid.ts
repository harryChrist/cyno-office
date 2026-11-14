import { gridKey, isLobbyCell, LOBBY_GRID_POSITION, type GridPosition, type Room } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";

/** 409 se a célula é do lobby ou de outro quarto. */
export function assertCellFree(rooms: Room[], cell: GridPosition, ignoreId?: string): void {
  if (isLobbyCell(cell)) throw new HttpError(409, "A célula (0,0) é do lobby");
  const owner = rooms.find((ws) => ws.id !== ignoreId && gridKey(ws.gridPosition) === gridKey(cell));
  if (owner) throw new HttpError(409, `A célula (${gridKey(cell)}) já está ocupada por "${owner.name}"`);
}

/** Células a distância `d` do lobby (Manhattan): quadrante positivo primeiro, depois por y e x. */
function ring(d: number): GridPosition[] {
  const cells: GridPosition[] = [];
  for (let x = -d; x <= d; x++) {
    const rest = d - Math.abs(x);
    cells.push({ x, y: rest });
    if (rest !== 0) cells.push({ x, y: -rest });
  }
  const negative = (cell: GridPosition) => (cell.x < 0 || cell.y < 0 ? 1 : 0);
  return cells.sort((a, b) => negative(a) - negative(b) || a.y - b.y || a.x - b.x);
}

/** Primeira célula livre mais perto do lobby. */
export function findFreeCell(rooms: Room[]): GridPosition {
  const taken = new Set([gridKey(LOBBY_GRID_POSITION), ...rooms.map((ws) => gridKey(ws.gridPosition))]);
  for (let d = 1; ; d++) {
    const free = ring(d).find((cell) => !taken.has(gridKey(cell)));
    if (free) return free;
  }
}
