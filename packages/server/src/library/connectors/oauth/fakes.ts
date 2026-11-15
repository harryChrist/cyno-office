import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Servidores falsos do login OAuth (só para testes e para o laboratório): um servidor de autorização
 * (com ou sem cadastro dinâmico, com o metadado estilo OIDC do Google ou o RFC 8414) e um servidor
 * MCP HTTP que exige Bearer. Tudo em 127.0.0.1, porta livre, sem rede de verdade.
 */

export type FakeOptions = {
  /** O servidor de autorização aceita cadastro dinâmico (RFC 7591)? */
  dynamicRegistration: boolean;
  /** Metadado só em `/.well-known/openid-configuration` (como o Google). */
  oidcOnly: boolean;
  /** Validade do token de acesso em segundos. */
  expiresIn: number;
  /** Escopos anunciados pelo recurso protegido. */
  scopes: string[];
  /** Cliente fixo (sem cadastro dinâmico): o que o dono digitaria. */
  manualClient: { id: string; secret: string };
  /** O servidor de autorização devolve token de renovação? */
  refreshToken: boolean;
  /** O MCP lista as ferramentas sem login (o Gmail faz isso). */
  publicToolsList: boolean;
};

export type FakeServers = {
  authUrl: string;
  mcpUrl: string;
  issuer: string;
  options: FakeOptions;
  /** O que o servidor de autorização viu. */
  stats: { registrations: number; codeExchanges: number; refreshes: number; revocations: number; lastAuthorize?: URLSearchParams; lastTokenBody?: URLSearchParams; lastRegistration?: Record<string, unknown> };
  /** Tokens de acesso que o MCP aceita agora. */
  valid: Set<string>;
  /** Faz o próximo(s) refresh falharem (invalid_grant) ou darem erro de servidor. */
  failRefresh: "none" | "invalid_grant" | "server_error";
  /** Quantas chamadas tools/call o MCP atendeu. */
  mcpCalls: number;
  /** Corpo de um 403 que o MCP devolve em tools/call (como o Gmail com a API desativada); vazio = atende normal. */
  forbidCalls: string;
  /** Quantos pedidos o MCP recusou com 401. */
  unauthorized: number;
  /** Vence todos os tokens de acesso emitidos (o MCP passa a responder 401). */
  revokeAccess: () => void;
  close: () => Promise<void>;
};

const body = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};

const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

export async function startFakes(overrides: Partial<FakeOptions> = {}): Promise<FakeServers> {
  const options: FakeOptions = { dynamicRegistration: true, oidcOnly: false, expiresIn: 3600, scopes: ["read", "write"], manualClient: { id: "manual-client-id", secret: "manual-client-secret" }, refreshToken: true, publicToolsList: false, ...overrides };
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const clients = new Map<string, { redirectUris: string[]; secret?: string }>();
  const refreshTokens = new Set<string>();
  const fakes = { options, stats: { registrations: 0, codeExchanges: 0, refreshes: 0, revocations: 0 }, valid: new Set<string>(), failRefresh: "none", mcpCalls: 0, unauthorized: 0, forbidCalls: "" } as unknown as FakeServers;
  clients.set(options.manualClient.id, { redirectUris: [], secret: options.manualClient.secret });

  let authPort = 0;
  let mcpPort = 0;
  const authBase = () => `http://127.0.0.1:${authPort}`;
  const mcpBase = () => `http://127.0.0.1:${mcpPort}`;

  const auth = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", authBase());
      const metadata = {
        issuer: authBase(),
        authorization_endpoint: `${authBase()}/authorize`,
        token_endpoint: `${authBase()}/token`,
        revocation_endpoint: `${authBase()}/revoke`,
        ...(options.dynamicRegistration ? { registration_endpoint: `${authBase()}/register` } : {}),
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: options.dynamicRegistration ? ["none", "client_secret_post"] : ["client_secret_post", "client_secret_basic"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        scopes_supported: ["openid"],
      };
      if (url.pathname === "/.well-known/oauth-authorization-server" && !options.oidcOnly) return json(response, 200, metadata);
      if (url.pathname === "/.well-known/openid-configuration") return json(response, 200, metadata);
      if (url.pathname === "/register" && request.method === "POST") {
        if (!options.dynamicRegistration) return json(response, 404, { error: "not_found" });
        const payload = JSON.parse(await body(request)) as { redirect_uris: string[] };
        fakes.stats.registrations++;
        fakes.stats.lastRegistration = payload as unknown as Record<string, unknown>;
        const clientId = `dyn-${randomUUID().slice(0, 8)}`;
        clients.set(clientId, { redirectUris: payload.redirect_uris });
        return json(response, 201, { client_id: clientId, token_endpoint_auth_method: "none" });
      }
      if (url.pathname === "/authorize") {
        fakes.stats.lastAuthorize = url.searchParams;
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const client = clients.get(clientId);
        if (!client) return json(response, 400, { error: "invalid_client" });
        if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) return json(response, 400, { error: "redirect_uri_mismatch" });
        if (url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge")) return json(response, 400, { error: "invalid_request", error_description: "PKCE obrigatório" });
        const code = `code-${randomUUID()}`;
        codes.set(code, { challenge: url.searchParams.get("code_challenge")!, clientId, redirectUri });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        back.searchParams.set("iss", authBase());
        response.writeHead(302, { location: back.toString() });
        return response.end();
      }
      if (url.pathname === "/revoke" && request.method === "POST") {
        fakes.stats.revocations++;
        return json(response, 200, {});
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await body(request));
        fakes.stats.lastTokenBody = form;
        const clientId = form.get("client_id") ?? "";
        const client = clients.get(clientId);
        if (!client) return json(response, 401, { error: "invalid_client" });
        if (client.secret && form.get("client_secret") !== client.secret && !request.headers.authorization) return json(response, 401, { error: "invalid_client" });
        const issue = () => {
          const access = `access-${randomUUID()}`;
          fakes.valid.add(access);
          const refresh = options.refreshToken ? `refresh-${randomUUID()}` : undefined;
          if (refresh) refreshTokens.add(refresh);
          return { access_token: access, token_type: "Bearer", expires_in: options.expiresIn, scope: form.get("scope") ?? "read", ...(refresh ? { refresh_token: refresh } : {}) };
        };
        if (form.get("grant_type") === "authorization_code") {
          fakes.stats.codeExchanges++;
          const entry = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (!entry || entry.clientId !== clientId || entry.redirectUri !== form.get("redirect_uri")) return json(response, 400, { error: "invalid_grant" });
          const verifier = form.get("code_verifier") ?? "";
          if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return json(response, 400, { error: "invalid_grant", error_description: "PKCE não confere" });
          return json(response, 200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          fakes.stats.refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 40)); // dá tempo de chamadas concorrentes se atropelarem
          if (fakes.failRefresh === "server_error") return json(response, 503, { error: "temporarily_unavailable" });
          if (fakes.failRefresh === "invalid_grant" || !refreshTokens.has(form.get("refresh_token") ?? "")) return json(response, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          const fresh = issue();
          delete (fresh as { refresh_token?: string }).refresh_token; // como o Google: o token de renovação continua o mesmo
          return json(response, 200, fresh);
        }
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      json(response, 404, { error: "not_found" });
    })().catch(() => json(response, 500, { error: "fake_failed" }));
  });

  const mcp = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", mcpBase());
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(response, 200, { resource: `${mcpBase()}/mcp`, authorization_servers: [authBase()], scopes_supported: options.scopes, bearer_methods_supported: ["header"] });
      }
      if (url.pathname !== "/mcp" || request.method !== "POST") return json(response, 404, { error: "not_found" });
      const message = JSON.parse(await body(request)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const token = /^Bearer (.+)$/i.exec(String(request.headers.authorization ?? ""))?.[1];
      const authed = Boolean(token && fakes.valid.has(token));
      const open = message.method === "initialize" || message.method === "notifications/initialized" || (message.method === "tools/list" && options.publicToolsList);
      if (!authed && !open) fakes.unauthorized++;
      if (!authed && !open) return json(response, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${mcpBase()}/.well-known/oauth-protected-resource/mcp"` });
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        return response.end();
      }
      if (message.method === "initialize") return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1" } } });
      if (message.method === "tools/list") return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "whoami", description: "Diz quem está logado", inputSchema: { type: "object", properties: {} } }] } });
      if (message.method === "tools/call") {
        fakes.mcpCalls++;
        if (fakes.forbidCalls) {
          response.writeHead(403, { "content-type": "application/json" });
          return response.end(fakes.forbidCalls);
        }
        return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `ok:${message.params?.name}` }], isError: false } });
      }
      json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "método desconhecido" } });
    })().catch(() => json(response, 500, { error: "fake_failed" }));
  });

  authPort = await listen(auth);
  mcpPort = await listen(mcp);
  fakes.authUrl = authBase();
  fakes.issuer = authBase();
  fakes.mcpUrl = `${mcpBase()}/mcp`;
  fakes.revokeAccess = () => fakes.valid.clear();
  fakes.close = async () => {
    auth.closeAllConnections();
    mcp.closeAllConnections();
    await Promise.all([new Promise((resolve) => auth.close(resolve)), new Promise((resolve) => mcp.close(resolve))]);
  };
  return fakes;
}
