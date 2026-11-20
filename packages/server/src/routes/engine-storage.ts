import {
  ENGINE_STORAGE_CLEANUP_PATH,
  ENGINE_STORAGE_PATH,
  ENGINE_STORAGE_PREVIEW_PATH,
  engineStoragePreviewQuerySchema,
  updateEngineStorageBodySchema,
  type EngineStorageCleanupResult,
  type EngineStoragePreview,
  type EngineStorageResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { EngineStorage } from "../platform/engine-storage/engine-storage";

/**
 * Armazenamento dos motores (configuração da instalação; mesma autenticação das demais configurações):
 * - GET  /api/settings/engine-storage          -> EngineStorageResponse (ajustes, tamanhos por motor, última limpeza)
 * - PUT  /api/settings/engine-storage          -> EngineStorageResponse (parcial; 400 se os dias forem inválidos)
 * - GET  /api/settings/engine-storage/preview  -> EngineStoragePreview (o que sairia; `?antigravityLogsDays=&freebuffChatsDays=`)
 * - POST /api/settings/engine-storage/cleanup  -> EngineStorageCleanupResult (limpa agora, com os ajustes salvos)
 */
export function registerEngineStorageRoutes(app: FastifyInstance, storage: EngineStorage): void {
  app.get(ENGINE_STORAGE_PATH, async (): Promise<EngineStorageResponse> => storage.snapshot());

  app.put(ENGINE_STORAGE_PATH, async (request): Promise<EngineStorageResponse> => {
    await storage.update(updateEngineStorageBodySchema.parse(request.body ?? {}));
    return storage.snapshot();
  });

  app.get(ENGINE_STORAGE_PREVIEW_PATH, async (request): Promise<EngineStoragePreview> => storage.preview(engineStoragePreviewQuerySchema.parse(request.query ?? {})));

  app.post(ENGINE_STORAGE_CLEANUP_PATH, async (): Promise<EngineStorageCleanupResult> => storage.cleanup());
}
