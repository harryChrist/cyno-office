import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Services } from "../workspace/office";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { WorkspaceRuntime } from "../workspace/runtime";
import path from "node:path";
import { registerActivityRoutes } from "./activity";
import { registerAgentLogRoutes } from "./agent-log";
import { registerAgentRoutes } from "./agents";
import { registerBrainRoutes } from "./brains";
import { registerBrowserRoutes } from "./browser";
import { registerCalendarRoutes } from "./calendar";
import { registerConnectorRoutes } from "./connectors";
import { registerForYouRoutes, registerForYouTypeRoutes } from "./for-you";
import { registerMaestroTerminalRoute } from "./maestro-terminal";
import { registerBoardRoutes } from "./board";
import { registerMediaRoutes } from "./media";
import { registerStorageRoutes } from "./storage";
import { DiskMeter } from "../platform/storage/disk-meter";
import { registerPlanRoutes } from "./plans";
import { registerRoomRoutes } from "./rooms";
import { registerPlatformRoutineRoutes, registerRoutineRoutes } from "./routines";
import { registerTaskRoutes } from "./tasks";
import { registerWorkspaceDayStatsRoutes } from "./day-stats";
import { registerWorkspaceMetricsRoute } from "./metrics";
import { registerWorkspaceReportRoutes } from "./reports";
import { registerWorkspaceRetroRoutes } from "./retro";
import { registerWorkspaceTimelineRoutes } from "./timeline";
import { registerWorkspaceTodayRoute } from "./today";
import { registerTeamRoutes } from "./teams";
import { registerTerminalRoutes } from "./terminals";
import { registerAgentUsageRoutes } from "./usage";
import { registerUsageHistoryRoutes } from "./usage-history";

/** Serviços do workspace da requisição (`:ws`). */
export type ServicesOf = (request: FastifyRequest) => Services;

/** Prefixo das rotas de um workspace. */
export const WORKSPACE_PREFIX = "/api/w/:ws";

/**
 * Todas as rotas de um workspace ficam em /api/w/:ws/... Um hook resolve o workspace antes de
 * qualquer validação: workspace inexistente -> 404 { error: 'Workspace "x" não encontrado' }.
 */
export function registerWorkspaceScopedRoutes(app: FastifyInstance, manager: WorkspaceManager, now: () => Date = () => new Date()): void {
  registerPlatformRoutineRoutes(app, manager);
  // Medidor de espaço em disco: cache em memória, só mede quando a tela pede.
  const diskMeter = new DiskMeter();
  const runtimes = new WeakMap<FastifyRequest, WorkspaceRuntime>();
  const runtimeOf = (request: FastifyRequest): WorkspaceRuntime => {
    const runtime = runtimes.get(request);
    if (!runtime) throw new Error("rota de workspace sem workspace resolvido");
    return runtime;
  };
  const servicesOf: ServicesOf = (request) => runtimeOf(request).services;

  void app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request) => {
        // Id fora do formato também é "não encontrado" (404), não um 400.
        const { ws } = request.params as { ws?: string };
        runtimes.set(request, manager.get(ws ?? ""));
      });

      scope.get("/office", async (request) => runtimeOf(request).store.snapshot());
      registerRoomRoutes(scope, servicesOf);
      registerTeamRoutes(scope, servicesOf);
      registerAgentRoutes(scope, servicesOf);
      registerTaskRoutes(scope, servicesOf);
      registerForYouRoutes(scope, servicesOf);
      registerForYouTypeRoutes(scope, (request) => runtimeOf(request).forYouTypes);
      registerPlanRoutes(scope, (request) => runtimeOf(request).plans);
      registerBrainRoutes(scope, (request) => runtimeOf(request).brain);
      registerCalendarRoutes(scope, (request) => runtimeOf(request).calendar);
      registerRoutineRoutes(scope, runtimeOf);
      registerWorkspaceTodayRoute(scope, runtimeOf);
      registerWorkspaceDayStatsRoutes(scope, runtimeOf, now);
      registerWorkspaceMetricsRoute(scope, runtimeOf, now);
      registerWorkspaceReportRoutes(scope, runtimeOf);
      registerWorkspaceRetroRoutes(scope, runtimeOf);
      registerWorkspaceTimelineRoutes(scope, runtimeOf);
      registerMediaRoutes(scope, runtimeOf, manager);
      registerBoardRoutes(scope, runtimeOf);
      registerStorageRoutes(scope, runtimeOf, manager, diskMeter);
      registerAgentLogRoutes(scope, (request) => runtimeOf(request).agentLog);
      registerTerminalRoutes(scope, (request) => runtimeOf(request).terminals, (request) => runtimeOf(request).agentChat);
      registerMaestroTerminalRoute(scope, (request) => runtimeOf(request).terminals);
      registerAgentUsageRoutes(scope, (request) => runtimeOf(request).terminals.agentUsage);
      // O gasto do Cyno (a plataforma, fora dos workspaces) entra no histórico de cada workspace como "Cyno · plataforma".
      registerUsageHistoryRoutes(
        scope,
        (request) => {
          const workspace = runtimeOf(request).usageHistory;
          const platform = request.server.cyno?.usageHistory;
          return platform ? { read: async (from, to) => [...(await workspace.read(from, to)), ...(await platform.read(from, to))] } : workspace;
        },
        (request) => runtimeOf(request).store.snapshot(),
      );
      registerActivityRoutes(scope, (request) => path.join(runtimeOf(request).store.paths.root, "activity"));
      registerConnectorRoutes(scope, (request) => runtimeOf(request).connectors);
      registerBrowserRoutes(scope, (request) => runtimeOf(request).browser);
    },
    { prefix: WORKSPACE_PREFIX },
  );
}
