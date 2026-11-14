import type { BrainNoteResponse, ListBrainsResponse } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Brain } from "../workspace/brain/brain";
import { HttpError } from "../platform/http/errors";

/** Cérebro do workspace da requisição. */
export type BrainOf = (request: FastifyRequest) => Brain;

const noteParamsSchema = z.object({ brainId: z.string(), file: z.string() });

/**
 * Navegador do Cérebro, dentro de /api/w/:ws. Os parâmetros não passam por um schema de
 * formato: qualquer coisa que não seja um Cérebro deste workspace ou o nome exato de uma nota
 * .md dele (inclusive "..", "%2e%2e", barras) é simplesmente "não encontrado" (404).
 */
export function registerBrainRoutes(scope: FastifyInstance, brainOf: BrainOf): void {
  scope.get("/brains", async (request): Promise<ListBrainsResponse> => brainOf(request).listBrains());

  scope.get("/brains/:brainId/notes/:file", async (request): Promise<BrainNoteResponse> => {
    const { brainId, file } = noteParamsSchema.parse(request.params);
    const brain = brainOf(request);
    if (!brain.hasBrain(brainId)) throw new HttpError(404, `Cérebro "${brainId}" não encontrado`);
    const note = await brain.readNote(brainId, file);
    if (!note) throw new HttpError(404, `Nota "${file}" não encontrada`);
    return note;
  });
}
