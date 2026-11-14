import { describe, expect, it } from "vitest";
import { hashWithMedia, mediaFromHash, neighbors, positionLabel } from "./mediaNav";

describe("anterior e próxima", () => {
  const keys = ["a:1", "a:2", "a:3"];

  it("acha a posição e as vizinhas", () => {
    expect(neighbors(keys, "a:2")).toEqual({ index: 1, total: 3, prev: "a:1", next: "a:3" });
  });

  it("no começo não tem anterior e no fim não tem próxima (sem dar a volta)", () => {
    expect(neighbors(keys, "a:1")).toEqual({ index: 0, total: 3, prev: null, next: "a:2" });
    expect(neighbors(keys, "a:3")).toEqual({ index: 2, total: 3, prev: "a:2", next: null });
  });

  it("fora da lista (filtro mudou) ou sem mídia aberta: sem vizinhas", () => {
    expect(neighbors(keys, "x:9")).toEqual({ index: -1, total: 3, prev: null, next: null });
    expect(neighbors(keys, null)).toEqual({ index: -1, total: 3, prev: null, next: null });
    expect(neighbors([], "a:1").total).toBe(0);
  });

  it("escreve a posição de 1 a N", () => {
    expect(positionLabel(2, 42)).toBe("3 de 42");
    expect(positionLabel(0, 1)).toBe("1 de 1");
  });
});

describe("mídia aberta no endereço", () => {
  it("lê o parâmetro, com ou sem outros", () => {
    expect(mediaFromHash("#/biblioteca/midia/principal")).toBeNull();
    expect(mediaFromHash("#/biblioteca/midia/principal?midia=principal%3AM-0001")).toBe("principal:M-0001");
    expect(mediaFromHash("#/biblioteca/midia/principal?item=x&midia=lume:M-2")).toBe("lume:M-2");
    expect(mediaFromHash("#/biblioteca/midia/principal?midia=")).toBeNull();
  });

  it("põe, troca e tira o parâmetro sem perder os outros", () => {
    const base = "#/biblioteca/midia/principal";
    const opened = hashWithMedia(base, "principal:M-1");
    expect(mediaFromHash(opened)).toBe("principal:M-1");
    expect(hashWithMedia(opened, "principal:M-2")).toBe(hashWithMedia(base, "principal:M-2"));
    expect(hashWithMedia(opened, null)).toBe(base);
    expect(hashWithMedia(`${base}?item=x`, "a:1")).toContain("item=x");
    expect(hashWithMedia(hashWithMedia(`${base}?item=x`, "a:1"), null)).toBe(`${base}?item=x`);
  });
});
