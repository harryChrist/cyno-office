import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { EngineStorageItem } from "@cyno/shared";

/**
 * Medição de pastas, SOMENTE LEITURA: nunca segue link simbólico (um link conta zero) e pasta ausente
 * ou ilegível conta zero.
 */

export type TreeInfo = {
  bytes: number;
  files: number;
  /** Modificação mais velha entre os ARQUIVOS (0 = sem arquivos). */
  oldestMs: number;
  /** Modificação mais nova entre os arquivos E as pastas (0 = nada). */
  newestMs: number;
};

export const emptyTree = (): TreeInfo => ({ bytes: 0, files: 0, oldestMs: 0, newestMs: 0 });

export async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

export async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Soma `more` em `into`. */
export function mergeTree(into: TreeInfo, more: TreeInfo): TreeInfo {
  into.bytes += more.bytes;
  into.files += more.files;
  if (more.oldestMs > 0) into.oldestMs = into.oldestMs > 0 ? Math.min(into.oldestMs, more.oldestMs) : more.oldestMs;
  into.newestMs = Math.max(into.newestMs, more.newestMs);
  return into;
}

/** Tamanho de uma árvore (arquivo ou pasta), sem seguir links simbólicos. */
export async function treeInfo(target: string): Promise<TreeInfo> {
  const info = await lstatOrNull(target);
  if (!info || info.isSymbolicLink()) return emptyTree();
  if (!info.isDirectory()) return info.isFile() ? { bytes: info.size, files: 1, oldestMs: info.mtimeMs, newestMs: info.mtimeMs } : emptyTree();
  const out: TreeInfo = { bytes: 0, files: 0, oldestMs: 0, newestMs: info.mtimeMs };
  for (const entry of await entriesOf(target)) mergeTree(out, await treeInfo(path.join(target, entry.name)));
  return out;
}

/** O que a tela mostra de uma árvore. */
export function toItem(info: TreeInfo): EngineStorageItem {
  return { bytes: info.bytes, files: info.files, oldestAt: info.oldestMs > 0 ? new Date(info.oldestMs).toISOString() : null };
}
