import {
  createCalendarEventBodySchema,
  idParamsSchema,
  listCalendarQuerySchema,
  updateCalendarEventBodySchema,
  type CalendarEvent,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CalendarService } from "../workspace/calendar/calendar-service";

/** Calendário do workspace da requisição (`:ws`). */
export type CalendarOf = (request: FastifyRequest) => CalendarService;

/** Rotas do calendário, dentro de /api/w/:ws. */
export function registerCalendarRoutes(scope: FastifyInstance, calendarOf: CalendarOf): void {
  scope.get("/calendar", async (request): Promise<CalendarEvent[]> => {
    return calendarOf(request).list(listCalendarQuerySchema.parse(request.query));
  });

  scope.post("/calendar", async (request, reply) => {
    const created = await calendarOf(request).create(createCalendarEventBodySchema.parse(request.body));
    return reply.code(201).send(created);
  });

  scope.patch("/calendar/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return calendarOf(request).update(id, updateCalendarEventBodySchema.parse(request.body));
  });

  scope.delete("/calendar/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    await calendarOf(request).remove(id);
    return reply.code(204).send();
  });
}
