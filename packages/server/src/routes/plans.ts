import { idParamsSchema, planAdjustBodySchema, projectCreateBodySchema, projectModeBodySchema, projectPatchBodySchema, sprintCreateBodySchema, sprintPatchBodySchema, sprintReorderBodySchema, taskCreateBodySchema, taskLabelBodySchema, taskMoveBodySchema, taskPatchBodySchema, taskReassignBodySchema, type Plan, type Project } from "@cyno/shared";
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
    return plansOf(request).approve(id);
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

  // Modo do projeto: SÓ o usuário liga o Automático (esta rota; o Maestro e o Cyno só sugerem, e nenhuma ferramenta MCP chama aqui).
  scope.post("/projects/:id/mode", async (request): Promise<{ project: Project }> => {
    const { id } = idParamsSchema.parse(request.params);
    const body = projectModeBodySchema.parse(request.body);
    return { project: await plansOf(request).setMode(id, body) };
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
