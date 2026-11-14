import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVITY_SYSTEM_PATH,
  activityQuerySchema,
  activitySummaryQuerySchema,
  type ActivityServerInfo,
  type ActivityResponse,
  type ActivitySummary,
  type ActivitySystemResponse,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { activeActivity, systemActivityDir } from "../workspace/activity/log";
import { queryActivity, readActivityRange, summarizeActivity } from "../workspace/activity/query";
import type { Heartbeat } from "../platform/activity/lifecycle";
import { addDays, dayKeyOf } from "../engines/usage/usage-time";
import { HttpError } from "../platform/http/errors";

/**
 * Atividade (o que foi feito no escritório):
 * - GET /api/w/:ws/activity?from&to&category&actor&q&limit&cursor -> ActivityResponse (mais novos primeiro, paginado);
 * - GET /api/w/:ws/activity/summary?day= (ou from= e to=) -> ActivitySummary;
 * - GET /api/activity/system?... -> ActivitySystemResponse (eventos do servidor + a memória do último batimento).
 */
export function registerActivityRoutes(scope: FastifyInstance, dirOf: (request: FastifyRequest) => string): void {
  scope.get("/activity", async (request): Promise<ActivityResponse> => {
    const query = activityQuerySchema.parse(request.query ?? {});
    await activeActivity()?.flush();
    return queryActivity(dirOf(request), query);
  });

  scope.get("/activity/summary", async (request): Promise<ActivitySummary> => {
    const { day, from: rawFrom, to: rawTo } = activitySummaryQuerySchema.parse(request.query ?? {});
    const today = dayKeyOf(Date.now());
    const from = day ?? rawFrom ?? rawTo ?? today;
    const to = day ?? rawTo ?? from;
    if (to < from) throw new HttpError(400, "O fim do período vem antes do começo");
    if (to > addDays(from, 400)) throw new HttpError(400, "Período grande demais (máximo de 400 dias)");
    await activeActivity()?.flush();
    return summarizeActivity(await readActivityRange(dirOf(request), from, to), { from, to });
  });
}

export function registerSystemActivityRoutes(app: FastifyInstance, dataDir: string): void {
  app.get(ACTIVITY_SYSTEM_PATH, async (request): Promise<ActivitySystemResponse> => {
    const query = activityQuerySchema.parse(request.query ?? {});
    await activeActivity()?.flush();
    const dir = systemActivityDir(dataDir);
    const page = await queryActivity(dir, query);
    const server = await readServerInfo(dir);
    return { ...page, ...(server ? { server } : {}) };
  });
}

/** Subida e memória da última amostra (do batimento do servidor). */
async function readServerInfo(dir: string): Promise<ActivityServerInfo | undefined> {
  try {
    const beat = JSON.parse(await readFile(path.join(dir, "heartbeat.json"), "utf8")) as Heartbeat;
    if (typeof beat.pid !== "number" || typeof beat.startedAt !== "string") return undefined;
    const sample = beat.lastSample;
    return {
      pid: beat.pid,
      startedAt: beat.startedAt,
      ...(typeof beat.at === "string" ? { heartbeatAt: beat.at } : {}),
      ...(sample ? { memAvailableMb: sample.memAvailableMb, memAvailablePct: sample.memAvailablePct, swapUsedMb: sample.swapUsedMb, serverRssMb: sample.serverRssMb, terminalsRssMb: sample.terminalsRssMb, browserRssMb: sample.browserRssMb } : {}),
    };
  } catch {
    return undefined;
  }
}
