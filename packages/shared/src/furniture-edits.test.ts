import { describe, expect, it } from "vitest";
import { furnitureEditsSchema, roomSchema, updateFurnitureBodySchema } from "./api";
import { furnitureEditKey, MAX_FURNITURE_EDITS, type FurnitureEdit } from "./furniture-edits";

const move: FurnitureEdit = { op: "move", key: "plant@0,0", i: 3, j: 4 };

describe("ajustes manuais dos móveis (schema)", () => {
  it("aceita as quatro operações e a lista vazia", () => {
    const edits: FurnitureEdit[] = [
      move,
      { op: "rotate", key: "seat:ana-2", facing: "NW" },
      { op: "remove", key: "bookshelf@0,3.2" },
      { op: "add", id: "add-7", kind: "rug", i: 1, j: 1, facing: "SE", variant: 1, color: "denim" },
    ];
    expect(furnitureEditsSchema.parse(edits)).toEqual(edits);
    expect(furnitureEditsSchema.parse([])).toEqual([]);
    expect(updateFurnitureBodySchema.parse({ edits })).toEqual({ edits });
  });

  it("limita tamanho, coordenadas, chaves, tipos e campos", () => {
    expect(furnitureEditsSchema.safeParse(Array.from({ length: MAX_FURNITURE_EDITS }, () => move)).success).toBe(true);
    expect(furnitureEditsSchema.safeParse(Array.from({ length: MAX_FURNITURE_EDITS + 1 }, () => move)).success).toBe(false);
    const bad: unknown[] = [
      { ...move, i: -1 },
      { ...move, j: 100 },
      { ...move, i: 1.5 },
      { ...move, key: "Planta Grande" },
      { ...move, key: "x".repeat(81) },
      { ...move, extra: true },
      { op: "rotate", key: "plant@0,0", facing: "N" },
      { op: "teleport", key: "plant@0,0" },
      { op: "add", id: "planta", kind: "plant", i: 1, j: 1, facing: "SW" },
      { op: "add", id: "add-1", kind: "desk", i: 1, j: 1, facing: "SW" },
      { op: "add", id: "add-1", kind: "plant", i: 1, j: 1, facing: "SW", color: "neon" },
      { op: "add", id: "add-1", kind: "plant", i: 1, j: 1, facing: "SW", variant: 9 },
    ];
    for (const edit of bad) expect(furnitureEditsSchema.safeParse([edit]).success, JSON.stringify(edit)).toBe(false);
    const add: FurnitureEdit = { op: "add", id: "add-1", kind: "plant", i: 1, j: 1, facing: "SW" };
    expect(furnitureEditsSchema.safeParse([add, add]).success).toBe(false);
    expect(updateFurnitureBodySchema.safeParse({ edits: [], more: 1 }).success).toBe(false);
  });

  it("é opcional no quarto (arquivos antigos continuam válidos)", () => {
    const room = { id: "sala", kind: "team", name: "Sala", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: false, readsBrainsOf: [] };
    expect(roomSchema.parse(room)).not.toHaveProperty("furnitureEdits");
    expect(roomSchema.parse({ ...room, furnitureEdits: [move] }).furnitureEdits).toEqual([move]);
  });

  it("chave do ajuste: o id do móvel adicionado ou a chave do gerado", () => {
    expect(furnitureEditKey(move)).toBe("plant@0,0");
    expect(furnitureEditKey({ op: "add", id: "add-2", kind: "lamp", i: 0, j: 0, facing: "SW" })).toBe("add-2");
  });
});
