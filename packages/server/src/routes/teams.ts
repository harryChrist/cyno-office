import { createTeamBodySchema, idParamsSchema, updateTeamBodySchema } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { ServicesOf } from "./scope";

/** Rotas de times, dentro de /api/w/:ws. */
export function registerTeamRoutes(scope: FastifyInstance, servicesOf: ServicesOf): void {
  scope.post("/teams", async (request, reply) => {
    const team = await servicesOf(request).teams.create(createTeamBodySchema.parse(request.body));
    return reply.code(201).send(team);
  });

  scope.patch("/teams/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).teams.update(id, updateTeamBodySchema.parse(request.body));
  });

  scope.delete("/teams/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    await servicesOf(request).teams.remove(id);
    return reply.code(204).send();
  });
}
