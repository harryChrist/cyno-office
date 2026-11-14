import { describe, expect, it, vi } from "vitest";
import { birdBesideMaestro, BIRD_HOME_KEY, resetBirdHomeForTests, setBirdBesideMaestro, subscribeBirdHome } from "./birdHome";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("casa da calopsita", () => {
  it("mora ao lado do Maestro por padrão; desligar lembra no navegador e avisa a cena", () => {
    resetBirdHomeForTests();
    const storage = memoryStorage();
    expect(birdBesideMaestro(storage)).toBe(true);
    const changes = vi.fn();
    const off = subscribeBirdHome(changes);
    setBirdBesideMaestro(false, storage);
    expect(birdBesideMaestro(storage)).toBe(false);
    expect(storage.getItem(BIRD_HOME_KEY)).toBe("0");
    expect(changes).toHaveBeenCalledTimes(1);
    // Repetir o mesmo valor não avisa de novo.
    setBirdBesideMaestro(false, storage);
    expect(changes).toHaveBeenCalledTimes(1);
    off();
    // Numa visita nova, lê o que ficou gravado.
    resetBirdHomeForTests();
    expect(birdBesideMaestro(storage)).toBe(false);
    // Armazenamento quebrado: liga por padrão e a troca vale só nesta visita, sem erro.
    resetBirdHomeForTests();
    const broken = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(birdBesideMaestro(broken)).toBe(true);
    expect(() => setBirdBesideMaestro(false, broken)).not.toThrow();
    expect(birdBesideMaestro(broken)).toBe(false);
    resetBirdHomeForTests();
  });
});
