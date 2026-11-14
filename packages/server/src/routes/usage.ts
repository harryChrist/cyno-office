import { agentUsageQuerySchema, usageRefreshBodySchema, USAGE_REFRESH_PATH, type AgentUsageResponse, type ApiErrorBody, type UsageRefreshResponse } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentUsageLedger } from "../engines/usage/agent-usage";
import type { UsagePoller } from "../engines/usage/usage-poller";

const DISABLED: Record<"claude" | "gemini", string> = {
  claude: "A consulta do uso da conta Claude está desligada (CLAUDE_USAGE_POLL_MS=0)",
  gemini: "A consulta da cota do Antigravity está desligada (ANTIGRAVITY_USAGE_POLL_MS=0)",
};

/**
 * `POST /api/usage/refresh` (corpo opcional `{ provider: "claude" | "gemini" }`, padrão "claude"):
 * consulta o uso da conta daquele motor agora (no máximo uma consulta real a cada 30 s; dentro disso
 * devolve o último valor com `refreshed: false`). 503 se a consulta dele estiver desligada.
 */
export function registerUsageRoutes(app: FastifyInstance, pollers: Partial<Record<"claude" | "gemini", UsagePoller>>): void {
  app.post(USAGE_REFRESH_PATH, async (request, reply): Promise<UsageRefreshResponse | ApiErrorBody> => {
    const { provider } = usageRefreshBodySchema.parse(request.body ?? {});
    const poller = pollers[provider];
    if (!poller) return reply.code(503).send({ error: DISABLED[provider] } satisfies ApiErrorBody);
    return poller.refresh();
  });
}

/**
 * `GET /api/w/:ws/usage/agents?since=ISO`: o uso relatado por agente do workspace (turnos e tokens
 * que cada CLI informou) desde `since` (padrão: últimas 5 h; no máximo 24 h). É estimativa: a
 * assinatura não separa o uso por agente.
 */
export function registerAgentUsageRoutes(scope: FastifyInstance, ledgerOf: (request: FastifyRequest) => AgentUsageLedger): void {
  scope.get("/usage/agents", async (request): Promise<AgentUsageResponse> => {
    const { since } = agentUsageQuerySchema.parse(request.query);
    return ledgerOf(request).summary(since);
  });
}
