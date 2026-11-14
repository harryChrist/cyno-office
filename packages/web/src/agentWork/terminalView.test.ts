import { describe, expect, it } from "vitest";
import { loadFilter, nextUnread, saveFilter, visibleRange, windowAround, WINDOW_STEP } from "./terminalView";

const fakeStorage = () => {
  const map = new Map<string, string>();
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
};

describe("janela de linhas", () => {
  it("sem salto da busca, as mais novas; com salto, a janela dele", () => {
    expect(visibleRange(3000, 300, null)).toEqual({ start: 2700, end: 3000 });
    expect(visibleRange(100, 300, null)).toEqual({ start: 0, end: 100 });
    expect(visibleRange(3000, 300, { start: 1000, end: 1300 })).toEqual({ start: 1000, end: 1300 });
    expect(visibleRange(500, 300, { start: 400, end: 900 })).toEqual({ start: 400, end: 500 });
    expect(visibleRange(500, 300, { start: -5, end: 100 })).toEqual({ start: 0, end: 100 });
  });

  it("o salto da busca abre uma janela ao redor do resultado, sem passar dos limites", () => {
    expect(windowAround(3000, 1500)).toEqual({ start: 1350, end: 1650 });
    expect(windowAround(3000, 2)).toEqual({ start: 0, end: 300 });
    expect(windowAround(3000, 2999)).toEqual({ start: 2700, end: 3000 });
    expect(windowAround(100, 50)).toEqual({ start: 0, end: 100 });
    const { start, end } = windowAround(3000, 1500);
    expect(start <= 1500 && 1500 < end).toBe(true);
    expect(end - start).toBe(WINDOW_STEP);
  });
});

describe("novas mensagens", () => {
  it("só soma quando o dono não está no fim; no fim zera", () => {
    expect(nextUnread(0, 10, 13, false)).toBe(3);
    expect(nextUnread(3, 13, 14, false)).toBe(4);
    expect(nextUnread(4, 14, 14, false)).toBe(4);
    expect(nextUnread(4, 14, 20, true)).toBe(0);
    expect(nextUnread(2, 20, 15, false)).toBe(2);
  });
});

describe("filtro lembrado por agente", () => {
  it("grava, lê e cada agente tem o seu", () => {
    const store = fakeStorage();
    saveFilter("rafa", "talk", store);
    saveFilter("lia", "noTools", store);
    expect(loadFilter("rafa", store)).toBe("talk");
    expect(loadFilter("lia", store)).toBe("noTools");
    expect(loadFilter("outro", store)).toBe("all");
  });

  it("'Tudo' apaga o que estava guardado; valor inválido ou storage quebrado dá 'Tudo'", () => {
    const store = fakeStorage();
    saveFilter("rafa", "talk", store);
    saveFilter("rafa", "all", store);
    expect(store.map.size).toBe(0);
    store.map.set("agent-office:term-filter:rafa", "lixo");
    expect(loadFilter("rafa", store)).toBe("all");
    expect(loadFilter("rafa", { getItem: () => { throw new Error("x"); } })).toBe("all");
    expect(loadFilter(undefined, store)).toBe("all");
    expect(loadFilter("rafa", undefined)).toBe("all");
  });
});
