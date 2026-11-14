import { mkdir } from "node:fs/promises";
import { connectorToolName, type ConnectorState, type ServerEvent } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { McpTool, McpToolResult } from "../../mcp/protocol";
import { sanitizeChildEnv } from "../../engines/terminals/env";
import { ConnectorAuthError, HttpMcpClient, StdioMcpClient, type McpClient, type SpawnLike } from "./mcp-client";
import type { ConnectorRegistry } from "./registry";
import { redact, secretValues, type ConnectorPaths, type StoredConnector, type StoredConnectorTool } from "./store";

/** O que o gateway precisa do AppToolRunner (o `LibraryService` liga os dois): as ferramentas de um app e rodar uma delas. */
export interface AppToolsPort {
  tools(appId: string): StoredConnectorTool[];
  /** Com `caller`: dentro da pasta do agente e com a saída na Mídia dele. Sem: a chamada do próprio sistema (mini teste). */
  run(appId: string, tool: string, args: Record<string, unknown>, caller?: { workspaceId: string; agentId: string }): Promise<{ text: string; isError: boolean }>;
}

export type ConnectorGatewayDeps = {
  registry: ConnectorRegistry;
  paths: ConnectorPaths;
  /** Eventos só visuais vão ao workspace do agente que chamou. */
  publish: (workspaceId: string, event: ServerEvent) => void;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
  now: () => Date;
  /** Fábrica de clientes (testes); padrão: HTTP com fetch, stdio com spawn. */
  createClient?: (record: StoredConnector) => McpClient;
  fetch?: typeof fetch;
  spawn?: SpawnLike;
  /** Ambiente base dos processos stdio (padrão: process.env, sem chaves de API). */
  env?: NodeJS.ProcessEnv;
  /** Ocioso por tanto tempo = processo stdio parado. */
  stdioIdleMs?: number;
  /** Conectores stdio liberados (CONNECTORS_STDIO=1)? Sem isso, nenhum comando é executado. */
  allowStdio?: boolean;
  /** Ferramentas dos conectores `kind: "app"` (sem processo: o AppToolRunner roda o comando do app). */
  appTools?: () => AppToolsPort | undefined;
};

/** Cliente de um conector `app`: não há processo para falar; a lista vem da receita e a chamada vai para o runner. */
class AppToolClient implements McpClient {
  constructor(
    private readonly appId: string,
    private readonly port: () => AppToolsPort | undefined,
  ) {}

  async listTools(): Promise<StoredConnectorTool[]> {
    const port = this.port();
    if (!port) throw new Error("o executor de ferramentas de apps ainda não está ligado");
    const tools = port.tools(this.appId);
    if (tools.length === 0) throw new Error("o app não declara ferramentas (instalado de uma receita antiga?)");
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError: boolean }> {
    const port = this.port();
    if (!port) throw new Error("o executor de ferramentas de apps ainda não está ligado");
    const result = await port.run(this.appId, name, args);
    return { content: [{ type: "text", text: result.text }], isError: result.isError };
  }

  async close(): Promise<void> {
    // nada a fechar: não há processo
  }
}

/** Estado e motivo a partir de um erro (sem segredos). */
export function statusFromError(error: unknown, secrets: readonly string[]): { state: ConnectorState; reason: string } {
  const message = redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 300);
  if (error instanceof ConnectorAuthError) return { state: "needs_auth", reason: message };
  return { state: "error", reason: message || "erro desconhecido" };
}

/** Qualquer objeto vira argumento (o servidor do conector valida pelo schema dele). */
const anyArgs = z.looseObject({});

/** JSON Schema de entrada que vai para o agente: o do conector, ou um objeto livre. */
function inputSchemaOf(tool: StoredConnectorTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema || schema.type !== "object") return { type: "object", properties: {}, ...(schema ? { ...schema, type: "object" } : {}) };
  return schema;
}

/**
 * Gateway único dos conectores da plataforma (um cliente por conector, compartilhado entre os
 * workspaces: um processo stdio só). O agente fala só com o nosso servidor MCP "office"; o
 * gateway conecta no conector (cliente HTTP com os cabeçalhos secretos, ou o processo stdio com as
 * variáveis secretas) e mostra as ferramentas dele com o prefixo (`notion__create_page`), só
 * para os agentes ligados ao conector. Cada chamada publica `connector:activity` (início e fim),
 * e uma falha de conexão atualiza o estado do conector. Segredos nunca vão para o log, para o
 * agente nem para a API (as mensagens passam por `redact`).
 */
export class ConnectorGateway {
  private readonly clients = new Map<string, { client: McpClient; fingerprint: string }>();
  private readonly testing = new Map<string, Promise<StoredConnector | undefined>>();

  constructor(private readonly deps: ConnectorGatewayDeps) {}

  /** O dono ligou ou desligou os conectores locais pela tela: vale para os próximos a subir. */
  setAllowStdio(allowed: boolean): void {
    this.deps.allowStdio = allowed;
  }

  /** Ferramentas dos conectores que o agente recebeu naquele workspace (do cache do último teste). Nomes repetidos: fica o primeiro. */
  toolsFor(workspaceId: string, agentId: string): McpTool[] {
    const tools: McpTool[] = [];
    const seen = new Set<string>();
    for (const record of this.deps.registry.attachedTo(workspaceId, agentId)) {
      for (const tool of record.status.tools) {
        const name = connectorToolName(record.toolPrefix, tool.name);
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push({
          name,
          description: `[Connector ${record.name}] ${tool.description ?? tool.name}`.slice(0, 2000),
          input: anyArgs,
          jsonSchema: inputSchemaOf(tool),
          call: (args) => this.call(workspaceId, agentId, record.id, tool.name, (args ?? {}) as Record<string, unknown>),
        });
      }
    }
    return tools;
  }

  /** Chama a ferramenta `tool` do conector para o agente (confere de novo o vínculo na hora). */
  async call(workspaceId: string, agentId: string, connectorId: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const record = this.deps.registry.attachedTo(workspaceId, agentId).find((candidate) => candidate.id === connectorId);
    if (!record) return { text: "This connector is no longer available to you.", isError: true };
    const secrets = secretValues(record);
    this.activity(workspaceId, connectorId, agentId, tool, "started");
    if (record.kind === "app") {
      // Ferramenta de app: o runner valida, entra na fila do app e roda dentro da pasta do agente.
      const port = this.deps.appTools?.();
      if (!port || !record.appId) {
        this.activity(workspaceId, connectorId, agentId, tool, "finished", false);
        return { text: `Connector ${record.name} is not ready (the app runner is off).`, isError: true };
      }
      try {
        const result = await port.run(record.appId, tool, args, { workspaceId, agentId });
        this.activity(workspaceId, connectorId, agentId, tool, "finished", !result.isError);
        return { text: result.text, isError: result.isError };
      } catch (error) {
        this.activity(workspaceId, connectorId, agentId, tool, "finished", false);
        return { text: `Connector ${record.name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    }
    try {
      if (record.kind === "stdio") await mkdir(this.deps.paths.dir(connectorId), { recursive: true });
      const result = await this.client(record).callTool(tool, args);
      this.activity(workspaceId, connectorId, agentId, tool, "finished", !result.isError);
      if (record.status.state !== "connected") void this.deps.registry.setStatus(connectorId, { state: "connected" });
      return { text: "", content: result.content.length > 0 ? result.content : [{ type: "text", text: "(no content)" }], isError: result.isError };
    } catch (error) {
      this.activity(workspaceId, connectorId, agentId, tool, "finished", false);
      const status = statusFromError(error, secrets);
      this.deps.log.warn({ connectorId, agentId, tool, state: status.state, reason: status.reason }, "chamada de conector falhou");
      await this.dropClient(connectorId);
      await this.deps.registry.setStatus(connectorId, status);
      const hint = status.state === "needs_auth" ? " It needs a login/credential: tell the user." : "";
      return { text: `Connector ${record.name} failed: ${status.reason}.${hint}`, isError: true };
    }
  }

  /**
   * Chamada do próprio sistema (o mini teste de um app): sem agente nem workspace, só com o conector
   * ligado. O processo sobe se precisar e some pela regra de ociosidade.
   */
  async callSystem(connectorId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const record = this.deps.registry.record(connectorId);
    if (!record) throw new Error("o conector não existe mais");
    if (!record.enabled) throw new Error("o conector está desligado");
    if (record.kind === "stdio") await mkdir(this.deps.paths.dir(connectorId), { recursive: true });
    try {
      const result = await this.client(record).callTool(tool, args);
      const text = result.content
        .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      return { text, isError: result.isError };
    } catch (error) {
      await this.dropClient(connectorId);
      throw new Error(statusFromError(error, secretValues(record)).reason, { cause: error });
    }
  }

  /** Testa a conexão (initialize + tools/list) e guarda o estado e as ferramentas. Um teste por vez por conector. */
  test(connectorId: string): Promise<StoredConnector | undefined> {
    const running = this.testing.get(connectorId);
    if (running) return running;
    const run = this.runTest(connectorId).finally(() => this.testing.delete(connectorId));
    this.testing.set(connectorId, run);
    return run;
  }

  /** O conector mudou (conexão, segredos, desligado) ou saiu: o cliente velho fecha. */
  async invalidate(connectorId: string): Promise<void> {
    await this.dropClient(connectorId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.dropClient(id)));
  }

  // ---------- Infra ----------

  private async runTest(connectorId: string): Promise<StoredConnector | undefined> {
    const record = this.deps.registry.record(connectorId);
    if (!record) return undefined;
    if (!record.enabled) {
      await this.dropClient(connectorId);
      return this.deps.registry.setStatus(connectorId, { state: "disabled" });
    }
    await this.dropClient(connectorId);
    if (record.kind === "stdio") await mkdir(this.deps.paths.dir(connectorId), { recursive: true });
    try {
      const tools = await this.client(record).listTools();
      return await this.deps.registry.setStatus(connectorId, { state: "connected", tools });
    } catch (error) {
      const status = statusFromError(error, secretValues(record));
      this.deps.log.info({ connectorId, state: status.state, reason: status.reason }, "teste de conector falhou");
      await this.dropClient(connectorId);
      return this.deps.registry.setStatus(connectorId, status);
    }
  }

  private fingerprint(record: StoredConnector): string {
    return JSON.stringify([record.kind, record.url, record.command, record.args, record.headers, record.env]);
  }

  private client(record: StoredConnector): McpClient {
    const fingerprint = this.fingerprint(record);
    const existing = this.clients.get(record.id);
    if (existing && existing.fingerprint === fingerprint) return existing.client;
    if (existing) void existing.client.close().catch(() => undefined);
    const client = this.deps.createClient?.(record) ?? this.defaultClient(record);
    this.clients.set(record.id, { client, fingerprint });
    return client;
  }

  private defaultClient(record: StoredConnector): McpClient {
    if (record.kind === "http") return new HttpMcpClient({ url: record.url ?? "", headers: record.headers, fetch: this.deps.fetch });
    if (record.kind === "app") return new AppToolClient(record.appId ?? "", () => this.deps.appTools?.());
    if (this.deps.allowStdio === false) throw new Error("conectores stdio (comando local) estão desligados neste servidor; suba com CONNECTORS_STDIO=1 para liberar");
    // O processo herda o ambiente do server sem chaves de API, mais as variáveis do conector
    // (essas o usuário pôs de propósito, então valem mesmo se o nome parecer de chave de API).
    const env = { ...sanitizeChildEnv(this.deps.env ?? process.env), ...record.env };
    // Apps pesados (ex.: Laya) pedem mais tempo para subir e param antes quando ociosos: `limits` do catálogo.
    const limits = record.limits;
    return new StdioMcpClient({
      command: record.command ?? "",
      args: record.args ?? [],
      cwd: this.deps.paths.dir(record.id),
      env,
      spawn: this.deps.spawn,
      idleMs: limits ? limits.idleSec * 1000 : this.deps.stdioIdleMs,
      ...(limits ? { timeoutMs: limits.startSec * 1000, callTimeoutMs: limits.callSec * 1000 } : {}),
    });
  }

  private async dropClient(connectorId: string): Promise<void> {
    const entry = this.clients.get(connectorId);
    if (!entry) return;
    this.clients.delete(connectorId);
    await entry.client.close().catch(() => undefined);
  }

  private activity(workspaceId: string, connectorId: string, agentId: string, tool: string, phase: "started" | "finished", ok?: boolean): void {
    this.deps.publish(workspaceId, { type: "connector:activity", activity: { connectorId, agentId, tool, phase, ...(ok === undefined ? {} : { ok }), at: this.deps.now().toISOString() } });
  }
}
