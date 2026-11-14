import { z } from "zod";
import { MAX_ID_LENGTH } from "./ids";

/**
 * Biblioteca de mídia do workspace (media/media.json + media/files/): imagens, vídeos, áudios e
 * documentos que os agentes (ou o usuário) criam, com quem fez, para qual tarefa/aprovação e onde
 * foi publicado. Os nomes e descrições das ferramentas MCP ficam em inglês; os rótulos daqui são
 * para a interface (pt-BR).
 */

export const MEDIA_KINDS = ["image", "video", "audio", "document", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MEDIA_KIND_LABELS: Record<MediaKind, string> = { image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento", other: "Outro" };

/** html = HTML renderizado em imagem; arquivo = arquivo que o agente fez na pasta dele; upload = enviado pelo usuário; screenshot = foto do navegador. */
export const MEDIA_ORIGINS = ["html", "arquivo", "upload", "screenshot", "mural", "app"] as const;
export type MediaOrigin = (typeof MEDIA_ORIGINS)[number];
export const MEDIA_ORIGIN_LABELS: Record<MediaOrigin, string> = { html: "HTML renderizado", arquivo: "Arquivo do agente", upload: "Enviado por você", screenshot: "Captura de tela", mural: "Do mural", app: "Feito por um app" };

export const MEDIA_STATUSES = ["rascunho", "aprovado", "publicado", "descartado"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
export const MEDIA_STATUS_LABELS: Record<MediaStatus, string> = { rascunho: "Rascunho", aprovado: "Aprovado", publicado: "Publicado", descartado: "Descartado" };

/** Quem criou quando não foi um agente. */
export const MEDIA_USER_CREATOR = "usuario";

/** Limite de tamanho por tipo (bytes). */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 300 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  other: 50 * 1024 * 1024,
};

/** Tipos aceitos: mime -> tipo e extensão guardada. HTML fica como documento (nunca é servido como página). */
export const MEDIA_MIME_TABLE: Record<string, { kind: MediaKind; ext: string }> = {
  "image/png": { kind: "image", ext: "png" },
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/gif": { kind: "image", ext: "gif" },
  "image/svg+xml": { kind: "image", ext: "svg" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
  "video/quicktime": { kind: "video", ext: "mov" },
  "audio/mpeg": { kind: "audio", ext: "mp3" },
  "audio/wav": { kind: "audio", ext: "wav" },
  "audio/ogg": { kind: "audio", ext: "ogg" },
  "application/pdf": { kind: "document", ext: "pdf" },
  "text/plain": { kind: "document", ext: "txt" },
  "text/markdown": { kind: "document", ext: "md" },
  "text/csv": { kind: "document", ext: "csv" },
  "application/json": { kind: "document", ext: "json" },
  "text/html": { kind: "document", ext: "html" },
};

/** Extensão (sem ponto, minúscula) -> mime aceito. */
export const MEDIA_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
};

export const MEDIA_LIMITS = { title: 200, fileName: 200, where: 200, note: 1000, url: 2000, tags: 10, tag: 40 } as const;

export const MEDIA_ID_PATTERN = /^M-\d{4,}$/;
export const mediaIdSchema = z.string().regex(MEDIA_ID_PATTERN, "id inválido: use o formato M-0001");

/** "M-0001", sequencial por workspace. */
export function nextMediaId(items: readonly { id: string }[]): string {
  let max = 0;
  for (const item of items) {
    const n = Number(item.id.slice(2));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `M-${String(max + 1).padStart(4, "0")}`;
}

/** Tipo (image/video/…) de um mime; undefined = mime não aceito. */
export function mediaKindOf(mime: string): MediaKind | undefined {
  return MEDIA_MIME_TABLE[mime.toLowerCase()]?.kind;
}

export const mediaItemSchema = z.object({
  id: mediaIdSchema,
  kind: z.enum(MEDIA_KINDS),
  mime: z.string().max(100),
  fileName: z.string().max(MEDIA_LIMITS.fileName),
  title: z.string().max(MEDIA_LIMITS.title),
  size: z.number().int().min(0),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
  /** Id do agente ou "usuario". */
  createdBy: z.string().min(1).max(MAX_ID_LENGTH),
  origin: z.enum(MEDIA_ORIGINS),
  taskId: z.string().max(80).optional(),
  rootTaskId: z.string().max(80).optional(),
  forYouIds: z.array(z.string().max(16)).max(200).optional(),
  status: z.enum(MEDIA_STATUSES).default("rascunho"),
  publishedUrl: z.string().max(MEDIA_LIMITS.url).optional(),
  where: z.string().max(MEDIA_LIMITS.where).optional(),
  note: z.string().max(MEDIA_LIMITS.note).optional(),
  tags: z.array(z.string().max(MEDIA_LIMITS.tag)).max(MEDIA_LIMITS.tags).optional(),
  /** Compartilhada com a plataforma (mural do Cyno): quando e com que nota. */
  shared: z.object({ at: z.iso.datetime(), note: z.string().max(500).default("") }).optional(),
});
export type MediaItem = z.output<typeof mediaItemSchema>;

/** media/media.json */
export const mediaFileSchema = z.array(mediaItemSchema);

/** PATCH /media/:id (só o que muda; null apaga o campo). */
export const updateMediaBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(MEDIA_LIMITS.title).optional(),
  status: z.enum(MEDIA_STATUSES).optional(),
  publishedUrl: z.string().trim().max(MEDIA_LIMITS.url).nullable().optional(),
  where: z.string().trim().max(MEDIA_LIMITS.where).nullable().optional(),
  note: z.string().trim().max(MEDIA_LIMITS.note).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(MEDIA_LIMITS.tag)).max(MEDIA_LIMITS.tags).optional(),
});
export type UpdateMediaBody = z.input<typeof updateMediaBodySchema>;

export const mediaParamsSchema = z.object({ id: mediaIdSchema });

/** GET /media?kind=&agentId=&taskId=&status=&q=&limit= */
export const listMediaQuerySchema = z.object({
  kind: z.enum(MEDIA_KINDS).optional(),
  agentId: z.string().max(MAX_ID_LENGTH).optional(),
  taskId: z.string().max(80).optional(),
  status: z.enum(MEDIA_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type ListMediaQuery = z.output<typeof listMediaQuerySchema>;

/** POST /media?fileName=&title= (corpo = bytes do arquivo; Content-Type = mime). */
export const uploadMediaQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(MEDIA_LIMITS.fileName),
  title: z.string().trim().min(1).max(MEDIA_LIMITS.title).optional(),
});
export type UploadMediaQuery = z.output<typeof uploadMediaQuerySchema>;

/** POST /media/bring: copia a mídia de outro workspace para este (o arquivo é copiado; nada é compartilhado). */
export const bringMediaBodySchema = z.strictObject({ workspace: z.string().min(1).max(MAX_ID_LENGTH), mediaId: mediaIdSchema });
export type BringMediaBody = z.input<typeof bringMediaBodySchema>;
