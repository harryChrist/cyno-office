import {
  createForYouTypeBodySchema,
  forYouAnswersBodySchema,
  forYouBatchBodySchema,
  forYouCancelBodySchema,
  forYouDecisionBodySchema,
  forYouParamsSchema,
  FOR_YOU_ARCHIVE_MONTH_PATTERN,
  forYouTypeParamsSchema,
  mergeForYouTypeBodySchema,
  updateForYouTypeBodySchema,
  type ForYouArchiveSummary,
  type ForYouBatchResponse,
  type ForYouItem,
  type ForYouTypeDef,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../platform/http/errors";
import type { ForYouTypesService } from "../workspace/for-you/types-service";
import type { ServicesOf } from "./scope";

/** ?taskId=&id= do GET /for-you/archive/find (ao menos um dos dois). */
const archiveFindQuerySchema = z.object({ taskId: z.string().max(200).optional(), id: z.string().max(200).optional() });

/** Rotas do "Para você", dentro de /api/w/:ws. */
export function registerForYouRoutes(scope: FastifyInstance, servicesOf: ServicesOf): void {
  scope.get("/for-you", async (request) => servicesOf(request).forYou.list());

  // Arquivo: as aprovações decididas há mais tempo que o prazo da lista viva (só leitura; nada se apaga).
  scope.get("/for-you/archive", async (request): Promise<ForYouArchiveSummary> => servicesOf(request).forYou.archiveSummary());

  // Os itens arquivados de uma tarefa e/ou de um id (a rota fixa vem antes da de mês: `find` não é um mês).
  scope.get("/for-you/archive/find", async (request): Promise<ForYouItem[]> => {
    const query = archiveFindQuerySchema.parse(request.query);
    if (!query.taskId && !query.id) throw new HttpError(400, "Informe taskId ou id para procurar no arquivo");
    return servicesOf(request).forYou.archiveFind({ ...(query.taskId ? { taskId: query.taskId } : {}), ...(query.id ? { id: query.id } : {}) });
  });

  scope.get("/for-you/archive/:month", async (request): Promise<ForYouItem[]> => {
    const { month } = request.params as { month: string };
    if (!FOR_YOU_ARCHIVE_MONTH_PATTERN.test(month)) throw new HttpError(400, `Mês inválido: use AAAA-MM (recebi "${month}")`);
    return servicesOf(request).forYou.archiveMonth(month);
  });

  // Aprovar em lote (Gestão): até 20 aprovações de texto do mesmo tipo, sem edição pendente (convite e post só com histórico).
  scope.post("/for-you/batch", async (request): Promise<ForYouBatchResponse> => {
    const { ids } = forYouBatchBodySchema.parse(request.body);
    return { items: await servicesOf(request).forYou.decideBatch(ids) };
  });

  scope.post("/for-you/:id/decision", async (request) => {
    const { id } = forYouParamsSchema.parse(request.params);
    const body = forYouDecisionBodySchema.parse(request.body);
    return servicesOf(request).forYou.decide(id, body);
  });

  // Rascunho das respostas de um questionário (não acorda ninguém).
  scope.patch("/for-you/:id/answers", async (request) => {
    const { id } = forYouParamsSchema.parse(request.params);
    const { answers } = forYouAnswersBodySchema.parse(request.body);
    return servicesOf(request).forYou.saveAnswers(id, answers);
  });

  // "Descartar": você retira o item pendente (a tarefa que ele segurava segue sem a resposta; não acorda o Maestro).
  scope.post("/for-you/:id/cancel", async (request) => {
    const { id } = forYouParamsSchema.parse(request.params);
    const { reason } = forYouCancelBodySchema.parse(request.body ?? {});
    return servicesOf(request).forYou.cancel(id, { by: "usuario", ...(reason ? { reason } : {}) });
  });

  // "Enviar respostas": acorda UMA vez quem perguntou (o Maestro, ou só a tarefa do agente).
  scope.post("/for-you/:id/submit", async (request) => {
    const { id } = forYouParamsSchema.parse(request.params);
    return servicesOf(request).forYou.submit(id);
  });
}

/** Tipos do "Para você" do workspace da requisição (`:ws`). */
export type ForYouTypesOf = (request: FastifyRequest) => ForYouTypesService;

/** Tipos do "Para você" (listar, criar, editar, excluir e juntar), dentro de /api/w/:ws. */
export function registerForYouTypeRoutes(scope: FastifyInstance, typesOf: ForYouTypesOf): void {
  scope.get("/for-you/types", async (request): Promise<ForYouTypeDef[]> => typesOf(request).list());

  scope.post("/for-you/types", async (request, reply) => {
    const created = await typesOf(request).create(createForYouTypeBodySchema.parse(request.body));
    return reply.code(201).send(created);
  });

  scope.patch("/for-you/types/:typeId", async (request) => {
    const { typeId } = forYouTypeParamsSchema.parse(request.params);
    return typesOf(request).update(typeId, updateForYouTypeBodySchema.parse(request.body));
  });

  scope.delete("/for-you/types/:typeId", async (request, reply) => {
    const { typeId } = forYouTypeParamsSchema.parse(request.params);
    await typesOf(request).remove(typeId);
    return reply.code(204).send();
  });

  scope.post("/for-you/types/:typeId/merge", async (request) => {
    const { typeId } = forYouTypeParamsSchema.parse(request.params);
    const { into } = mergeForYouTypeBodySchema.parse(request.body);
    return typesOf(request).merge(typeId, into);
  });
}
