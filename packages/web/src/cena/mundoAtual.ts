// O mundo da cena aberta agora, ao alcance dos controles do Escritório (zoom, visão geral) sem passar por props.
import type { MundoInterativo } from "./ligarInterface";

let atual: Partial<MundoInterativo> | null = null;

export function definirMundoAtual(mundo: Partial<MundoInterativo> | null): void {
  atual = mundo;
}

export function mundoAtual(): Partial<MundoInterativo> | null {
  return atual;
}
