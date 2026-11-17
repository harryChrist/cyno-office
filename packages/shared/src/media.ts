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

/** Qualquer arquivo sem tipo conhecido entra com este mime (kind "other", guardado como .bin). */
export const MEDIA_OTHER_MIME = "application/octet-stream";

/** Tipos conhecidos: mime -> tipo e extensão guardada. HTML fica como documento (nunca é servido como página). Qualquer outro tipo cai em MEDIA_OTHER_MIME. */
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
  "application/xml": { kind: "document", ext: "xml" },
  "application/rtf": { kind: "document", ext: "rtf" },
  "application/msword": { kind: "document", ext: "doc" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { kind: "document", ext: "docx" },
  "application/vnd.ms-excel": { kind: "document", ext: "xls" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { kind: "document", ext: "xlsx" },
  "application/vnd.ms-powerpoint": { kind: "document", ext: "ppt" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { kind: "document", ext: "pptx" },
  "application/vnd.oasis.opendocument.text": { kind: "document", ext: "odt" },
  "application/vnd.oasis.opendocument.spreadsheet": { kind: "document", ext: "ods" },
  "application/vnd.oasis.opendocument.presentation": { kind: "document", ext: "odp" },
  "application/epub+zip": { kind: "document", ext: "epub" },
  "image/avif": { kind: "image", ext: "avif" },
  "image/bmp": { kind: "image", ext: "bmp" },
  "audio/mp4": { kind: "audio", ext: "m4a" },
  "audio/flac": { kind: "audio", ext: "flac" },
  "audio/aac": { kind: "audio", ext: "aac" },
  "video/x-matroska": { kind: "video", ext: "mkv" },
  "application/zip": { kind: "other", ext: "zip" },
  "application/gzip": { kind: "other", ext: "gz" },
  "application/x-7z-compressed": { kind: "other", ext: "7z" },
  "application/x-rar-compressed": { kind: "other", ext: "rar" },
  "application/x-tar": { kind: "other", ext: "tar" },
  [MEDIA_OTHER_MIME]: { kind: "other", ext: "bin" },
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
  xml: "application/xml",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  avif: "image/avif",
  bmp: "image/bmp",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mkv: "video/x-matroska",
  zip: "application/zip",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/x-rar-compressed",
  tar: "application/x-tar",
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

/** Tipo (image/video/…) de um mime; undefined = mime fora da tabela (entra como "other"). */
export function mediaKindOf(mime: string): MediaKind | undefined {
  return MEDIA_MIME_TABLE[mime.toLowerCase()]?.kind;
}

/**
 * O mime guardado de um arquivo: o declarado quando está na tabela (e não é o genérico); senão o da extensão do
 * nome; senão application/octet-stream. Nada é recusado por tipo.
 */
export function resolveMediaMime(declared: string | undefined, fileName: string): string {
  const mime = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime && mime !== MEDIA_OTHER_MIME && MEDIA_MIME_TABLE[mime]) return mime;
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return MEDIA_EXT_MIME[ext] ?? MEDIA_OTHER_MIME;
}

// ---------- Pastas ----------

/** Profundidade máxima de pastas ("A/B/C/D/E") e tamanhos. */
export const MEDIA_FOLDER_LIMITS = { depth: 5, name: 60, path: 320, count: 500 } as const;

/** Nome de UMA pasta saneado (sem "/", controles, "." ou ".."); null = sobra nada utilizável. */
export function cleanFolderName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").replace(/\s+/g, " ").trim().slice(0, MEDIA_FOLDER_LIMITS.name).trim();
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * Caminho de pasta normalizado ("Livros/Matemática"); "" = raiz. Devolve null quando é inválido: segmento ".."
 * ou "." , segmento vazio depois de sanear, ou mais fundo que o limite. Barras nas pontas e repetidas são ignoradas.
 */
export function normalizeFolderPath(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (text === "") return "";
  const parts = text.replace(/\\/g, "/").split("/").filter((part) => part.trim() !== "");
  if (parts.length > MEDIA_FOLDER_LIMITS.depth) return null;
  const clean: string[] = [];
  for (const part of parts) {
    // ".." e "." não viram nome: o caminho inteiro é recusado.
    if (part.trim() === ".." || part.trim() === ".") return null;
    const name = cleanFolderName(part);
    if (!name) return null;
    clean.push(name);
  }
  const joined = clean.join("/");
  return joined.length > MEDIA_FOLDER_LIMITS.path ? null : joined;
}

/** "A/B/C" -> ["A", "A/B", "A/B/C"]. */
export function folderChain(folder: string): string[] {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Pasta de cima ("A/B" -> "A"; "A" -> ""). */
export const parentFolder = (folder: string): string => folder.split("/").slice(0, -1).join("/");

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
  /** Pasta (caminho "Livros/Matemática"); ausente = raiz. Só existe no índice: o arquivo fica em media/files/<id>.<ext>. */
  folder: z.string().max(MEDIA_FOLDER_LIMITS.path).optional(),
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
  /** Mover de pasta: caminho, "" ou null = raiz. */
  folder: z.string().max(MEDIA_FOLDER_LIMITS.path).nullable().optional(),
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
  /** Só os itens DIRETAMENTE nesta pasta ("" = raiz); sem o parâmetro, todos. */
  folder: z.string().max(MEDIA_FOLDER_LIMITS.path).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type ListMediaQuery = z.output<typeof listMediaQuerySchema>;

/** POST /media?fileName=&title= (corpo = bytes do arquivo; Content-Type = mime). */
export const uploadMediaQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(MEDIA_LIMITS.fileName),
  title: z.string().trim().min(1).max(MEDIA_LIMITS.title).optional(),
  /** Pasta onde o arquivo cai (criada se não existir). */
  folder: z.string().max(MEDIA_FOLDER_LIMITS.path).optional(),
});
export type UploadMediaQuery = z.output<typeof uploadMediaQuerySchema>;

/** POST /media/bring: copia a mídia de outro workspace para este (o arquivo é copiado; nada é compartilhado). */
export const bringMediaBodySchema = z.strictObject({ workspace: z.string().min(1).max(MAX_ID_LENGTH), mediaId: mediaIdSchema });
export type BringMediaBody = z.input<typeof bringMediaBodySchema>;

/** GET /media/folders */
export type MediaFoldersResponse = { folders: string[] };

/** POST /media/folders: cria `name` dentro de `parent` (raiz se omitido). */
export const createMediaFolderBodySchema = z.strictObject({ name: z.string().min(1).max(200), parent: z.string().max(MEDIA_FOLDER_LIMITS.path).optional() });
export type CreateMediaFolderBody = z.input<typeof createMediaFolderBodySchema>;

/** PATCH /media/folders: renomeia a pasta `path` (só o último nome; subpastas e itens vão junto). */
export const renameMediaFolderBodySchema = z.strictObject({ path: z.string().min(1).max(MEDIA_FOLDER_LIMITS.path), name: z.string().min(1).max(200) });
export type RenameMediaFolderBody = z.input<typeof renameMediaFolderBodySchema>;

/** DELETE /media/folders?path= (os itens e as subpastas sobem para a pasta de cima; nenhum arquivo é apagado). */
export const deleteMediaFolderQuerySchema = z.object({ path: z.string().min(1).max(MEDIA_FOLDER_LIMITS.path) });

/** POST /media/move: move itens para uma pasta (null ou "" = raiz). */
export const moveMediaBodySchema = z.strictObject({ ids: z.array(mediaIdSchema).min(1).max(500), folder: z.string().max(MEDIA_FOLDER_LIMITS.path).nullable() });
export type MoveMediaBody = z.input<typeof moveMediaBodySchema>;
