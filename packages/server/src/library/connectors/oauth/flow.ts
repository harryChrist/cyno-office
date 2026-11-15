import { createHash, randomBytes } from "node:crypto";
import { OAUTH_CLIENT_NAME } from "@cyno/shared";
import { ConnectorError } from "../mcp-client";
import { limitedFetch, parseJsonObject } from "./safe-fetch";
import { TOKEN_AUTH_METHODS, type StoredAuthServer, type StoredOAuth, type StoredOAuthClient, type TokenAuthMethod } from "./stored";

/** Passos do authorization code com PKCE (RFC 7636, método S256), cadastro (RFC 7591) e token (RFC 6749). */

export type FlowDeps = { fetch?: typeof fetch; now: () => Date };

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** O desafio S256 do verificador. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48); // 64 caracteres (43 a 128 pela RFC 7636)
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** URL da tela de login. Google: `access_type=offline` e `prompt=consent` (sem isso não vem token de renovação). */
export function buildAuthorizationUrl(oauth: StoredOAuth, input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(oauth.authServer.authorizationEndpoint);
  const set = (key: string, value: string) => url.searchParams.set(key, value);
  set("response_type", "code");
  set("client_id", input.clientId);
  set("redirect_uri", input.redirectUri);
  set("state", input.state);
  set("code_challenge", input.challenge);
  set("code_challenge_method", "S256");
  if (oauth.scopes.length > 0) set("scope", oauth.scopes.join(" "));
  if (oauth.usesResource) set("resource", oauth.resource);
  if (oauth.provider === "google") {
    set("access_type", "offline");
    set("prompt", "consent");
  }
  return url.toString();
}

/** Prefere cliente público (sem segredo); com segredo, o corpo do formulário (que todos aceitam). */
function pickAuthMethod(server: StoredAuthServer, hasSecret: boolean): TokenAuthMethod {
  const supported = server.tokenAuthMethods.length > 0 ? server.tokenAuthMethods : ["client_secret_basic"];
  if (!hasSecret) return "none";
  if (supported.includes("client_secret_post") || supported.length === 0) return "client_secret_post";
  if (supported.includes("client_secret_basic")) return "client_secret_basic";
  return "client_secret_post";
}

/** Cliente digitado pelo dono (ex.: o do Google Cloud). */
export function manualClient(server: StoredAuthServer, clientId: string, clientSecret: string | undefined, redirectUris: string[]): StoredOAuthClient {
  return { source: "manual", clientId, ...(clientSecret ? { clientSecret } : {}), authMethod: pickAuthMethod(server, Boolean(clientSecret)), redirectUris };
}

function oauthErrorText(body: Record<string, unknown> | undefined, status: number): string {
  const code = typeof body?.error === "string" ? body.error : undefined;
  const description = typeof body?.error_description === "string" ? body.error_description : undefined;
  return [code, description].filter(Boolean).join(": ").slice(0, 240) || `HTTP ${status}`;
}

/** Cadastro dinâmico de cliente (RFC 7591): sem o dono preencher nada. */
export async function registerClient(server: StoredAuthServer, input: { redirectUri: string; scopes: string[]; knownRedirectUris?: string[] }, deps: FlowDeps): Promise<StoredOAuthClient> {
  if (!server.registrationEndpoint) throw new ConnectorError("o servidor de autorização não aceita cadastro dinâmico");
  const supported = server.tokenAuthMethods;
  const authMethod: TokenAuthMethod = supported.length === 0 || supported.includes("none") ? "none" : supported.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
  const redirectUris = [...new Set([...(input.knownRedirectUris ?? []), input.redirectUri])];
  const response = await limitedFetch(server.registrationEndpoint, {
    fetch: deps.fetch,
    method: "POST",
    maxRedirects: 0,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: OAUTH_CLIENT_NAME,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
    }),
  });
  const body = parseJsonObject(response.text);
  if (response.status !== 200 && response.status !== 201) throw new ConnectorError(`o cadastro do cliente foi recusado (${oauthErrorText(body, response.status)})`);
  const clientId = typeof body?.client_id === "string" ? body.client_id : undefined;
  if (!clientId) throw new ConnectorError("o servidor de autorização não devolveu o client_id no cadastro");
  const clientSecret = typeof body?.client_secret === "string" && body.client_secret ? body.client_secret : undefined;
  const granted = typeof body?.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : authMethod;
  const known = (TOKEN_AUTH_METHODS as readonly string[]).includes(granted) ? (granted as TokenAuthMethod) : authMethod;
  return { source: "dynamic", clientId, ...(clientSecret ? { clientSecret } : {}), authMethod: clientSecret && known === "none" ? "client_secret_post" : known, redirectUris };
}

export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string };

/** Falha do endpoint do token. `permanent`: o código/token não vale mais (pedir login de novo); senão, tentar depois. */
export class TokenRequestError extends ConnectorError {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

async function tokenRequest(oauth: StoredOAuth, params: Record<string, string>, deps: FlowDeps): Promise<TokenSet> {
  const client = oauth.client;
  if (!client) throw new TokenRequestError("o conector não tem cliente OAuth", true);
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  form.set("client_id", client.clientId);
  if (client.clientSecret && client.authMethod === "client_secret_post") form.set("client_secret", client.clientSecret);
  if (client.clientSecret && client.authMethod === "client_secret_basic") headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  if (oauth.usesResource) form.set("resource", oauth.resource);
  let response;
  try {
    response = await limitedFetch(oauth.authServer.tokenEndpoint, { fetch: deps.fetch, method: "POST", maxRedirects: 0, headers, body: form.toString(), timeoutMs: 15_000 });
  } catch (error) {
    throw new TokenRequestError(error instanceof Error ? error.message : String(error), false);
  }
  const body = parseJsonObject(response.text);
  if (response.status < 200 || response.status >= 300) {
    const code = typeof body?.error === "string" ? body.error : "";
    // 5xx e 429 passam; 400/401 com invalid_grant (ou qualquer 4xx) é o fim da autorização.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429 && code !== "temporarily_unavailable";
    throw new TokenRequestError(`o servidor de autorização recusou o pedido (${oauthErrorText(body, response.status)})`, permanent);
  }
  const accessToken = typeof body?.access_token === "string" ? body.access_token : undefined;
  if (!accessToken) throw new TokenRequestError("o servidor de autorização não devolveu o token de acesso", false);
  const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : typeof body?.expires_in === "string" ? Number(body.expires_in) : undefined;
  return {
    accessToken,
    ...(typeof body?.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(expiresIn && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: new Date(deps.now().getTime() + expiresIn * 1000).toISOString() } : {}),
    ...(typeof body?.scope === "string" && body.scope ? { scope: body.scope } : {}),
  };
}

/** Troca o código do login pelos tokens (com o verificador PKCE). */
export function exchangeCode(oauth: StoredOAuth, input: { code: string; verifier: string; redirectUri: string }, deps: FlowDeps): Promise<TokenSet> {
  return tokenRequest(oauth, { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri }, deps);
}

/** Renova com o token de renovação (o servidor pode não mandar um novo: quem chama mantém o antigo). */
export function refreshTokens(oauth: StoredOAuth, refreshToken: string, deps: FlowDeps): Promise<TokenSet> {
  return tokenRequest(oauth, { grant_type: "refresh_token", refresh_token: refreshToken }, deps);
}
