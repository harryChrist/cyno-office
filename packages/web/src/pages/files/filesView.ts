import { FILE_LIMITS, fileDirOf, fileExtension, fileNameOf, fileViewByName, joinFilePath, type FileEntry, type FileRoot, type FileView } from "@cyno/shared";
import type { CodeRun } from "./highlight";

export type { CodeRun } from "./highlight";

/**
 * Regras puras da página "Arquivos": endereço, árvore achatada (com caminho compacto e recuo com teto), abas
 * (provisória e fixa), rótulos, largura da divisória, estado lembrado por workspace e o realce do JSON.
 * Nada aqui toca em React nem na rede.
 */

// ---------- Endereço ----------

/** Um arquivo identificado pela raiz e pelo caminho relativo a ela. */
export type FileRef = { root: string; path: string };

/** Chave de um nó (pasta ou arquivo) nos mapas do estado. O separador não aparece em nomes de arquivo comuns. */
export const nodeKey = (root: string, path: string): string => `${root}\t${path}`;

/** O que vem depois de `#/<ws>/arquivos`: `<rootId>/<caminho>` com cada pedaço em `encodeURIComponent`. "" = sem arquivo. */
export function filesSub(ref: FileRef | null): string {
  if (!ref) return "";
  return [ref.root, ...ref.path.split("/").filter(Boolean)].map(encodeURIComponent).join("/");
}

/** Lê o endereço de volta; null se não há arquivo (só a raiz) ou se algum pedaço é inválido. */
export function parseFilesSub(sub: string | undefined): FileRef | null {
  const parts = (sub ?? "").split("?")[0]!.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  try {
    const decoded = parts.map((part) => decodeURIComponent(part));
    if (decoded.some((part) => part === "" || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0"))) return null;
    return { root: decoded[0]!, path: decoded.slice(1).join("/") };
  } catch {
    return null;
  }
}

/** O caminho real completo (`root.path` + "/" + relativo), para o botão "Copiar caminho". */
export function fullPathOf(root: Pick<FileRoot, "path">, relative: string): string {
  const base = root.path.length > 1 ? root.path.replace(/\/+$/, "") : root.path;
  if (!relative) return base;
  return base === "/" ? `/${relative}` : `${base}/${relative}`;
}

/** Caminho encurtado para o título da seção: `/home/…/mahou-reader`. */
export function shortRootPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `/${parts[0]}/…/${parts[parts.length - 1]}`;
}

// ---------- Abas ----------

export type FileTab = FileRef & {
  /** Aba provisória: o próximo clique simples num arquivo a substitui. */
  preview: boolean;
};

export type TabsState = { tabs: FileTab[]; active: string | null };

export const tabKey = (ref: FileRef): string => nodeKey(ref.root, ref.path);

/**
 * Abre um arquivo. Clique simples (`pin` falso): se já tem aba, só ativa; senão ocupa a aba provisória (troca a que
 * existir no mesmo lugar) ou cria uma. `pin` (duplo clique, Enter, endereço): aba fixa. Passou do limite de abas:
 * fecha a mais antiga que não seja a ativa.
 */
export function openTab(state: TabsState, ref: FileRef, pin: boolean, limit: number = FILE_LIMITS.tabs): TabsState {
  const key = tabKey(ref);
  const existing = state.tabs.findIndex((tab) => tabKey(tab) === key);
  let tabs = state.tabs;
  if (existing >= 0) {
    if (pin && tabs[existing]!.preview) tabs = tabs.map((tab, index) => (index === existing ? { ...tab, preview: false } : tab));
    return { tabs, active: key };
  }
  const created: FileTab = { root: ref.root, path: ref.path, preview: !pin };
  const previewAt = pin ? -1 : tabs.findIndex((tab) => tab.preview);
  tabs = previewAt >= 0 ? tabs.map((tab, index) => (index === previewAt ? created : tab)) : [...tabs, created];
  while (tabs.length > limit) {
    const oldest = tabs.findIndex((tab) => tabKey(tab) !== key);
    if (oldest < 0) break;
    tabs = tabs.filter((_, index) => index !== oldest);
  }
  return { tabs, active: key };
}

/** Fixa uma aba provisória (duplo clique na aba). */
export function pinTab(state: TabsState, key: string): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tabKey(tab) === key && tab.preview ? { ...tab, preview: false } : tab)) };
}

/** Fecha uma aba. Se era a ativa, passa para a vizinha (a da direita; sem ela, a da esquerda). */
export function closeTab(state: TabsState, key: string): TabsState {
  const index = state.tabs.findIndex((tab) => tabKey(tab) === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((_, at) => at !== index);
  if (state.active !== key) return { tabs, active: state.active };
  const next = tabs[index] ?? tabs[index - 1];
  return { tabs, active: next ? tabKey(next) : null };
}

export type TabLabel = { key: string; name: string; /** A pasta (apagada), só quando outra aba tem o mesmo nome de arquivo. */ hint?: string };

/** Rótulo de cada aba: o nome do arquivo e, quando o nome se repete, a pasta que o diferencia. */
export function tabLabels(tabs: readonly FileTab[], rootName: (rootId: string) => string): TabLabel[] {
  const counts = new Map<string, number>();
  for (const tab of tabs) counts.set(fileNameOf(tab.path), (counts.get(fileNameOf(tab.path)) ?? 0) + 1);
  return tabs.map((tab) => {
    const name = fileNameOf(tab.path);
    if ((counts.get(name) ?? 0) < 2) return { key: tabKey(tab), name };
    const dir = fileDirOf(tab.path);
    return { key: tabKey(tab), name, hint: dir ? fileNameOf(dir) : rootName(tab.root) };
  });
}

// ---------- Árvore ----------

export type DirListing = {
  entries: FileEntry[];
  total: number;
  more: boolean;
  /** O filtro com que esta lista foi pedida. */
  filter: string;
  loading: boolean;
  error?: string;
};

export type TreeRow =
  | { kind: "dir"; key: string; root: string; path: string; label: string; depth: number; open: boolean; locked: boolean; link: boolean; title: string }
  | { kind: "file"; key: string; root: string; path: string; label: string; depth: number; size: number | undefined; locked: boolean; link: boolean; title: string }
  | { kind: "more"; key: string; root: string; path: string; depth: number; remaining: number; loading: boolean }
  | { kind: "filter"; key: string; root: string; path: string; depth: number; value: string }
  | { kind: "status"; key: string; root: string; path: string; depth: number; text: string; tone: "loading" | "error" | "empty" };

export type TreeContext = {
  dirs: Readonly<Record<string, DirListing | undefined>>;
  open: Readonly<Record<string, true | undefined>>;
};

/** Quantos níveis de recuo a árvore mostra; mais fundo que isso o recuo para (o caminho completo fica no `title`). */
export const TREE_INDENT_MAX_LEVELS = 6;
export const TREE_INDENT_STEP = 14;

export const indentFor = (depth: number): number => Math.min(Math.max(depth, 0), TREE_INDENT_MAX_LEVELS) * TREE_INDENT_STEP;

/** O único item de uma lista, se for uma pasta que abre (sem cadeado): a cadeia compacta e a abertura automática seguem por ele. */
export function soleDirChild(listing: Pick<DirListing, "entries" | "total" | "filter"> | undefined): FileEntry | undefined {
  if (!listing || listing.filter || listing.total !== 1 || listing.entries.length !== 1) return undefined;
  const only = listing.entries[0]!;
  return only.kind === "dir" && !only.locked ? only : undefined;
}

/**
 * A árvore de uma raiz (ou da pasta focada, `base`) como lista de linhas. Caminho compacto: uma pasta aberta cujo
 * único item é uma pasta também aberta mostra as duas na mesma linha ("a/b/c") e a linha conta um nível só.
 */
export function flattenTree(rootId: string, base: string, context: TreeContext, pageSize: number = FILE_LIMITS.pageSize): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dirPath: string, depth: number): void => {
    const key = nodeKey(rootId, dirPath);
    const listing = context.dirs[key];
    if (!listing || (listing.loading && listing.entries.length === 0)) {
      rows.push({ kind: "status", key: `${key}\tstatus`, root: rootId, path: dirPath, depth, text: "Carregando…", tone: "loading" });
      return;
    }
    if (listing.error && listing.entries.length === 0) {
      rows.push({ kind: "status", key: `${key}\tstatus`, root: rootId, path: dirPath, depth, text: listing.error, tone: "error" });
      return;
    }
    if (listing.filter || listing.total > pageSize) rows.push({ kind: "filter", key: `${key}\tfilter`, root: rootId, path: dirPath, depth, value: listing.filter });
    if (listing.entries.length === 0) {
      rows.push({ kind: "status", key: `${key}\tstatus`, root: rootId, path: dirPath, depth, text: listing.filter ? "Nada com esse nome." : "Pasta vazia.", tone: "empty" });
      return;
    }
    for (const entry of listing.entries) {
      let path = joinFilePath(dirPath, entry.name);
      if (entry.kind === "file") {
        rows.push({ kind: "file", key: nodeKey(rootId, path), root: rootId, path, label: entry.name, depth, size: entry.size, locked: entry.locked === true, link: entry.link === true, title: path });
        continue;
      }
      let label = entry.name;
      while (context.open[nodeKey(rootId, path)]) {
        const child = soleDirChild(context.dirs[nodeKey(rootId, path)]);
        const childPath = child ? joinFilePath(path, child.name) : "";
        if (!child || !context.open[nodeKey(rootId, childPath)]) break;
        label = `${label}/${child.name}`;
        path = childPath;
      }
      const isOpen = context.open[nodeKey(rootId, path)] === true;
      rows.push({ kind: "dir", key: nodeKey(rootId, path), root: rootId, path, label, depth, open: isOpen, locked: entry.locked === true, link: entry.link === true, title: path });
      if (isOpen && !entry.locked) walk(path, depth + 1);
    }
    if (listing.more) rows.push({ kind: "more", key: `${key}\tmore`, root: rootId, path: dirPath, depth, remaining: Math.max(0, listing.total - listing.entries.length), loading: listing.loading });
  };
  walk(base, 0);
  return rows;
}

/** Os caminhos de uma pasta até a raiz, do mais fundo ao mais raso ("a/b/c" -> a/b/c, a/b, a). */
export function ancestorDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let size = parts.length; size >= 1; size -= 1) dirs.push(parts.slice(0, size).join("/"));
  return dirs;
}

/** `dir` está dentro de `base` (ou é ela). `base` "" = a raiz inteira. */
export const isInside = (base: string, dir: string): boolean => base === "" || dir === base || dir.startsWith(`${base}/`);

// ---------- Rótulos ----------

/** "modificado há X": agora, minutos, horas, dias, meses. */
export function modifiedAgo(mtime: string | undefined, now: number): string {
  const time = mtime ? Date.parse(mtime) : NaN;
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 45) return "há instantes";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  const months = Math.round(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? "mês" : "meses"}`;
  const years = Math.round(days / 365);
  return `há ${years} ${years === 1 ? "ano" : "anos"}`;
}

/** O tipo mostrado na barra do arquivo ("Markdown", "JSON", "PNG"). */
export function kindLabel(name: string, view: FileView): string {
  const ext = fileExtension(name);
  if (view === "markdown") return "Markdown";
  if (ext === "json") return "JSON";
  if (view === "text") return ext ? ext.toUpperCase() : "Texto";
  if (view === "locked") return "Protegido";
  return ext ? ext.toUpperCase() : "Arquivo";
}

// ---------- Divisória ----------

export const TREE_WIDTH_DEFAULT = 320;
export const TREE_WIDTH_MIN = 220;
export const TREE_WIDTH_MAX = 640;
/** O arquivo aberto nunca fica com menos que isto. */
export const FILE_PANE_MIN = 420;
export const TREE_WIDTH_STEP = 16;

/** Limita a largura da árvore: 220 a 640 px e o arquivo com pelo menos 420 px (`available` = largura da área, divisória inclusa). */
export function clampTreeWidth(width: number, available: number): number {
  const ceiling = Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, available - FILE_PANE_MIN));
  const value = Number.isFinite(width) ? Math.round(width) : TREE_WIDTH_DEFAULT;
  return Math.min(ceiling, Math.max(TREE_WIDTH_MIN, value));
}

/** A largura que o teclado pede (setas, Home e End), ou null se a tecla não é da divisória. */
export function treeWidthForKey(key: string, width: number, available: number): number | null {
  if (key === "ArrowLeft") return clampTreeWidth(width - TREE_WIDTH_STEP, available);
  if (key === "ArrowRight") return clampTreeWidth(width + TREE_WIDTH_STEP, available);
  if (key === "Home") return TREE_WIDTH_MIN;
  if (key === "End") return clampTreeWidth(TREE_WIDTH_MAX, available);
  return null;
}

// ---------- Estado lembrado (por workspace) ----------

export type PersistedFiles = {
  tabs: FileTab[];
  active: string | null;
  open: string[];
  /** Raízes abertas (as outras ficam recolhidas, que é como toda raiz nasce). */
  rootsOpen: string[];
  focus: Record<string, string>;
  width: number;
};

export const emptyPersisted = (): PersistedFiles => ({ tabs: [], active: null, open: [], rootsOpen: [], focus: {}, width: TREE_WIDTH_DEFAULT });

export const filesStorageKey = (workspaceId: string): string => `cyno.files.${workspaceId}`;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const isText = (value: unknown): value is string => typeof value === "string";
const isPath = (value: unknown): value is string => isText(value) && value.length <= FILE_LIMITS.path;

/** Lê o que ficou lembrado do workspace; qualquer falha (sem armazenamento, texto quebrado, formato velho) volta ao vazio. */
export function loadPersisted(workspaceId: string, storage: StorageLike | undefined): PersistedFiles {
  const fresh = emptyPersisted();
  try {
    const raw = storage?.getItem(filesStorageKey(workspaceId));
    if (!raw) return fresh;
    const data = JSON.parse(raw) as Partial<Record<keyof PersistedFiles, unknown>>;
    const tabs: FileTab[] = [];
    if (Array.isArray(data.tabs)) {
      for (const item of data.tabs as Array<Record<string, unknown>>) {
        if (item && isText(item.root) && isPath(item.path) && item.path !== "" && !tabs.some((tab) => tab.root === item.root && tab.path === item.path)) {
          tabs.push({ root: item.root, path: item.path, preview: item.preview === true });
        }
      }
    }
    const limited = tabs.slice(-FILE_LIMITS.tabs);
    const active = isText(data.active) && limited.some((tab) => tabKey(tab) === data.active) ? data.active : (limited.length > 0 ? tabKey(limited[limited.length - 1]!) : null);
    const focus: Record<string, string> = {};
    if (data.focus && typeof data.focus === "object") for (const [root, path] of Object.entries(data.focus as Record<string, unknown>)) if (isPath(path) && path !== "") focus[root] = path;
    return {
      tabs: limited,
      active,
      open: Array.isArray(data.open) ? (data.open as unknown[]).filter(isText).slice(0, 2000) : [],
      rootsOpen: Array.isArray(data.rootsOpen) ? (data.rootsOpen as unknown[]).filter(isText) : [],
      focus,
      width: typeof data.width === "number" ? clampTreeWidth(data.width, Number.MAX_SAFE_INTEGER) : TREE_WIDTH_DEFAULT,
    };
  } catch {
    return fresh;
  }
}

/** Guarda o estado; sem armazenamento (ou cheio), a página segue funcionando, só não lembra. */
export function savePersisted(workspaceId: string, state: PersistedFiles, storage: StorageLike | undefined): void {
  try {
    storage?.setItem(filesStorageKey(workspaceId), JSON.stringify(state));
  } catch {
    // sem armazenamento: tudo funciona, só não lembra
  }
}

// ---------- Realce do JSON ----------


/** Só até este tamanho o JSON ganha cor (acima, o texto vai sem cor). */
export const JSON_HIGHLIGHT_MAX_BYTES = 200_000;

export const isHighlightableJson = (name: string, text: string): boolean => fileExtension(name) === "json" && text.length <= JSON_HIGHLIGHT_MAX_BYTES;

const JSON_TOKEN = /("(?:\\.|[^"\\\n])*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;

/** Divide o texto em trechos coloridos (chaves, textos, números, true/false/null) e trechos sem cor. */
export function jsonRuns(text: string): CodeRun[] {
  const runs: CodeRun[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at) });
    if (match[1] !== undefined) {
      if (match[2] !== undefined) {
        runs.push({ text: match[1], kind: "key" });
        runs.push({ text: match[2] });
      } else runs.push({ text: match[1], kind: "string" });
    } else runs.push({ text: match[0], kind: /^-?\d/.test(match[0]) ? "number" : "literal" });
    last = at + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** O texto da coluna de números de linha ("1\n2\n3"). Uma linha vazia final não conta. */
export function lineNumbers(text: string): string {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  if (text.endsWith("\n") && count > 1) count -= 1;
  let out = "1";
  for (let line = 2; line <= count; line += 1) out += `\n${line}`;
  return out;
}

/** Texto de erro da leitura de um arquivo, em português simples. */
export function readErrorText(status: number | undefined, message: string): string {
  if (status === 404) return "Esse arquivo não existe mais.";
  if (status === 403) return "Este arquivo é protegido e não abre por aqui.";
  return message;
}

// ---------- Editar: quebras de linha e BOM ----------

/** Como o arquivo no disco termina as linhas e se começa com BOM: o editor mostra `\n` e o salvar devolve o estilo original. */
export type TextStyle = { crlf: boolean; bom: boolean };

const BOM = 0xfeff;

/** `\r\n` só conta como estilo do arquivo se não houver nenhum `\n` sozinho (arquivo misto vira `\n`). */
export function textStyleOf(raw: string): TextStyle {
  const bom = raw.charCodeAt(0) === BOM;
  const body = bom ? raw.slice(1) : raw;
  const crlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
  return { crlf, bom };
}

/** O texto que o editor mostra: sem BOM e, se o arquivo é `\r\n`, com `\n`. */
export function editorTextOf(raw: string, style: TextStyle): string {
  const body = style.bom && raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  return style.crlf ? body.replace(/\r\n/g, "\n") : body;
}

/** O texto que vai para o disco: o do editor (`\n`) com o estilo do arquivo original. */
export function diskTextOf(draft: string, style: TextStyle): string {
  const body = style.crlf ? draft.replace(/\r?\n/g, "\r\n") : draft;
  return style.bom ? `\u{feff}${body}` : body;
}

/** O texto passa do que se salva (FILE_LIMITS.editBytes, em bytes UTF-8)? Confere barato antes de medir. */
export function editTooBig(text: string): boolean {
  if (text.length * 3 <= FILE_LIMITS.editBytes) return false;
  if (text.length > FILE_LIMITS.editBytes) return true;
  return new TextEncoder().encode(text).length > FILE_LIMITS.editBytes;
}

/** Texto do aviso de descartar ("Descartar as alterações de X?"). */
export function discardMessage(names: readonly string[]): string {
  if (names.length === 1) return `Descartar as alterações de ${names[0]}?`;
  return `Descartar as alterações de ${names.length} arquivos?`;
}

// ---------- Renomear e apagar: o que muda nas abas, pastas abertas e foco ----------

/** O caminho de `path` depois de `from` virar `to` (o próprio item ou algo dentro dele); null se `path` não é afetado. */
export function remapPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return null;
}

const splitKey = (key: string): [string, string] => {
  const at = key.indexOf("\t");
  return [key.slice(0, at), key.slice(at + 1)];
};

/** Troca as chaves `raiz\tcaminho` de um mapa quando `from` vira `to` (só dentro da `root`). */
export function remapNodeKeys<T>(record: Readonly<Record<string, T | undefined>>, root: string, from: string, to: string, update?: (value: T, newPath: string) => T): Record<string, T | undefined> {
  const next: Record<string, T | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    const [keyRoot, keyPath] = splitKey(key);
    const moved = keyRoot === root ? remapPath(keyPath, from, to) : null;
    if (moved === null || value === undefined) next[key] = value;
    else next[nodeKey(root, moved)] = update ? update(value, moved) : value;
  }
  return next;
}

/** Tira de um mapa as chaves do item e de tudo o que está dentro dele. */
export function dropNodeKeys<T>(record: Readonly<Record<string, T | undefined>>, root: string, path: string): Record<string, T | undefined> {
  const next: Record<string, T | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    const [keyRoot, keyPath] = splitKey(key);
    if (keyRoot === root && remapPath(keyPath, path, path) !== null) continue;
    next[key] = value;
  }
  return next;
}

/** Abas do item (ou de dentro dele, se for pasta). */
export const tabsInside = (tabs: readonly FileTab[], root: string, path: string): FileTab[] => tabs.filter((tab) => tab.root === root && remapPath(tab.path, path, path) !== null);

/** As abas depois de `from` virar `to`. */
export const remapTabs = (tabs: readonly FileTab[], root: string, from: string, to: string): FileTab[] =>
  tabs.map((tab) => {
    const moved = tab.root === root ? remapPath(tab.path, from, to) : null;
    return moved === null ? tab : { ...tab, path: moved };
  });

/** A chave da aba ativa depois de `from` virar `to`. */
export function remapActive(active: string | null, root: string, from: string, to: string): string | null {
  if (!active) return active;
  const [keyRoot, keyPath] = splitKey(active);
  const moved = keyRoot === root ? remapPath(keyPath, from, to) : null;
  return moved === null ? active : nodeKey(root, moved);
}

/** O foco de cada raiz depois de `from` virar `to`. */
export function remapFocus(focus: Readonly<Record<string, string | undefined>>, root: string, from: string, to: string): Record<string, string | undefined> {
  const path = focus[root];
  const moved = path === undefined ? null : remapPath(path, from, to);
  return moved === null ? { ...focus } : { ...focus, [root]: moved };
}

/** O foco depois de apagar `path`: se o foco estava nele ou dentro dele, sobe para a pasta de cima (sem foco = a raiz). */
export function focusAfterDelete(focus: Readonly<Record<string, string | undefined>>, root: string, path: string): Record<string, string | undefined> {
  const current = focus[root];
  if (current === undefined || remapPath(current, path, path) === null) return { ...focus };
  const parent = fileDirOf(path);
  const next = { ...focus };
  if (parent) next[root] = parent;
  else delete next[root];
  return next;
}

// ---------- Menu de ações ----------

export type MenuAction = "open" | "edit" | "new-file" | "new-dir" | "upload" | "rename" | "delete" | "download" | "focus" | "copy-path";

export const MENU_LABELS: Readonly<Record<MenuAction, string>> = {
  open: "Abrir",
  edit: "Editar",
  "new-file": "Novo arquivo",
  "new-dir": "Nova pasta",
  upload: "Enviar arquivos",
  rename: "Renomear",
  delete: "Apagar",
  download: "Baixar",
  focus: "Focar nesta pasta",
  "copy-path": "Copiar caminho",
};

/** Quais ações o menu de um item oferece: item trancado não tem nenhuma; raiz só leitura só abre, baixa, foca e copia o caminho. */
export function menuActions(item: { kind: "dir" | "file"; name: string; locked: boolean; writable: boolean }): MenuAction[] {
  if (item.locked) return [];
  if (item.kind === "dir") return item.writable ? ["new-file", "new-dir", "upload", "rename", "delete", "focus", "copy-path"] : ["focus", "copy-path"];
  if (!item.writable) return ["open", "download", "copy-path"];
  const editable = fileViewByName(item.name) !== "image";
  return editable ? ["open", "edit", "rename", "download", "copy-path", "delete"] : ["open", "rename", "download", "copy-path", "delete"];
}

/** Até onde o nome é selecionado ao renomear: arquivo sem a extensão (".gitignore" e pastas inteiros). */
export function nameStemEnd(name: string, kind: "dir" | "file"): number {
  if (kind === "dir") return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** Texto da confirmação de apagar. `count` só vale para pasta (quantos itens há dentro). */
export function deleteConfirmText(name: string, kind: "dir" | "file", count?: { files: number; dirs: number; truncated: boolean }): string {
  if (kind === "file") return `Apagar '${name}'? Não dá para desfazer.`;
  if (!count) return `Apagar a pasta '${name}' e tudo o que há dentro dela? Não dá para desfazer.`;
  const total = count.files + count.dirs;
  if (total === 0) return `Apagar a pasta '${name}'? Não dá para desfazer.`;
  if (count.truncated) return `Apagar a pasta '${name}' e os mais de ${total} itens dentro dela? Não dá para desfazer.`;
  if (total === 1) return `Apagar a pasta '${name}' e o 1 item dentro dela? Não dá para desfazer.`;
  return `Apagar a pasta '${name}' e os ${total} itens dentro dela? Não dá para desfazer.`;
}

/** A dica de uma raiz que não se altera por aqui (null se ela é alterável). */
export function readonlyHint(root: Pick<FileRoot, "kind" | "writable">): string | null {
  if (root.writable) return null;
  if (root.kind === "data") return "Os dados do workspace não são alterados por aqui.";
  return "Para alterar por aqui, mude para leitura e escrita em Configurações, Pastas de trabalho.";
}

// ---------- Nome na própria linha da árvore (criar e renomear) ----------

/** O que a árvore está pedindo um nome para: um item novo dentro de `dir` ou um item existente. */
export type Naming = { mode: "create-file" | "create-dir"; root: string; dir: string } | { mode: "rename"; root: string; path: string; kind: "dir" | "file" };

/** A linha com o campo de nome, no lugar onde o item vai ficar. */
export type NameRow = { kind: "name"; key: string; depth: number; naming: Naming; initial: string; nodeKind: "dir" | "file" };

/**
 * Põe o campo de nome na lista de linhas de uma raiz: renomear troca a linha do item pelo campo; criar abre o campo
 * como primeiro item da pasta (`base` = a raiz ou a pasta em foco). Se a pasta ainda não tem linha à vista (fechada), nada aparece.
 */
export function withNamingRow(rows: readonly TreeRow[], naming: Naming | null, rootId: string, base: string): Array<TreeRow | NameRow> {
  if (!naming || naming.root !== rootId) return [...rows];
  if (naming.mode === "rename") {
    const at = rows.findIndex((row) => (row.kind === "dir" || row.kind === "file") && row.path === naming.path);
    if (at < 0) return [...rows];
    const row = rows[at] as Extract<TreeRow, { kind: "dir" | "file" }>;
    const name: NameRow = { kind: "name", key: `${row.key}\tname`, depth: row.depth, naming, initial: fileNameOf(naming.path), nodeKind: naming.kind };
    return rows.map((candidate, index) => (index === at ? name : candidate));
  }
  const nodeKind = naming.mode === "create-dir" ? "dir" : "file";
  let at: number;
  let depth: number;
  if (naming.dir === base) {
    at = rows[0]?.kind === "filter" ? 1 : 0;
    depth = 0;
  } else {
    const parent = rows.findIndex((row) => row.kind === "dir" && row.path === naming.dir && row.open);
    if (parent < 0) return [...rows];
    at = parent + 1;
    depth = (rows[parent] as { depth: number }).depth + 1;
  }
  const name: NameRow = { kind: "name", key: `${nodeKey(rootId, naming.dir)}\tnew`, depth, naming, initial: "", nodeKind };
  const next: Array<TreeRow | NameRow> = [...rows];
  const here = next[at];
  // A linha "Pasta vazia." dá lugar ao campo.
  const replace = here?.kind === "status" && here.tone === "empty" && here.path === naming.dir ? 1 : 0;
  next.splice(at, replace, name);
  return next;
}
