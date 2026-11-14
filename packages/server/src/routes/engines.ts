import os from "node:os";
import path from "node:path";
import {
  engineConfigBodySchema,
  ENGINE_STATUS_PATH,
  FREEBUFF_MODELS_REFRESH_PATH,
  FREEBUFF_SETTINGS_PATH,
  FREEBUFF_TEST_PATH,
  freebuffCostText,
  freebuffSettingsBodySchema,
  freebuffTestBodySchema,
  isSupportedEngineId,
  type ApiErrorBody,
  type EngineStatusResponse,
  type EngineTestResult,
  type SubscriptionUsage,
  type SupportedEngineId,
  type TurnUsage,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { defaultProbe, type EngineProbe } from "../engines/terminals/engines";
import { detectEngineStatuses, findExecutable } from "../engines/terminals/engine-status";
import { EngineTester, runEngineTest, ENGINE_TEST_MIN_GAP_MS } from "../engines/terminals/engine-test";
import type { TerminalsConfig } from "../engines/terminals/manager";
import type { EngineSettingsStore } from "../platform/models/engine-settings";
import { freebuffEnv } from "../engines/freebuff/adapter";
import { probeFreebuffModels } from "../engines/freebuff/probe";
import type { FreebuffRuntime } from "../engines/freebuff/runtime";
import { runFreebuffTest } from "../engines/freebuff/test-run";
import { errorMessage } from "../util/text";
import { registerOneShotEngineRoutes, type OneShotRoutesDeps } from "./one-shot-engines";

type Bin = { command: string; prefixArgs?: string[] | undefined };

const DEFAULT_COMMANDS: Record<SupportedEngineId, string> = { claude: "claude", gemini: "agy" };

export type EngineRoutesDeps = {
  /** A configuração de terminais em uso (o caminho escolhido na tela é aplicado aqui, para as próximas subidas). */
  terminals: TerminalsConfig;
  settings: EngineSettingsStore;
  usage: () => readonly SubscriptionUsage[];
  /** Freebuff: as horas abertas e o executável dele (ausente = ele aparece só como detectado). */
  freebuff?: FreebuffRuntime;
  /** Refaz a detecção de motores (o catálogo do GET /api/engines) depois de trocar um caminho. */
  redetect: () => Promise<unknown>;
  dataDir: string;
  now: () => Date;
  /** Só testes. */
  probe?: EngineProbe;
  pathEnv?: string;
  homeDir?: string;
  testRunner?: (engine: SupportedEngineId) => Promise<EngineTestResult>;
  /** O "Testar" gastou tokens: grava no histórico de uso da plataforma (com a marca de teste). */
  recordTestUsage?: (spent: { engine: SupportedEngineId; model: string; usage: TurnUsage; durationMs: number }) => void;
  testMinGapMs?: number;
  testTimeoutMs?: number;
  /** Registro na Atividade (ações do dono: instalar um motor, guardar a chave do OpenRouter). */
  record?: (action: string, summary: string, data?: Record<string, unknown>) => void;
  /** OpenClaw e Hermes (o passo a passo, a chave do OpenRouter, o Verificar e a instalação); ausente = só detectados. */
  oneShot?: Pick<OneShotRoutesDeps, "engines" | "key" | "models" | "setCommand">;
};

/** O comando de cada motor agora (o que `terminals` diz). */
function binOf(terminals: TerminalsConfig, engine: SupportedEngineId): Bin {
  const bin = engine === "claude" ? terminals.claude : terminals.gemini;
  return { command: bin?.command ?? DEFAULT_COMMANDS[engine], prefixArgs: bin?.prefixArgs };
}

/** Aplica (ou tira) o caminho escolhido na tela em `terminals`; `base` é o que valia sem ele. */
function applyPath(terminals: TerminalsConfig, base: Record<SupportedEngineId, Bin>, engine: SupportedEngineId, value: string | undefined): void {
  const next = value ? { command: value, prefixArgs: undefined } : base[engine];
  if (engine === "claude") terminals.claude = { ...terminals.claude, command: next.command, prefixArgs: next.prefixArgs };
  else terminals.gemini = { ...terminals.gemini, command: next.command, prefixArgs: next.prefixArgs };
}

/**
 * Rotas da tela Motores (Configurações):
 * - `GET /api/engines/status`: o estado de todos os motores conhecidos (detectado por código);
 * - `POST /api/engines/:id/test`: um pedido mínimo ao motor (um teste por vez; 429 se foi há pouco);
 * - `PUT /api/engines/:id/config`: o caminho do executável (vale para as próximas subidas dos agentes).
 * Devolve a função que aplica os caminhos salvos no boot.
 */
export function registerEngineRoutes(app: FastifyInstance, deps: EngineRoutesDeps): { applySavedPaths: () => void } {
  const probe = deps.probe ?? defaultProbe;
  const homeDir = deps.homeDir ?? os.homedir();
  const base: Record<SupportedEngineId, Bin> = { claude: binOf(deps.terminals, "claude"), gemini: binOf(deps.terminals, "gemini") };
  const pathEnv = () => deps.pathEnv ?? process.env.PATH ?? "";

  const applySavedPaths = () => {
    for (const [engine, value] of Object.entries(deps.settings.paths()) as [SupportedEngineId, string][]) applyPath(deps.terminals, base, engine, value);
  };

  const tester = new EngineTester(
    deps.testRunner ??
      ((engine) => {
        const bin = binOf(deps.terminals, engine);
        return runEngineTest({
          engine,
          command: bin.command,
          ...(bin.prefixArgs ? { prefixArgs: bin.prefixArgs } : {}),
          workDir: path.join(deps.dataDir, "platform", "engine-tests"),
          now: deps.now,
          ...(deps.recordTestUsage ? { onUsage: (spent: { usage: TurnUsage; model: string; durationMs: number }) => deps.recordTestUsage?.({ engine, ...spent }) } : {}),
          ...(deps.testTimeoutMs ? { timeoutMs: deps.testTimeoutMs } : {}),
        });
      }),
    (engine, result) => deps.settings.setTest(engine, result),
    () => deps.now().getTime(),
    deps.testMinGapMs ?? ENGINE_TEST_MIN_GAP_MS,
  );

  const status = async (): Promise<EngineStatusResponse> => ({
    engines: await detectEngineStatuses({
      binaries: { claude: binOf(deps.terminals, "claude"), gemini: binOf(deps.terminals, "gemini") },
      defaultCommands: DEFAULT_COMMANDS,
      configured: deps.settings.paths(),
      pathEnv: pathEnv(),
      homeDir,
      probe,
      usage: deps.usage,
      tests: () => deps.settings.tests(),
      now: () => deps.now().getTime(),
      ...(deps.freebuff ? { freebuff: { service: deps.freebuff.service, manicodeDir: deps.freebuff.manicodeDir, command: deps.freebuff.command } } : {}),
      ...(deps.oneShot ? { oneShot: (id) => deps.oneShot!.engines.status(id) } : {}),
    }),
  });
  app.get(ENGINE_STATUS_PATH, status);

  app.post<{ Params: { id: string } }>("/api/engines/:id/test", async (request, reply): Promise<{ result: EngineTestResult } | ApiErrorBody> => {
    const { id } = request.params;
    if (!isSupportedEngineId(id)) return reply.code(404).send({ error: "Este motor ainda não pode ser testado." } satisfies ApiErrorBody);
    const outcome = await tester.test(id);
    if ("blocked" in outcome) return reply.code(outcome.blocked === "busy" ? 409 : 429).send({ error: outcome.message } satisfies ApiErrorBody);
    return outcome;
  });

  app.put<{ Params: { id: string } }>("/api/engines/:id/config", async (request, reply): Promise<EngineStatusResponse | ApiErrorBody> => {
    const { id } = request.params;
    if (!isSupportedEngineId(id)) return reply.code(404).send({ error: "Este motor ainda não pode ser configurado." } satisfies ApiErrorBody);
    const body = engineConfigBodySchema.parse(request.body ?? {});
    if (body.path === undefined) return status();
    const value = body.path || null;
    if (value && !(await findExecutable(value, pathEnv(), homeDir))) {
      return reply.code(400).send({ error: `Não achei um executável em "${value}".` } satisfies ApiErrorBody);
    }
    await deps.settings.setPath(id, value);
    applyPath(deps.terminals, base, id, value ?? undefined);
    await deps.redetect();
    return status();
  });

  if (deps.freebuff) registerFreebuffRoutes(app, deps.freebuff, deps, status);
  if (deps.oneShot) {
    registerOneShotEngineRoutes(app, { ...deps.oneShot, settings: deps.settings, status, redetect: deps.redetect, pathEnv, homeDir, now: deps.now, ...(deps.record ? { record: deps.record } : {}) });
  }

  return { applySavedPaths };
}

/**
 * Rotas do Freebuff na tela Motores:
 * - `PUT /api/engines/freebuff/settings`: o modelo e o esforço da plataforma (um só: a escolha da TUI é global na
 *   máquina) e o teto de horas abertas; vale para a PRÓXIMA hora aberta (uma hora aberta segue no modelo dela);
 * - `POST /api/engines/freebuff/models/refresh`: abre um Freebuff de sondagem, lê o `/model` e fecha sem mandar
 *   mensagem (não abre hora, não gasta nada);
 * - `POST /api/engines/freebuff/test`: um pedido mínimo, que ABRE uma hora (gasta horas do dia): só com `confirm: true`.
 */
function registerFreebuffRoutes(app: FastifyInstance, runtime: FreebuffRuntime, deps: EngineRoutesDeps, status: () => Promise<EngineStatusResponse>): void {
  const workDir = path.join(deps.dataDir, "platform", "freebuff");
  let busy: "models" | "test" | undefined;
  let lastTestAt = 0;
  const baseEnv = () => freebuffEnv(runtime.env ?? process.env, { agentId: "engine", cwd: workDir, systemPrompt: "", mcpConfigFile: "", tools: [] });

  app.put(FREEBUFF_SETTINGS_PATH, async (request, reply): Promise<EngineStatusResponse | ApiErrorBody> => {
    const body = freebuffSettingsBodySchema.parse(request.body ?? {});
    const { models } = runtime.service.models();
    const current = runtime.service.settings();
    const model = body.model ?? current.model;
    const known = models.find((candidate) => candidate.name === model);
    if (body.model !== undefined && models.length > 0 && !known) {
      return reply.code(400).send({ error: `O modelo "${body.model}" não está na lista lida do Freebuff. Use "Atualizar modelos".` } satisfies ApiErrorBody);
    }
    if (body.effort !== undefined && known && known.efforts.length > 0 && !known.efforts.includes(body.effort)) {
      return reply.code(400).send({ error: `O modelo "${model}" não tem o esforço "${body.effort}" (tem: ${known.efforts.join(", ")}).` } satisfies ApiErrorBody);
    }
    await runtime.service.setSettings({ ...(body.model !== undefined ? { model: body.model } : {}), ...(body.effort !== undefined ? { effort: body.effort } : {}), ...(body.maxOpenHours !== undefined ? { maxOpenHours: body.maxOpenHours } : {}) });
    return status();
  });

  app.post(FREEBUFF_MODELS_REFRESH_PATH, async (_request, reply): Promise<EngineStatusResponse | ApiErrorBody> => {
    if (busy) return reply.code(409).send({ error: busy === "models" ? "Já estou lendo a lista de modelos do Freebuff." : "Há um teste do Freebuff em andamento. Espere terminar." } satisfies ApiErrorBody);
    busy = "models";
    try {
      const result = await probeFreebuffModels({
        command: runtime.command,
        ...(runtime.prefixArgs ? { prefixArgs: runtime.prefixArgs } : {}),
        workDir,
        env: baseEnv(),
        ...(runtime.spawn ? { spawn: runtime.spawn } : {}),
        ...(runtime.readyTimeoutMs ? { readyTimeoutMs: runtime.readyTimeoutMs } : {}),
        ...(runtime.settleMs ? { settleMs: runtime.settleMs } : {}),
        ...(runtime.settleCatalogMs ? { settleCatalogMs: runtime.settleCatalogMs } : {}),
      });
      if (!result.ok) return reply.code(502).send({ error: `Não consegui ler os modelos do Freebuff: ${result.error}` } satisfies ApiErrorBody);
      await runtime.service.setModels(result.reading.models);
      if (result.reading.hours) await runtime.service.measure(result.reading.hours);
      return status();
    } catch (error) {
      return reply.code(502).send({ error: `Não consegui ler os modelos do Freebuff: ${errorMessage(error)}` } satisfies ApiErrorBody);
    } finally {
      busy = undefined;
    }
  });

  app.post(FREEBUFF_TEST_PATH, async (request, reply): Promise<{ result: EngineTestResult } | ApiErrorBody> => {
    const { confirm } = freebuffTestBodySchema.parse(request.body ?? {});
    const cost = runtime.service.multiplier();
    if (confirm !== true) {
      return reply.code(409).send({ error: `Este teste abre uma hora do Freebuff: gasta ${freebuffCostText(cost).replace(" por hora aberta", "")} das suas horas de hoje. Confirme para rodar.` } satisfies ApiErrorBody);
    }
    if (busy) return reply.code(409).send({ error: busy === "test" ? "Já há um teste do Freebuff em andamento. Espere terminar." : "Estou lendo a lista de modelos do Freebuff. Espere terminar." } satisfies ApiErrorBody);
    const wait = (deps.testMinGapMs ?? ENGINE_TEST_MIN_GAP_MS) - (deps.now().getTime() - lastTestAt);
    if (lastTestAt > 0 && wait > 0) return reply.code(429).send({ error: `Testou há pouco. Espere ${Math.ceil(wait / 1000)} s para testar de novo.` } satisfies ApiErrorBody);
    busy = "test";
    lastTestAt = deps.now().getTime();
    try {
      const outcome = await runFreebuffTest({ runtime, workDir, settings: runtime.service.settings(), now: deps.now, ...(deps.testTimeoutMs ? { timeoutMs: deps.testTimeoutMs } : {}) });
      await runtime.service.setTest(outcome.result);
      if (outcome.spentHours > 0) await runtime.service.noteSpent(outcome.spentHours);
      return { result: outcome.result };
    } finally {
      busy = undefined;
    }
  });
}

