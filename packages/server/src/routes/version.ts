import { VERSION_CHECK_PATH, VERSION_PATH, VERSION_UPDATE_PATH, type VersionResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../platform/http/errors";
import type { VersionService } from "../platform/version/service";

/**
 * Versão do app e aviso de atualização (atrás da senha, como o resto do /api):
 * - GET  /api/version         -> VersionResponse (versão instalada, último resultado da verificação, botão de baixar e reinício pendente; sem rede)
 * - POST /api/version/check   -> VersionResponse (verifica agora; cliques repetidos devolvem o último resultado)
 * - POST /api/version/update  -> VersionResponse (começa a baixar a atualização em segundo plano; o andamento vem em `update.job`;
 *                                pedido repetido enquanto roda devolve o andamento; 409 com o motivo quando não pode)
 */
export function registerVersionRoutes(app: FastifyInstance, service: Pick<VersionService, "view" | "checker" | "startUpdate">): void {
  app.get(VERSION_PATH, async (): Promise<VersionResponse> => service.view());
  app.post(VERSION_CHECK_PATH, async (): Promise<VersionResponse> => {
    await service.checker.check({ manual: true });
    return service.view();
  });
  app.post(VERSION_UPDATE_PATH, async (): Promise<VersionResponse> => {
    const started = await service.startUpdate();
    if (!started.started && !started.running) throw new HttpError(409, started.reason);
    return service.view();
  });
}
