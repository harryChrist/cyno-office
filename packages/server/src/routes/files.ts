import {
  fileCountQuerySchema,
  fileCreateBodySchema,
  fileDeleteBodySchema,
  fileListQuerySchema,
  fileRawQuerySchema,
  fileReadQuerySchema,
  fileRenameBodySchema,
  fileSearchQuerySchema,
  fileUploadQuerySchema,
  fileWriteBodySchema,
  FILE_LIMITS,
  type FileCountResponse,
  type FileCreateResponse,
  type FileDeleteResponse,
  type FileListResponse,
  type FileReadResponse,
  type FileRenameResponse,
  type FileRootsResponse,
  type FileSearchResponse,
  type FileUploadResponse,
  type FileWriteResponse,
} from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { attachment } from "../platform/http/attachment";
import { HttpError } from "../platform/http/errors";
import type { FilesService } from "../workspace/files/service";

/** Arquivos do workspace da requisição (`:ws`). */
export type FilesOf = (request: FastifyRequest) => FilesService;

/**
 * Arquivos do workspace (dentro de /api/w/:ws). Leitura:
 * - GET /files/roots   -> as raízes (dados do workspace e pastas de trabalho)
 * - GET /files/list    -> uma página dos itens de uma pasta
 * - GET /files/read    -> dados e prévia de texto de um arquivo
 * - GET /files/raw     -> o arquivo em fluxo (imagem na tela ou anexo)
 * - GET /files/search  -> busca por nome dentro de uma raiz
 * - GET /files/count   -> quantos itens há dentro de uma pasta
 * Alterações (só em pasta de trabalho com escrita):
 * - PUT  /files/write  -> salva o texto de um arquivo (cria se não existe)
 * - POST /files/create -> cria arquivo vazio ou pasta
 * - POST /files/rename -> renomeia ou move dentro da raiz
 * - POST /files/delete -> apaga arquivo, link ou pasta inteira
 * - POST /files/upload -> envia um arquivo (corpo cru em fluxo)
 */
export function registerFileRoutes(scope: FastifyInstance, filesOf: FilesOf): void {
  scope.get("/files/roots", async (request): Promise<FileRootsResponse> => filesOf(request).roots());

  scope.get("/files/list", async (request): Promise<FileListResponse> => {
    const { root, path, offset, limit, filter } = fileListQuerySchema.parse(request.query);
    return filesOf(request).list(root, path, { offset, limit, filter });
  });

  scope.get("/files/read", async (request): Promise<FileReadResponse> => {
    const { root, path, known, edit } = fileReadQuerySchema.parse(request.query);
    return filesOf(request).read(root, path, known, edit === "1");
  });

  scope.get("/files/raw", async (request, reply) => {
    const { root, path, download } = fileRawQuerySchema.parse(request.query);
    const file = await filesOf(request).raw(root, path, download === "1");
    // O conteúdo vem de fora: nunca é interpretado pelo navegador (sem sniffing, sem script).
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .header("Cache-Control", "no-store")
      .header("Content-Length", file.size);
    if (file.inlineMime) reply.header("Content-Type", file.inlineMime);
    else reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", attachment(file.name));
    return reply.send(file.stream);
  });

  scope.get("/files/search", async (request): Promise<FileSearchResponse> => {
    const { root, q } = fileSearchQuerySchema.parse(request.query);
    return filesOf(request).search(root, q);
  });

  scope.get("/files/count", async (request): Promise<FileCountResponse> => {
    const { root, path } = fileCountQuerySchema.parse(request.query);
    return filesOf(request).count(root, path);
  });

  // O texto vai dentro de um JSON: no pior caso (muitas quebras de linha e caracteres escapados) ele ocupa várias vezes
  // o tamanho do arquivo, e o teto padrão de 1 MB recusaria um arquivo que cabe no limite de edição.
  scope.put("/files/write", { bodyLimit: FILE_LIMITS.editBytes * 6 + 64 * 1024 }, async (request): Promise<FileWriteResponse> => {
    const body = fileWriteBodySchema.parse(request.body);
    return filesOf(request).write(body.root, body.path, body.text, body.baseVersion);
  });

  scope.post("/files/create", async (request, reply): Promise<FileCreateResponse> => {
    const body = fileCreateBodySchema.parse(request.body);
    reply.code(201);
    return filesOf(request).create(body.root, body.path, body.kind);
  });

  scope.post("/files/rename", async (request): Promise<FileRenameResponse> => {
    const body = fileRenameBodySchema.parse(request.body);
    return filesOf(request).rename(body.root, body.from, body.to, body.overwrite === true);
  });

  scope.post("/files/delete", async (request): Promise<FileDeleteResponse> => {
    const body = fileDeleteBodySchema.parse(request.body);
    return filesOf(request).delete(body.root, body.path);
  });

  // O envio recebe os bytes crus: o parser "qualquer tipo" fica só neste contexto (as outras rotas seguem com JSON).
  void scope.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    // Antes de ler o corpo: tamanho declarado acima do teto responde na hora, com a mensagem em português.
    upload.addHook("onRequest", async (request, reply) => {
      if (request.method === "POST" && Number(request.headers["content-length"] ?? 0) > FILE_LIMITS.uploadBytes) {
        return reply.header("Connection", "close").code(413).send({ error: "Arquivo grande demais para enviar por aqui." });
      }
      return undefined;
    });
    upload.post("/files/upload", { bodyLimit: FILE_LIMITS.uploadBytes }, async (request: FastifyRequest, reply: FastifyReply): Promise<FileUploadResponse> => {
      const query = fileUploadQuerySchema.parse(request.query ?? {});
      try {
        const result = await filesOf(request).upload(query.root, query.path, query.name, query.overwrite === "1", request.body as NodeJS.ReadableStream);
        reply.code(201);
        return result;
      } catch (error) {
        // Recusou com o corpo ainda chegando: fecha a conexão em vez de ler tudo à toa.
        if (error instanceof HttpError) reply.header("Connection", "close");
        throw error;
      }
    });
  });
}
