import { describe, expect, it } from "vitest";
import { collect, createLatest, createScopeCache, keysToFetch } from "./mediaCache";

describe("cache por escopo", () => {
  it("acerta o que foi guardado e conta como velho depois do prazo", () => {
    let now = 1_000;
    const cache = createScopeCache<string>({ ttlMs: 30_000, now: () => now });
    expect(cache.read("lume")).toBeUndefined();
    cache.set("lume", "A");
    expect(cache.read("lume")).toEqual({ value: "A", stale: false });
    now += 29_999;
    expect(cache.read("lume")?.stale).toBe(false);
    now += 1;
    // velho ainda serve para mostrar na hora (a revalidação roda em segundo plano)
    expect(cache.read("lume")).toEqual({ value: "A", stale: true });
  });

  it("gravar de novo renova o prazo; descartar e limpar esquecem", () => {
    let now = 0;
    const cache = createScopeCache<number>({ ttlMs: 10, now: () => now });
    cache.set("a", 1);
    now = 50;
    cache.set("a", 2);
    expect(cache.read("a")).toEqual({ value: 2, stale: false });
    cache.set("b", 3);
    cache.drop("a");
    expect(cache.read("a")).toBeUndefined();
    expect(cache.read("b")?.value).toBe(3);
    cache.clear();
    expect(cache.read("b")).toBeUndefined();
  });
});

describe("o que ainda precisa ser pedido", () => {
  it("pede o que falta e o que ficou velho; o que está fresco ou já a caminho não", () => {
    let now = 0;
    const cache = createScopeCache<string>({ ttlMs: 10, now: () => now });
    cache.set("fresco", "x");
    cache.set("velho", "y");
    now = 8;
    cache.set("fresco", "x");
    now = 15;
    expect(keysToFetch(["fresco", "velho", "novo"], cache, new Set())).toEqual(["velho", "novo"]);
    expect(keysToFetch(["fresco", "velho", "novo"], cache, new Set(["novo"]))).toEqual(["velho"]);
  });

  it("com force pede também o fresco (menos o que já está a caminho)", () => {
    const cache = createScopeCache<string>();
    cache.set("a", "x");
    expect(keysToFetch(["a", "b"], cache, new Set(["b"]), true)).toEqual(["a"]);
  });
});

describe("pedido antigo ignorado", () => {
  it("só a senha mais nova vale", () => {
    const latest = createLatest();
    const first = latest.begin();
    expect(latest.isCurrent(first)).toBe(true);
    const second = latest.begin();
    expect(latest.isCurrent(first)).toBe(false);
    expect(latest.isCurrent(second)).toBe(true);
  });
});

describe("várias chaves de uma vez", () => {
  it("devolve todas na ordem pedida, ou nada se falta alguma (nunca meia lista)", () => {
    const cache = createScopeCache<string>();
    cache.set("a", "A");
    expect(collect(["a", "b"], cache)).toBeNull();
    cache.set("b", "B");
    expect(collect(["b", "a"], cache)).toEqual(["B", "A"]);
    expect(collect([], cache)).toEqual([]);
  });
});
