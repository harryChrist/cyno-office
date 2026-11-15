import { createLibraryConnectorBodySchema, GMAIL_API_URL, GMAIL_MCP_URL, type LibraryConnector } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { LibraryService } from "../library-service";
import type { StoredOAuth } from "./oauth/stored";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const ACCESS = "ya29.token-de-acesso-1234";
const REFRESH = "1//refresh-token-9876";
const tempDir = useTempDirs();
const services: LibraryService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const OIDC = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  revocation_endpoint: "https://oauth2.googleapis.com/revoke",
  code_challenge_methods_supported: ["plain", "S256"],
  scopes_supported: ["openid", "email", "profile"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
};

type Seen = { method: string; url: string; auth?: string };

/** fetch falso do Google: o metadado de login e a API do Gmail; qualquer outro endereço (ex.: o servidor MCP) é registrado e recusado. */
function fakeGoogle(options: { profile?: { status: number; body: unknown } } = {}) {
  const seen: Seen[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? "GET", url: url.toString(), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.hostname === "accounts.google.com" && url.pathname === "/.well-known/openid-configuration") return Response.json(OIDC);
    if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/profile") {
      const profile = options.profile ?? { status: 200, body: { emailAddress: "dono@example.com" } };
      return Response.json(profile.body, { status: profile.status });
    }
    if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/labels") return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: fake, seen, hit: (host: string) => seen.some((item) => new URL(item.url).hostname === host) };
}

async function open(fetch: typeof globalThis.fetch) {
  const library = await LibraryService.open({
    libraryDir: await tempDir(),
    publishPlatform: () => undefined,
    claudeList: { command: "/nao-existe/claude" },
    autoTest: false,
    gateway: { fetch },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  });
  services.push(library);
  return library;
}

/** O OAuth de um conector do Gmail MCP onde o dono já está logado (com os escopos certos). */
const loggedInMcpOAuth = (overrides: Partial<StoredOAuth> = {}): StoredOAuth => ({
  resource: GMAIL_MCP_URL,
  provider: "google",
  usesResource: false,
  authServer: { issuer: "https://accounts.google.com", authorizationEndpoint: OIDC.authorization_endpoint, tokenEndpoint: OIDC.token_endpoint, tokenAuthMethods: [] },
  scopesSupported: [READONLY, COMPOSE, "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"],
  scopes: [READONLY, COMPOSE],
  client: { source: "manual", clientId: "id-do-cliente.apps.googleusercontent.com", clientSecret: "segredo-do-cliente-abc", authMethod: "client_secret_post", redirectUris: [] },
  tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2026-11-08T14:00:00.000Z", scope: `${READONLY} ${COMPOSE}` },
  connection: "connected",
  connectedAt: "2026-11-01T10:00:00.000Z",
  discoveredAt: "2026-11-01T09:00:00.000Z",
  ...overrides,
});

async function seedMcpConnector(library: LibraryService, oauth: StoredOAuth = loggedInMcpOAuth()) {
  const record = await library.registry.create({ name: "Gmail", kind: "http", url: GMAIL_MCP_URL, oauth });
  // Estado derivado do cliente antigo (o servidor MCP listava 23 ferramentas).
  await library.registry.setStatus(record.id, { state: "error", reason: "requires that your Google Cloud project is enrolled", tools: [{ name: "gmail_list" }] });
  return record.id;
}

describe("Gmail pela API: criar", () => {
  it("o modo 'gmail-api' não faz descoberta MCP: o login vem do metadado do Google, sem cadastro automático e sem resource", async () => {
    const google = fakeGoogle();
    const library = await open(google.fetch);
    const created = await library.create({ name: "Gmail", kind: "http", builtin: "gmail-api", auth: { mode: "oauth", scopes: [READONLY], clientId: "id.apps.googleusercontent.com", clientSecret: "segredo-xyz-123" } });
    expect(created).toMatchObject({ builtin: "gmail-api", kind: "http", url: GMAIL_API_URL });
    expect(created.oauth).toMatchObject({ provider: "google", usesResource: false, registration: "manual", scopesSupported: [READONLY, COMPOSE], defaultScopes: [READONLY], scopes: [READONLY], clientSource: "manual", clientSecretSet: true, connection: "not_connected" });
    expect(google.seen.map((item) => new URL(item.url).hostname)).toEqual(["accounts.google.com", "accounts.google.com"].slice(0, google.seen.length));
    expect(google.hit("gmailmcp.googleapis.com")).toBe(false);
    expect(google.seen.some((item) => item.method === "POST")).toBe(false);
    expect(JSON.stringify(created)).not.toContain("segredo-xyz-123");
  });

  it("a rota de descoberta responde para o modo embutido (e para um conector já embutido)", async () => {
    const google = fakeGoogle();
    const library = await open(google.fetch);
    const found = await library.discoverOAuthFor({ builtin: "gmail-api" });
    expect(found).toMatchObject({ found: true, provider: "google", registration: "manual", defaultScopes: [READONLY], scopesSupported: [READONLY, COMPOSE], usesResource: false });
    const created = await library.create({ name: "Gmail", kind: "http", builtin: "gmail-api", auth: { mode: "oauth" } });
    expect(await library.discoverOAuthFor({ connectorId: created.id })).toMatchObject({ found: true, provider: "google" });
    // Sem rede para o Google: motivo legível, não exceção.
    const offline = await open((async () => new Response("{}", { status: 404 })) as typeof fetch);
    expect(await offline.discoverOAuthFor({ builtin: "gmail-api" })).toMatchObject({ found: false });
  });

  it("recusa o modo embutido sem OAuth ou sem ser HTTP", async () => {
    const library = await open(fakeGoogle().fetch);
    await expect(library.create({ name: "X", kind: "http", builtin: "gmail-api" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(library.create({ name: "X", kind: "http", builtin: "gmail-api", auth: { mode: "static" } })).rejects.toMatchObject({ statusCode: 400 });
    expect(createLibraryConnectorBodySchema.safeParse({ name: "X", kind: "http", builtin: "gmail-api" }).success).toBe(false);
    expect(createLibraryConnectorBodySchema.safeParse({ name: "X", kind: "stdio", command: "x", builtin: "gmail-api", auth: { mode: "oauth" } }).success).toBe(false);
    // Com OAuth não precisa de URL; o modo comum continua pedindo.
    expect(createLibraryConnectorBodySchema.safeParse({ name: "X", kind: "http", builtin: "gmail-api", auth: { mode: "oauth" } }).success).toBe(true);
    expect(createLibraryConnectorBodySchema.safeParse({ name: "X", kind: "http" }).success).toBe(false);
  });
});

describe("Gmail pela API: trocar o modo de um conector que já existe", () => {
  it("MCP para API: o login (cliente, segredo, escopos, tokens) fica; só o estado derivado é descartado e o teste usa a API", async () => {
    const google = fakeGoogle();
    const library = await open(google.fetch);
    const id = await seedMcpConnector(library);
    const before = library.registry.record(id)!.oauth!;

    const updated = await library.update(id, { builtin: "gmail-api" });
    expect(updated).toMatchObject({ builtin: "gmail-api", url: GMAIL_API_URL });
    const after = library.registry.record(id)!;
    expect(after.oauth).toMatchObject({ client: before.client, tokens: before.tokens, scopes: before.scopes, connection: "connected", connectedAt: before.connectedAt, resource: "https://gmail.googleapis.com", scopesSupported: [READONLY, COMPOSE] });
    expect(after.status).toMatchObject({ state: "unknown", tools: [] });
    expect(after.status.reason).toBeUndefined();
    expect(google.seen).toHaveLength(0); // trocar não usa a rede

    const tested = await library.test(id);
    expect(tested.status.state).toBe("connected");
    expect(tested.status.tools.map((tool) => tool.name)).toEqual(["search_threads", "get_thread", "list_labels", "create_draft"]);
    const profile = google.seen.find((item) => item.url.endsWith("/users/me/profile"))!;
    expect(profile.auth).toBe(`Bearer ${ACCESS}`);
    expect(google.hit("gmailmcp.googleapis.com")).toBe(false);
    // O endereço de e-mail do perfil não fica em lugar nenhum.
    expect(JSON.stringify([tested, library.registry.record(id)])).not.toContain("dono@example.com");
  });

  it("API para MCP: o login também fica; volta o endereço do servidor oficial e o estado derivado é descartado", async () => {
    const google = fakeGoogle();
    const library = await open(google.fetch);
    const id = await seedMcpConnector(library);
    await library.update(id, { builtin: "gmail-api" });
    await library.test(id);
    const before = library.registry.record(id)!.oauth!;

    const back = await library.update(id, { builtin: null });
    expect(back.builtin).toBeUndefined();
    expect(back.url).toBe(GMAIL_MCP_URL);
    const record = library.registry.record(id)!;
    expect(record.builtin).toBeUndefined();
    expect(record.oauth).toMatchObject({ client: before.client, tokens: before.tokens, connection: "connected", scopes: before.scopes });
    expect(record.status).toMatchObject({ state: "unknown", tools: [] });
  });

  it("ligar o modo sem login OAuth é recusado; desligar um conector que não é embutido não muda nada", async () => {
    const library = await open(fakeGoogle().fetch);
    const plain = await library.registry.create({ name: "Notion", kind: "http", url: "https://mcp.example.com/mcp" });
    await expect(library.update(plain.id, { builtin: "gmail-api" })).rejects.toMatchObject({ statusCode: 400 });
    const id = await seedMcpConnector(library);
    const same = await library.update(id, { builtin: null });
    expect(same.url).toBe(GMAIL_MCP_URL);
    expect(library.registry.record(id)!.status.tools).toHaveLength(1);
  });

  it("não deixa voltar ao token fixo enquanto o modo embutido está ligado", async () => {
    const library = await open(fakeGoogle().fetch);
    const id = await seedMcpConnector(library);
    await library.update(id, { builtin: "gmail-api" });
    await expect(library.update(id, { auth: { mode: "static" } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a edição de escopos e cliente no modo embutido não vai ao servidor MCP e mantém os tokens quando o cliente é o mesmo", async () => {
    const google = fakeGoogle();
    const library = await open(google.fetch);
    const id = await seedMcpConnector(library);
    await library.update(id, { builtin: "gmail-api" });
    const changed = await library.update(id, { auth: { mode: "oauth", scopes: [READONLY] } });
    const record = library.registry.record(id)!;
    expect(changed.oauth?.scopes).toEqual([READONLY]);
    expect(record.oauth?.tokens?.accessToken).toBe(ACCESS);
    expect(record.oauth?.connection).toBe("needs_login"); // escopos mudaram: entrar de novo vale
    expect(google.hit("gmailmcp.googleapis.com")).toBe(false);
  });
});

describe("Gmail pela API: o gateway", () => {
  const withBuiltin = async (google: ReturnType<typeof fakeGoogle>, oauth: StoredOAuth = loggedInMcpOAuth()) => {
    const library = await open(google.fetch);
    const id = await seedMcpConnector(library, oauth);
    await library.update(id, { builtin: "gmail-api" });
    return { library, id };
  };

  it("usa o cliente novo (sem initialize/tools/list de MCP) e as ferramentas dependem dos escopos concedidos", async () => {
    const google = fakeGoogle();
    const { library, id } = await withBuiltin(google, loggedInMcpOAuth({ tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2026-11-08T14:00:00.000Z", scope: READONLY } }));
    const tested = await library.test(id);
    expect(tested.status).toMatchObject({ state: "connected" });
    expect(tested.status.tools.map((tool) => tool.name)).toEqual(["search_threads", "get_thread", "list_labels"]); // sem compose, sem rascunho
    expect(google.seen.every((item) => item.method === "GET")).toBe(true);
    const result = await library.gateway.callSystem(id, "list_labels", {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"INBOX"');
  });

  it("repassa as dicas (readOnlyHint) das ferramentas ao agente", async () => {
    const google = fakeGoogle();
    const { library, id } = await withBuiltin(google);
    await library.test(id);
    await library.registry.setGrants(id, {});
    const record = library.registry.record(id)!;
    expect(record.status.tools.find((tool) => tool.name === "create_draft")?.annotations?.readOnlyHint).toBe(false);
    expect(record.status.tools.find((tool) => tool.name === "search_threads")?.annotations?.readOnlyHint).toBe(true);
  });

  it("o teste não passa quando o uso está barrado: 403 vira Erro com o motivo (a lista de ferramentas continua visível) e o login segue conectado", async () => {
    const google = fakeGoogle({ profile: { status: 403, body: { error: { message: "Gmail API has not been used in project 42 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42 then retry." } } } });
    const { library, id } = await withBuiltin(google);
    const tested = await library.test(id);
    expect(tested.status.state).toBe("error");
    expect(tested.status.reason).toMatch(/não está ativada no projeto/);
    expect(tested.status.tools.length).toBeGreaterThan(0);
    expect(tested.oauth?.connection).toBe("connected");
  });

  it("sem entrar com a conta: lista as ferramentas, não chama a API e o estado é 'precisa de login'", async () => {
    const google = fakeGoogle();
    const { library, id } = await withBuiltin(google, loggedInMcpOAuth({ tokens: undefined, connection: "not_connected", connectedAt: undefined }));
    const tested = await library.test(id);
    expect(tested.status.state).toBe("needs_auth");
    expect(tested.status.tools.length).toBeGreaterThan(0);
    expect(google.seen).toHaveLength(0);
  });
});

describe("Gmail pela API: tipo do conector na visão pública", () => {
  it("traz builtin só nos conectores embutidos", async () => {
    const library = await open(fakeGoogle().fetch);
    const id = await seedMcpConnector(library);
    const find = () => (library.list() as LibraryConnector[]).find((connector) => connector.id === id)!;
    expect(find().builtin).toBeUndefined();
    await library.update(id, { builtin: "gmail-api" });
    expect(find().builtin).toBe("gmail-api");
  });
});
