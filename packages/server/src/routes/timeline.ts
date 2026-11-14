import { dayRange, isDayKey, TIMELINE_PART_MS, type ApiErrorBody, type TimelineDaysResponse } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceRuntime } from "../workspace/runtime";

type PartQuery = { from?: string; to?: string };

/**
 * O "Rever o dia", atrás da senha:
 * - GET /api/w/:ws/timeline/days -> { recording, days: [{ day, bytes, from, to }] };
 * - GET /api/w/:ws/timeline/:day[?from=&to=] -> NDJSON (uma linha por registro). Sem `from` e `to` vem o dia inteiro;
 *   com eles, só o recorte (o quadro completo que vale em `from` vai na frente), para o navegador pedir por partes.
 * Dia mal escrito: 400; dia sem gravação: 404.
 */
export function registerWorkspaceTimelineRoutes(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime): void {
  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error } satisfies ApiErrorBody);

  scope.get("/timeline/days", async (request): Promise<TimelineDaysResponse> => {
    const timeline = runtimeOf(request).timeline;
    return { recording: timeline.recording, days: await timeline.days() };
  });

  scope.get<{ Params: { day: string }; Querystring: PartQuery }>("/timeline/:day", async (request, reply) => {
    const { day } = request.params;
    if (!isDayKey(day)) return fail(reply, 400, "dia inválido (use AAAA-MM-DD)");
    const { from: fromText, to: toText } = request.query;
    const range = dayRange(day);
    let from = range.start - 1;
    let to = range.end;
    if (fromText !== undefined || toText !== undefined) {
      from = Number(fromText ?? from);
      to = Number(toText ?? to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 2 * TIMELINE_PART_MS) return fail(reply, 400, "recorte inválido");
    }
    const body = await runtimeOf(request).timeline.readPart(day, from, to);
    if (body === undefined) return fail(reply, 404, "não há gravação deste dia");
    return reply.type("application/x-ndjson; charset=utf-8").header("cache-control", "no-store").send(body);
  });
}
