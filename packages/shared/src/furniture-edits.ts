import type { PaletteColorId } from "./palette";

/**
 * Ajustes manuais dos móveis de uma sala (editor "Editar móveis"). Ficam gravados no quarto como
 * uma lista aplicada, em ordem, por cima do layout procedural: o gerador continua mandando e os
 * ajustes que não couberem mais (o móvel não é mais gerado, sairia da sala, fecharia a passagem…)
 * são pulados sem quebrar nada.
 *
 * - `move`/`rotate`/`remove` apontam para um móvel gerado pela chave estável (`key`): um posto de
 *   trabalho de agente é `seat:<agentId>` (mesa, PC e cadeira andam juntos e não podem ser
 *   removidos); os demais móveis são `<tipo>@<i>,<j>` da posição em que o gerador os colocou.
 *   `move` dá a nova posição do canto de trás (menor i e j) do conjunto; `rotate`, para onde ele
 *   fica virado (para um posto, para onde o agente olha sentado).
 * - `add` cria um móvel novo (`id` = add-…), que depois também pode ser movido, girado ou removido.
 */

/** Orientações de um móvel (frente apontando para SE/SW = visível; NE/NW = de costas). */
export const FURNITURE_FACINGS = ["SE", "SW", "NE", "NW"] as const;
export type FurnitureFacing = (typeof FURNITURE_FACINGS)[number];

/** Móveis que o editor deixa adicionar (postos de agente não: cada agente já ganha o seu). */
export const FURNITURE_ADD_KINDS = [
  "plant",
  "sofa",
  "armchair",
  "pouf",
  "wood-chair",
  "coffee-table",
  "dining-table",
  "meeting-table",
  "bookshelf",
  "coffee-machine",
  "fridge",
  "kitchen-counter",
  "tv-console",
  "lamp",
  "rug",
  "server-rack",
  "camera-tripod",
  "light-stand",
  "mic-stand",
] as const;
export type FurnitureAddKind = (typeof FURNITURE_ADD_KINDS)[number];

/** Limite de ajustes por sala (o editor junta os ajustes do mesmo móvel, então sobra muito). */
export const MAX_FURNITURE_EDITS = 200;
/** Maior coordenada aceita (as salas crescem, mas nunca chegam perto disso). */
export const FURNITURE_TILE_MAX = 99;

export type FurnitureEdit =
  | { op: "move"; key: string; i: number; j: number }
  | { op: "rotate"; key: string; facing: FurnitureFacing }
  | { op: "remove"; key: string }
  | { op: "add"; id: string; kind: FurnitureAddKind; i: number; j: number; facing: FurnitureFacing; variant?: number; color?: PaletteColorId };

/** Chave do móvel/conjunto que o ajuste afeta (o `id` de um móvel adicionado). */
export function furnitureEditKey(edit: FurnitureEdit): string {
  return edit.op === "add" ? edit.id : edit.key;
}
