import { createWorkspaceBodySchema, updateWorkspaceAccessBodySchema, updateWorkspaceBodySchema, workspaceParamsSchema, type Workspace } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { WorkspaceManager } from "../platform/workspaces/manager";

/** Lista, criação, renomeação e exclusão de workspaces (o nível acima do escritório). */
export function registerWorkspaceRoutes(app: FastifyInstance, manager: WorkspaceManager): void {
  app.get("/api/workspaces", async (): Promise<Workspace[]> => manager.list());

  app.post("/api/workspaces", async (request, reply) => {
    const { name, maestro, access } = createWorkspaceBodySchema.parse(request.body);
    return reply.code(201).send(await manager.create(name, maestro, access));
  });

  app.patch("/api/workspaces/:ws", async (request) => {
    const { ws } = workspaceParamsSchema.parse(request.params);
    return manager.update(ws, updateWorkspaceBodySchema.parse(request.body));
  });

  /** Acesso dos agentes (internet, navegador, terminal, domínios): só os campos enviados mudam. Devolve o workspace. */
  app.put("/api/workspaces/:ws/access", async (request) => {
    const { ws } = workspaceParamsSchema.parse(request.params);
    return manager.update(ws, { access: updateWorkspaceAccessBodySchema.parse(request.body) });
  });

  app.delete("/api/workspaces/:ws", async (request, reply) => {
    const { ws } = workspaceParamsSchema.parse(request.params);
    await manager.remove(ws);
    return reply.code(204).send();
  });
}
