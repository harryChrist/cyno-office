import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  folderChain,
  MEDIA_FOLDER_LIMITS,
  MEDIA_LIMITS,
  MEDIA_MIME_TABLE,
  MEDIA_OTHER_MIME,
  cleanFolderName,
  nextMediaId,
  normalizeFolderPath,
  parentFolder,
  resolveMediaMime,
  type ListMediaQuery,
  type MediaItem,
  type MediaKind,
  type MediaOrigin,
  type ServerEvent,
  type UpdateMediaBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";
import { contentMatchesMime, imageSize } from "./sniff";

/** Erro de uma ferramenta MCP (mensagem em inglês, o modelo lê). */
export class MediaToolError extends Error {}

export type MediaServiceDeps = {
  /** data/workspaces/<id>/media/ */
  dir: string;
  /** data/workspaces/<id>/media/media.json */
  file: string;
  /** data/workspaces/<id>/media/files/ */
  filesDir: string;
  /** A mesma fila de escrita do workspace. */
  queue: WriteQueue;
  publish: (event: ServerEvent) => void;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
  now: () => Date;
};

/** Quem e para quê: o que a mídia nova leva de contexto. */
export type MediaMeta = {
  title: string;
  createdBy: string;
  origin: MediaOrigin;
  taskId?: string;
  rootTaskId?: string;
  note?: string;
  where?: string;
  fileName?: string;
  /** Pasta de destino (caminho; criada se não existir). Ausente = raiz. */
  folder?: string;
};

/** Bytes lidos do começo do arquivo para conferir o tipo e achar as dimensões (o SOF de um JPEG pode vir depois do EXIF). */
const HEAD_BYTES = 256 * 1024;

/** Pasta recusada (caminho com "..", fundo demais...). */
const badFolder = (raw: string): HttpError => new HttpError(400, `Pasta inválida: "${raw}". Use nomes simples separados por "/" (até ${MEDIA_FOLDER_LIMITS.depth} níveis, sem "..").`);

/** Mime sem parâmetros ("image/png; charset=x" -> "image/png"), minúsculo. */
export function cleanMime(raw: string | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Nome de arquivo seguro para mostrar (sem pasta, sem controles). */
export function safeFileName(raw: string, fallbackExt: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(raw.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim().slice(0, MEDIA_LIMITS.fileName);
  return base && base !== "." && base !== ".." ? base : `arquivo.${fallbackExt}`;
}

/**
 * Biblioteca de mídia do workspace: índice em media/media.json e arquivos em media/files/<id>.<ext>
 * (a extensão sai do mime aceito, nunca do nome que veio de fora). Cada mudança vai para a fila de
 * escrita e avisa a interface pelos eventos media:upserted / media:deleted.
 */
export class MediaService {
  /** Pastas criadas de forma explícita (uma pasta vazia só existe aqui). media/folders.json */
  private explicitFolders: Set<string>;

  constructor(
    private items: MediaItem[],
    private readonly deps: MediaServiceDeps,
  ) {
    this.explicitFolders = new Set(this.readFolders());
  }

  private get foldersFile(): string {
    return path.join(this.deps.dir, "folders.json");
  }

  private readFolders(): string[] {
    try {
      const data: unknown = JSON.parse(readFileSync(this.foldersFile, "utf8"));
      if (!Array.isArray(data)) return [];
      return data.flatMap((entry) => (typeof entry === "string" ? [normalizeFolderPath(entry)].filter((folder): folder is string => !!folder) : []));
    } catch {
      return [];
    }
  }

  // ---------- Leitura ----------

  /** Mais recentes primeiro, com os filtros da rota. */
  list(filter: Partial<ListMediaQuery> & { limit?: number } = {}): MediaItem[] {
    const q = filter.q?.trim().toLowerCase();
    const found = this.items
      .filter((item) => (!filter.kind || item.kind === filter.kind) && (!filter.agentId || item.createdBy === filter.agentId) && (!filter.taskId || item.taskId === filter.taskId || item.rootTaskId === filter.taskId) && (!filter.status || item.status === filter.status))
      .filter((item) => filter.folder === undefined || (item.folder ?? "") === (normalizeFolderPath(filter.folder) ?? filter.folder))
      .filter((item) => !q || [item.id, item.title, item.fileName, item.note, item.where, item.publishedUrl, item.folder, ...(item.tags ?? [])].some((field) => field?.toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return structuredClone(filter.limit ? found.slice(0, filter.limit) : found);
  }

  find(id: string): MediaItem | undefined {
    const found = this.items.find((item) => item.id === id);
    return found ? structuredClone(found) : undefined;
  }

  get(id: string): MediaItem {
    const found = this.find(id);
    if (!found) throw new HttpError(404, `Mídia "${id}" não encontrada`);
    return found;
  }

  /** Todas as pastas (as criadas, as dos itens e as de cima de cada uma), em ordem alfabética. */
  folders(): string[] {
    const all = new Set<string>();
    for (const folder of this.explicitFolders) for (const part of folderChain(folder)) all.add(part);
    for (const item of this.items) if (item.folder) for (const part of folderChain(item.folder)) all.add(part);
    return [...all].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }

  /** Caminho do arquivo de um item (a extensão vem do mime guardado). */
  fileOf(item: Pick<MediaItem, "id" | "mime">): string {
    const ext = MEDIA_MIME_TABLE[item.mime]?.ext ?? "bin";
    return path.join(this.deps.filesDir, `${item.id}.${ext}`);
  }

  /** Ids que não existem na biblioteca (vazio = todos existem). */
  missing(ids: readonly string[]): string[] {
    return ids.filter((id) => !this.items.some((item) => item.id === id));
  }

  /** Espera as gravações pedidas. */
  flush(): Promise<void> {
    return this.deps.queue.idle();
  }

  // ---------- Criação ----------

  /** Tipo e extensão guardada de um mime: o que está fora da tabela entra como "other" (.bin). */
  private check(mime: string): { kind: MediaKind; ext: string } {
    return MEDIA_MIME_TABLE[mime] ?? MEDIA_MIME_TABLE[MEDIA_OTHER_MIME]!;
  }

  /** Lê o começo de um arquivo. */
  private async head(file: string): Promise<Buffer> {
    const handle = await open(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** Confere o conteúdo do arquivo temporário, escolhe o id e põe o arquivo no lugar. */
  private async adopt(tmp: string, size: number, declaredMime: string, meta: MediaMeta): Promise<MediaItem> {
    const mime = MEDIA_MIME_TABLE[declaredMime] ? declaredMime : MEDIA_OTHER_MIME;
    const entry = this.check(mime);
    if (size === 0) throw new HttpError(400, "Arquivo vazio");
    const head = await this.head(tmp);
    if (!contentMatchesMime(mime, head)) throw new HttpError(415, `O conteúdo do arquivo não bate com o tipo ${mime}`);
    const dims = entry.kind === "image" ? imageSize(head) : undefined;
    // Do id ao push é tudo síncrono: dois envios ao mesmo tempo nunca pegam o mesmo id.
    const folder = meta.folder === undefined ? "" : normalizeFolderPath(meta.folder);
    if (folder === null) throw badFolder(meta.folder ?? "");
    const id = nextMediaId(this.items);
    const item: MediaItem = {
      id,
      kind: entry.kind,
      mime,
      fileName: safeFileName(meta.fileName ?? meta.title, entry.ext),
      title: meta.title.trim().slice(0, MEDIA_LIMITS.title) || id,
      size,
      ...(dims ?? {}),
      createdAt: this.deps.now().toISOString(),
      createdBy: meta.createdBy,
      origin: meta.origin,
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
      ...(meta.rootTaskId ? { rootTaskId: meta.rootTaskId } : {}),
      status: "rascunho",
      ...(meta.where ? { where: meta.where.slice(0, MEDIA_LIMITS.where) } : {}),
      ...(meta.note ? { note: meta.note.slice(0, MEDIA_LIMITS.note) } : {}),
      ...(folder ? { folder } : {}),
    };
    await rename(tmp, this.fileOf(item));
    this.items.push(item);
    if (folder) this.ensureFolder(folder);
    this.commit({ type: "media:upserted", media: structuredClone(item) });
    return structuredClone(item);
  }

  private async tmpPath(): Promise<string> {
    await mkdir(this.deps.filesDir, { recursive: true });
    return path.join(this.deps.filesDir, `.upload-${randomUUID()}.tmp`);
  }

  /** Item novo a partir de bytes já em memória (HTML renderizado, captura de tela). */
  async addBuffer(buf: Buffer, mime: string, meta: MediaMeta): Promise<MediaItem> {
    const tmp = await this.tmpPath();
    try {
      await open(tmp, "w").then(async (handle) => {
        try {
          await handle.writeFile(buf);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
      return await this.adopt(tmp, buf.length, mime, meta);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /**
   * Item novo a partir de um fluxo (upload do usuário), sem limite de tamanho: os bytes vão do socket direto para um
   * arquivo temporário em disco (nada de guardar o arquivo na memória) e só depois o item é criado. Qualquer tipo
   * entra; o desconhecido vira "other".
   */
  async addStream(stream: Readable, mimeRaw: string, meta: MediaMeta): Promise<MediaItem> {
    const mime = resolveMediaMime(mimeRaw, meta.fileName ?? meta.title);
    const tmp = await this.tmpPath();
    try {
      await pipeline(stream, createWriteStream(tmp));
      const info = await stat(tmp);
      return await this.adopt(tmp, info.size, mime, meta);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /**
   * `media_save_file`: copia para a biblioteca um arquivo que o agente fez na PRÓPRIA pasta. O caminho
   * é resolvido com realpath (links simbólicos e `..` que saem da pasta são recusados). O tipo vem da
   * extensão e é conferido pelo conteúdo.
   */
  async importFile(root: string, requested: string, meta: Omit<MediaMeta, "origin" | "fileName"> & { origin?: MediaOrigin }): Promise<MediaItem> {
    let realRoot: string;
    let real: string;
    try {
      realRoot = await realpath(root);
      real = await realpath(path.resolve(realRoot, requested));
    } catch {
      throw new MediaToolError(`File not found: ${requested}. Pass a path inside your own folder.`);
    }
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new MediaToolError("The file must be inside your own agent folder (links and \"..\" that leave it are refused).");
    const info = await stat(real);
    if (!info.isFile()) throw new MediaToolError(`${requested} is not a file.`);
    const mime = resolveMediaMime(undefined, real);
    const tmp = await this.tmpPath();
    try {
      await copyFile(real, tmp);
      return await this.adopt(tmp, info.size, mime, { ...meta, origin: meta.origin ?? "arquivo", fileName: path.basename(real) });
    } catch (error) {
      await rm(tmp, { force: true });
      if (error instanceof HttpError) throw new MediaToolError(`${error.message}.`);
      throw error;
    }
  }

  /**
   * Copia para a biblioteca um arquivo de OUTRA biblioteca da plataforma (o `mural_use` e a entrega de um
   * projeto conjunto). O caminho vem do servidor (`fileOf` do workspace de origem), nunca de um agente; o
   * tipo e o conteúdo são conferidos como em qualquer entrada.
   */
  async copyFrom(file: string, mime: string, meta: MediaMeta): Promise<MediaItem> {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new HttpError(404, "O arquivo de origem não existe mais");
    const tmp = await this.tmpPath();
    try {
      await copyFile(file, tmp);
      return await this.adopt(tmp, info.size, mime, meta);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  // ---------- Alteração ----------

  /** Marca (ou desmarca, com `null`) como compartilhada com a plataforma (mural). */
  setShared(id: string, note: string | null): MediaItem {
    const current = this.items.find((item) => item.id === id);
    if (!current) throw new HttpError(404, `Mídia "${id}" não encontrada`);
    if (note === null) delete current.shared;
    else current.shared = { at: this.deps.now().toISOString(), note: note.slice(0, MEDIA_LIMITS.note) };
    this.commit({ type: "media:upserted", media: structuredClone(current) });
    return structuredClone(current);
  }

  /** Altera campos (null apaga o campo opcional). Quem chama decide se é o usuário ou um agente. */
  update(id: string, patch: UpdateMediaBody): MediaItem {
    const current = this.items.find((item) => item.id === id);
    if (!current) throw new HttpError(404, `Mídia "${id}" não encontrada`);
    if (patch.title !== undefined) current.title = patch.title;
    if (patch.status !== undefined) current.status = patch.status;
    if (patch.tags !== undefined) current.tags = patch.tags.length > 0 ? patch.tags : undefined;
    if (patch.folder !== undefined) this.placeIn(current, patch.folder);
    for (const key of ["publishedUrl", "where", "note"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null || value === "") delete current[key];
      else current[key] = value;
    }
    if (current.tags === undefined) delete current.tags;
    this.commit({ type: "media:upserted", media: structuredClone(current) });
    return structuredClone(current);
  }

  // ---------- Pastas ----------

  /** Põe o item na pasta (null ou "" = raiz); cria a pasta se ainda não existir. */
  private placeIn(item: MediaItem, raw: string | null): void {
    const folder = normalizeFolderPath(raw);
    if (folder === null) throw badFolder(raw ?? "");
    if (folder) {
      this.ensureFolder(folder);
      item.folder = folder;
    } else delete item.folder;
  }

  /** Garante que a pasta (e as de cima) existam na lista explícita. */
  private ensureFolder(folder: string): void {
    const known = this.folders();
    const missing = folderChain(folder).filter((part) => !known.includes(part));
    if (missing.length === 0) return;
    if (known.length + missing.length > MEDIA_FOLDER_LIMITS.count) throw new HttpError(400, `Pastas demais (máximo ${MEDIA_FOLDER_LIMITS.count})`);
    for (const part of missing) this.explicitFolders.add(part);
    this.saveFolders();
  }

  private saveFolders(): void {
    const snapshot = [...this.explicitFolders].sort();
    this.deps.queue
      .enqueue(async () => {
        await mkdir(this.deps.dir, { recursive: true });
        await writeJsonAtomic(this.foldersFile, snapshot);
      })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar folders.json"));
  }

  /** Cria a pasta `name` dentro de `parent` (raiz se vazio). Já existe: 409. Devolve o caminho. */
  createFolder(name: string, parent = ""): string {
    const clean = cleanFolderName(name);
    if (!clean) throw new HttpError(400, "Nome de pasta inválido");
    const base = normalizeFolderPath(parent);
    if (base === null) throw badFolder(parent);
    if (base && !this.folders().includes(base)) throw new HttpError(404, `A pasta "${base}" não existe`);
    const full = normalizeFolderPath(base ? `${base}/${clean}` : clean);
    if (full === null) throw new HttpError(400, `Pastas só podem ter até ${MEDIA_FOLDER_LIMITS.depth} níveis`);
    if (this.folders().includes(full)) throw new HttpError(409, `Já existe uma pasta "${clean}" aqui`);
    this.ensureFolder(full);
    return full;
  }

  /** Renomeia a pasta (só o último nome); as subpastas e os itens vão junto. */
  renameFolder(folder: string, name: string): string {
    const from = normalizeFolderPath(folder);
    if (!from || !this.folders().includes(from)) throw new HttpError(404, `A pasta "${folder}" não existe`);
    const clean = cleanFolderName(name);
    if (!clean) throw new HttpError(400, "Nome de pasta inválido");
    const parent = parentFolder(from);
    const to = parent ? `${parent}/${clean}` : clean;
    if (to === from) return from;
    if (this.folders().includes(to)) throw new HttpError(409, `Já existe uma pasta "${clean}" aqui`);
    return this.relocate(from, to);
  }

  /**
   * Apaga a pasta SEM apagar arquivo: os itens e as subpastas dela sobem para a pasta de cima. Devolve a pasta
   * que os recebeu ("" = raiz).
   */
  deleteFolder(folder: string): string {
    const from = normalizeFolderPath(folder);
    if (!from || !this.folders().includes(from)) throw new HttpError(404, `A pasta "${folder}" não existe`);
    const up = parentFolder(from);
    this.relocate(from, up, true);
    return up;
  }

  /** Troca o prefixo `from` por `to` em itens e pastas. `flatten`: o conteúdo de `from` vai para `to`, e `from` some. */
  private relocate(from: string, to: string, flatten = false): string {
    const swap = (value: string): string => {
      if (value === from) return to;
      return value.startsWith(`${from}/`) ? (to ? `${to}${value.slice(from.length)}` : value.slice(from.length + 1)) : value;
    };
    const changed: MediaItem[] = [];
    for (const item of this.items) {
      if (!item.folder || (item.folder !== from && !item.folder.startsWith(`${from}/`))) continue;
      const next = swap(item.folder);
      if (next) item.folder = next;
      else delete item.folder;
      changed.push(item);
    }
    const next = new Set<string>();
    for (const entry of this.explicitFolders) {
      if (flatten && entry === from) continue;
      next.add(entry === from || entry.startsWith(`${from}/`) ? swap(entry) : entry);
    }
    next.delete("");
    this.explicitFolders = next;
    if (!flatten) for (const part of folderChain(to)) this.explicitFolders.add(part);
    this.saveFolders();
    if (changed.length > 0) this.commit(...changed.map((item): ServerEvent => ({ type: "media:upserted", media: structuredClone(item) })));
    return to;
  }

  /** Move vários itens de uma vez (null ou "" = raiz). */
  move(ids: readonly string[], folder: string | null): MediaItem[] {
    const found = ids.map((id) => {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new HttpError(404, `Mídia "${id}" não encontrada`);
      return item;
    });
    for (const item of found) this.placeIn(item, folder);
    if (found.length > 0) this.commit(...found.map((item): ServerEvent => ({ type: "media:upserted", media: structuredClone(item) })));
    return structuredClone(found);
  }

  /**
   * `media_get_file`: copia o arquivo ORIGINAL de um item para dentro da pasta do agente (`midia/<id>-<nome>`), que é
   * onde ele consegue ler. É uma cópia: o original da biblioteca não muda. Devolve o caminho relativo à pasta do agente.
   * Recusa pasta `midia` que seja link ou arquivo (um link poderia levar a cópia para fora da pasta do agente).
   */
  async exportTo(item: MediaItem, agentDir: string): Promise<{ relative: string; size: number }> {
    const source = this.fileOf(item);
    const info = await stat(source).catch(() => undefined);
    if (!info?.isFile()) throw new MediaToolError(`The file of ${item.id} is no longer on disk.`);
    const dir = path.join(agentDir, "midia");
    const existing = await lstat(dir).catch(() => undefined);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new MediaToolError('Your "midia" folder is not a plain folder (a link or a file is in the way); remove it and try again.');
    await mkdir(dir, { recursive: true });
    // eslint-disable-next-line no-control-regex
    const name = safeFileName(item.fileName, path.extname(source).slice(1) || "bin").replace(/^\.+/, "").replace(/\s+/g, "_").replace(/[\u0000-\u001f]/g, "_") || `arquivo.${path.extname(source).slice(1) || "bin"}`;
    const relative = `midia/${item.id}-${name}`.slice(0, 240);
    const target = path.join(agentDir, relative);
    const old = await lstat(target).catch(() => undefined);
    if (old) await rm(target, { force: true });
    await copyFile(source, target);
    return { relative, size: info.size };
  }

  /** Liga as mídias ao item do "Para você" (forYouIds). */
  linkForYou(ids: readonly string[], forYouId: string): void {
    const changed: MediaItem[] = [];
    for (const id of ids) {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item || item.forYouIds?.includes(forYouId)) continue;
      item.forYouIds = [...(item.forYouIds ?? []), forYouId];
      changed.push(item);
    }
    if (changed.length > 0) this.commit(...changed.map((item): ServerEvent => ({ type: "media:upserted", media: structuredClone(item) })));
  }

  /** O item do "Para você" foi aprovado: mídia em rascunho vira "aprovado" (as outras ficam como estão). */
  approve(ids: readonly string[]): void {
    const changed = this.items.filter((item) => ids.includes(item.id) && item.status === "rascunho");
    for (const item of changed) item.status = "aprovado";
    if (changed.length > 0) this.commit(...changed.map((item): ServerEvent => ({ type: "media:upserted", media: structuredClone(item) })));
  }

  /** Apaga o arquivo e a entrada (só o usuário, pela rota). */
  async delete(id: string): Promise<void> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) throw new HttpError(404, `Mídia "${id}" não encontrada`);
    const [item] = this.items.splice(index, 1);
    this.commit({ type: "media:deleted", id });
    await rm(this.fileOf(item!), { force: true });
  }

  // ---------- Internos ----------

  /** Grava o índice (pela fila) e publica. */
  private commit(...events: ServerEvent[]): void {
    const snapshot = structuredClone(this.items);
    this.deps.queue
      .enqueue(async () => {
        await mkdir(this.deps.dir, { recursive: true });
        await writeJsonAtomic(this.deps.file, snapshot);
      })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar media.json"));
    for (const event of events) this.deps.publish(event);
  }
}
