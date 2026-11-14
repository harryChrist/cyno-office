import { agentChatBodySchema, idParamsSchema, terminalStopQuerySchema } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentChat } from "../engines/terminals/agent-chat";
import type { TerminalManager } from "../engines/terminals/manager";

/**
 * Terminais de CLI dos agentes reais, dentro de /api/w/:ws:
 * - POST /agents/:id/terminal/start -> AgentTerminalInfo (sobe o processo, retomando a sessão);
 * - POST /agents/:id/terminal/stop[?force=1] -> AgentTerminalInfo (para o processo; a sessão fica salva;
 *   no meio de um turno -> 409, a menos que venha `force`: aí o turno é cortado).
 * - POST /agents/:id/chat { text } -> 202 AgentChatResponse (nota na tarefa em curso ou conversa;
 *   o agente simulado responde com um texto pronto; o Maestro -> 409: ele tem a caixa dele).
 * Agente simulado (motor "mock") -> 409 no start/stop; motor sem adaptador ainda -> 422.
 */
export function registerTerminalRoutes(scope: FastifyInstance, terminalsOf: (request: FastifyRequest) => TerminalManager, chatOf: (request: FastifyRequest) => AgentChat): void {
  scope.post("/agents/:id/chat", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { text } = agentChatBodySchema.parse(request.body);
    return reply.code(202).send(await chatOf(request).send(id, text));
  });

  scope.post("/agents/:id/terminal/start", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return terminalsOf(request).start(id);
  });

  scope.post("/agents/:id/terminal/stop", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { force } = terminalStopQuerySchema.parse(request.query ?? {});
    return terminalsOf(request).stop(id, { force: force === "1" || force === "true" });
  });
}
