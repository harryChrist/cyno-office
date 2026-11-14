import { OFFICE_MCP_PATH } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { noteMcpForbidden } from "../platform/activity/hooks";
import type { McpTool } from "./protocol";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import { handleMcpPayload } from "./protocol";
import type { McpTokens } from "./tokens";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}

/** Métodos JSON-RPC de uma mensagem (ou de um lote), na ordem. */
function mcpMethods(payload: unknown): string[] {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.flatMap((message) => (typeof message === "object" && message !== null && typeof (message as { method?: unknown }).method === "string" ? [(message as { method: string }).method] : []));
}

const INSTRUCTIONS = "Cyno tools: use them to receive and submit work and to talk to the office. Always answer the user in Brazilian Portuguese.";

/**
 * Servidor MCP "office" (POST /mcp): só aceita conexões de 127.0.0.1 e com o token de um terminal
 * de agente (Authorization: Bearer). O token diz o workspace e o agente; as ferramentas são as do
 * papel dele (Maestro ou agente de time). GET/DELETE: 405 (sem stream SSE nem sessão).
 */
export function registerMcpRoute(app: FastifyInstance, manager: WorkspaceManager, tokens: McpTokens, platform?: { tools(): McpTool[] }): void {
  app.post(OFFICE_MCP_PATH, async (request, reply) => {
    if (!LOOPBACK.has(request.socket.remoteAddress ?? "")) {
      noteMcpForbidden();
      return reply.code(403).send({ error: "O servidor MCP só aceita conexões locais" });
    }
    const token = bearer(request);
    const identity = tokens.resolve(token);
    // O token do Cyno (escopo "platform") vale para as ferramentas da plataforma; os outros, para as do workspace.
    const runtime = identity && identity.scope !== "platform" ? manager.find(identity.workspaceId) : undefined;
    const platformTools = identity?.scope === "platform" ? platform : undefined;
    if (!identity || (!runtime && !platformTools)) {
      return reply.code(401).send({ error: "Token MCP inválido" });
    }
    const toolsOf = () => (platformTools ? platformTools.tools() : runtime!.officeTools(identity.agentId));
    const response = await handleMcpPayload(request.body, toolsOf, INSTRUCTIONS);
    const sent = response === undefined ? reply.code(202).send() : reply.code(200).header("content-type", "application/json").send(response);
    // Depois de responder: o `tools/list` respondido é o que libera a primeira mensagem do terminal.
    for (const method of mcpMethods(request.body)) tokens.observe(token!, method);
    return sent;
  });

  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send({ error: "Use POST (este servidor MCP não abre stream SSE)" });
  app.get(OFFICE_MCP_PATH, notAllowed);
  app.delete(OFFICE_MCP_PATH, notAllowed);
}
