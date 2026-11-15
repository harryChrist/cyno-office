import {
  defaultOAuthScopes,
  OAUTH_REDIRECT_MODES,
  OAUTH_CONNECTIONS,
  type ConnectorOAuthPublic,
  type OAuthClientSource,
  type OAuthDiscoverySummary,
  type OAuthProvider,
} from "@cyno/shared";
import { z } from "zod";

/** Método de autenticação do cliente no endpoint do token. */
export const TOKEN_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type TokenAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];

/** O que a descoberta guarda do servidor de autorização (RFC 8414 / OIDC). */
export const storedAuthServerSchema = z.object({
  issuer: z.string().max(2000),
  authorizationEndpoint: z.string().max(2000),
  tokenEndpoint: z.string().max(2000),
  registrationEndpoint: z.string().max(2000).optional(),
  revocationEndpoint: z.string().max(2000).optional(),
  tokenAuthMethods: z.array(z.string().max(60)).max(20).default([]),
  /** De onde veio o metadado (para o diagnóstico). */
  metadataUrl: z.string().max(2000).optional(),
});

export const storedClientSchema = z.object({
  source: z.enum(["dynamic", "manual"]),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(2000).optional(),
  authMethod: z.enum(TOKEN_AUTH_METHODS),
  /** Endereços de retorno cadastrados (cadastro dinâmico: um por origem usada). */
  redirectUris: z.array(z.string().max(500)).max(20).default([]),
});

export const storedTokensSchema = z.object({
  accessToken: z.string().min(1).max(20_000),
  refreshToken: z.string().max(20_000).optional(),
  /** ISO 8601; ausente = o servidor não disse (vale até um 401). */
  expiresAt: z.string().optional(),
  scope: z.string().max(4000).optional(),
});

export const storedOAuthSchema = z.object({
  resource: z.string().max(2000),
  provider: z.enum(["google", "generic"]),
  usesResource: z.boolean(),
  authServer: storedAuthServerSchema,
  scopesSupported: z.array(z.string().max(300)).max(200).default([]),
  scopes: z.array(z.string().max(300)).max(200).default([]),
  client: storedClientSchema.optional(),
  tokens: storedTokensSchema.optional(),
  connection: z.enum(OAUTH_CONNECTIONS),
  /** Modo do endereço de retorno; ausente = o padrão do tipo de cliente. */
  redirect: z.enum(OAUTH_REDIRECT_MODES).optional(),
  reason: z.string().max(300).optional(),
  discoveredAt: z.string(),
  connectedAt: z.string().optional(),
});
export type StoredOAuth = z.infer<typeof storedOAuthSchema>;
export type StoredOAuthClient = z.infer<typeof storedClientSchema>;
export type StoredAuthServer = z.infer<typeof storedAuthServerSchema>;

/** Tokens e segredo do cliente (para apagar de mensagens de erro e do log). */
export function oauthSecretValues(oauth: StoredOAuth): string[] {
  return [oauth.tokens?.accessToken, oauth.tokens?.refreshToken, oauth.client?.clientSecret].filter((value): value is string => Boolean(value && value.length >= 4));
}

/** Resumo da descoberta (o que a tela mostra antes e depois de salvar). */
export function discoverySummary(oauth: StoredOAuth, defaultScopes: string[]): OAuthDiscoverySummary {
  return {
    resource: oauth.resource,
    issuer: oauth.authServer.issuer,
    provider: oauth.provider as OAuthProvider,
    scopesSupported: [...oauth.scopesSupported],
    defaultScopes,
    registration: oauth.authServer.registrationEndpoint ? "dynamic" : "manual",
    usesResource: oauth.usesResource,
  };
}

/** Visão da API: sem tokens, sem segredo do cliente (só se existe). */
export function publicOAuth(oauth: StoredOAuth): ConnectorOAuthPublic {
  return {
    resource: oauth.resource,
    issuer: oauth.authServer.issuer,
    provider: oauth.provider,
    scopesSupported: [...oauth.scopesSupported],
    defaultScopes: defaultOAuthScopes(oauth.scopesSupported),
    registration: oauth.authServer.registrationEndpoint ? "dynamic" : "manual",
    usesResource: oauth.usesResource,
    connection: oauth.connection,
    ...(oauth.redirect ? { redirect: oauth.redirect } : {}),
    scopes: [...oauth.scopes],
    ...(oauth.client ? { clientSource: oauth.client.source as OAuthClientSource, clientId: oauth.client.clientId } : {}),
    clientSecretSet: Boolean(oauth.client?.clientSecret),
    discoveredAt: oauth.discoveredAt,
    ...(oauth.connectedAt ? { connectedAt: oauth.connectedAt } : {}),
    ...(oauth.reason ? { reason: oauth.reason } : {}),
  };
}
