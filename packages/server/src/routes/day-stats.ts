import { DAY_STATS_PATH, DAY_STATS_RANGE_MAX_DAYS, daysBetween, parseDayQuery, type ApiErrorBody, type DayStats, type DayStatsDaysResponse, type DayStatsRangeResponse, type PlatformDayStats } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { platformDayStatsOf } from "../platform/day-stats/platform-day-stats";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { WorkspaceRuntime } from "../workspace/runtime";

const usdBrlOf = (request: FastifyRequest): number | undefined => request.server.spendSettings?.usdBrl();

type DayQuery = { day?: string; from?: string; to?: string };

/**
 * "Meu dia" (a diária), atrás da senha:
 * - GET /api/w/:ws/day-stats?day=AAAA-MM-DD -> DayStats (padrão hoje; com as comparações);
 * - GET /api/w/:ws/day-stats/range?from&to -> DayStatsRangeResponse (até 31 dias, sem comparação);
 * - GET /api/w/:ws/day-stats/days -> DayStatsDaysResponse (os dias com dado).
 * Dia mal escrito ou no futuro: 400; fora dos 90 dias: 404.
 */
export function registerWorkspaceDayStatsRoutes(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime, now: () => Date): void {
  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error } satisfies ApiErrorBody);

  scope.get("/day-stats", async (request, reply): Promise<DayStats | ApiErrorBody> => {
    const parsed = parseDayQuery((request.query as DayQuery).day, now().getTime());
    if (!parsed.ok) return fail(reply, parsed.status, parsed.error);
    return runtimeOf(request).dayStats(parsed.day, { usdBrl: usdBrlOf(request) });
  });

  scope.get("/day-stats/range", async (request, reply): Promise<DayStatsRangeResponse | ApiErrorBody> => {
    const query = request.query as DayQuery;
    const from = parseDayQuery(query.from, now().getTime());
    const to = parseDayQuery(query.to, now().getTime());
    if (!from.ok) return fail(reply, from.status, from.error);
    if (!to.ok) return fail(reply, to.status, to.error);
    if (from.day > to.day) return fail(reply, 400, "`from` depois de `to`");
    if (daysBetween(from.day, to.day) + 1 > DAY_STATS_RANGE_MAX_DAYS) return fail(reply, 400, `Intervalo grande demais (máximo ${DAY_STATS_RANGE_MAX_DAYS} dias)`);
    const days = await runtimeOf(request).dayStatsService(usdBrlOf(request)).range(from.day, to.day);
    return { from: from.day, to: to.day, days };
  });

  scope.get("/day-stats/days", async (request): Promise<DayStatsDaysResponse> => {
    const runtime = runtimeOf(request);
    const since = runtime.stateClock.since();
    return { days: await runtime.dayStatsService(usdBrlOf(request)).days(), ...(since !== undefined ? { clockFrom: new Date(since).toISOString() } : {}) };
  });
}

/** GET /api/day-stats?day= -> PlatformDayStats (os workspaces somados, para a página do Cyno e o Hoje). */
export function registerPlatformDayStatsRoute(app: FastifyInstance, manager: Pick<WorkspaceManager, "list" | "find">, now: () => Date): void {
  app.get(DAY_STATS_PATH, async (request, reply): Promise<PlatformDayStats | ApiErrorBody> => {
    const parsed = parseDayQuery((request.query as DayQuery).day, now().getTime());
    if (!parsed.ok) return reply.code(parsed.status).send({ error: parsed.error } satisfies ApiErrorBody);
    return platformDayStatsOf(manager, parsed.day, usdBrlOf(request));
  });
}
