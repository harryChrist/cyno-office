import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { bringMediaBodySchema, listMediaQuerySchema, MEDIA_MAX_BYTES, MEDIA_USER_CREATOR, mediaKindOf, mediaParamsSchema, updateMediaBodySchema, uploadMediaQuerySchema, type MediaItem } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../platform/http/errors";
import { cleanMime } from "../workspace/media/media-service";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { WorkspaceRuntime } from "../workspace/runtime";

/** Workspace da requisição (`:ws`). */
export type RuntimeOf = (request: FastifyRequest) => WorkspaceRuntime;

/** Maior corpo aceito num envio (o limite de cada tipo é conferido durante o recebimento). */
const UPLOAD_BODY_LIMIT = Math.max(...Object.values(MEDIA_MAX_BYTES)) + 1024 * 1024;

/**
 * Tipos servidos como texto puro (nunca como página): HTML, Markdown e afins não executam nada no
 * navegador, mesmo abertos direto pelo endereço.
 */
const AS_TEXT = new Set(["text/html", "text/markdown", "text/plain", "text/csv", "application/json"]);

/** "bytes=0-99", "bytes=500-", "bytes=-200" -> faixa dentro do arquivo; null = inválida (416). */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "") || size === 0) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const tail = Number(match[2]);
    if (tail === 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? null : { start, end };
}

/** Nome para o Content-Disposition: ASCII de reserva e o nome real em UTF-8 (RFC 5987). */
function disposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Biblioteca de mídia, dentro de /api/w/:ws:
 * - GET    /media?kind=&agentId=&taskId=&status=&q=&limit= -> MediaItem[] (mais novos primeiro)
 * - GET    /media/:id                                      -> MediaItem
 * - GET    /media/:id/file[?download=1]                    -> os bytes (com Range para vídeo); sempre nosniff + CSP sandbox
 * - POST   /media?fileName=&title=                         -> 201 MediaItem (corpo = bytes crus; Content-Type = mime do arquivo)
 * - POST   /media/bring                                    -> 201 MediaItem (copia a mídia de OUTRO workspace para este: { workspace, mediaId })
 * - PATCH  /media/:id                                      -> MediaItem (title, status, publishedUrl, where, note, tags)
 * - DELETE /media/:id                                      -> 204 (só você: apaga o arquivo e a entrada)
 */
export function registerMediaRoutes(scope: FastifyInstance, runtimeOf: RuntimeOf, manager?: Pick<WorkspaceManager, "get" | "list">): void {
  scope.get("/media", async (request): Promise<MediaItem[]> => runtimeOf(request).media.list(listMediaQuerySchema.parse(request.query ?? {})));

  scope.get("/media/:id", async (request): Promise<MediaItem> => runtimeOf(request).media.get(mediaParamsSchema.parse(request.params).id));

  scope.get("/media/:id/file", async (request, reply) => {
    const media = runtimeOf(request).media;
    const item = media.get(mediaParamsSchema.parse(request.params).id);
    const file = media.fileOf(item);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new HttpError(404, `O arquivo de "${item.id}" não está mais no disco`);
    const download = (request.query as { download?: string } | undefined)?.download === "1";
    const etag = `"${item.id}-${info.size}-${Math.round(info.mtimeMs)}"`;
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .header("Cross-Origin-Resource-Policy", "same-site")
      .header("Content-Type", AS_TEXT.has(item.mime) ? "text/plain; charset=utf-8" : item.mime)
      .header("Content-Disposition", disposition(download ? "attachment" : "inline", item.fileName))
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "private, no-cache")
      .header("ETag", etag);
    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const range = parseRange(rangeHeader, info.size);
      if (!range) return reply.code(416).header("Content-Range", `bytes */${info.size}`).send();
      reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`).header("Content-Length", range.end - range.start + 1);
      return reply.send(createReadStream(file, { start: range.start, end: range.end }));
    }
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.header("Content-Length", info.size);
    return reply.send(createReadStream(file));
  });

  scope.post("/media/bring", async (request, reply): Promise<MediaItem> => {
    const body = bringMediaBodySchema.parse(request.body ?? {});
    const target = runtimeOf(request);
    if (!manager) throw new HttpError(503, "O gerenciador de workspaces não está pronto");
    if (target.id === body.workspace) throw new HttpError(409, "Esta mídia já é deste workspace");
    const origin = manager.get(body.workspace);
    const source = origin.media.get(body.mediaId);
    const originName = manager.list().find((workspace) => workspace.id === body.workspace)?.name ?? body.workspace;
    const copy = await target.media.copyFrom(origin.media.fileOf(source), source.mime, {
      title: source.title,
      createdBy: MEDIA_USER_CREATOR,
      origin: "mural",
      fileName: source.fileName,
      note: `Veio de ${originName} · ${source.id}`.slice(0, 500),
    });
    reply.code(201);
    return copy;
  });

  scope.patch("/media/:id", async (request) => {
    const { id } = mediaParamsSchema.parse(request.params);
    return runtimeOf(request).media.update(id, updateMediaBodySchema.parse(request.body ?? {}));
  });

  scope.delete("/media/:id", async (request, reply) => {
    await runtimeOf(request).media.delete(mediaParamsSchema.parse(request.params).id);
    return reply.code(204).send();
  });

  // O envio recebe os bytes crus: o parser "qualquer tipo" fica só neste contexto (as outras rotas seguem com JSON).
  void scope.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    upload.post("/media", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request: FastifyRequest, reply: FastifyReply) => {
      const query = uploadMediaQuerySchema.parse(request.query ?? {});
      const mime = cleanMime(request.headers["content-type"]);
      const kind = mediaKindOf(mime);
      if (!kind) throw new HttpError(415, `Tipo de arquivo não aceito: ${mime || "(sem Content-Type)"}`);
      // Recusa logo, antes de receber, quando o tamanho declarado já passa do limite do tipo.
      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MEDIA_MAX_BYTES[kind]) throw new HttpError(413, `Arquivo grande demais para ${kind} (máximo ${Math.round(MEDIA_MAX_BYTES[kind] / 1024 / 1024)} MB)`);
      const item = await runtimeOf(request).media.addStream(request.body as NodeJS.ReadableStream as never, mime, {
        title: query.title ?? (path.parse(query.fileName).name || query.fileName),
        createdBy: MEDIA_USER_CREATOR,
        origin: "upload",
        fileName: query.fileName,
      });
      return reply.code(201).send(item);
    });
  });
}
