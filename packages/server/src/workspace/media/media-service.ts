import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import {
  MEDIA_LIMITS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_TABLE,
  nextMediaId,
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
import { contentMatchesMime, imageSize, mimeOfFileName } from "./sniff";

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
};

/** Bytes lidos do começo do arquivo para conferir o tipo e achar as dimensões (o SOF de um JPEG pode vir depois do EXIF). */
const HEAD_BYTES = 256 * 1024;

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
  constructor(
    private items: MediaItem[],
    private readonly deps: MediaServiceDeps,
  ) {}

  // ---------- Leitura ----------

  /** Mais recentes primeiro, com os filtros da rota. */
  list(filter: Partial<ListMediaQuery> & { limit?: number } = {}): MediaItem[] {
    const q = filter.q?.trim().toLowerCase();
    const found = this.items
      .filter((item) => (!filter.kind || item.kind === filter.kind) && (!filter.agentId || item.createdBy === filter.agentId) && (!filter.taskId || item.taskId === filter.taskId || item.rootTaskId === filter.taskId) && (!filter.status || item.status === filter.status))
      .filter((item) => !q || [item.id, item.title, item.fileName, item.note, item.where, item.publishedUrl, ...(item.tags ?? [])].some((field) => field?.toLowerCase().includes(q)))
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

  /** Valida o mime e o tamanho de um arquivo (HttpError 415/413) e devolve o tipo. */
  private check(mime: string, size?: number): { kind: MediaKind; ext: string } {
    const entry = MEDIA_MIME_TABLE[mime];
    if (!entry) throw new HttpError(415, `Tipo de arquivo não aceito: ${mime || "(sem tipo)"}`);
    if (size !== undefined && size > MEDIA_MAX_BYTES[entry.kind]) throw new HttpError(413, `Arquivo grande demais para ${entry.kind} (máximo ${Math.round(MEDIA_MAX_BYTES[entry.kind] / 1024 / 1024)} MB)`);
    return entry;
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
  private async adopt(tmp: string, size: number, mime: string, meta: MediaMeta): Promise<MediaItem> {
    const entry = this.check(mime, size);
    if (size === 0) throw new HttpError(400, "Arquivo vazio");
    const head = await this.head(tmp);
    if (!contentMatchesMime(mime, head)) throw new HttpError(415, `O conteúdo do arquivo não bate com o tipo ${mime}`);
    const dims = entry.kind === "image" ? imageSize(head) : undefined;
    // Do id ao push é tudo síncrono: dois envios ao mesmo tempo nunca pegam o mesmo id.
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
    };
    await rename(tmp, this.fileOf(item));
    this.items.push(item);
    this.commit({ type: "media:upserted", media: structuredClone(item) });
    return structuredClone(item);
  }

  private async tmpPath(): Promise<string> {
    await mkdir(this.deps.filesDir, { recursive: true });
    return path.join(this.deps.filesDir, `.upload-${randomUUID()}.tmp`);
  }

  /** Item novo a partir de bytes já em memória (HTML renderizado, captura de tela). */
  async addBuffer(buf: Buffer, mime: string, meta: MediaMeta): Promise<MediaItem> {
    this.check(mime, buf.length);
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

  /** Item novo a partir de um fluxo (upload do usuário): corta quando passa do limite, sem guardar tudo na memória. */
  async addStream(stream: Readable, mimeRaw: string, meta: MediaMeta): Promise<MediaItem> {
    const mime = cleanMime(mimeRaw);
    const entry = this.check(mime);
    const limit = MEDIA_MAX_BYTES[entry.kind];
    const tmp = await this.tmpPath();
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > limit) done(new HttpError(413, `Arquivo grande demais para ${entry.kind} (máximo ${Math.round(limit / 1024 / 1024)} MB)`));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(stream, counter, createWriteStream(tmp));
      return await this.adopt(tmp, size, mime, meta);
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
    const mime = mimeOfFileName(real);
    if (!mime) throw new MediaToolError(`File type not accepted: ${path.extname(real) || "(no extension)"}. Accepted: png, jpg, webp, gif, svg, mp4, webm, mov, mp3, wav, ogg, pdf, txt, md, csv, json, html.`);
    try {
      this.check(mime, info.size);
    } catch (error) {
      throw new MediaToolError(error instanceof HttpError ? `${error.message}.` : String(error));
    }
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
    this.check(mime, info.size);
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
