import type { MediaItem } from "@cyno/shared";

/** Lógica pura das pastas da Mídia: caminhos como "Livros/Matemática", "" = raiz. */

export const ROOT_LABEL = "Biblioteca";

/** Pasta do item ("" = raiz). */
export const folderOf = (item: Pick<MediaItem, "folder">): string => item.folder ?? "";

/** Último nome do caminho ("Livros/Matemática" -> "Matemática"). */
export const folderName = (path: string): string => path.split("/").pop() ?? path;

/** O item está DIRETAMENTE nesta pasta? */
export const isDirectlyIn = (item: Pick<MediaItem, "folder">, folder: string): boolean => folderOf(item) === folder;

/** O item está nesta pasta ou numa subpasta dela? ("" = tudo) */
export const isInside = (item: Pick<MediaItem, "folder">, folder: string): boolean => folder === "" || folderOf(item) === folder || folderOf(item).startsWith(`${folder}/`);

/** Migalhas do caminho: [{ name: "Livros", path: "Livros" }, { name: "Matemática", path: "Livros/Matemática" }]. */
export function crumbs(folder: string): { name: string; path: string }[] {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** Subpastas imediatas de `current` (as de `folders` que são filhas diretas), em ordem alfabética. */
export function childFolders(folders: readonly string[], current: string): string[] {
  const prefix = current ? `${current}/` : "";
  return folders.filter((path) => path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes("/")).sort((a, b) => folderName(a).localeCompare(folderName(b), "pt-BR"));
}

export type FolderStat = { count: number; bytes: number; folders: number };

/** Quantos itens e quantos bytes há na pasta (com as subpastas), e quantas subpastas. */
export function folderStats(items: readonly MediaItem[], folders: readonly string[], folder: string): FolderStat {
  let count = 0;
  let bytes = 0;
  for (const item of items) {
    if (!isInside(item, folder)) continue;
    count += 1;
    bytes += item.size;
  }
  const prefix = folder ? `${folder}/` : "";
  return { count, bytes, folders: folders.filter((path) => path.startsWith(prefix) && path !== folder).length };
}

/** Soma dos tamanhos (o rótulo de tamanho do cabeçalho e dos blocos). */
export const sumBytes = (items: readonly Pick<MediaItem, "size">[]): number => items.reduce((total, item) => total + item.size, 0);

/** Todas as pastas em árvore achatada (com a profundidade), para o seletor "Mover para". */
export function folderChoices(folders: readonly string[]): { path: string; name: string; depth: number }[] {
  return [...folders].sort((a, b) => a.localeCompare(b, "pt-BR")).map((path) => ({ path, name: folderName(path), depth: path.split("/").length - 1 }));
}

/** Pasta de cima ("A/B" -> "A"; "A" -> ""). */
export const parentOf = (folder: string): string => folder.split("/").slice(0, -1).join("/");

/** "3 itens", "1 item", "vazia". */
export const countLabel = (count: number): string => (count === 0 ? "vazia" : count === 1 ? "1 item" : `${count} itens`);

/** Tipo do arraste de itens entre cartões e pastas. */
export const DRAG_TYPE = "application/x-cyno-media";

/** Onde fica a pasta aberta depois de renomear `from` para `to` (a aberta pode ser ela ou uma de dentro). */
export function remapAfterRename(current: string, from: string, to: string): string {
  if (current === from) return to;
  return current.startsWith(`${from}/`) ? `${to}${current.slice(from.length)}` : current;
}

/** Onde fica a pasta aberta depois de apagar `from` (o conteúdo sobe um nível). */
export function remapAfterDelete(current: string, from: string): string {
  const up = parentOf(from);
  if (current === from) return up;
  if (!current.startsWith(`${from}/`)) return current;
  const rest = current.slice(from.length + 1);
  return up ? `${up}/${rest}` : rest;
}
