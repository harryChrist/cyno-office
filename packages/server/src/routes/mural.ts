import { MURAL_PATH, muralShareBodySchema, muralUseBodySchema, type MuralEntry, type MuralResponse, type MuralUseResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { MuralService } from "../platform/mural/mural-service";
import type { WorkspaceManager } from "../platform/workspaces/manager";

/**
 * O mural da plataforma (atrás da senha do app, como todas as rotas /api):
 * - GET    /api/mural            -> MuralResponse (itens ativos, os mais novos primeiro, e as novidades que cada workspace ainda não viu)
 * - POST   /api/mural/share      -> MuralEntry (o dono compartilha uma mídia ou um texto em nome de um workspace)
 * - POST   /api/mural/:id/use    -> MuralUseResponse (o workspace traz o item: a mídia é copiada para a biblioteca dele, com a origem)
 * - DELETE /api/mural/:id        -> MuralEntry (retira do mural; as cópias já feitas ficam)
 */
export function registerMuralRoutes(app: FastifyInstance, mural: MuralService, manager: Pick<WorkspaceManager, "list">): void {
  app.get(MURAL_PATH, async (): Promise<MuralResponse> => ({ entries: mural.list(), news: mural.newsCounts(manager.list().map((workspace) => workspace.id)) }));

  app.post(`${MURAL_PATH}/share`, async (request, reply): Promise<MuralEntry> => {
    const body = muralShareBodySchema.parse(request.body ?? {});
    const entry = mural.share({ workspace: body.workspace, by: "dono", ...(body.mediaId ? { mediaId: body.mediaId } : {}), ...(body.projectId ? { projectId: body.projectId } : {}), ...(body.text ? { text: body.text } : {}), ...(body.title ? { title: body.title } : {}), ...(body.note ? { note: body.note } : {}) });
    reply.code(201);
    return entry;
  });

  app.post(`${MURAL_PATH}/:id/use`, async (request): Promise<MuralUseResponse> => {
    const { id } = request.params as { id: string };
    const { workspace } = muralUseBodySchema.parse(request.body ?? {});
    const used = await mural.use(id, workspace, "dono");
    return { mediaId: used.mediaId ?? "", workspace, entry: used.entry };
  });

  app.delete(`${MURAL_PATH}/:id`, async (request): Promise<MuralEntry> => {
    const { id } = request.params as { id: string };
    return mural.retire(id, "dono");
  });
}
