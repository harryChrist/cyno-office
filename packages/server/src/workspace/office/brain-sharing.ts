import type { Room } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { requireRoom } from "./lookup";

/**
 * Troca a lista completa de quartos cujos Cérebros `id` lê. Não é simétrica (ler o Cérebro de
 * um quarto não faz o outro ler o seu) e não depende de portas nem de vizinhança no grid.
 * Muta `rooms` e devolve o quarto alterado.
 * Erros: o próprio quarto na lista -> 400; quarto inexistente -> 404.
 */
export function applyReadsBrainsOf(rooms: Room[], id: string, requested: string[]): Room {
  const target = requireRoom(rooms, id);
  const wanted = [...new Set(requested)];
  if (wanted.includes(id)) throw new HttpError(400, "Uma sala já lê o próprio Cérebro: não o liste");
  const known = new Set(rooms.map((room) => room.id));
  const missing = wanted.find((peerId) => !known.has(peerId));
  if (missing) throw new HttpError(404, `Sala "${missing}" não encontrada`);
  target.readsBrainsOf = wanted;
  return target;
}
