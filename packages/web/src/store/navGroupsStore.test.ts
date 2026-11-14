import { beforeEach, describe, expect, it, vi } from "vitest";
import { savedCollapsedGroups, useNavGroupsStore } from "./navGroupsStore";

/** localStorage de mentira (o ambiente dos testes é node). */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

describe("navGroupsStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    useNavGroupsStore.setState({ collapsed: [], movedDismissed: false });
  });

  it("os grupos começam abertos", () => {
    expect(useNavGroupsStore.getState().isOpen("nav-gestao")).toBe(true);
    expect(savedCollapsedGroups()).toEqual([]);
  });

  it("recolher e abrir de novo, lembrando por navegador", () => {
    const { toggle } = useNavGroupsStore.getState();
    toggle("nav-gestao");
    expect(useNavGroupsStore.getState().isOpen("nav-gestao")).toBe(false);
    expect(useNavGroupsStore.getState().isOpen("nav-biblioteca")).toBe(true);
    expect(savedCollapsedGroups()).toEqual(["nav-gestao"]);
    toggle("nav-gestao");
    expect(useNavGroupsStore.getState().isOpen("nav-gestao")).toBe(true);
    expect(savedCollapsedGroups()).toEqual([]);
  });

  it("valor salvo estragado vira tudo aberto", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage({ "cyno:nav-groups-collapsed": "{nao-json" }) });
    expect(savedCollapsedGroups()).toEqual([]);
    vi.stubGlobal("window", { localStorage: fakeStorage({ "cyno:nav-groups-collapsed": '{"a":1}' }) });
    expect(savedCollapsedGroups()).toEqual([]);
  });

  it("sem armazenamento, funciona só na sessão", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("bloqueado");
        },
        setItem: () => {
          throw new Error("bloqueado");
        },
      },
    });
    useNavGroupsStore.getState().toggle("nav-gestao");
    expect(useNavGroupsStore.getState().isOpen("nav-gestao")).toBe(false);
    useNavGroupsStore.getState().dismissMoved();
    expect(useNavGroupsStore.getState().movedDismissed).toBe(true);
  });

  it("a dica de onde foi parar some ao dispensar e fica guardada", () => {
    expect(useNavGroupsStore.getState().movedDismissed).toBe(false);
    useNavGroupsStore.getState().dismissMoved();
    expect(useNavGroupsStore.getState().movedDismissed).toBe(true);
    expect(window.localStorage.getItem("cyno:nav-moved-hint-dismissed")).toBe("1");
  });
});
