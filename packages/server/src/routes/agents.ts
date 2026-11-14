import { createAgentBodySchema, idParamsSchema, updateAgentBodySchema } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { ServicesOf } from "./scope";

/** Rotas de agentes, dentro de /api/w/:ws. */
export function registerAgentRoutes(scope: FastifyInstance, servicesOf: ServicesOf): void {
  scope.post("/agents", async (request, reply) => {
    const agent = await servicesOf(request).agents.create(createAgentBodySchema.parse(request.body));
    return reply.code(201).send(agent);
  });

  scope.patch("/agents/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).agents.update(id, updateAgentBodySchema.parse(request.body));
  });

  scope.delete("/agents/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    await servicesOf(request).agents.remove(id);
    return reply.code(204).send();
  });
}
