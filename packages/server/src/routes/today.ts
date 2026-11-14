import { TODAY_PATH, type PlatformToday, type TodayView } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgendaService } from "../platform/agenda/agenda-service";
import { platformTodayOf } from "../platform/today/platform-today";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { WorkspaceRuntime } from "../workspace/runtime";

/** GET /api/w/:ws/today -> TodayView (o painel "Hoje" do workspace, calculado por código). */
export function registerWorkspaceTodayRoute(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime): void {
  scope.get("/today", async (request): Promise<TodayView> => runtimeOf(request).today());
}

/** GET /api/today -> PlatformToday (todos os workspaces agrupados, mais os compromissos do dono). */
export function registerPlatformTodayRoute(app: FastifyInstance, manager: WorkspaceManager, agenda: AgendaService, now: () => Date): void {
  app.get(TODAY_PATH, async (): Promise<PlatformToday> => platformTodayOf(manager, agenda, now()));
}
