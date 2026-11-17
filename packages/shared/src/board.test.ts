import { describe, expect, it } from "vitest";
import { applyMergePatch, boardActivityAt, boardsFileSchema, nextBoardId, updateBoardBodySchema } from "./board";

describe("applyMergePatch (RFC 7396)", () => {
  it("segue os exemplos da RFC", () => {
    const cases: [unknown, unknown, unknown][] = [
      [{ a: "b" }, { a: "c" }, { a: "c" }],
      [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
      [{ a: "b" }, { a: null }, {}],
      [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
      [{ a: ["b"] }, { a: "c" }, { a: "c" }],
      [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
      [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
      [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
      [["a", "b"], ["c", "d"], ["c", "d"]],
      [{ a: "b" }, ["c"], ["c"]],
      [{ a: "foo" }, null, null],
      [{ a: "foo" }, "bar", "bar"],
      [{ e: null }, { a: 1 }, { e: null, a: 1 }],
      [[1, 2], { a: "b", c: null }, { a: "b" }],
      [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
    ];
    for (const [target, patch, expected] of cases) expect(applyMergePatch(target, patch)).toEqual(expected);
  });

  it("atualiza um item dentro de um objeto por id sem mexer nos outros e não altera os argumentos", () => {
    const target = { works: { w1: { name: "A", last: 1 }, w2: { name: "B", last: 2 } }, updatedAt: "x" };
    const copy = JSON.parse(JSON.stringify(target));
    const out = applyMergePatch(target, { works: { w1: { last: 9 }, w2: null, w3: { name: "C" } } });
    expect(out).toEqual({ works: { w1: { name: "A", last: 9 }, w3: { name: "C" } }, updatedAt: "x" });
    expect(target).toEqual(copy);
  });

  it("ignora __proto__ (não polui o protótipo)", () => {
    const out = applyMergePatch({}, JSON.parse('{"__proto__":{"polluted":true},"ok":1}')) as Record<string, unknown>;
    expect(out.ok).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((out as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("contrato do Quadro", () => {
  it("ids sequenciais Q-0001", () => {
    expect(nextBoardId([])).toBe("Q-0001");
    expect(nextBoardId([{ id: "Q-0001" }, { id: "Q-0009" }])).toBe("Q-0010");
  });

  it("valida o índice e a edição do dono", () => {
    const board = { id: "Q-0001", title: "Obras", description: "Catálogo", createdBy: "clara", createdAt: "2026-11-16T10:00:00.000Z", pageUpdatedAt: "2026-11-16T10:00:00.000Z", dataUpdatedAt: "2026-11-16T11:00:00.000Z", pageBytes: 10, dataBytes: 20 };
    expect(boardsFileSchema.safeParse([board]).success).toBe(true);
    expect(boardsFileSchema.safeParse([{ ...board, id: "x" }]).success).toBe(false);
    expect(boardActivityAt(board)).toBe("2026-11-16T11:00:00.000Z");
    expect(updateBoardBodySchema.safeParse({ title: " Novo " }).data).toEqual({ title: "Novo" });
    expect(updateBoardBodySchema.safeParse({}).success).toBe(false);
    expect(updateBoardBodySchema.safeParse({ title: "" }).success).toBe(false);
    expect(updateBoardBodySchema.safeParse({ source: "x" }).success).toBe(false);
  });
});
