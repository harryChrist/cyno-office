import {
  createRoomBodySchema,
  idParamsSchema,
  updateBrainSharingBodySchema,
  updateFurnitureBodySchema,
  updateRoomBodySchema,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { ServicesOf } from "./scope";

/** Rotas de quartos, dentro de /api/w/:ws. */
export function registerRoomRoutes(scope: FastifyInstance, servicesOf: ServicesOf): void {
  scope.post("/rooms", async (request, reply) => {
    const room = await servicesOf(request).rooms.create(createRoomBodySchema.parse(request.body));
    return reply.code(201).send(room);
  });

  scope.patch("/rooms/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).rooms.update(id, updateRoomBodySchema.parse(request.body));
  });

  scope.delete("/rooms/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    await servicesOf(request).rooms.remove(id);
    return reply.code(204).send();
  });

  scope.get("/rooms/:id/deletion-preview", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).rooms.deletionPreview(id);
  });

  scope.patch("/rooms/:id/brain-sharing", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).rooms.setBrainSharing(id, updateBrainSharingBodySchema.parse(request.body));
  });

  // Ajustes manuais dos móveis: a lista completa (vazia = voltar ao gerado).
  scope.patch("/rooms/:id/furniture", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).rooms.setFurnitureEdits(id, updateFurnitureBodySchema.parse(request.body));
  });

  scope.get("/rooms/:id/context", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return servicesOf(request).tasks.context(id);
  });
}
