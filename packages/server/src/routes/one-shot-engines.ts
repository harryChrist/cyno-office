import {
  engineAccountPath,
  engineConfigBodySchema,
  engineProgramDetectPath,
  engineProgramModelsPath,
  oneShotAccountBodySchema,
  type ProgramAccountInfo,
  type ProgramModelsResponse,
  engineInstallBodySchema,
  engineInstallPlanPath,
  engineInstallPath,
  engineVerifyPath,
  INSTALLABLE_ENGINE_IDS,
  isOneShotEngineId,
  OPENROUTER_KEY_PATH,
  OPENROUTER_MODELS_PATH,
  ONE_SHOT_ENGINE_IDS,
  ENGINE_LABELS,
  oneShotTestBodySchema,
  openRouterKeyBodySchema,
  type ApiErrorBody,
  type EngineInstallJob,
  type EngineInstallPlan,
  type EngineStatusResponse,
  type EngineVerifyResult,
  type InstallableEngineId,
  type OneShotEngineId,
  type OpenRouterKeyInfo,
  type OpenRouterModelsResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { findExecutable } from "../engines/terminals/engine-status";
import type { OneShotEngines } from "../engines/terminals/one-shot-engines";
import type { EngineSettingsStore } from "../platform/models/engine-settings";
import type { OpenRouterModelsCache } from "../platform/openrouter/client";
import type { OpenRouterKeyStore } from "../platform/openrouter/key-store";
import { errorMessage } from "../util/text";

export type EngineInstallRoutesHandler = {
  plan: (engine: InstallableEngineId) => EngineInstallPlan;
  start: (engine: InstallableEngineId) => EngineInstallJob;
  current: (engine: InstallableEngineId) => EngineInstallJob | null;
};

export type OneShotRoutesDeps = {
  engines: OneShotEngines;
  key: OpenRouterKeyStore;
  models: OpenRouterModelsCache;
  settings: EngineSettingsStore;
  status: () => Promise<EngineStatusResponse>;
  redetect: () => Promise<unknown>;
  setCommand: (engine: OneShotEngineId, command: string | undefined) => void;
  pathEnv: () => string;
  homeDir: string;
  now: () => Date;
  record?: (action: string, summary: string, data?: Record<string, unknown>) => void;
  /** Instalação privada unificada para `claude`, `gemini`, `openclaw` e `hermes`. */
  install?: EngineInstallRoutesHandler;
};

/**
 * Rotas do OpenClaw e do Hermes na tela Motores (o passo a passo):
 * - `GET/PUT/DELETE /api/engines/openrouter/key`: a chave do OpenRouter (só "configurada · termina em …abcd"; NENHUMA rota devolve a chave);
 * - `GET/POST /api/engines/openrouter/models`: a lista pública de modelos (sob demanda, com cache em disco);
 * - `PUT /api/engines/:id/config`: caminho do executável, modelo e esforço padrão;
 * - `POST /api/engines/:id/verify`: as checagens e, com `confirm: true`, o turno de teste de verdade (um por vez);
 * - `POST /api/engines/:id/install/plan` e `POST …/install` (só com `confirm: true`) e `GET …/install`: a instalação.
 */
export function registerOneShotEngineRoutes(app: FastifyInstance, deps: OneShotRoutesDeps): void {
  app.get(OPENROUTER_KEY_PATH, async (): Promise<OpenRouterKeyInfo> => deps.key.info());

  app.put(OPENROUTER_KEY_PATH, async (request): Promise<OpenRouterKeyInfo> => {
    const body = openRouterKeyBodySchema.parse(request.body ?? {});
    const replaced = deps.key.info().configured;
    await deps.key.set(body.key, deps.now());
    // A Atividade registra que mudou, nunca o valor.
    deps.record?.(replaced ? "openrouter_chave_trocada" : "openrouter_chave_guardada", replaced ? "Você trocou a chave do OpenRouter" : "Você guardou a chave do OpenRouter", { last4: body.key.slice(-4) });
    const warning = await deps.engines.keyWarning(body.key);
    return { ...deps.key.info(), ...(warning ? { warning } : {}) };
  });

  app.delete(OPENROUTER_KEY_PATH, async (): Promise<OpenRouterKeyInfo> => {
    await deps.key.remove();
    deps.record?.("openrouter_chave_removida", "Você removeu a chave do OpenRouter");
    return deps.key.info();
  });

  app.get(OPENROUTER_MODELS_PATH, async (): Promise<OpenRouterModelsResponse> => deps.models.read() ?? { models: [], readAt: "" });

  let refreshing = false;
  app.post(OPENROUTER_MODELS_PATH, async (_request, reply): Promise<OpenRouterModelsResponse | ApiErrorBody> => {
    if (refreshing) return reply.code(409).send({ error: "Já estou lendo a lista de modelos." } satisfies ApiErrorBody);
    refreshing = true;
    try {
      return await deps.engines.refreshModels();
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) } satisfies ApiErrorBody);
    } finally {
      refreshing = false;
    }
  });

  let verifying: OneShotEngineId | undefined;
  for (const id of ONE_SHOT_ENGINE_IDS) {
    app.put(`/api/engines/${id}/config`, async (request, reply): Promise<EngineStatusResponse | ApiErrorBody> => {
      const body = engineConfigBodySchema.parse(request.body ?? {});
      if (body.path !== undefined) {
        const value = body.path || null;
        if (value && !(await findExecutable(value, deps.pathEnv(), deps.homeDir))) return reply.code(400).send({ error: `Não achei um executável em "${value}".` } satisfies ApiErrorBody);
        await deps.settings.setPath(id, value);
        deps.setCommand(id, value ?? undefined);
      }
      if (body.maxGateways !== undefined && id === "hermes") await deps.settings.setMaxGateways(body.maxGateways);
      if (body.fence !== undefined) await deps.settings.setFence(id, body.fence);
      if (body.model !== undefined || body.effort !== undefined) {
        try {
          await deps.engines.setChoices(id, { ...(body.model !== undefined ? { model: body.model } : {}), ...(body.effort !== undefined ? { effort: body.effort } : {}) });
        } catch (error) {
          return reply.code(400).send({ error: errorMessage(error) } satisfies ApiErrorBody);
        }
      }
      await deps.redetect();
      return deps.status();
    });

    // A forma de conta (chave do painel ou configuração do programa) e o local da configuração.
    app.put(engineAccountPath(id), async (request): Promise<EngineStatusResponse> => {
      const body = oneShotAccountBodySchema.parse(request.body ?? {});
      await deps.engines.setAccount(id, body);
      await deps.redetect();
      return deps.status();
    });

    // O que o programa tem ligado: roda só o comando de ESTADO dele (somente leitura) e devolve nome, tipo e contagem.
    app.post(engineProgramDetectPath(id), async (): Promise<{ program: ProgramAccountInfo }> => ({ program: await deps.engines.detectProgram(id) }));

    app.get(engineProgramModelsPath(id), async (): Promise<ProgramModelsResponse> => deps.engines.programModels(id));

    app.post(engineVerifyPath(id), async (request, reply): Promise<{ result: EngineVerifyResult } | ApiErrorBody> => {
      const body = oneShotTestBodySchema.parse(request.body ?? {});
      if (verifying) return reply.code(409).send({ error: `Já há uma verificação em andamento (${ENGINE_LABELS[verifying]}). Espere terminar.` } satisfies ApiErrorBody);
      verifying = id;
      try {
        return { result: await deps.engines.verify(id, { ...(body.confirm === true ? { confirm: true } : {}) }) };
      } finally {
        verifying = undefined;
      }
    });
  }

  // Plano, início e estado da instalação privada para todos os motores instaláveis (claude, gemini, openclaw, hermes).
  const installTargets: readonly InstallableEngineId[] = deps.install ? INSTALLABLE_ENGINE_IDS : ONE_SHOT_ENGINE_IDS;
  for (const id of installTargets) {
    app.post(engineInstallPlanPath(id), async (): Promise<{ plan: EngineInstallPlan }> => ({
      plan: deps.install ? deps.install.plan(id) : deps.engines.installPlan(id as OneShotEngineId),
    }));

    app.get(engineInstallPath(id), async (): Promise<{ job: EngineInstallJob | null }> => {
      if (deps.install) return { job: deps.install.current(id) };
      const status = (await deps.status()).engines.find((engine) => engine.id === id);
      return { job: status?.installJob ?? null };
    });

    app.post(engineInstallPath(id), async (request, reply): Promise<{ job: EngineInstallJob } | ApiErrorBody> => {
      const body = engineInstallBodySchema.parse(request.body ?? {});
      // Instalar baixa e roda código: só depois de o dono ver o plano e confirmar na tela.
      if (body.confirm !== true) return reply.code(409).send({ error: `Instalar o ${ENGINE_LABELS[id]} baixa e roda um instalador. Veja o plano e confirme para instalar.` } satisfies ApiErrorBody);
      try {
        const job = deps.install ? deps.install.start(id) : isOneShotEngineId(id) ? deps.engines.startInstall(id) : undefined;
        if (!job) return reply.code(404).send({ error: `Este motor não tem instalador disponível.` } satisfies ApiErrorBody);
        return { job };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) } satisfies ApiErrorBody);
      }
    });
  }
}
