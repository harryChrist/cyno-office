import type { Agent, Team, Room } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";

function find<T extends { id: string }>(items: T[], id: string, notFound: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError(404, notFound);
  return item;
}

export const requireRoom = (items: Room[], id: string) =>
  find(items, id, `Sala "${id}" não encontrada`);
export const requireTeam = (items: Team[], id: string) => find(items, id, `Time "${id}" não encontrado`);
export const requireAgent = (items: Agent[], id: string) => find(items, id, `Agente "${id}" não encontrado`);

/** Copia só os campos definidos (PATCH parcial). */
export function definedFields<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}
