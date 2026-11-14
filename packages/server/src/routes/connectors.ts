import {
  agentConnectorsParamsSchema,
  connectorParamsSchema,
  createConnectorBodySchema,
  CONNECTOR_ICON_MAX_BYTES,
  setAgentConnectorsBodySchema,
  updateConnectorBodySchema,
  uploadConnectorIconBodySchema,
  type Connector,
  type ConnectorImportResponse,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ConnectorsService } from "../library/connectors/service";
import { HttpError } from "../platform/http/errors";

/** Conectores do workspace da requisição (`:ws`). */
export type ConnectorsOf = (request: FastifyRequest) => ConnectorsService;

/**
 * Conectores (servidores MCP externos), dentro de /api/w/:ws. Nenhuma resposta traz segredos:
 * só os nomes dos cabeçalhos/variáveis definidos e a URL mascarada.
 */
export function registerConnectorRoutes(scope: FastifyInstance, connectorsOf: ConnectorsOf): void {
  scope.get("/connectors", async (request): Promise<Connector[]> => connectorsOf(request).list());

  scope.get("/connectors/import/claude", async (request): Promise<ConnectorImportResponse> => connectorsOf(request).importFromClaude());

  scope.post("/connectors", async (request, reply) => {
    const created = await connectorsOf(request).create(createConnectorBodySchema.parse(request.body));
    return reply.code(201).send(created);
  });

  scope.patch("/connectors/:connectorId", async (request): Promise<Connector> => {
    const { connectorId } = connectorParamsSchema.parse(request.params);
    return connectorsOf(request).update(connectorId, updateConnectorBodySchema.parse(request.body));
  });

  scope.delete("/connectors/:connectorId", async (request, reply) => {
    const { connectorId } = connectorParamsSchema.parse(request.params);
    await connectorsOf(request).remove(connectorId);
    return reply.code(204).send();
  });

  /** Testa agora (initialize + tools/list) e devolve o conector com o estado novo. */
  scope.post("/connectors/:connectorId/test", async (request): Promise<Connector> => {
    const { connectorId } = connectorParamsSchema.parse(request.params);
    return connectorsOf(request).test(connectorId);
  });

  scope.post("/connectors/:connectorId/icon", { bodyLimit: Math.ceil(CONNECTOR_ICON_MAX_BYTES * 1.5) + 4096 }, async (request): Promise<Connector> => {
    const { connectorId } = connectorParamsSchema.parse(request.params);
    const body = uploadConnectorIconBodySchema.parse(request.body);
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (bytes.length > CONNECTOR_ICON_MAX_BYTES) throw new HttpError(413, `A imagem passa de ${Math.round(CONNECTOR_ICON_MAX_BYTES / 1024)} KB`);
    return connectorsOf(request).setIcon(connectorId, body.mime, bytes);
  });

  scope.get("/connectors/:connectorId/icon", async (request, reply) => {
    const { connectorId } = connectorParamsSchema.parse(request.params);
    const icon = await connectorsOf(request).readIcon(connectorId);
    if (!icon) throw new HttpError(404, "Este conector não tem ícone próprio");
    return reply
      .header("content-type", icon.mime)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .header("cache-control", "private, max-age=86400")
      .send(icon.bytes);
  });

  /** Conectores do agente (lista inteira): o seletor "Conectores" do painel do agente/Maestro. */
  scope.patch("/agents/:agentId/connectors", async (request): Promise<Connector[]> => {
    const { agentId } = agentConnectorsParamsSchema.parse(request.params);
    const { connectorIds } = setAgentConnectorsBodySchema.parse(request.body);
    return connectorsOf(request).setAgentConnectors(agentId, connectorIds);
  });
}
