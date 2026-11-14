/** O armazenamento do navegador, ou nulo se estiver bloqueado (aba privada). */
function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/*
 * Onde a calopsita (egg #18) mora: no poleiro ao lado do Maestro (padrão) ou no poleirinho do
 * balcão da recepção do lobby. Preferência só deste navegador (localStorage, se der): não vai
 * para o server nem mexe no escritório. A cena e o painel da Sala do Maestro escutam a mudança.
 */

export const BIRD_HOME_KEY = "agent-office:egg-bird-maestro";

type Store = Pick<Storage, "getItem" | "setItem"> | null;

let cached: boolean | null = null;
const listeners = new Set<() => void>();

function read(storage: Store): boolean {
  try {
    return storage?.getItem(BIRD_HOME_KEY) !== "0";
  } catch {
    return true;
  }
}

/** A calopsita fica ao lado do Maestro? (padrão: sim) */
export function birdBesideMaestro(storage: Store = safeStorage()): boolean {
  cached ??= read(storage);
  return cached;
}

/** Liga/desliga a calopsita ao lado do Maestro (sem armazenamento, vale só nesta visita). */
export function setBirdBesideMaestro(on: boolean, storage: Store = safeStorage()): void {
  if (cached === on) return;
  cached = on;
  try {
    storage?.setItem(BIRD_HOME_KEY, on ? "1" : "0");
  } catch {
    // Aba privada ou bloqueado: só não lembra.
  }
  for (const listener of listeners) listener();
}

/** Escuta a troca (para o useSyncExternalStore e a cena); devolve quem desliga. */
export function subscribeBirdHome(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Só para testes: esquece o valor lido. */
export function resetBirdHomeForTests(): void {
  cached = null;
  listeners.clear();
}
