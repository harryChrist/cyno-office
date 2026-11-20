import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent, type ReadStream, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  compareFileEntries,
  FILE_IMAGE_MIME,
  FILE_LIMITS,
  FILE_ROOT_DATA,
  FILE_SEARCH_SKIP,
  fileExtension,
  fileNameError,
  fileViewByName,
  fileVersion,
  isLockedDirName,
  isLockedFileName,
  joinFilePath,
  LOCKED_DATA_DIRS,
  maskSecrets,
  type FileCountResponse,
  type FileCreateResponse,
  type FileDeleteResponse,
  type FileEntry,
  type FileEntryKind,
  type FileListResponse,
  type FileReadResponse,
  type FileRenameResponse,
  type FileRoot,
  type FileRootsResponse,
  type FileSearchMatch,
  type FileSearchResponse,
  type FileView,
  type FileWriteResponse,
  type WorkFolder,
} from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { isInside } from "../../platform/workspaces/folders";

/*
 * Arquivos do workspace: leitura em qualquer raiz e, só nas pastas de trabalho com "leitura e escrita" (`writable`),
 * edição, criação, envio, renomeação e exclusão. A raiz de dados e as pastas "só leitura" nunca são alteradas.
 * Todo caminho chega relativo a uma raiz (já sem `..`), é resolvido pelo caminho REAL e precisa ficar dentro do caminho real da raiz:
 * link simbólico que aponta para fora não abre. Itens sensíveis (chaves, senhas, perfil do navegador) ficam trancados.
 */

const ERR = {
  root: "Pasta não encontrada neste workspace.",
  missing: "Esse arquivo não existe mais.",
  locked: "Este item é protegido e não abre por aqui.",
  denied: "O Cyno não tem permissão para abrir isso no computador.",
  notFile: "Isso é uma pasta, não um arquivo.",
  notDir: "Isso é um arquivo, não uma pasta.",
  dataRoot: "Os dados do workspace não são alterados por aqui.",
  readOnly: "Esta pasta é só leitura. Para alterar por aqui, mude para leitura e escrita em Configurações, Pastas de trabalho.",
  exists: "Já existe um item com esse nome.",
  changed: "O arquivo mudou no disco depois que você abriu.",
  gone: "Esse arquivo não existe mais no disco.",
  tooBigEdit: "Este arquivo é grande demais para editar por aqui.",
  notText: "Este arquivo não é texto e não pode ser editado por aqui.",
  notUtf8: "Este arquivo não está em UTF-8 e não pode ser editado por aqui.",
  textTooBig: "O texto é grande demais para salvar por aqui.",
  uploadTooBig: "Arquivo grande demais para enviar por aqui.",
  notRegular: "Isso não é um arquivo comum.",
  intoSelf: "Não dá para mover uma pasta para dentro dela mesma.",
  otherDisk: "Não dá para mover entre discos diferentes por aqui.",
  isRoot: "A pasta raiz não pode ser alterada por aqui.",
} as const;

const SNIFF_BYTES = 8 * 1024;

export type FilesServiceOptions = {
  /** Pasta de dados do workspace (raiz "Dados do workspace"). */
  dataDir: string;
  /** Pastas de trabalho do workspace (lidas a cada pedido: podem mudar). */
  folders: () => readonly WorkFolder[];
  /** Só para teste: troca o `stat` (para contar quantos itens são medidos) e os tetos da busca. */
  stat?: (target: string) => Promise<Stats>;
  searchScan?: number;
  searchResults?: number;
  /** Só para teste: baixam o teto de envio e de contagem. */
  uploadBytes?: number;
  countScan?: number;
};

type Resolved = {
  root: FileRoot;
  /** Caminho real da raiz. */
  realRoot: string;
  /** Caminho real do item. */
  real: string;
  /** Caminho relativo normalizado pedido. */
  rel: string;
  info: Stats;
  locked: boolean;
};

/** Fim de uma sequência UTF-8 que ficou pela metade: quantos bytes do fim do buffer não formam um caractere completo. */
function incompleteTail(buffer: Buffer): number {
  const max = Math.min(3, buffer.length);
  for (let back = 1; back <= max; back += 1) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

function fsError(error: unknown): HttpError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new HttpError(403, ERR.denied);
  return new HttpError(404, ERR.missing);
}

export class FilesService {
  private readonly statFn: (target: string) => Promise<Stats>;
  private readonly searchScan: number;
  private readonly searchResults: number;
  private readonly uploadBytes: number;
  private readonly countScan: number;

  constructor(private readonly options: FilesServiceOptions) {
    this.statFn = options.stat ?? ((target) => stat(target));
    this.searchScan = options.searchScan ?? FILE_LIMITS.searchScan;
    this.searchResults = options.searchResults ?? FILE_LIMITS.searchResults;
    this.uploadBytes = options.uploadBytes ?? FILE_LIMITS.uploadBytes;
    this.countScan = options.countScan ?? FILE_LIMITS.countScan;
  }

  // ------------------------------------------------------------ raízes

  async roots(): Promise<FileRootsResponse> {
    const roots: FileRoot[] = [];
    for (const root of this.rootList()) {
      try {
        const info = await stat(root.path);
        roots.push(info.isDirectory() ? root : { ...root, error: "Isso não é uma pasta." });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        roots.push({ ...root, error: code === "EACCES" || code === "EPERM" ? "O Cyno não tem permissão para abrir esta pasta." : "Esta pasta não existe mais no computador." });
      }
    }
    return { roots };
  }

  private rootList(): FileRoot[] {
    const list: FileRoot[] = [{ id: FILE_ROOT_DATA, kind: "data", name: "Dados do workspace", path: this.options.dataDir, writable: false }];
    for (const folder of this.options.folders()) list.push({ id: folder.id, kind: "folder", name: folder.name, path: folder.path, writable: folder.mode === "write" });
    return list;
  }

  // ------------------------------------------------------------ resolução e trancas

  /** Um nome de pasta é trancado neste ponto da árvore? `level` = quantos níveis acima dele (0 = primeiro nível da raiz). */
  private lockedDir(root: FileRoot, name: string, level: number): boolean {
    if (isLockedDirName(name)) return true;
    return root.kind === "data" && level === 0 && (LOCKED_DATA_DIRS as readonly string[]).includes(name);
  }

  /** Algum ANCESTRAL (todos os segmentos menos o último) é pasta trancada? */
  private ancestorLocked(root: FileRoot, segments: string[]): boolean {
    for (let i = 0; i < segments.length - 1; i += 1) if (this.lockedDir(root, segments[i]!, i)) return true;
    return false;
  }

  private findRoot(rootId: string): FileRoot {
    const root = this.rootList().find((item) => item.id === rootId);
    if (!root) throw new HttpError(404, ERR.root);
    return root;
  }

  private async realRootOf(root: FileRoot): Promise<string> {
    try {
      return await realpath(root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, ERR.missing);
      throw fsError(error);
    }
  }

  /** Confere o caminho e devolve o item real. Fora da raiz ou com ancestral trancado = 403; não existe = 404. */
  private async resolve(rootId: string, rel: string): Promise<Resolved> {
    const root = this.findRoot(rootId);
    const realRoot = await this.realRootOf(root);
    const segments = rel === "" ? [] : rel.split("/");
    if (this.ancestorLocked(root, segments)) throw new HttpError(403, ERR.locked);
    let real: string;
    try {
      real = await realpath(path.join(realRoot, rel));
    } catch (error) {
      throw fsError(error);
    }
    if (!isInside(real, realRoot)) throw new HttpError(403, ERR.locked);
    let info: Stats;
    try {
      info = await stat(real);
    } catch (error) {
      throw fsError(error);
    }
    // O caminho real também não pode passar por pasta trancada (um link para dentro de `browser`, por exemplo).
    const realSegments = path.relative(realRoot, real).split(path.sep).filter(Boolean);
    if (this.ancestorLocked(root, realSegments)) throw new HttpError(403, ERR.locked);
    const lastName = segments[segments.length - 1];
    const realName = realSegments[realSegments.length - 1];
    let locked = false;
    for (const [name, level] of [
      [lastName, segments.length - 1],
      [realName, realSegments.length - 1],
    ] as const) {
      if (name === undefined) continue;
      if (info.isDirectory() ? this.lockedDir(root, name, level) : isLockedFileName(name)) locked = true;
    }
    return { root, realRoot, real, rel, info, locked };
  }

  // ------------------------------------------------------------ lista

  async list(rootId: string, rel: string, options: { offset: number; limit: number; filter?: string | undefined }): Promise<FileListResponse> {
    const dir = await this.resolve(rootId, rel);
    if (dir.locked) throw new HttpError(403, ERR.locked);
    if (!dir.info.isDirectory()) throw new HttpError(400, ERR.notDir);
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir.real, { withFileTypes: true });
    } catch (error) {
      throw fsError(error);
    }
    const level = rel === "" ? 0 : rel.split("/").length;
    const needle = options.filter?.toLowerCase();
    const all: FileEntry[] = [];
    for (const dirent of dirents) {
      if (needle && !dirent.name.toLowerCase().includes(needle)) continue;
      all.push(await this.classify(dir, dirent, level));
    }
    all.sort(compareFileEntries);
    const page = all.slice(options.offset, options.offset + options.limit);
    // Só os itens da página são medidos: pastas com milhares de itens não custam um stat por item.
    const entries = await Promise.all(page.map((entry) => this.measure(dir.real, entry)));
    return { root: rootId, path: rel, entries, total: all.length, offset: options.offset, more: options.offset + page.length < all.length };
  }

  /** Tipo e trancas de um item, sem medir tamanho. Só links simbólicos custam uma consulta (precisam do tipo do alvo). */
  private async classify(dir: Resolved, dirent: Dirent, level: number): Promise<FileEntry> {
    const { name } = dirent;
    if (dirent.isSymbolicLink()) {
      let real: string;
      let info: Stats;
      try {
        real = await realpath(path.join(dir.real, name));
        info = await stat(real);
      } catch {
        return { name, kind: "file", locked: true, link: true };
      }
      const kind = info.isDirectory() ? "dir" : "file";
      if (!isInside(real, dir.realRoot)) return { name, kind, locked: true, link: true };
      const realSegments = path.relative(dir.realRoot, real).split(path.sep).filter(Boolean);
      const realName = realSegments[realSegments.length - 1] ?? name;
      const locked =
        this.ancestorLocked(dir.root, realSegments) ||
        (kind === "dir" ? this.lockedDir(dir.root, name, level) || this.lockedDir(dir.root, realName, realSegments.length - 1) : isLockedFileName(name) || isLockedFileName(realName));
      return { name, kind, link: true, ...(locked ? { locked: true as const } : {}) };
    }
    if (dirent.isDirectory()) return { name, kind: "dir", ...(this.lockedDir(dir.root, name, level) ? { locked: true as const } : {}) };
    return { name, kind: "file", ...(isLockedFileName(name) ? { locked: true as const } : {}) };
  }

  private async measure(dirReal: string, entry: FileEntry): Promise<FileEntry> {
    if (entry.locked && entry.link) return entry;
    try {
      const info = await this.statFn(path.join(dirReal, entry.name));
      return { ...entry, ...(entry.kind === "file" ? { size: info.size } : {}), mtime: info.mtime.toISOString() };
    } catch {
      return entry;
    }
  }

  // ------------------------------------------------------------ leitura

  async read(rootId: string, rel: string, known?: string, edit = false): Promise<FileReadResponse> {
    if (edit) return this.readForEdit(rootId, rel);
    const file = await this.resolve(rootId, rel);
    if (file.info.isDirectory()) throw new HttpError(400, ERR.notFile);
    const { info } = file;
    const version = fileVersion(info.size, info.mtimeMs);
    if (known !== undefined && known === version) return { unchanged: true, version };
    const name = path.basename(file.rel);
    const base = { root: rootId, path: rel, name, size: info.size, mtime: info.mtime.toISOString(), version };
    if (file.locked) return { ...base, view: "locked", truncated: false };
    let view: FileView | undefined = fileViewByName(name);
    if (view === "image" && info.size > FILE_LIMITS.imageBytes) view = "binary";
    if (view === undefined) view = (await this.sniffsBinary(file.real, info.size)) ? "binary" : "text";
    if (view !== "markdown" && view !== "text") return { ...base, view, truncated: false };
    const { text, truncated } = await this.readText(file.real, info.size);
    const masked = maskSecrets(text);
    return { ...base, view, text: masked, truncated, ...(masked !== text ? { masked: true as const } : {}) };
  }

  /** Texto EXATO do disco para o editor: sem máscara e inteiro. Recusa o que não dá para editar com segurança. */
  private async readForEdit(rootId: string, rel: string): Promise<FileReadResponse> {
    this.assertWritable(this.findRoot(rootId));
    const file = await this.resolve(rootId, rel);
    if (file.info.isDirectory()) throw new HttpError(400, ERR.notFile);
    if (file.locked) throw new HttpError(403, ERR.locked);
    const { info } = file;
    if (info.size > FILE_LIMITS.editBytes) throw new HttpError(400, ERR.tooBigEdit);
    const name = path.basename(file.rel);
    let view: FileView | undefined = fileViewByName(name);
    if (view === "image") throw new HttpError(400, ERR.notText);
    if (view === undefined && (await this.sniffsBinary(file.real, info.size))) throw new HttpError(400, ERR.notText);
    view ??= "text";
    const handle = await open(file.real, "r").catch((error: unknown) => {
      throw fsError(error);
    });
    let buffer: Buffer;
    try {
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    // Pode ter crescido entre o stat e a leitura.
    if (buffer.length > FILE_LIMITS.editBytes) throw new HttpError(400, ERR.tooBigEdit);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw new HttpError(400, ERR.notUtf8);
    }
    return { root: rootId, path: rel, name, size: info.size, mtime: info.mtime.toISOString(), version: fileVersion(info.size, info.mtimeMs), view, text, truncated: false };
  }

  private async sniffsBinary(real: string, size: number): Promise<boolean> {
    const handle = await open(real, "r").catch((error: unknown) => {
      throw fsError(error);
    });
    try {
      const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  }

  private async readText(real: string, size: number): Promise<{ text: string; truncated: boolean }> {
    const handle = await open(real, "r").catch((error: unknown) => {
      throw fsError(error);
    });
    try {
      const buffer = Buffer.alloc(Math.min(FILE_LIMITS.previewBytes, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let end = bytesRead;
      const truncated = size > FILE_LIMITS.previewBytes;
      // Cortou no meio do arquivo: não deixa um caractere UTF-8 pela metade no fim.
      if (truncated) end -= incompleteTail(buffer.subarray(0, end));
      return { text: buffer.subarray(0, end).toString("utf8"), truncated };
    } finally {
      await handle.close();
    }
  }

  // ------------------------------------------------------------ arquivo em si

  /** Abre o arquivo para enviar em fluxo. `inline` = mostrar na tela (imagem pequena); senão vira anexo. */
  async raw(rootId: string, rel: string, download: boolean): Promise<{ stream: ReadStream; size: number; name: string; inlineMime?: string }> {
    const file = await this.resolve(rootId, rel);
    if (file.info.isDirectory()) throw new HttpError(400, ERR.notFile);
    if (file.locked) throw new HttpError(403, ERR.locked);
    const name = path.basename(file.rel);
    const mime = FILE_IMAGE_MIME[fileExtension(name)];
    const inlineMime = !download && mime !== undefined && file.info.size <= FILE_LIMITS.imageBytes ? mime : undefined;
    return { stream: createReadStream(file.real), size: file.info.size, name, ...(inlineMime ? { inlineMime } : {}) };
  }

  // ------------------------------------------------------------ busca

  /** Procura NOMES em largura. Não entra em pastas pesadas, trancadas nem links; para no teto de itens ou de resultados. */
  async search(rootId: string, query: string): Promise<FileSearchResponse> {
    const root = this.findRoot(rootId);
    const realRoot = await this.realRootOf(root);
    const needle = query.toLowerCase();
    const matches: FileSearchMatch[] = [];
    const skip = new Set<string>(FILE_SEARCH_SKIP);
    const queue: string[] = [""];
    let scanned = 0;
    let truncated = false;
    walk: for (let head = 0; head < queue.length; head += 1) {
      const rel = queue[head]!;
      const level = rel === "" ? 0 : rel.split("/").length;
      let dirents: Dirent[];
      try {
        dirents = await readdir(path.join(realRoot, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (scanned >= this.searchScan) {
          truncated = true;
          break walk;
        }
        scanned += 1;
        // Links não são seguidos nem listados: o alvo pode estar fora da raiz.
        if (dirent.isSymbolicLink()) continue;
        const isDir = dirent.isDirectory();
        if (isDir ? this.lockedDir(root, dirent.name, level) : isLockedFileName(dirent.name)) continue;
        const itemPath = joinFilePath(rel, dirent.name);
        if (dirent.name.toLowerCase().includes(needle)) {
          matches.push({ path: itemPath, name: dirent.name, kind: isDir ? "dir" : "file" });
          if (matches.length >= this.searchResults) {
            truncated = true;
            break walk;
          }
        }
        if (isDir && !skip.has(dirent.name)) queue.push(itemPath);
      }
    }
    return { root: rootId, query, matches, truncated };
  }

  // ------------------------------------------------------------ alterações

  /** Só pasta de trabalho com escrita muda por aqui. */
  private assertWritable(root: FileRoot): void {
    if (root.kind === "data") throw new HttpError(403, ERR.dataRoot);
    if (!root.writable) throw new HttpError(403, ERR.readOnly);
  }

  /**
   * Prepara uma alteração em `rel`: confere a raiz, resolve e confere a PASTA PAI (existe, é pasta, dentro da raiz,
   * sem tranca nem ancestral trancado) e devolve o caminho real do pai e o nome final. `rel` nunca é a própria raiz.
   */
  private async parentOf(rootId: string, rel: string): Promise<{ root: FileRoot; parent: Resolved; name: string; abs: string }> {
    const root = this.findRoot(rootId);
    this.assertWritable(root);
    if (rel === "") throw new HttpError(400, ERR.isRoot);
    const at = rel.lastIndexOf("/");
    const parentRel = at < 0 ? "" : rel.slice(0, at);
    const name = rel.slice(at + 1);
    const parent = await this.resolve(rootId, parentRel);
    if (parent.locked) throw new HttpError(403, ERR.locked);
    if (!parent.info.isDirectory()) throw new HttpError(400, ERR.notDir);
    return { root, parent, name, abs: path.join(parent.real, name) };
  }

  /** `lstat` que devolve null se não existe (qualquer outro erro vira o erro de permissão). */
  private async lstatOrNull(target: string): Promise<Stats | null> {
    try {
      return await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw fsError(error);
    }
  }

  private lockedByName(root: FileRoot, name: string, level: number): boolean {
    return isLockedFileName(name) || this.lockedDir(root, name, level);
  }

  private async statResponse(rootId: string, rel: string, real: string): Promise<FileWriteResponse> {
    const info = await stat(real);
    return { root: rootId, path: rel, name: path.basename(rel), size: info.size, mtime: info.mtime.toISOString(), version: fileVersion(info.size, info.mtimeMs) };
  }

  private tempName(): string {
    return `.cyno-${randomBytes(6).toString("hex")}.tmp`;
  }

  async write(rootId: string, rel: string, text: string, baseVersion?: string): Promise<FileWriteResponse> {
    if (Buffer.byteLength(text, "utf8") > FILE_LIMITS.editBytes) throw new HttpError(400, ERR.textTooBig);
    const { name, abs } = await this.parentOf(rootId, rel);
    let target = abs;
    let mode: number | undefined;
    const existing = await this.lstatOrNull(abs);
    if (existing === null) {
      if (baseVersion !== undefined) throw new HttpError(409, ERR.gone);
      const nameError = fileNameError(name, "file");
      if (nameError) throw new HttpError(400, nameError);
    } else {
      // Pelo caminho real: link para dentro escreve no alvo e fica; link para fora é recusado.
      const file = await this.resolve(rootId, rel);
      if (file.locked) throw new HttpError(403, ERR.locked);
      if (!file.info.isFile()) throw new HttpError(400, file.info.isDirectory() ? ERR.notFile : ERR.notRegular);
      if (file.info.size > FILE_LIMITS.editBytes) throw new HttpError(400, ERR.tooBigEdit);
      if (baseVersion !== undefined && baseVersion !== fileVersion(file.info.size, file.info.mtimeMs)) throw new HttpError(409, ERR.changed);
      target = file.real;
      mode = file.info.mode & 0o7777;
    }
    const tmp = path.join(path.dirname(target), this.tempName());
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(Buffer.from(text, "utf8"));
      } finally {
        await handle.close();
      }
      if (mode !== undefined) await chmod(tmp, mode);
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error instanceof HttpError ? error : fsError(error);
    }
    return this.statResponse(rootId, rel, target);
  }

  async create(rootId: string, rel: string, kind: FileEntryKind): Promise<FileCreateResponse> {
    const { name, abs } = await this.parentOf(rootId, rel);
    const nameError = fileNameError(name, kind);
    if (nameError) throw new HttpError(400, nameError);
    if ((await this.lstatOrNull(abs)) !== null) throw new HttpError(409, ERR.exists);
    try {
      if (kind === "dir") await mkdir(abs);
      else await (await open(abs, "wx", 0o644)).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, ERR.exists);
      throw fsError(error);
    }
    return { root: rootId, path: rel, kind };
  }

  /** O item existente em `rel` para renomear ou apagar: age no próprio caminho (um link é o link, não o alvo). */
  private async existingEntry(rootId: string, rel: string) {
    const { root, parent, name, abs } = await this.parentOf(rootId, rel);
    const info = await this.lstatOrNull(abs);
    if (info === null) throw new HttpError(404, ERR.missing);
    const level = rel.split("/").length - 1;
    if (info.isSymbolicLink()) {
      if (this.lockedByName(root, name, level)) throw new HttpError(403, ERR.locked);
    } else {
      const item = await this.resolve(rootId, rel);
      if (item.locked) throw new HttpError(403, ERR.locked);
    }
    return { root, parent, name, abs, info };
  }

  async rename(rootId: string, from: string, to: string, overwrite = false): Promise<FileRenameResponse> {
    const source = await this.existingEntry(rootId, from);
    const dest = await this.parentOf(rootId, to);
    const isDir = source.info.isDirectory();
    const kinds: FileEntryKind[] = source.info.isSymbolicLink() ? ["file", "dir"] : [isDir ? "dir" : "file"];
    for (const kind of kinds) {
      const nameError = fileNameError(dest.name, kind);
      if (nameError) throw new HttpError(400, nameError);
    }
    if (dest.abs === source.abs) return { root: rootId, path: to };
    if (isDir && isInside(dest.abs, source.abs)) throw new HttpError(400, ERR.intoSelf);
    const existing = await this.lstatOrNull(dest.abs);
    if (existing !== null && !(overwrite && existing.isFile() && source.info.isFile())) throw new HttpError(409, ERR.exists);
    try {
      await rename(source.abs, dest.abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV") throw new HttpError(400, ERR.otherDisk);
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") throw new HttpError(409, ERR.exists);
      throw fsError(error);
    }
    return { root: rootId, path: to };
  }

  async delete(rootId: string, rel: string): Promise<FileDeleteResponse> {
    const item = await this.existingEntry(rootId, rel);
    let deleted = 1;
    try {
      if (item.info.isSymbolicLink() || !item.info.isDirectory()) {
        await unlink(item.abs);
      } else {
        const counted = await this.countIn(item.abs);
        deleted = 1 + counted.files + counted.dirs;
        // `rm` recursivo não segue links: um link dentro da pasta sai como link.
        await rm(item.abs, { recursive: true, force: false });
      }
    } catch (error) {
      throw fsError(error);
    }
    return { root: rootId, path: rel, deleted };
  }

  /** Conta em largura, sem seguir links (um link conta como arquivo); para no teto. */
  private async countIn(dirReal: string): Promise<{ files: number; dirs: number; truncated: boolean }> {
    let files = 0;
    let dirs = 0;
    let truncated = false;
    const queue = [dirReal];
    walk: for (let head = 0; head < queue.length; head += 1) {
      let dirents: Dirent[];
      try {
        dirents = await readdir(queue[head]!, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (files + dirs >= this.countScan) {
          truncated = true;
          break walk;
        }
        if (dirent.isDirectory()) {
          dirs += 1;
          queue.push(path.join(queue[head]!, dirent.name));
        } else files += 1;
      }
    }
    return { files, dirs, truncated };
  }

  /** Quantos arquivos e pastas há dentro de uma pasta. Leitura: vale também em raiz só leitura. */
  async count(rootId: string, rel: string): Promise<FileCountResponse> {
    const dir = await this.resolve(rootId, rel);
    if (dir.locked) throw new HttpError(403, ERR.locked);
    if (!dir.info.isDirectory()) throw new HttpError(400, ERR.notDir);
    return { root: rootId, path: rel, ...(await this.countIn(dir.real)) };
  }

  /** Recebe o arquivo em fluxo para um temporário na pasta de destino e renomeia no fim. */
  async upload(rootId: string, dirRel: string, name: string, overwrite: boolean, body: NodeJS.ReadableStream): Promise<FileWriteResponse> {
    const root = this.findRoot(rootId);
    this.assertWritable(root);
    const nameError = fileNameError(name, "file");
    if (nameError) throw new HttpError(400, nameError);
    const parent = await this.resolve(rootId, dirRel);
    if (parent.locked) throw new HttpError(403, ERR.locked);
    if (!parent.info.isDirectory()) throw new HttpError(400, ERR.notDir);
    const abs = path.join(parent.real, name);
    const rel = joinFilePath(dirRel, name);
    const existing = await this.lstatOrNull(abs);
    let mode: number | undefined;
    if (existing !== null) {
      if (!overwrite) throw new HttpError(409, ERR.exists);
      if (!existing.isFile()) throw new HttpError(existing.isSymbolicLink() ? 403 : 409, existing.isSymbolicLink() ? ERR.locked : ERR.exists);
      mode = existing.mode & 0o7777;
    }
    const tmp = path.join(parent.real, this.tempName());
    const limit = this.uploadBytes;
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > limit) done(new HttpError(413, ERR.uploadTooBig));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(tmp, { flags: "wx", mode: 0o644 }));
      if (mode !== undefined) await chmod(tmp, mode);
      if (overwrite) {
        await rename(tmp, abs);
      } else {
        // `link` falha se o destino apareceu no meio do envio; o temporário sai em seguida.
        try {
          await link(tmp, abs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, ERR.exists);
          if ((await this.lstatOrNull(abs)) !== null) throw new HttpError(409, ERR.exists);
          await rename(tmp, abs);
        }
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (error instanceof HttpError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") throw new HttpError(400, "O envio foi interrompido.");
      throw fsError(error);
    }
    return this.statResponse(rootId, rel, abs);
  }
}
