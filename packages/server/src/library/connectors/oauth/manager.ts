import {
  defaultOAuthScopes,
  effectiveRedirectMode,
  isGoogleIssuer,
  isFullAccessScope,
  oauthRedirectFor,
  parsePastedCallbackUrl,
  redirectOriginIssue,
  sameIssuer,
  type ConnectorAuthInput,
  type OAuthDiscoveryResult,
  type OAuthStartResponse,
} from "@cyno/shared";
import { HttpError } from "../../../platform/http/errors";
import { ConnectorAuthError, ConnectorError } from "../mcp-client";
import type { StoredConnector } from "../store";
import { discoverGmailApi, discoverOAuth, gmailApiFrom, type Discovered, type DiscoverDeps } from "./discovery";
import { buildAuthorizationUrl, exchangeCode, manualClient, newPkce, randomToken, refreshTokens, registerClient, TokenRequestError, type FlowDeps } from "./flow";
import { limitedFetch } from "./safe-fetch";
import { discoverySummary, type StoredOAuth } from "./stored";

/** A autorização venceu, foi revogada ou nunca foi dada: o dono precisa entrar de novo. */
export class OAuthReloginError extends ConnectorAuthError {
  constructor(message = "Precisa entrar de novo com a conta (a autorização venceu ou foi revogada)") {
    super(message);
    this.name = "OAuthReloginError";
  }
}

/** O retorno do login deu errado; `message` já é legível para o dono (pt-BR). */
export class OAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

/** O que o manager precisa do cadastro de conectores (o `ConnectorRegistry` implementa). */
export interface OAuthStore {
  record(id: string): StoredConnector | undefined;
  /** Troca o OAuth guardado (undefined = tira). Avisa a tela só se algo visível mudou. */
  setOAuth(id: string, oauth: StoredOAuth | undefined): Promise<StoredConnector | undefined>;
}

export type OAuthManagerDeps = {
  store: OAuthStore;
  fetch?: typeof fetch;
  now: () => Date;
  /** Entrou com a conta: o gateway recomeça o cliente e testa de novo. */
  onConnected?: (connectorId: string) => void;
  log: { warn: (object: object, message: string) => void };
};

type Pending = { connectorId: string; verifier: string; redirectUri: string; createdAt: number };

/** Avisa antes de vencer: renova quando faltar menos que isto. */
export const REFRESH_MARGIN_MS = 60_000;
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 30;

/**
 * O login OAuth dos conectores: descoberta, cliente, `state` de uso único, troca do código e tokens
 * com renovação (uma por vez por conector). Tokens ficam no registro do conector (connectors.json,
 * 0600) e nunca saem do servidor.
 */
export class OAuthManager {
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly deps: OAuthManagerDeps) {}

  private get flow(): FlowDeps {
    return { fetch: this.deps.fetch, now: this.deps.now };
  }

  private get discoverDeps(): DiscoverDeps {
    return { fetch: this.deps.fetch };
  }

  /** Só descobre (nada é guardado): a tela mostra escopos e se o cadastro é automático. */
  async discover(url: string): Promise<OAuthDiscoveryResult> {
    try {
      const found = await discoverOAuth(url, this.discoverDeps);
      const stored = this.fromDiscovered(found, []);
      return { found: true, ...discoverySummary(stored, defaultOAuthScopes(found.scopesSupported)) };
    } catch (error) {
      return { found: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Só descobre o login do Gmail pela API (metadado do próprio Google; nada é guardado). */
  async discoverGmailApi(): Promise<OAuthDiscoveryResult> {
    try {
      const found = await discoverGmailApi(this.discoverDeps);
      return { found: true, ...discoverySummary(this.fromDiscovered(found, []), defaultOAuthScopes(found.scopesSupported)) };
    } catch (error) {
      return { found: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private fromDiscovered(found: Discovered, scopes: string[]): StoredOAuth {
    return {
      resource: found.resource,
      provider: found.provider,
      usesResource: found.usesResource,
      authServer: found.authServer,
      scopesSupported: found.scopesSupported,
      scopes,
      connection: "not_connected",
      discoveredAt: this.deps.now().toISOString(),
    };
  }

  /**
   * Descobre e monta o OAuth de um conector (criar, trocar a URL, "Verificar" ou ajustar escopos e
   * cliente). Mantém escopos, cliente e tokens do `existing` quando o servidor de autorização e o
   * recurso são os mesmos. Lança `HttpError 400` se o servidor não anuncia OAuth.
   */
  async build(url: string, input: Extract<ConnectorAuthInput, { mode: "oauth" }>, existing?: StoredOAuth): Promise<StoredOAuth> {
    let found;
    try {
      found = await discoverOAuth(url, this.discoverDeps);
    } catch (error) {
      throw new HttpError(400, `Não deu para configurar o login OAuth: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return this.buildFrom(found, input, existing);
  }

  /** O OAuth de um conector "gmail-api" novo: o metadado vem do próprio Google, sem descoberta MCP. */
  async buildGmailApi(input: Extract<ConnectorAuthInput, { mode: "oauth" }>, existing?: StoredOAuth): Promise<StoredOAuth> {
    let found;
    try {
      found = existing && isGoogleIssuer(existing.authServer.issuer) ? gmailApiFrom(existing.authServer) : await discoverGmailApi(this.discoverDeps);
    } catch (error) {
      throw new HttpError(400, `Não deu para configurar o login do Gmail: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return this.buildFrom(found, input, existing);
  }

  /**
   * Troca de modo (API do Gmail <-> servidor MCP oficial) sem perder o login: cliente, segredo, escopos e
   * tokens ficam; só mudam o endereço do recurso e a lista de permissões que o servidor anuncia.
   * `found` ausente (sem rede, servidor MCP fora do ar) = a lista antiga fica.
   */
  rebase(existing: StoredOAuth, found?: Discovered): StoredOAuth {
    if (!found || !sameIssuer(found.authServer.issuer, existing.authServer.issuer)) return existing;
    return { ...existing, resource: found.resource, usesResource: found.usesResource, scopesSupported: found.scopesSupported };
  }

  /** Descobre o OAuth do servidor MCP (para `rebase`); undefined se não deu. */
  async tryDiscover(url: string): Promise<Discovered | undefined> {
    return discoverOAuth(url, this.discoverDeps).catch(() => undefined);
  }

  /** O OAuth do modo API a partir do que o conector já guarda (sem rede). */
  gmailApiFor(existing: StoredOAuth): Discovered | undefined {
    return isGoogleIssuer(existing.authServer.issuer) ? gmailApiFrom(existing.authServer) : undefined;
  }

  private buildFrom(found: Discovered, input: Extract<ConnectorAuthInput, { mode: "oauth" }>, existing?: StoredOAuth): StoredOAuth {
    const next = this.fromDiscovered(found, []);
    const same = Boolean(existing && sameIssuer(existing.authServer.issuer, next.authServer.issuer) && existing.resource === next.resource);
    const keep = same ? existing : undefined;
    const requested = input.scopes ?? keep?.scopes;
    const redirect = input.redirect ?? keep?.redirect;
    if (redirect) next.redirect = redirect;
    next.scopes = (requested ?? defaultOAuthScopes(found.scopesSupported)).filter((scope, index, all) => all.indexOf(scope) === index);
    // Escopo de acesso total só vai se o dono marcou de propósito (a tela avisa); nunca por padrão.
    if (!requested) next.scopes = next.scopes.filter((scope) => !isFullAccessScope(scope));

    let client = keep?.client;
    if (input.clientId !== undefined && input.clientId !== client?.clientId) {
      client = manualClient(next.authServer, input.clientId, input.clientSecret ?? undefined, []);
    } else if (client?.source === "manual" && input.clientSecret !== undefined) {
      const secret = input.clientSecret ?? undefined;
      client = manualClient(next.authServer, client.clientId, secret, client.redirectUris);
    }
    if (client) next.client = client;

    const sameClient = Boolean(keep?.client && client && keep.client.clientId === client.clientId);
    if (keep?.tokens && sameClient) {
      next.tokens = keep.tokens;
      next.connection = keep.connection;
      if (keep.connectedAt) next.connectedAt = keep.connectedAt;
      if (keep.reason) next.reason = keep.reason;
      const scopesChanged = [...keep.scopes].sort().join(" ") !== [...next.scopes].sort().join(" ");
      if (scopesChanged && next.connection === "connected") {
        next.connection = "needs_login";
        next.reason = "Os escopos mudaram: entre de novo para valerem.";
      }
    } else if (keep?.connection === "needs_login" && sameClient) {
      next.connection = "needs_login";
      if (keep.reason) next.reason = keep.reason;
    }
    return next;
  }

  /** Começa o login: cliente (cadastro dinâmico se preciso), `state` e URL de autorização. */
  async start(connectorId: string, origin: string): Promise<OAuthStartResponse> {
    const record = this.deps.store.record(connectorId);
    const oauth = record?.oauth;
    if (!record || !oauth) throw new HttpError(400, "Este conector não usa login OAuth.");
    if (!record.enabled) throw new HttpError(409, "O conector está desligado: ligue antes de entrar.");
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new HttpError(400, "Origem inválida.");
    }
    const mode = effectiveRedirectMode(oauth.redirect, oauth.authServer.registrationEndpoint ? "dynamic" : "manual");
    if (oauth.provider === "google" && mode === "app") {
      const issue = redirectOriginIssue(originUrl.origin);
      if (issue) throw new HttpError(400, issue);
    }
    const redirectUri = oauthRedirectFor(mode, originUrl.origin);
    let client = oauth.client;
    if (!client) {
      if (!oauth.authServer.registrationEndpoint) throw new HttpError(400, "Este servidor de autorização não faz cadastro automático: informe o ID do cliente e o segredo (da credencial OAuth que você criou) e salve.");
      client = await this.register(connectorId, oauth, redirectUri);
    } else if (client.source === "dynamic" && !client.redirectUris.includes(redirectUri)) {
      client = await this.register(connectorId, oauth, redirectUri, client.redirectUris);
    }
    const current = this.deps.store.record(connectorId)?.oauth ?? oauth;
    this.purge();
    const { verifier, challenge } = newPkce();
    const state = randomToken(24);
    this.pending.set(state, { connectorId, verifier, redirectUri, createdAt: this.deps.now().getTime() });
    return { authorizationUrl: buildAuthorizationUrl({ ...current, client }, { clientId: client.clientId, redirectUri, state, challenge }), redirectUri };
  }

  private async register(connectorId: string, oauth: StoredOAuth, redirectUri: string, known: string[] = []): Promise<NonNullable<StoredOAuth["client"]>> {
    let client;
    try {
      client = await registerClient(oauth.authServer, { redirectUri, scopes: oauth.scopes, knownRedirectUris: known }, this.flow);
    } catch (error) {
      throw new HttpError(502, `Não deu para cadastrar o Cyno Office no servidor de autorização: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const base = this.deps.store.record(connectorId)?.oauth ?? oauth;
    // Cliente novo: os tokens do antigo não servem para renovar com ele.
    await this.deps.store.setOAuth(connectorId, { ...base, client, tokens: undefined, connection: base.connection === "connected" ? "needs_login" : base.connection });
    return client;
  }

  /**
   * Termina o login com o endereço que o dono colou (o navegador tentou abrir um `localhost` que não é
   * este servidor). Só vale para o `state` deste conector. Nunca loga a URL nem o código.
   */
  async finish(connectorId: string, callbackUrl: string): Promise<{ connectorId: string; name: string }> {
    const query = parsePastedCallbackUrl(callbackUrl);
    if (!query) throw new OAuthCallbackError("Isto não parece o endereço de retorno. Cole o endereço inteiro da barra do navegador, aquele que começa com http://localhost e termina com code=… e state=….");
    if (!query.state) throw new OAuthCallbackError("O endereço colado não tem o state do login. Cole o endereço inteiro da barra do navegador.");
    const found = this.pending.get(query.state);
    if (found && found.connectorId !== connectorId) throw new OAuthCallbackError("Este endereço é do login de outro conector. Cole o endereço do login que você acabou de fazer aqui.");
    return this.complete(query);
  }

  /** O retorno do login (`/api/library/oauth/callback`). Lança `OAuthCallbackError` com texto legível. */
  async complete(query: { state?: string; code?: string; error?: string; errorDescription?: string; iss?: string }): Promise<{ connectorId: string; name: string }> {
    this.purge();
    const found = query.state ? this.pending.get(query.state) : undefined;
    if (query.state) this.pending.delete(query.state); // uso único, dê certo ou não
    if (!found) throw new OAuthCallbackError("Este login expirou ou já foi usado. Volte ao Cyno Office e clique em Entrar de novo.");
    const record = this.deps.store.record(found.connectorId);
    const oauth = record?.oauth;
    if (!record || !oauth?.client) throw new OAuthCallbackError("O conector mudou ou foi removido durante o login. Volte ao Cyno Office e tente de novo.");
    if (query.error) {
      throw new OAuthCallbackError(query.error === "access_denied" ? "O acesso foi recusado na tela de login." : `O serviço recusou o login (${query.error}${query.errorDescription ? `: ${query.errorDescription.slice(0, 200)}` : ""}).`);
    }
    if (query.iss && !sameIssuer(query.iss, oauth.authServer.issuer)) throw new OAuthCallbackError("A resposta veio de um servidor de autorização diferente do esperado. Por segurança, o login foi descartado.");
    if (!query.code) throw new OAuthCallbackError("O serviço não devolveu o código de autorização.");
    let tokens;
    try {
      tokens = await exchangeCode(oauth, { code: query.code, verifier: found.verifier, redirectUri: found.redirectUri }, this.flow);
    } catch (error) {
      throw new OAuthCallbackError(`Não deu para trocar o código pelo acesso: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const now = this.deps.now().toISOString();
    const reason = tokens.refreshToken ? undefined : "O serviço não mandou token de renovação: será preciso entrar de novo quando o acesso vencer.";
    await this.deps.store.setOAuth(found.connectorId, { ...oauth, tokens, connection: "connected", connectedAt: now, reason });
    this.deps.onConnected?.(found.connectorId);
    return { connectorId: found.connectorId, name: record.name };
  }

  /** Token de acesso válido (renova se faltar menos de 1 min), ou undefined se não entrou. */
  async accessToken(connectorId: string): Promise<string | undefined> {
    const oauth = this.deps.store.record(connectorId)?.oauth;
    if (!oauth?.tokens || oauth.connection !== "connected") return undefined;
    const expiresAt = oauth.tokens.expiresAt ? Date.parse(oauth.tokens.expiresAt) : undefined;
    if (expiresAt !== undefined && expiresAt - REFRESH_MARGIN_MS <= this.deps.now().getTime()) return this.refresh(connectorId);
    return oauth.tokens.accessToken;
  }

  /**
   * O servidor MCP respondeu 401 com `usedToken`: renova (uma vez por conector, mesmo que várias
   * chamadas levem 401 juntas) e devolve true; sem como renovar, lança `OAuthReloginError`.
   */
  async refreshAfterRejection(connectorId: string, usedToken?: string, rejectedAfterRefresh = false): Promise<boolean> {
    if (rejectedAfterRefresh) {
      await this.markNeedsLogin(connectorId, "O servidor recusou o acesso mesmo com o token renovado.");
      throw new OAuthReloginError();
    }
    const oauth = this.deps.store.record(connectorId)?.oauth;
    if (!oauth?.tokens || oauth.connection !== "connected") throw new OAuthReloginError(oauth?.connection === "needs_login" ? undefined : "Ainda não entrou com a conta");
    if (usedToken && oauth.tokens.accessToken !== usedToken) return true; // outra chamada já renovou
    await this.refresh(connectorId);
    return true;
  }

  /** Renova agora; chamadas juntas dividem a mesma renovação. */
  refresh(connectorId: string): Promise<string> {
    const running = this.refreshing.get(connectorId);
    if (running) return running;
    const run = this.doRefresh(connectorId).finally(() => this.refreshing.delete(connectorId));
    this.refreshing.set(connectorId, run);
    return run;
  }

  private async doRefresh(connectorId: string): Promise<string> {
    const oauth = this.deps.store.record(connectorId)?.oauth;
    const refreshToken = oauth?.tokens?.refreshToken;
    if (!oauth || !oauth.tokens) throw new OAuthReloginError();
    if (!refreshToken) {
      await this.markNeedsLogin(connectorId, "O acesso venceu e o serviço não deu token de renovação.");
      throw new OAuthReloginError();
    }
    let fresh;
    try {
      fresh = await refreshTokens(oauth, refreshToken, this.flow);
    } catch (error) {
      if (error instanceof TokenRequestError && error.permanent) {
        await this.markNeedsLogin(connectorId, "O serviço recusou renovar o acesso (venceu ou foi revogado).");
        throw new OAuthReloginError();
      }
      this.deps.log.warn({ connectorId }, "renovação do token do conector falhou (tentará de novo)");
      throw new ConnectorError(`não deu para renovar o acesso agora: ${error instanceof Error ? error.message : String(error)}`);
    }
    const current = this.deps.store.record(connectorId)?.oauth ?? oauth;
    const tokens = { ...fresh, refreshToken: fresh.refreshToken ?? refreshToken, ...(fresh.scope ? {} : oauth.tokens.scope ? { scope: oauth.tokens.scope } : {}) };
    await this.deps.store.setOAuth(connectorId, { ...current, tokens, connection: "connected", reason: undefined });
    return tokens.accessToken;
  }

  /** O login acabou de vez: tira os tokens e deixa o conector em "precisa entrar de novo". */
  async markNeedsLogin(connectorId: string, reason: string): Promise<void> {
    const oauth = this.deps.store.record(connectorId)?.oauth;
    if (!oauth) return;
    await this.deps.store.setOAuth(connectorId, { ...oauth, tokens: undefined, connection: "needs_login", reason });
  }

  /** Desconecta: revoga no serviço (se ele permite; falha não impede) e apaga os tokens. */
  async disconnect(connectorId: string): Promise<void> {
    const oauth = this.deps.store.record(connectorId)?.oauth;
    if (!oauth) throw new HttpError(400, "Este conector não usa login OAuth.");
    const token = oauth.tokens?.refreshToken ?? oauth.tokens?.accessToken;
    if (token && oauth.authServer.revocationEndpoint && oauth.client) {
      const body = new URLSearchParams({ token, client_id: oauth.client.clientId });
      await limitedFetch(oauth.authServer.revocationEndpoint, { fetch: this.deps.fetch, method: "POST", maxRedirects: 0, timeoutMs: 8000, headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }).catch(() => undefined);
    }
    await this.deps.store.setOAuth(connectorId, { ...oauth, tokens: undefined, connection: "not_connected", connectedAt: undefined, reason: undefined });
  }

  private purge(): void {
    const now = this.deps.now().getTime();
    for (const [state, entry] of this.pending) if (now - entry.createdAt > STATE_TTL_MS) this.pending.delete(state);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}
