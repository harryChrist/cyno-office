// A preferência de som do Escritório, por navegador (localStorage): desligado por padrão. O motor só SUGERE os sons
// (`onSound`); quem toca é o `SoundBoard`, que respeita esta preferência e só libera o áudio depois de um gesto.
import { useSyncExternalStore } from "react";

export type OpcoesDeSom = { ligado: boolean; volume: number };

export const CHAVE_DE_SOM = "cyno.cena.som";
export const SOM_PADRAO: OpcoesDeSom = { ligado: false, volume: 0.6 };

type Armazem = Pick<Storage, "getItem" | "setItem">;

function armazem(): Armazem | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Lê a preferência; sem armazenamento ou com valor estragado, vale o padrão (som desligado). */
export function lerOpcoesDeSom(loja: Armazem | null = armazem()): OpcoesDeSom {
  try {
    const bruto = loja?.getItem(CHAVE_DE_SOM);
    const salvo: unknown = bruto ? JSON.parse(bruto) : null;
    if (salvo && typeof salvo === "object") {
      const o = salvo as Record<string, unknown>;
      const volume = typeof o.volume === "number" && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : SOM_PADRAO.volume;
      return { ligado: o.ligado === true, volume };
    }
  } catch {
    // Valor estragado: padrão.
  }
  return { ...SOM_PADRAO };
}

let atual: OpcoesDeSom | null = null;
const ouvintes = new Set<() => void>();

export function opcoesDeSom(): OpcoesDeSom {
  return (atual ??= lerOpcoesDeSom());
}

export function definirOpcoesDeSom(mudanca: Partial<OpcoesDeSom>, loja: Armazem | null = armazem()): void {
  atual = { ...opcoesDeSom(), ...mudanca };
  try {
    loja?.setItem(CHAVE_DE_SOM, JSON.stringify(atual));
  } catch {
    // Sem armazenamento: vale só nesta sessão.
  }
  for (const avisar of ouvintes) avisar();
}

export function assinarOpcoesDeSom(avisar: () => void): () => void {
  ouvintes.add(avisar);
  return () => ouvintes.delete(avisar);
}

export function useOpcoesDeSom(): OpcoesDeSom {
  return useSyncExternalStore(assinarOpcoesDeSom, opcoesDeSom, () => SOM_PADRAO);
}

/** Só para testes: esquece o valor guardado em memória. */
export function reiniciarOpcoesDeSom(): void {
  atual = null;
  ouvintes.clear();
}
