import {
  agentLogQuerySchema,
  idSchema,
  taskIdParamsSchema,
  taskLogQuerySchema,
  type AgentLogResponse,
  type TaskLogResponse,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentLogService } from "../workspace/agent-log/service";
import { HttpError } from "../platform/http/errors";

const agentParamsSchema = z.object({ agentId: idSchema });

/**
 * Log de trabalho dos agentes, dentro de /api/w/:ws:
 * - GET agents/:agentId/log?limit= : entradas recentes de todas as tarefas do agente (as mais
 *   novas por último) e o resumo do momento (tarefa aberta, subagentes rodando). Agente sem log
 *   (ou removido) = lista vazia.
 * - GET tasks/:taskId/log?thread= : log da tarefa e as threads de subagentes; `thread` filtra
 *   (id do subagente, ou "main" para só o agente). 404 se não há log nem tarefa.
 */
export function registerAgentLogRoutes(scope: FastifyInstance, agentLogOf: (request: FastifyRequest) => AgentLogService): void {
  scope.get("/agents/:agentId/log", async (request): Promise<AgentLogResponse> => {
    const { agentId } = agentParamsSchema.parse(request.params);
    const { limit } = agentLogQuerySchema.parse(request.query);
    const agentLog = agentLogOf(request);
    return { agentId, entries: await agentLog.recentForAgent(agentId, limit), summary: agentLog.summary(agentId) };
  });

  scope.get("/tasks/:taskId/log", async (request): Promise<TaskLogResponse> => {
    const { taskId } = taskIdParamsSchema.parse(request.params);
    const { thread } = taskLogQuerySchema.parse(request.query);
    const log = await agentLogOf(request).readTask(taskId, thread);
    if (!log) throw new HttpError(404, `Tarefa "${taskId}" não encontrada`);
    return log;
  });
}
