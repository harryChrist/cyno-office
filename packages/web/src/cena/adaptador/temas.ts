import { hash32 } from "./hash";

/** Os 15 temas de sala do Cyno nos 10 do motor (índice de `art.roomTheme`): `seed % 10` escolhe o tema. */
const TEMA_DO_MOTOR: Record<string, number> = {
  mint: 2,
  lavender: 3,
  terracotta: 4,
  ocean: 8,
  sand: 1,
  graphite: 6,
  forest: 2,
  night: 9,
  cherry: 7,
  coffee: 9,
  snow: 0,
  sunset: 4,
  industrial: 6,
  office: 0,
  cyber: 5,
};

export function indiceDoTema(tema: string): number {
  return TEMA_DO_MOTOR[tema] ?? 0;
}

/** Semente da sala: o resto da divisão por 10 é o tema; o quociente varia a planta (espelhada, cantos). Estável por sala. */
export function sementeDaSala(sala: { id: string; theme: string; layoutSeed?: number }): number {
  return indiceDoTema(sala.theme) + 10 * (hash32(String(sala.layoutSeed ?? sala.id)) % 100000);
}
