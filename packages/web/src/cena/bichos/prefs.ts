import { useSyncExternalStore } from "react";

/*
 * Preferências dos easter eggs, por visualizador (localStorage). Cada item é um liga/desliga com
 * padrão; sem armazenamento (aba privada, bloqueado, JSON estragado) vale o padrão. Para um item
 * novo, basta somar o id em `EggPrefId` e uma linha em `EGG_PREFS`: a seção
 * "Escritório" das Configurações lista todos.
 */

export type EggPrefId = "gato" | "cachorro" | "calopsita";

export type EggPrefInfo = { id: EggPrefId; label: string; hint: string; default: boolean };

/** Itens na ordem em que aparecem na tela. */
export const EGG_PREFS: readonly EggPrefInfo[] = [
  { id: "gato", label: "Gato passeando", hint: "Um gato laranja mora no escritório e passeia pelos quartos.", default: true },
  { id: "cachorro", label: "Cachorro passeando", hint: "Um cachorrinho caramelo passeia e às vezes acompanha as entregas.", default: true },
  { id: "calopsita", label: "Calopsita no poleirinho", hint: "Uma calopsita mora no poleirinho do escritório. Cinco cliques seguidos fazem ela assobiar.", default: true },
];

export type EggPrefs = Readonly<Record<EggPrefId, boolean>>;

export const EGG_PREFS_KEY = "agent-office:egg-prefs";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const defaults = (): EggPrefs => Object.fromEntries(EGG_PREFS.map((p) => [p.id, p.default])) as EggPrefs;

function storage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Lê as preferências (só os ids conhecidos e com valor booleano; o resto fica no padrão). */
export function readEggPrefs(store: StorageLike | null = storage()): EggPrefs {
  const out = { ...defaults() } as Record<EggPrefId, boolean>;
  try {
    const raw = store?.getItem(EGG_PREFS_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object")
      for (const p of EGG_PREFS) {
        const value = (saved as Record<string, unknown>)[p.id];
        if (typeof value === "boolean") out[p.id] = value;
      }
  } catch {
    // Sem armazenamento ou valor estragado: padrão.
  }
  return out;
}

let current: EggPrefs | null = null;
const listeners = new Set<() => void>();

/** Preferências atuais (lidas uma vez e guardadas). */
export function eggPrefs(): EggPrefs {
  return (current ??= readEggPrefs());
}

/** Um item ligado agora? */
export function eggPref(id: EggPrefId): boolean {
  return eggPrefs()[id];
}

/** Liga/desliga um item e salva (se der). Avisa quem escuta (a cena acorda, a tela redesenha). */
export function setEggPref(id: EggPrefId, on: boolean, store: StorageLike | null = storage()): void {
  if (eggPrefs()[id] === on) return;
  current = { ...eggPrefs(), [id]: on };
  try {
    store?.setItem(EGG_PREFS_KEY, JSON.stringify(current));
  } catch {
    // Sem armazenamento: vale só nesta aba.
  }
  for (const listener of listeners) listener();
}

export function subscribeEggPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Para testes: esquece o que foi lido (a próxima leitura vai ao armazenamento de novo). */
export function resetEggPrefs(): void {
  current = null;
}

/** Hook React: as preferências, redesenhando quando mudam. */
export function useEggPrefs(): EggPrefs {
  return useSyncExternalStore(subscribeEggPrefs, eggPrefs, eggPrefs);
}
