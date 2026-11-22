import { avulsasCleanupBodySchema, avulsasCleanupQuerySchema, idParamsSchema, planAdjustBodySchema, planApproveBodySchema, projectCreateBodySchema, projectHoldBodySchema, projectModeBodySchema, projectPatchBodySchema, projectReleaseBodySchema, sprintCreateBodySchema, sprintPatchBodySchema, sprintReorderBodySchema, taskCreateBodySchema, taskLabelBodySchema, taskMoveBodySchema, taskPatchBodySchema, taskReassignBodySchema, type AvulsasCleanupPreview, type AvulsasCleanupResult, type Plan, type Project, type ProjectDeleteResult } from "@cyno/shared";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../platform/http/errors";
import type { ProjectService } from "../workspace/projects/project-service";

/** Planos do workspace da requisição (`:ws`). */
export type PlansOf = (request: FastifyRequest) => ProjectService;

/** Planos dos pedidos (listar, aprovar, pedir ajuste, cancelar), dentro de /api/w/:ws. */
export function registerPlanRoutes(scope: FastifyInstance, plansOf: PlansOf): void {
  scope.get("/plans", async (request): Promise<Plan[]> => plansOf(request).list());

  scope.get("/plans/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return plansOf(request).get(id);
  });

  scope.post("/plans/:id/approve", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    // Corpo opcional: ausente mantém o `released` definido pelo Maestro (legado = liberado); `all` libera tudo; `none` deixa tudo Planejado.
    const { release } = planApproveBodySchema.parse(request.body ?? {});
    return plansOf(request).approve(id, release ? { release } : {});
  });

  // O ajuste vai para o Maestro numa mensagem só (ele manda a versão nova).
  scope.post("/plans/:id/adjust", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { feedback } = planAdjustBodySchema.parse(request.body);
    return plansOf(request).adjust(id, feedback);
  });

  scope.post("/plans/:id/cancel", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return plansOf(request).cancel(id);
  });

  // Prioridade, prazo, "começa em", ritmo, título e pausa/retomada (a etapa em andamento nunca é interrompida).
  scope.patch("/projects/:id", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    const patch = projectPatchBodySchema.parse(request.body);
    return { project: await plansOf(request).updateProject(id, patch) };
  });

  // Reabrir projeto concluído ou cancelado (ou retomar pausado); Avulsas nunca muda de status.
  scope.post("/projects/:id/reopen", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    return { project: await plansOf(request).setProjectStatus(id, "ativo", "usuario") };
  });

  // Concluir projeto (recusa com 409 se houver tarefa em andamento ou esperando você; Avulsas nunca muda de status).
  scope.post("/projects/:id/complete", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    return { project: await plansOf(request).setProjectStatus(id, "concluido", "usuario") };
  });

  // Modo do projeto: SÓ o usuário liga o Automático (esta rota; o Maestro e o Cyno só sugerem, e nenhuma ferramenta MCP chama aqui).
  scope.post("/projects/:id/mode", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    const body = projectModeBodySchema.parse(request.body);
    return { project: await plansOf(request).setMode(id, body) };
  });

  // ---------- Apagar de vez: o dono tira o que não quer mais guardar (nada é apagado sozinho, só pela retenção que ele liga) ----------

  // Quantas tarefas avulsas terminadas há mais de N dias dariam para apagar agora (só lê).
  scope.get("/projects/avulsas/cleanup", async (request): Promise<AvulsasCleanupPreview> => {
    const { olderThanDays } = avulsasCleanupQuerySchema.parse(request.query);
    return plansOf(request).avulsasCleanupPreview(olderThanDays);
  });

  // Apaga de vez as tarefas avulsas concluídas ou canceladas há mais de N dias (e, se pedir, as do arquivo mensal).
  scope.post("/projects/avulsas/cleanup", async (request): Promise<AvulsasCleanupResult> => {
    const body = avulsasCleanupBodySchema.parse(request.body);
    return plansOf(request).cleanupAvulsas(body);
  });

  // Um projeto comum inteiro: 409 no Avulsas e com tarefa rodando ou esperando o dono.
  scope.delete("/projects/:id", async (request): Promise<ProjectDeleteResult> => {
    const { id } = idParamsSchema.parse(request.params);
    return plansOf(request).deleteProject(id);
  });

  // ---------- Árvore de tarefas: o dono cria e edita pela tela ----------

  const taskParams = z.object({ id: z.string().min(1).max(64), ref: z.string().min(1).max(12) });

  // Projeto à mão: origem "usuario", já ativo, sem plano para aprovar (as tarefas ele cria na tela).
  scope.post("/projects", async (request, reply): Promise<{ project: Project }> => {
    const body = projectCreateBodySchema.parse(request.body);
    const project = await plansOf(request).createProject(body);
    return reply.code(201).send({ project }) as never;
  });

  // Entregável, tarefa ou subtarefa. Responde o projeto inteiro e o `ref` criado.
  scope.post("/projects/:id/tasks", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = taskCreateBodySchema.parse(request.body);
    return reply.code(201).send(await plansOf(request).createTask(id, body));
  });

  // Edição na linha (nome, responsável, datas, prioridade, etiquetas, "pronto quando") e cancelar.
  scope.patch("/projects/:id/tasks/:ref", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    const patch = taskPatchBodySchema.parse(request.body);
    return { project: await plansOf(request).updateTask(id, ref, patch) };
  });

  // Reatribuir uma tarefa travada (parada, na fila, que falhou ou sem cota): troca o agente e devolve à fila; 409 com a etapa rodando.
  scope.post("/projects/:id/tasks/:ref/reassign", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    const body = taskReassignBodySchema.parse(request.body);
    return { project: await plansOf(request).reassignTask(id, ref, body) };
  });

  scope.post("/projects/:id/tasks/:ref/move", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    const body = taskMoveBodySchema.parse(request.body);
    return { project: await plansOf(request).moveTask(id, ref, body) };
  });

  scope.post("/projects/:id/tasks/:ref/duplicate", async (request, reply) => {
    const { id, ref } = taskParams.parse(request.params);
    return reply.code(201).send(await plansOf(request).duplicateTask(id, ref));
  });

  scope.post("/projects/:id/tasks/:ref/archive", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    return { project: await plansOf(request).archiveTask(id, ref) };
  });

  // Apaga um item (tarefa, subtarefa ou módulo + subárvore) de qualquer projeto (no Avulsas mantém a regra das folhas terminadas).
  scope.delete("/projects/:id/tasks/:ref", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    return { project: (await plansOf(request).deleteTask(id, ref, { by: "usuario" })).project };
  });

  scope.post("/projects/:id/tasks/:ref/label", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    const { name } = taskLabelBodySchema.parse(request.body);
    return { project: await plansOf(request).labelTask(id, ref, name) };
  });

  // Converter: a tarefa avulsa vira projeto próprio; o projeto de uma tarefa só vira tarefa avulsa.
  scope.post("/projects/:id/tasks/:ref/convert", async (request): Promise<{ project: Project }> => {
    const { id, ref } = taskParams.parse(request.params);
    if (id !== "avulsas") throw new HttpError(409, "Só as tarefas do projeto Avulsas viram projeto");
    return { project: await plansOf(request).convertTaskToProject(ref) };
  });

  scope.post("/projects/:id/convert", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    return { project: await plansOf(request).convertProjectToTask(id) };
  });

  // ---------- Liberação: criar não executa; só entra na fila o que for liberado ----------

  // Libera tarefas ou módulos (`refs`) ou o projeto inteiro (`all`); `withPrerequisites` leva junto o que elas esperam. 409 no Avulsas.
  scope.post("/projects/:id/release", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    const body = projectReleaseBodySchema.parse(request.body ?? {});
    return { project: await plansOf(request).releaseWork(id, { ...(body.refs ? { refs: body.refs } : {}), ...(body.all ? { all: true } : {}), ...(body.withPrerequisites ? { withPrerequisites: true } : {}) }) };
  });

  // Volta a Planejada o que ainda não começou; 409 se nada pôde ser segurado porque já começou.
  scope.post("/projects/:id/hold", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    const { refs } = projectHoldBodySchema.parse(request.body ?? {});
    return { project: await plansOf(request).holdWork(id, { refs }) };
  });

  // ---------- Sprints: a dimensão de tempo do projeto (só quem anda é a folha da sprint ativa) ----------

  const sprintParams = z.object({ id: z.string().min(1).max(64), sid: z.string().min(1).max(12) });

  scope.post("/projects/:id/sprints", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = sprintCreateBodySchema.parse(request.body ?? {});
    return reply.code(201).send(await plansOf(request).createSprint(id, body));
  });

  scope.post("/projects/:id/sprints/reorder", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    const { ids } = sprintReorderBodySchema.parse(request.body);
    return { project: await plansOf(request).reorderSprints(id, ids) };
  });

  scope.patch("/projects/:id/sprints/:sid", async (request): Promise<{ project: Project }> => {
    const { id, sid } = sprintParams.parse(request.params);
    const patch = sprintPatchBodySchema.parse(request.body);
    return { project: await plansOf(request).updateSprint(id, sid, patch) };
  });

  scope.delete("/projects/:id/sprints/:sid", async (request): Promise<{ project: Project }> => {
    const { id, sid } = sprintParams.parse(request.params);
    return { project: await plansOf(request).deleteSprint(id, sid) };
  });

  scope.post("/projects/:id/sprints/:sid/start", async (request): Promise<{ project: Project }> => {
    const { id, sid } = sprintParams.parse(request.params);
    return { project: await plansOf(request).startSprint(id, sid) };
  });

  scope.post("/projects/:id/sprints/:sid/close", async (request): Promise<{ project: Project }> => {
    const { id, sid } = sprintParams.parse(request.params);
    return { project: await plansOf(request).closeSprint(id, sid) };
  });
}
