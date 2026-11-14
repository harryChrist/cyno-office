// Liga os sons sugeridos pela cena (`onSound`) ao `SoundBoard` do motor, obedecendo a preferência do Cyno
// (desligado por padrão). O áudio só é liberado depois do primeiro gesto do usuário, como pedem os navegadores.
import type { SoundCue } from "@cyno/cena";
import { assinarOpcoesDeSom, opcoesDeSom } from "./opcoesDeSom";

/** O que a ligação usa da mesa de som do motor (permite falsos nos testes). */
export interface MesaDeSom {
  configure(enabled: boolean, settings: { volume: number; alerts: boolean; keys: boolean; elevator: boolean; social: boolean }): void;
  unlock(): Promise<void>;
  play(kind: SoundCue["kind"], opts?: { gain?: number; pan?: number; count?: number }): boolean;
}

export interface MundoComSom {
  onSound?(cb: (cue: SoundCue) => void): () => void;
}

export function ligarSom(mundo: MundoComSom, mesa: MesaDeSom, alvoDeGestos: Pick<Document, "addEventListener" | "removeEventListener"> = document): () => void {
  const aplicar = (): void => {
    const o = opcoesDeSom();
    mesa.configure(o.ligado, { volume: o.volume, alerts: true, keys: true, elevator: true, social: true });
    if (o.ligado) void mesa.unlock();
  };
  aplicar();
  const desassinar = assinarOpcoesDeSom(aplicar);
  const gesto = (): void => {
    if (opcoesDeSom().ligado) void mesa.unlock();
  };
  alvoDeGestos.addEventListener("pointerdown", gesto);
  alvoDeGestos.addEventListener("keydown", gesto);
  const desligarCena = mundo.onSound?.((cue) => {
    if (opcoesDeSom().ligado) mesa.play(cue.kind, { gain: cue.gain, pan: cue.pan, ...(cue.count !== undefined ? { count: cue.count } : {}) });
  });
  return () => {
    desassinar();
    alvoDeGestos.removeEventListener("pointerdown", gesto);
    alvoDeGestos.removeEventListener("keydown", gesto);
    desligarCena?.();
  };
}
