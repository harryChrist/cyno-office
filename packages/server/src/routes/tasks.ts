import {
  closeRequestBodySchema,
  createTaskBodySchema,
  idParamsSchema,
  listTasksQuerySchema,
  maestroMessageBodySchema,
  taskApprovalBodySchema,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { ServicesOf } from "./scope";

/** Rotas de tarefas, dentro de /api/w/:ws. */
export function registerTaskRoutes(scope: FastifyInstance, servicesOf: ServicesOf): void {
  scope.get("/tasks", async (request) => servicesOf(request).tasks.list(listTasksQuerySchema.parse(request.query)));

  scope.post("/tasks", async (request, reply) => {
    const task = await servicesOf(request).tasks.create(createTaskBodySchema.parse(request.body));
    return reply.code(201).send(task);
  });

  // Conversa com o Maestro (202: a resposta chega pelo log/terminal dele, não aqui).
  // Conversa sem limite de tamanho: o corpo pode passar do 1 MB padrão do Fastify.
  scope.post("/maestro/messages", { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    const { text } = maestroMessageBodySchema.parse(request.body);
    return reply.code(202).send(await servicesOf(request).tasks.message(text));
  });

  scope.post("/tasks/:id/approval", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { approved } = taskApprovalBodySchema.parse(request.body);
    return servicesOf(request).tasks.approve(id, approved);
  });

  // O usuário fecha um pedido do Maestro (parado, esquecido): concluir como está ou cancelar.
  scope.post("/tasks/:id/close", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { mode, note } = closeRequestBodySchema.parse(request.body);
    return servicesOf(request).tasks.close(id, mode, note);
  });
}
