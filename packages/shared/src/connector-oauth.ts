import { z } from "zod";

/**
 * Login OAuth dos conectores HTTP (especificação de autorização do MCP, versão 2025-06-18):
 * descoberta (RFC 9728 e RFC 8414/OIDC), cadastro dinâmico (RFC 7591), authorization code com PKCE
 * S256 e o parâmetro `resource` (RFC 8707). O servidor do Cyno faz tudo e guarda os tokens (nunca
 * vão ao navegador nem aos agentes); o navegador só abre a tela de login do serviço.
 *
 * Aqui ficam os tipos que a API mostra e as regras puras que o servidor e a tela dividem
 * (escopos padrão, risco de um escopo, endereço de retorno aceito).
 */

/** Caminho (dentro do app) do endereço de retorno: o mesmo para todos os conectores. */
export const OAUTH_CALLBACK_PATH = "/api/library/oauth/callback";

/** Porta web padrão do app: vira o endereço de retorno `localhost` fixo quando o navegador não está na máquina do servidor. */
export const OAUTH_LOCAL_REDIRECT_ORIGIN = "http://localhost:3067";

/** Endereço de retorno `localhost` fixo (o que se cadastra no Google quando o app não é aberto por localhost). */
export const OAUTH_LOCAL_REDIRECT_URI = `${OAUTH_LOCAL_REDIRECT_ORIGIN}${OAUTH_CALLBACK_PATH}`;

/**
 * Modo do endereço de retorno: `app` = a origem pela qual o app foi aberto (um clique, mas preso ao
 * domínio); `local` = `localhost` (não depende do domínio; fora da máquina do servidor o dono cola o
 * endereço de volta no Cyno para terminar).
 */
export const OAUTH_REDIRECT_MODES = ["app", "local"] as const;
export type OAuthRedirectMode = (typeof OAUTH_REDIRECT_MODES)[number];

/** As duas permissões que o Cyno oferece para o Gmail pela API pública (o servidor MCP oficial lista 20). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_API_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE] as const;
/** Endereço do recurso guardado num conector "gmail-api" (não vai no login: o Google não leva `resource`). */
export const GMAIL_API_RESOURCE = "https://gmail.googleapis.com";

/** Emissor do Google (o login do Gmail pela API pega o metadado dele, sem descoberta MCP). */
export const GOOGLE_ISSUER = "https://accounts.google.com";

/** Nome com que o Cyno se cadastra nos servidores de autorização. */
export const OAUTH_CLIENT_NAME = "Cyno Office";

/** Situação do login: nunca entrou, entrou, ou a autorização acabou (precisa entrar de novo). */
export const OAUTH_CONNECTIONS = ["not_connected", "connected", "needs_login"] as const;
export type OAuthConnection = (typeof OAUTH_CONNECTIONS)[number];

/** `google`: o servidor de autorização é o do Google (pede `access_type=offline` e não leva `resource`). */
export type OAuthProvider = "google" | "generic";

/** Como o cliente OAuth existe: cadastrado sozinho (RFC 7591) ou digitado pelo dono. */
export type OAuthClientSource = "dynamic" | "manual";

/** O que a descoberta achou (sem segredos), antes ou depois de salvar o conector. */
export type OAuthDiscoverySummary = {
  /** Endereço do recurso (RFC 8707) que vai no `resource`, quando o servidor aceita. */
  resource: string;
  issuer: string;
  provider: OAuthProvider;
  scopesSupported: string[];
  /** Escopos marcados por padrão (o dono ajusta). */
  defaultScopes: string[];
  /** O servidor de autorização aceita cadastro dinâmico? Sim = o dono não preenche nada. */
  registration: "dynamic" | "manual";
  /** O `resource` é enviado no login? (não vai para o Google: não é servidor de autorização do padrão MCP) */
  usesResource: boolean;
};

export type OAuthDiscoveryResult = ({ found: true } & OAuthDiscoverySummary) | { found: false; reason: string };

/** O OAuth de um conector como a API mostra: nada de token, segredo nem código. */
export type ConnectorOAuthPublic = OAuthDiscoverySummary & {
  connection: OAuthConnection;
  /** Modo do endereço de retorno guardado (ausente = o padrão do tipo de cliente; veja `effectiveRedirectMode`). */
  redirect?: OAuthRedirectMode;
  /** Escopos escolhidos. */
  scopes: string[];
  clientSource?: OAuthClientSource;
  /** O ID do cliente não é segredo (aparece na URL de login). */
  clientId?: string;
  clientSecretSet: boolean;
  discoveredAt: string;
  connectedAt?: string;
  /** Por que precisa entrar de novo (sem segredos). */
  reason?: string;
};

// ---------- Corpos da API ----------

const scopeSchema = z.string().min(1).max(300).refine((value) => !/\s/.test(value), "escopo inválido");

/** `auth` no POST/PATCH da Biblioteca: token fixo (o de sempre) ou login OAuth. */
export const connectorAuthInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("static") }),
  z.object({
    mode: z.literal("oauth"),
    scopes: z.array(scopeSchema).max(100).optional(),
    clientId: z.string().trim().min(1).max(500).optional(),
    /** Endereço de retorno: ausente = fica (ou o padrão do tipo de cliente). */
    redirect: z.enum(OAUTH_REDIRECT_MODES).optional(),
    /** String = define; null = apaga; ausente = fica. */
    clientSecret: z.string().min(1).max(2000).nullable().optional(),
  }),
]);
export type ConnectorAuthInput = z.input<typeof connectorAuthInputSchema>;

/**
 * POST /api/library/connectors/oauth/discover: só descobre, nada é guardado. `url` (formulário de
 * conector novo) ou `connectorId` (conector que já existe: a URL guardada, que a tela não conhece inteira).
 */
export const oauthDiscoverBodySchema = z
  .object({ url: z.url({ protocol: /^https?$/ }).max(2000).optional(), connectorId: z.string().max(64).optional(), builtin: z.literal("gmail-api").optional() })
  .refine((body) => [body.url, body.connectorId, body.builtin].filter(Boolean).length === 1, "informe a url, o connectorId ou o builtin");
export type OAuthDiscoverBody = z.input<typeof oauthDiscoverBodySchema>;

/** POST /api/library/connectors/:id/oauth/start: a origem pela qual o dono acessa o app agora. */
export const oauthStartBodySchema = z.object({ origin: z.url({ protocol: /^https?$/ }).max(300) });
export type OAuthStartBody = z.input<typeof oauthStartBodySchema>;

/** POST /api/library/connectors/:id/oauth/finish: o endereço inteiro que o navegador tentou abrir depois do login (colado pelo dono). */
export const oauthFinishBodySchema = z.object({ callbackUrl: z.string().max(4000) });
export type OAuthFinishBody = z.input<typeof oauthFinishBodySchema>;

export type OAuthStartResponse = {
  /** Para onde o navegador vai (tela de login do serviço). */
  authorizationUrl: string;
  /** O endereço de retorno usado (o que o Google precisa ter cadastrado). */
  redirectUri: string;
};

// ---------- Regras puras ----------

/** O servidor de autorização é o do Google? */
export function isGoogleIssuer(issuer: string): boolean {
  return /^https:\/\/accounts\.google\.com(?::443)?(?:[/?#]|$)/i.test(issuer);
}

/** Protocolo, host e porta de uma origem (`https://app.exemplo:8443`), sem caminho; undefined se não for uma origem http(s). */
function parseOrigin(origin: string): { protocol: "http" | "https"; host: string; port: string } | undefined {
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/:?#@\s]+)(?::(\d{1,5}))?\/?$/i.exec(origin.trim());
  return match ? { protocol: match[1]!.toLowerCase() as "http" | "https", host: match[2]!.toLowerCase(), port: match[3] ?? "" } : undefined;
}

/** `https://x.com/`, `https://x.com` e afins: compara emissores sem a barra final. */
export function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Endereço de retorno para uma origem (`https://app.exemplo`): origem + caminho fixo. */
export function oauthRedirectUri(origin: string): string {
  const parsed = parseOrigin(origin);
  if (!parsed) throw new Error("origem inválida");
  return `${parsed.protocol}://${parsed.host}${parsed.port ? `:${parsed.port}` : ""}${OAUTH_CALLBACK_PATH}`;
}

const isLocalHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

/** A origem é da própria máquina (localhost, 127.0.0.1 ou [::1])? */
export function isLocalOrigin(origin: string): boolean {
  const parsed = parseOrigin(origin);
  return Boolean(parsed && isLocalHost(parsed.host));
}

/** Modo efetivo: o guardado; sem ele, `local` para cliente digitado (sem cadastro automático) e `app` para cadastro dinâmico. */
export function effectiveRedirectMode(stored: OAuthRedirectMode | undefined, registration: "dynamic" | "manual"): OAuthRedirectMode {
  return stored ?? (registration === "manual" ? "local" : "app");
}

/**
 * Endereço de retorno de um modo, dada a origem atual do app. `app`: a origem atual. `local`: a origem
 * atual se já é localhost (retorno direto); senão o endereço fixo `OAUTH_LOCAL_REDIRECT_URI`.
 */
export function oauthRedirectFor(mode: OAuthRedirectMode, origin: string): string {
  if (mode === "local" && !isLocalOrigin(origin)) return OAUTH_LOCAL_REDIRECT_URI;
  return oauthRedirectUri(origin);
}

/** O dono precisa colar o endereço de volta? Só no modo `local` com o app aberto fora de localhost (o navegador abriria um localhost que não é o servidor). */
export function needsPasteBack(mode: OAuthRedirectMode, origin: string): boolean {
  return mode === "local" && !isLocalOrigin(origin);
}

/** Retorno colado pelo dono, já interpretado (sem validar o `state`). */
export type ParsedCallbackUrl = { state?: string; code?: string; error?: string; errorDescription?: string; iss?: string };

/** Interpreta o endereço colado: precisa ser uma URL http(s) com o caminho do retorno. Devolve undefined se for outra coisa. */
export function parsePastedCallbackUrl(text: string): ParsedCallbackUrl | undefined {
  const match = /^https?:\/\/(?:\[[0-9a-f:.]+\]|[^/:?#@\s]+)(?::\d{1,5})?(\/[^?#\s]*)(?:\?([^#\s]*))?(?:#\S*)?$/i.exec(text.trim());
  if (!match || match[1]!.replace(/\/+$/, "") !== OAUTH_CALLBACK_PATH) return undefined;
  const params = new Map<string, string>();
  for (const pair of (match[2] ?? "").split("&")) {
    const [rawKey, ...rest] = pair.split("=");
    if (!rawKey) continue;
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      if (!params.has(key)) params.set(key, decodeURIComponent(rest.join("=").replace(/\+/g, " ")));
    } catch {
      return undefined;
    }
  }
  const pick = (key: string) => params.get(key)?.slice(0, 4000) || undefined;
  return { state: pick("state"), code: pick("code"), error: pick("error"), errorDescription: pick("error_description"), iss: pick("iss") };
}

/**
 * Problema do endereço de retorno para esta origem, ou undefined se serve. O Google só aceita https
 * ou `http://localhost`; um IP da rede local em http (ex.: `http://192.168.0.10:3067`) não serve.
 */
export function redirectOriginIssue(origin: string): string | undefined {
  const url = parseOrigin(origin);
  if (!url) return "Origem inválida.";
  if (url.protocol === "https") return undefined;
  if (isLocalHost(url.host)) return undefined;
  return "Você abriu o Cyno por um endereço http de rede (um IP). O Google só aceita retorno em https ou em http://localhost. Troque o endereço de retorno para localhost, ou abra o Cyno pelo endereço https (o domínio), e tente de novo.";
}

/** Tipos de risco de um escopo (o aviso da tela). */
export type ScopeRisk = "full" | "write" | "send" | "delete" | "none";

/** Escopo de acesso total (nunca vem marcado): ex.: `https://mail.google.com/`. */
export function isFullAccessScope(scope: string): boolean {
  return scope === "https://mail.google.com/" || /^https:\/\/www\.googleapis\.com\/auth\/(cloud-platform|drive)$/.test(scope) || /(^|[./:_-])(full|admin|all)([./:_-]|$)/i.test(scope);
}

/** Classifica um escopo pelo nome (heurística: somente leitura não tem aviso). */
export function scopeRisk(scope: string): ScopeRisk {
  if (isFullAccessScope(scope)) return "full";
  const tail = scope.replace(/^https?:\/\/[^/]+\/(auth\/)?/, "").toLowerCase();
  if (/(^|[./:_-])(read|readonly|metadata|openid|email|profile)$/.test(tail)) return "none";
  if (/delete|trash|remove|destroy/.test(tail)) return "delete";
  if (/send/.test(tail)) return "send";
  if (/(^|[./:_-])(write|modify|compose|create|update|insert|edit|manage|drafts|settings|labels|messages|filters)([./:_-]|$)/.test(tail)) return "write";
  return "none";
}

/** Escopos marcados que escrevem, enviam ou excluem (para o aviso). */
export function risksOf(scopes: readonly string[]): { full: string[]; write: string[]; send: string[]; delete: string[] } {
  const out = { full: [] as string[], write: [] as string[], send: [] as string[], delete: [] as string[] };
  for (const scope of scopes) {
    const risk = scopeRisk(scope);
    if (risk !== "none") out[risk].push(scope);
  }
  return out;
}

/** Até este tamanho a lista é "curta" e vem toda marcada (menos os de acesso total). */
export const SHORT_SCOPE_LIST = 6;

/**
 * Escopos marcados por padrão. Lista curta: todos (menos acesso total). Lista longa (ex.: Gmail, 20
 * escopos): um conjunto mínimo, o de leitura e, para a caixa de e-mail, o de rascunhos (o par que o
 * Google documenta para o MCP do Gmail). Nunca marca `https://mail.google.com/`.
 */
export function defaultOAuthScopes(supported: readonly string[]): string[] {
  // Gmail pela API: só ler vem marcado; criar rascunhos (que no Google também permite enviar) o dono marca de propósito.
  if (supported.length === GMAIL_API_SCOPES.length && GMAIL_API_SCOPES.every((scope) => supported.includes(scope))) return [GMAIL_READONLY_SCOPE];
  const safe = supported.filter((scope) => !isFullAccessScope(scope));
  if (supported.length <= SHORT_SCOPE_LIST) return safe;
  const readonly = safe.filter((scope) => /(^|[./:_-])readonly$/i.test(scope));
  const broadest = readonly.length > 0 ? [readonly.reduce((a, b) => (b.length < a.length ? b : a))] : [];
  const compose = safe.filter((scope) => /\/gmail\.compose$/.test(scope));
  const picked = [...broadest, ...compose];
  return picked.length > 0 ? picked : safe.slice(0, 1);
}
