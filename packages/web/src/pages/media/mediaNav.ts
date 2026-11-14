/**
 * Lógica pura da navegação da gaveta de Mídia: anterior e próxima da lista que está na tela, e a mídia aberta
 * no endereço (`#/biblioteca/midia/<workspace>?midia=<código>`), para abrir direto por link e para o Voltar do
 * navegador fechar a gaveta.
 */

export type Neighbors = { index: number; total: number; prev: string | null; next: string | null };

/** Onde `current` está na lista de chaves, com a anterior e a próxima (sem dar a volta). `index` -1 = não está na lista. */
export function neighbors(keys: readonly string[], current: string | null): Neighbors {
  const index = current === null ? -1 : keys.indexOf(current);
  if (index < 0) return { index: -1, total: keys.length, prev: null, next: null };
  return { index, total: keys.length, prev: index > 0 ? keys[index - 1]! : null, next: index < keys.length - 1 ? keys[index + 1]! : null };
}

/** "3 de 42" (índice a partir de zero). */
export const positionLabel = (index: number, total: number): string => `${index + 1} de ${total}`;

const PARAM = "midia";

/** A mídia aberta que o endereço pede (null = nenhuma). */
export function mediaFromHash(hash: string): string | null {
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get(PARAM) || null;
}

/** O mesmo endereço com a mídia aberta trocada (ou tirada, com null); os outros parâmetros ficam. */
export function hashWithMedia(hash: string, key: string | null): string {
  const at = hash.indexOf("?");
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
  if (key) params.set(PARAM, key);
  else params.delete(PARAM);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
