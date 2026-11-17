import { boardParamsSchema, updateBoardBodySchema, type Board } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { RuntimeOf } from "./media";

/**
 * Quadros do workspace, dentro de /api/w/:ws (a página e os dados nunca são servidos como página: texto puro
 * e JSON com nosniff + CSP sandbox, mesmo abertos direto pelo endereço; a tela os mostra num iframe isolado):
 * - GET    /boards            -> Board[] (o mexido por último primeiro)
 * - GET    /boards/:id        -> Board
 * - GET    /boards/:id/page   -> o HTML da página, como text/plain
 * - GET    /boards/:id/data   -> os dados, application/json (o JSON do agente, como está guardado)
 * - PATCH  /boards/:id        -> Board (o dono renomeia: title, description)
 * - DELETE /boards/:id        -> 204 (só o dono; os agentes não apagam)
 * Quem cria e atualiza são os agentes (ferramentas board_*): não há POST aqui.
 */
export function registerBoardRoutes(scope: FastifyInstance, runtimeOf: RuntimeOf): void {
  scope.get("/boards", async (request): Promise<Board[]> => runtimeOf(request).boards.list());

  scope.get("/boards/:id", async (request): Promise<Board> => runtimeOf(request).boards.get(boardParamsSchema.parse(request.params).id));

  scope.get("/boards/:id/page", async (request, reply) => {
    const html = await runtimeOf(request).boards.readPage(boardParamsSchema.parse(request.params).id);
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .header("Cache-Control", "private, no-cache")
      .header("Content-Type", "text/plain; charset=utf-8")
      .send(html);
  });

  scope.get("/boards/:id/data", async (request, reply) => {
    const json = await runtimeOf(request).boards.readData(boardParamsSchema.parse(request.params).id);
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .header("Cache-Control", "private, no-cache")
      .header("Content-Type", "application/json; charset=utf-8")
      .send(json);
  });

  scope.patch("/boards/:id", async (request): Promise<Board> => {
    const { id } = boardParamsSchema.parse(request.params);
    return runtimeOf(request).boards.rename(id, updateBoardBodySchema.parse(request.body ?? {}));
  });

  scope.delete("/boards/:id", async (request, reply) => {
    await runtimeOf(request).boards.delete(boardParamsSchema.parse(request.params).id);
    return reply.code(204).send();
  });
}
