// Aleatório com semente da demonstração: o mesmo número de semente dá sempre o mesmo escritório.
// `hash32` e `mulberry32` vêm de `shared/hash.ts` do Habblaud (MIT, Copyright 2026 Márcio Junior; veja THIRD_PARTY/habblaud-LICENSE.txt).

/** Hash FNV-1a 32-bit: determinístico, rápido e suficiente para sementes. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** PRNG mulberry32: use com uma semente de `hash32` para sequências reprodutíveis. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const between = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);
export const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length]!;
