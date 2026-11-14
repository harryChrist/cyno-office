import {
  CONNECTORS_STDIO_PATH,
  updateConnectorsStdioBodySchema,
  type ConnectorsStdioResponse,
  MODEL_DEFAULTS_PATH,
  RETENTION_CLEANUP_PATH,
  RETENTION_PATH,
  updateModelDefaultsBodySchema,
  updateRetentionBodySchema,
  type ModelDefaultsResponse,
  type RetentionResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { ModelDefaultsStore } from "../platform/models/defaults-store";
import type { RetentionService } from "../platform/retention/retention";
import type { PlatformSettings } from "../platform/settings/platform-settings";
import type { LibraryService } from "../library/library-service";

/**
 * Configurações do server (da instalação):
 * - GET   /api/settings/retention          -> RetentionResponse (configuração, uso de disco, última limpeza)
 * - PATCH /api/settings/retention          -> RetentionResponse (400 se os dias forem inválidos)
 * - POST  /api/settings/retention/cleanup  -> RetentionResponse (limpa agora; `lastCleanup` é esta)
 * - GET   /api/settings/models             -> ModelDefaultsResponse (modelos padrão globais)
 * - GET/PUT/DELETE /api/settings/connectors-stdio -> ConnectorsStdioResponse (conectores locais ligados? PUT liga/desliga; DELETE volta ao `.env`)
 * - PUT   /api/settings/models             -> ModelDefaultsResponse (troca tudo; só vale para workspaces novos)
 */
export function registerSettingsRoutes(
  app: FastifyInstance,
  retention: RetentionService,
  models: ModelDefaultsStore,
  stdio?: { settings: PlatformSettings; library: LibraryService; envDefault: boolean },
): void {
  if (stdio) {
    const view = (): ConnectorsStdioResponse => {
      const choice = stdio.settings.stdioChoice();
      return { enabled: stdio.library.stdioAllowed(), source: choice === undefined ? "env" : "owner", envDefault: stdio.envDefault };
    };
    app.get(CONNECTORS_STDIO_PATH, async (): Promise<ConnectorsStdioResponse> => view());
    // Ação do dono (atrás da senha): liga ou desliga os conectores locais, que rodam comandos nesta máquina.
    app.put(CONNECTORS_STDIO_PATH, async (request): Promise<ConnectorsStdioResponse> => {
      const { enabled } = updateConnectorsStdioBodySchema.parse(request.body ?? {});
      await stdio.settings.setStdio(enabled);
      stdio.library.setAllowStdio(enabled);
      return view();
    });
    // Volta ao padrão: o que o `.env` diz (CONNECTORS_STDIO).
    app.delete(CONNECTORS_STDIO_PATH, async (): Promise<ConnectorsStdioResponse> => {
      await stdio.settings.setStdio(undefined);
      stdio.library.setAllowStdio(stdio.envDefault);
      return view();
    });
  }

  app.get(MODEL_DEFAULTS_PATH, async (): Promise<ModelDefaultsResponse> => ({ defaults: models.get() }));

  app.put(MODEL_DEFAULTS_PATH, async (request): Promise<ModelDefaultsResponse> => {
    const { defaults } = updateModelDefaultsBodySchema.parse(request.body ?? {});
    // O Cyno tem o seletor dele (PUT /api/cyno/model): quem manda o objeto sem `cyno` não o apaga.
    return { defaults: await models.set({ ...defaults, ...(defaults.cyno ? {} : models.get().cyno ? { cyno: models.get().cyno } : {}) }) };
  });

  app.get(RETENTION_PATH, async (): Promise<RetentionResponse> => retention.snapshot());

  app.patch(RETENTION_PATH, async (request): Promise<RetentionResponse> => {
    await retention.update(updateRetentionBodySchema.parse(request.body ?? {}));
    return retention.snapshot();
  });

  app.post(RETENTION_CLEANUP_PATH, async (): Promise<RetentionResponse> => {
    await retention.cleanup();
    return retention.snapshot();
  });
}
