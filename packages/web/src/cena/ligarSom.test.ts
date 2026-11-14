import type { SoundCue } from "@cyno/cena";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAVE_DE_SOM, definirOpcoesDeSom, lerOpcoesDeSom, reiniciarOpcoesDeSom, SOM_PADRAO } from "./opcoesDeSom";
import { ligarSom } from "./ligarSom";

afterEach(() => reiniciarOpcoesDeSom());

const alvo = () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });

describe("preferência de som", () => {
  it("vem desligada por padrão; valor estragado ou ausente também", () => {
    expect(SOM_PADRAO.ligado).toBe(false);
    expect(lerOpcoesDeSom(null)).toEqual(SOM_PADRAO);
    expect(lerOpcoesDeSom({ getItem: () => "{ruim", setItem: () => undefined })).toEqual(SOM_PADRAO);
    expect(lerOpcoesDeSom({ getItem: (k: string) => (k === CHAVE_DE_SOM ? JSON.stringify({ ligado: true, volume: 9 }) : null), setItem: () => undefined })).toEqual({ ligado: true, volume: 1 });
  });
});

describe("ligarSom", () => {
  const cue: SoundCue = { kind: "keys", gain: 0.5, pan: -0.2, count: 3 };

  it("desligado: configura a mesa como desligada e não toca nada", () => {
    let aoSom: ((c: SoundCue) => void) | undefined;
    const mesa = { configure: vi.fn(), unlock: vi.fn().mockResolvedValue(undefined), play: vi.fn() };
    ligarSom({ onSound: (cb) => ((aoSom = cb), () => undefined) }, mesa, alvo());
    expect(mesa.configure).toHaveBeenCalledWith(false, expect.objectContaining({ volume: 0.6 }));
    aoSom?.(cue);
    expect(mesa.play).not.toHaveBeenCalled();
    expect(mesa.unlock).not.toHaveBeenCalled();
  });

  it("ligar nas Configurações reconfigura a mesa, libera o áudio e passa a tocar o que a cena sugere", () => {
    let aoSom: ((c: SoundCue) => void) | undefined;
    const mesa = { configure: vi.fn(), unlock: vi.fn().mockResolvedValue(undefined), play: vi.fn() };
    const desligar = ligarSom({ onSound: (cb) => ((aoSom = cb), () => undefined) }, mesa, alvo());
    definirOpcoesDeSom({ ligado: true, volume: 0.3 }, null);
    expect(mesa.configure).toHaveBeenLastCalledWith(true, expect.objectContaining({ volume: 0.3 }));
    expect(mesa.unlock).toHaveBeenCalled();
    aoSom?.(cue);
    expect(mesa.play).toHaveBeenCalledWith("keys", { gain: 0.5, pan: -0.2, count: 3 });
    desligar();
    definirOpcoesDeSom({ ligado: false }, null);
    expect(mesa.configure).toHaveBeenCalledTimes(2);
  });
});
