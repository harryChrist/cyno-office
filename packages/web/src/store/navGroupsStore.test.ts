import { beforeEach, describe, expect, it, vi } from "vitest";
import { savedGroupChoices, useNavGroupsStore } from "./navGroupsStore";

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
    useNavGroupsStore.setState({ choices: {} });
  });

  it("sem escolha nenhuma, cada grupo segue a página atual", () => {
    expect(useNavGroupsStore.getState().choices["nav-gestao"]).toBeUndefined();
    expect(savedGroupChoices()).toEqual({});
  });

  it("abrir e fechar, lembrando por navegador", () => {
    const { choose } = useNavGroupsStore.getState();
    choose("nav-gestao", true);
    choose("nav-biblioteca", false);
    expect(useNavGroupsStore.getState().choices).toEqual({ "nav-gestao": true, "nav-biblioteca": false });
    expect(savedGroupChoices()).toEqual({ "nav-gestao": true, "nav-biblioteca": false });
  });

  it("esquecer a escolha de um grupo", () => {
    const { choose, clear } = useNavGroupsStore.getState();
    choose("nav-gestao", false);
    clear("nav-gestao");
    expect(useNavGroupsStore.getState().choices).toEqual({});
    expect(savedGroupChoices()).toEqual({});
  });

  it("valor salvo estragado vira nenhuma escolha", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage({ "cyno:nav-groups": "{nao-json" }) });
    expect(savedGroupChoices()).toEqual({});
    vi.stubGlobal("window", { localStorage: fakeStorage({ "cyno:nav-groups": '["a"]' }) });
    expect(savedGroupChoices()).toEqual({});
    vi.stubGlobal("window", { localStorage: fakeStorage({ "cyno:nav-groups": '{"a":true,"b":1}' }) });
    expect(savedGroupChoices()).toEqual({ a: true });
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
    useNavGroupsStore.getState().choose("nav-gestao", true);
    expect(useNavGroupsStore.getState().choices["nav-gestao"]).toBe(true);
  });
});
