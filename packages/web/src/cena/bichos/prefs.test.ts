import { afterEach, describe, expect, it, vi } from "vitest";
import { EGG_PREFS, EGG_PREFS_KEY, eggPref, readEggPrefs, resetEggPrefs, setEggPref, subscribeEggPrefs } from "./prefs";

function memoryStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>(initial === undefined ? [] : [[EGG_PREFS_KEY, initial]]);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

afterEach(() => resetEggPrefs());

describe("preferências dos bichos", () => {
  it("gato, cachorro e calopsita ligados por padrão; sem armazenamento ou com valor estragado vale o padrão", () => {
    expect(EGG_PREFS.map((p) => [p.id, p.default])).toEqual([
      ["gato", true],
      ["cachorro", true],
      ["calopsita", true],
    ]);
    expect(readEggPrefs(null)).toEqual({ gato: true, cachorro: true, calopsita: true });
    expect(readEggPrefs(memoryStorage("{estragado"))).toEqual({ gato: true, cachorro: true, calopsita: true });
    expect(readEggPrefs(memoryStorage('{"gato":false,"cachorro":"não","outro":false}'))).toEqual({ gato: false, cachorro: true, calopsita: true });
    const broken = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(readEggPrefs(broken)).toEqual({ gato: true, cachorro: true, calopsita: true });
  });

  it("a escolha antiga do dono continua valendo no mapa novo (mesma chave e mesmo formato)", () => {
    expect(EGG_PREFS_KEY).toBe("agent-office:egg-prefs");
    // quem desligou o gato no mapa antigo: o gato segue desligado; a calopsita (item novo) nasce ligada
    expect(readEggPrefs(memoryStorage('{"gato":false,"cachorro":true}'))).toEqual({ gato: false, cachorro: true, calopsita: true });
    expect(readEggPrefs(memoryStorage('{"calopsita":false}')).calopsita).toBe(false);
  });

  it("desligar salva, avisa quem escuta e vale na hora (mesmo se não der para salvar)", () => {
    const store = memoryStorage();
    const listener = vi.fn();
    const off = subscribeEggPrefs(listener);
    setEggPref("cachorro", false, store);
    expect(eggPref("cachorro")).toBe(false);
    expect(eggPref("gato")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readEggPrefs(store)).toEqual({ gato: true, cachorro: false, calopsita: true });
    // Mesmo valor: nada muda, ninguém é avisado.
    setEggPref("cachorro", false, store);
    expect(listener).toHaveBeenCalledTimes(1);
    setEggPref("gato", false, {
      getItem: () => null,
      setItem: () => {
        throw new Error("cheio");
      },
    });
    expect(eggPref("gato")).toBe(false);
    off();
    setEggPref("gato", true, store);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
