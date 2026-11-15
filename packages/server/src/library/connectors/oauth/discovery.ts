import { GMAIL_API_RESOURCE, GMAIL_API_SCOPES, GOOGLE_ISSUER, isGoogleIssuer, sameIssuer, type OAuthProvider } from "@cyno/shared";
import { ConnectorError } from "../mcp-client";
import { assertAllowedUrl, limitedFetch, parseJsonObject } from "./safe-fetch";
import type { StoredAuthServer } from "./stored";

/**
 * Descoberta do OAuth de um servidor MCP (especificação de autorização do MCP, 2025-06-18):
 * 1. metadado do recurso protegido (RFC 9728): `resource_metadata` do `WWW-Authenticate` de um 401
 *    e os caminhos `/.well-known/oauth-protected-resource[/<caminho>]`;
 * 2. metadado do servidor de autorização (RFC 8414 `oauth-authorization-server`, com e sem caminho,
 *    e OIDC `openid-configuration`; o Google só tem o OIDC).
 * Nada aqui precisa de login. Sem metadado do recurso, tenta o servidor de autorização na origem do
 * servidor MCP (a regra da versão 2025-03-26).
 */

export type Discovered = {
  resource: string;
  provider: OAuthProvider;
  authServer: StoredAuthServer;
  scopesSupported: string[];
  /** O `resource` vai no pedido de login? Não vai para o Google (não é um servidor de autorização do padrão MCP). */
  usesResource: boolean;
};

export type DiscoverDeps = { fetch?: typeof fetch; timeoutMs?: number };

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 300) : []);
const asUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return assertAllowedUrl(value).toString();
  } catch {
    return undefined;
  }
};

/** `https://h/mcp/v1/` e `https://h/mcp/v1` são o mesmo recurso; sem query e sem fragmento. */
export function canonicalResource(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "") || url.origin;
}

/** `resource_metadata="…"` de um cabeçalho WWW-Authenticate. */
export function resourceMetadataFromChallenge(header: string | null): string | undefined {
  if (!header) return undefined;
  return /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)?.[1] ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(header)?.[1];
}

/** Os endereços onde o metadado do recurso pode estar, do mais provável ao menos. */
export function protectedResourceUrls(mcpUrl: URL, challengeUrl?: string): string[] {
  const path = mcpUrl.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (challengeUrl) urls.push(challengeUrl);
  if (path) urls.push(`${mcpUrl.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${mcpUrl.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

/** Os endereços do metadado do servidor de autorização para um emissor (RFC 8414 §3.1 e OIDC). */
export function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const base = url.origin;
  if (!path) return [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  return [`${base}/.well-known/oauth-authorization-server${path}`, `${base}/.well-known/openid-configuration${path}`, `${base}${path}/.well-known/openid-configuration`];
}

async function getJson(url: string, deps: DiscoverDeps): Promise<Record<string, unknown> | undefined> {
  try {
    assertAllowedUrl(url);
    const response = await limitedFetch(url, { fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? 8000, headers: { accept: "application/json" } });
    if (response.status !== 200) return undefined;
    return parseJsonObject(response.text);
  } catch {
    return undefined;
  }
}

/** Pergunta ao servidor MCP (sem credencial) o que ele responde: um 401 com `resource_metadata` mostra o metadado. */
async function probeChallenge(mcpUrl: URL, deps: DiscoverDeps): Promise<string | undefined> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cyno-gateway", version: "0.1.0" } } });
  try {
    const response = await limitedFetch(mcpUrl.toString(), {
      fetch: deps.fetch,
      method: "POST",
      timeoutMs: deps.timeoutMs ?? 8000,
      maxRedirects: 0,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
    if (response.status !== 401 && response.status !== 403) return undefined;
    const found = resourceMetadataFromChallenge(response.headers.get("www-authenticate"));
    return found ? asUrl(found) : undefined;
  } catch {
    return undefined;
  }
}

async function readAuthServer(issuer: string, deps: DiscoverDeps): Promise<{ authServer: StoredAuthServer; scopes: string[]; pkce: string[] } | undefined> {
  let parsed: URL;
  try {
    parsed = assertAllowedUrl(issuer);
  } catch {
    return undefined;
  }
  for (const metadataUrl of authServerMetadataUrls(parsed.toString())) {
    const doc = await getJson(metadataUrl, deps);
    if (!doc) continue;
    const authorizationEndpoint = asUrl(doc.authorization_endpoint);
    const tokenEndpoint = asUrl(doc.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    // RFC 8414 §3.3: o `issuer` do documento tem que ser o emissor pedido (a barra final não conta).
    if (typeof doc.issuer !== "string" || !sameIssuer(doc.issuer, issuer)) continue;
    const registrationEndpoint = asUrl(doc.registration_endpoint);
    const revocationEndpoint = asUrl(doc.revocation_endpoint);
    return {
      authServer: {
        issuer: doc.issuer.replace(/\/+$/, ""),
        authorizationEndpoint,
        tokenEndpoint,
        ...(registrationEndpoint ? { registrationEndpoint } : {}),
        ...(revocationEndpoint ? { revocationEndpoint } : {}),
        tokenAuthMethods: asStrings(doc.token_endpoint_auth_methods_supported),
        metadataUrl,
      },
      scopes: asStrings(doc.scopes_supported),
      pkce: asStrings(doc.code_challenge_methods_supported),
    };
  }
  return undefined;
}

/**
 * Descobre o OAuth de `mcpUrl`. Lança `ConnectorError` (mensagem em pt-BR, para o dono) quando o
 * servidor não anuncia OAuth ou não aceita PKCE S256.
 */
export async function discoverOAuth(mcpUrlRaw: string, deps: DiscoverDeps = {}): Promise<Discovered> {
  const mcpUrl = assertAllowedUrl(mcpUrlRaw);
  const challenge = await probeChallenge(mcpUrl, deps);
  let resourceDoc: Record<string, unknown> | undefined;
  for (const url of protectedResourceUrls(mcpUrl, challenge)) {
    const doc = await getJson(url, deps);
    if (doc && asStrings(doc.authorization_servers).length > 0) {
      resourceDoc = doc;
      break;
    }
  }
  const issuers = resourceDoc ? asStrings(resourceDoc.authorization_servers) : [mcpUrl.origin];
  let found: Awaited<ReturnType<typeof readAuthServer>>;
  for (const issuer of issuers) {
    found = await readAuthServer(issuer, deps);
    if (found) break;
  }
  if (!found) {
    throw new ConnectorError(
      resourceDoc ? "o servidor anuncia OAuth, mas não achei o metadado do servidor de autorização dele" : "não achei OAuth neste servidor (sem metadado do recurso protegido nem do servidor de autorização)",
    );
  }
  if (found.pkce.length > 0 && !found.pkce.includes("S256")) throw new ConnectorError("o servidor de autorização não aceita PKCE com S256, que o Cyno exige");
  const provider: OAuthProvider = isGoogleIssuer(found.authServer.issuer) ? "google" : "generic";
  // O `resource` do metadado vale se for este mesmo servidor MCP; senão fica o endereço configurado.
  const declared = typeof resourceDoc?.resource === "string" ? resourceDoc.resource : undefined;
  let resource = canonicalResource(mcpUrl.toString());
  if (declared) {
    try {
      if (canonicalResource(declared) === resource) resource = canonicalResource(declared);
    } catch {
      // `resource` inválido no metadado: fica o endereço configurado.
    }
  }
  const scopesSupported = resourceDoc && asStrings(resourceDoc.scopes_supported).length > 0 ? asStrings(resourceDoc.scopes_supported) : found.scopes;
  return { resource, provider, authServer: found.authServer, scopesSupported: [...new Set(scopesSupported)], usesResource: provider !== "google" };
}

/**
 * OAuth do Gmail pela API pública (conector "gmail-api"): não há servidor MCP para descobrir. O
 * servidor de autorização é o do Google (metadado OIDC do próprio Google), sem cadastro automático
 * (o dono traz o ID e o segredo), sem `resource`, com as duas permissões fixas que o Cyno oferece.
 */
export async function discoverGmailApi(deps: DiscoverDeps = {}): Promise<Discovered> {
  const found = await readAuthServer(GOOGLE_ISSUER, deps);
  if (!found) throw new ConnectorError("não deu para ler o metadado de login do Google (accounts.google.com)");
  if (found.pkce.length > 0 && !found.pkce.includes("S256")) throw new ConnectorError("o servidor de autorização não aceita PKCE com S256, que o Cyno exige");
  const { registrationEndpoint: _ignored, ...authServer } = found.authServer;
  return { resource: GMAIL_API_RESOURCE, provider: "google", authServer, scopesSupported: [...GMAIL_API_SCOPES], usesResource: false };
}

/** O mesmo, sem rede: monta a partir de um servidor de autorização do Google que o conector já guarda (trocar de modo não pode depender da internet). */
export function gmailApiFrom(authServer: StoredAuthServer): Discovered {
  const { registrationEndpoint: _ignored, ...rest } = authServer;
  return { resource: GMAIL_API_RESOURCE, provider: "google", authServer: rest, scopesSupported: [...GMAIL_API_SCOPES], usesResource: false };
}
