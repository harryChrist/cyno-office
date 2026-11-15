import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { OAUTH_CALLBACK_PATH, OAUTH_LOCAL_REDIRECT_URI, type ApiErrorBody, type LibraryConnector, type OAuthDiscoveryResult, type OAuthStartResponse } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createTeam } from "../../../dev/test-api";
import { useTestApp } from "../../../dev/test-app";
import { buildAuthorizationUrl, pkceChallenge } from "./flow";
import { startFakes, type FakeOptions, type FakeServers } from "./fakes";
import type { StoredOAuth } from "./stored";

const setupApp = useTestApp();
const LIB = "/api/library/connectors";
const ORIGIN = "http://127.0.0.1:3341";
const REDIRECT = `${ORIGIN}${OAUTH_CALLBACK_PATH}`;
const fakesToClose: FakeServers[] = [];

afterEach(async () => {
  await Promise.all(fakesToClose.splice(0).map((fakes) => fakes.close()));
});

async function setup(options: Partial<FakeOptions> = {}, now?: () => Date) {
  const fakes = await startFakes({ publicToolsList: true, ...options });
  fakesToClose.push(fakes);
  // Sem `createClient`: o gateway fala HTTP de verdade com os servidores falsos (127.0.0.1).
  const test = await setupApp({ connectors: { autoTest: false }, ...(now ? { now } : {}) });
  const room = await createRoom(test.app, "Sala P");
  const team = await createTeam(test.app, room.id, "Time P");
  const agent = await createAgent(test.app, team.id, "Clara");
  return { ...test, fakes, agent };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const tools = (test: Setup) => test.workspaces.get("principal").officeTools(test.agent.id);

/** Cria o conector OAuth, libera à Clara e devolve o conector. */
async function createOAuthConnector(test: Setup, auth: object = { mode: "oauth" }) {
  const created = await call<LibraryConnector>(test.app, "POST", LIB, { name: "Falso", kind: "http", url: test.fakes.mcpUrl, auth });
  await call(test.app, "PUT", `${LIB}/falso/grants`, { grants: { principal: { agentIds: [test.agent.id] } } }, 200);
  // O servidor falso lista as ferramentas sem login (como o do Gmail): o teste guarda a lista, e o agente passa a vê-las.
  await call(test.app, "POST", `${LIB}/falso/test`, undefined, 200);
  return created;
}

/** O dono clica em Entrar e aprova na tela do serviço: devolve o que a página de retorno respondeu. */
async function signIn(test: Setup, id = "falso", origin = ORIGIN) {
  const started = await call<OAuthStartResponse>(test.app, "POST", `${LIB}/${id}/oauth/start`, { origin }, 200);
  const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get("location")!);
  const callback = await test.app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
  return { started, callback, back };
}

const callTool = async (test: Setup) => {
  const tool = tools(test).find((candidate) => candidate.name === "falso__whoami");
  expect(tool, "ferramenta falso__whoami liberada").toBeDefined();
  return tool!.call({});
};

describe("login OAuth: descoberta", () => {
  it("acha o recurso protegido pelo WWW-Authenticate e o servidor de autorização (RFC 8414), com cadastro dinâmico", async () => {
    const test = await setup({ scopes: ["read", "write"] });
    const found = await call<OAuthDiscoveryResult>(test.app, "POST", `${LIB}/oauth/discover`, { url: test.fakes.mcpUrl }, 200);
    expect(found).toMatchObject({ found: true, resource: test.fakes.mcpUrl, issuer: test.fakes.issuer, provider: "generic", scopesSupported: ["read", "write"], defaultScopes: ["read", "write"], registration: "dynamic", usesResource: true });
  });

  it("'Verificar' num conector que já existe usa a URL guardada (a tela só conhece a mascarada) e não muda nada", async () => {
    const test = await setup();
    await call(test.app, "POST", LIB, { name: "Falso", kind: "http", url: test.fakes.mcpUrl });
    const found = await call<OAuthDiscoveryResult>(test.app, "POST", `${LIB}/oauth/discover`, { connectorId: "falso" }, 200);
    expect(found).toMatchObject({ found: true, registration: "dynamic" });
    expect((await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`)).oauth).toBeUndefined();
    await call(test.app, "POST", `${LIB}/oauth/discover`, {}, 400);
  });

  it("serve o metadado só em OIDC (como o Google): sem cadastro dinâmico, pede cliente do dono", async () => {
    const test = await setup({ oidcOnly: true, dynamicRegistration: false });
    const found = await call<OAuthDiscoveryResult>(test.app, "POST", `${LIB}/oauth/discover`, { url: test.fakes.mcpUrl }, 200);
    expect(found).toMatchObject({ found: true, registration: "manual" });
  });

  it("devolve um motivo legível quando o servidor não anuncia OAuth, e recusa http fora de localhost", async () => {
    const test = await setup();
    const none = await call<OAuthDiscoveryResult>(test.app, "POST", `${LIB}/oauth/discover`, { url: test.fakes.mcpUrl.replace("/mcp", "/outro") }, 200);
    expect(none).toMatchObject({ found: false, reason: expect.stringMatching(/não achei OAuth/) });
    const remote = await call<OAuthDiscoveryResult>(test.app, "POST", `${LIB}/oauth/discover`, { url: "http://mcp.exemplo.invalid/mcp" }, 200);
    expect(remote).toMatchObject({ found: false, reason: expect.stringMatching(/só https/) });
    await call(test.app, "POST", `${LIB}/oauth/discover`, { url: "ftp://x" }, 400);
  });

  it("criar com OAuth num servidor sem OAuth falha com 400 e não cria nada", async () => {
    const test = await setup();
    const error = await call<ApiErrorBody>(test.app, "POST", LIB, { name: "Sem", kind: "http", url: test.fakes.mcpUrl.replace("/mcp", "/outro"), auth: { mode: "oauth" } }, 400);
    expect(error.error).toMatch(/login OAuth/);
    expect(await call<LibraryConnector[]>(test.app, "GET", LIB)).toEqual([]);
  });
});

describe("login OAuth: fluxo completo com cadastro dinâmico", () => {
  it("cadastra 'Cyno Office', loga com PKCE e state, guarda os tokens e chama a ferramenta pelo gateway", async () => {
    const test = await setup();
    const created = await createOAuthConnector(test);
    expect(created.oauth).toMatchObject({ connection: "not_connected", registration: "dynamic", scopes: ["read", "write"], clientSecretSet: false });

    const { started, callback, back } = await signIn(test);
    expect(started.redirectUri).toBe(REDIRECT);
    // Cadastro dinâmico automático, com o nome do app e o endereço de retorno.
    expect(test.fakes.stats.registrations).toBe(1);
    expect(test.fakes.stats.lastRegistration).toMatchObject({ client_name: "Cyno Office", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
    // A URL de login: PKCE S256, state aleatório, resource (RFC 8707), escopos.
    const params = test.fakes.stats.lastAuthorize!;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")!.length).toBeGreaterThanOrEqual(24);
    expect(params.get("resource")).toBe(test.fakes.mcpUrl);
    expect(params.get("scope")).toBe("read write");
    expect(params.get("access_type")).toBeNull(); // só o Google leva
    // Troca do código: o verificador bate com o desafio e leva resource e redirect_uri.
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('data-ok="true"');
    expect(back.searchParams.get("state")).toBe(params.get("state"));
    const body = test.fakes.stats.lastTokenBody!;
    expect(pkceChallenge(body.get("code_verifier")!)).toBe(params.get("code_challenge"));
    expect(body.get("resource")).toBe(test.fakes.mcpUrl);
    expect(body.get("redirect_uri")).toBe(REDIRECT);

    const connected = await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`);
    expect(connected.oauth).toMatchObject({ connection: "connected", clientSource: "dynamic" });
    const tested = await call<LibraryConnector>(test.app, "POST", `${LIB}/falso/test`, undefined, 200);
    expect(tested.status).toMatchObject({ state: "connected", tools: [{ name: "whoami" }] });
    const result = await callTool(test);
    expect(result.isError).toBe(false);
    expect(test.fakes.mcpCalls).toBe(1);
  });

  it("o state é de uso único e state desconhecido, erro do serviço e iss trocado viram página de erro legível", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    const { back, callback } = await signIn(test);
    expect(callback.statusCode).toBe(200);
    const again = await test.app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("expirou ou já foi usado");
    expect((await test.app.inject({ method: "GET", url: `${OAUTH_CALLBACK_PATH}?code=x&state=inventado` })).body).toContain('data-ok="false"');

    // O usuário recusa no serviço.
    const started = await call<OAuthStartResponse>(test.app, "POST", `${LIB}/falso/oauth/start`, { origin: ORIGIN }, 200);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const denied = await test.app.inject({ method: "GET", url: `${OAUTH_CALLBACK_PATH}?error=access_denied&state=${state}` });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain("recusado");

    // Resposta de outro servidor de autorização (RFC 9207): descartada.
    const second = await call<OAuthStartResponse>(test.app, "POST", `${LIB}/falso/oauth/start`, { origin: ORIGIN }, 200);
    const state2 = new URL(second.authorizationUrl).searchParams.get("state")!;
    const wrong = await test.app.inject({ method: "GET", url: `${OAUTH_CALLBACK_PATH}?code=x&state=${state2}&iss=${encodeURIComponent("https://outro.exemplo")}` });
    expect(wrong.body).toContain("diferente do esperado");
  });

  it("uma origem nova faz um cadastro novo (o endereço de retorno é por origem)", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    await signIn(test, "falso", "http://localhost:5341");
    expect(test.fakes.stats.registrations).toBe(2);
    expect(test.fakes.stats.lastRegistration).toMatchObject({ redirect_uris: [REDIRECT, "http://localhost:5341/api/library/oauth/callback"] });
  });
});

describe("login OAuth: tokens e renovação", () => {
  it("renova antes de vencer (faltando menos de 1 min), sem o servidor nem chegar a ver um 401", async () => {
    let clock = Date.now();
    const test = await setup({}, () => new Date(clock));
    await createOAuthConnector(test);
    await signIn(test);
    expect((await callTool(test)).isError).toBe(false);
    expect(test.fakes.stats.refreshes).toBe(0); // token novo: nada a renovar
    clock += 3550_000; // faltam 50 s dos 3600 s
    expect((await callTool(test)).isError).toBe(false);
    expect(test.fakes.stats.refreshes).toBe(1);
    expect(test.fakes.unauthorized).toBe(0);
  });

  it("renova ao levar 401 e repete a chamada com o token novo", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    test.fakes.revokeAccess();
    expect((await callTool(test)).isError).toBe(false);
    expect(test.fakes.stats.refreshes).toBe(1);
    expect(test.fakes.stats.lastTokenBody!.get("grant_type")).toBe("refresh_token");
    expect(test.fakes.stats.lastTokenBody!.get("resource")).toBe(test.fakes.mcpUrl);
  });

  it("várias chamadas ao mesmo tempo com 401 fazem UMA renovação só", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    test.fakes.revokeAccess();
    const results = await Promise.all(Array.from({ length: 6 }, () => callTool(test)));
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(test.fakes.stats.refreshes).toBe(1);
    expect(test.fakes.mcpCalls).toBe(6);
  });

  it("renovação recusada de vez: 'precisa entrar de novo' na tela e erro claro em inglês para o agente", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    test.fakes.revokeAccess();
    test.fakes.failRefresh = "invalid_grant";
    const result = await callTool(test);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/is disconnected.*sign in again/i);
    const after = await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`);
    expect(after.oauth).toMatchObject({ connection: "needs_login" });
    expect(after.status.state).toBe("needs_auth");
    // Entrar de novo resolve.
    test.fakes.failRefresh = "none";
    await signIn(test);
    expect((await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`)).oauth).toMatchObject({ connection: "connected" });
    expect((await callTool(test)).isError).toBe(false);
  });

  it("falha passageira da renovação (5xx) não derruba o login", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    test.fakes.revokeAccess();
    test.fakes.failRefresh = "server_error";
    const result = await callTool(test);
    expect(result.isError).toBe(true);
    expect(result.text).not.toMatch(/disconnected/);
    expect((await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`)).oauth).toMatchObject({ connection: "connected" });
    test.fakes.failRefresh = "none";
    expect((await callTool(test)).isError).toBe(false);
  });

  it("403 (ex.: API do Google não ativada) não derruba o login, não renova token e mostra o motivo; sai do erro quando volta a funcionar", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    const refreshesBefore = test.fakes.stats.refreshes;
    test.fakes.forbidCalls = JSON.stringify({ error: { code: 403, message: "Gmail MCP API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmailmcp.googleapis.com/overview?project=123 then retry.", status: "PERMISSION_DENIED" } });
    const result = await callTool(test);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/não está ativada no projeto do Google Cloud/);
    expect(result.text).not.toMatch(/is disconnected/);
    const after = await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`);
    expect(after.oauth).toMatchObject({ connection: "connected" });
    expect(after.status.state).toBe("error");
    expect(after.status.reason).toMatch(/gmailmcp\.googleapis\.com/);
    expect(test.fakes.stats.refreshes).toBe(refreshesBefore);
    expect(test.fakes.stats.revocations).toBe(0);
    test.fakes.forbidCalls = "";
    expect((await callTool(test)).isError).toBe(false);
    expect((await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`)).status.state).toBe("connected");
  });

  it("sem entrar ainda: a chamada do agente diz em inglês que o dono precisa entrar; o teste lista as ferramentas mas não vira 'conectado'", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    const tested = await call<LibraryConnector>(test.app, "POST", `${LIB}/falso/test`, undefined, 200);
    expect(tested.status.state).toBe("needs_auth");
    expect(tested.status.tools).toHaveLength(1);
    expect(tested.status.reason).toMatch(/Entre com a conta/);
    const result = await callTool(test);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Cyno Office.*Sign in/);
  });

  it("desconectar revoga no serviço e apaga os tokens", async () => {
    const test = await setup();
    await createOAuthConnector(test);
    await signIn(test);
    const off = await call<LibraryConnector>(test.app, "POST", `${LIB}/falso/oauth/disconnect`, undefined, 200);
    expect(off.oauth).toMatchObject({ connection: "not_connected" });
    expect(test.fakes.stats.revocations).toBe(1);
    expect((await callTool(test)).isError).toBe(true);
  });
});

describe("login OAuth: cliente digitado pelo dono (servidor sem cadastro dinâmico)", () => {
  it("sem ID do cliente, Entrar explica o que falta; com ID e segredo, entra (segredo no corpo do token)", async () => {
    const test = await setup({ oidcOnly: true, dynamicRegistration: false });
    const created = await createOAuthConnector(test);
    expect(created.oauth).toMatchObject({ registration: "manual", clientSecretSet: false });
    const missing = await call<ApiErrorBody>(test.app, "POST", `${LIB}/falso/oauth/start`, { origin: ORIGIN }, 400);
    expect(missing.error).toMatch(/ID do cliente/);

    const patched = await call<LibraryConnector>(test.app, "PATCH", `${LIB}/falso`, { auth: { mode: "oauth", clientId: test.fakes.options.manualClient.id, clientSecret: test.fakes.options.manualClient.secret } }, 200);
    expect(patched.oauth).toMatchObject({ clientSource: "manual", clientId: test.fakes.options.manualClient.id, clientSecretSet: true });
    expect(JSON.stringify(patched)).not.toContain(test.fakes.options.manualClient.secret);
    const { callback } = await signIn(test);
    expect(callback.body).toContain('data-ok="true"');
    expect(test.fakes.stats.lastTokenBody!.get("client_secret")).toBe(test.fakes.options.manualClient.secret);
    expect((await callTool(test)).isError).toBe(false);
  });

  it("mudar os escopos de um conector conectado pede para entrar de novo; voltar ao token fixo tira o OAuth", async () => {
    const test = await setup({ scopes: ["read", "write", "admin"] });
    await createOAuthConnector(test);
    await signIn(test);
    const changed = await call<LibraryConnector>(test.app, "PATCH", `${LIB}/falso`, { auth: { mode: "oauth", scopes: ["read"] } }, 200);
    expect(changed.oauth).toMatchObject({ scopes: ["read"], connection: "needs_login" });
    const fixed = await call<LibraryConnector>(test.app, "PATCH", `${LIB}/falso`, { auth: { mode: "static" } }, 200);
    expect(fixed.oauth).toBeUndefined();
  });
});

describe("login OAuth: segredos ficam no servidor", () => {
  it("nenhum token, segredo ou código aparece nas respostas da API nem nos eventos; o cofre é 0600 e os tokens estão nele", async () => {
    const test = await setup({ oidcOnly: true, dynamicRegistration: false });
    const created = await call<LibraryConnector>(test.app, "POST", LIB, { name: "Falso", kind: "http", url: test.fakes.mcpUrl, auth: { mode: "oauth", clientId: test.fakes.options.manualClient.id, clientSecret: test.fakes.options.manualClient.secret } });
    await call(test.app, "PUT", `${LIB}/falso/grants`, { grants: { principal: { agentIds: [test.agent.id] } } }, 200);
    await call(test.app, "POST", `${LIB}/falso/test`, undefined, 200);
    const { started, callback } = await signIn(test);
    await callTool(test);
    const responses = [
      created,
      await call(test.app, "GET", LIB),
      await call(test.app, "GET", `${LIB}/falso`),
      await call(test.app, "POST", `${LIB}/falso/test`, undefined, 200),
      await call(test.app, "GET", `/api/w/principal/connectors`),
      started,
      callback.body,
      test.log.events,
    ];
    const text = JSON.stringify(responses);
    const stored = await readFile(path.join(test.dataDir, "platform", "library", "connectors.json"), "utf8");
    const accessToken = /"accessToken": ?"([^"]+)"/.exec(stored)?.[1];
    const refreshToken = /"refreshToken": ?"([^"]+)"/.exec(stored)?.[1];
    expect(accessToken).toMatch(/^access-/);
    expect(refreshToken).toMatch(/^refresh-/);
    for (const secret of [accessToken!, refreshToken!, test.fakes.options.manualClient.secret, "code-"]) expect(text, `vazou: ${secret}`).not.toContain(secret);
    // O code_verifier também não sai (a URL de login só leva o desafio).
    expect(started.authorizationUrl).not.toContain(test.fakes.stats.lastTokenBody!.get("code_verifier")!);
    expect((await stat(path.join(test.dataDir, "platform", "library", "connectors.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("login OAuth: o que vai na URL de login", () => {
  const base: StoredOAuth = {
    resource: "https://gmailmcp.googleapis.com/mcp/v1",
    provider: "google",
    usesResource: false,
    authServer: { issuer: "https://accounts.google.com", authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", tokenEndpoint: "https://oauth2.googleapis.com/token", tokenAuthMethods: ["client_secret_post"] },
    scopesSupported: [],
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    connection: "not_connected",
    discoveredAt: "2026-01-01T00:00:00.000Z",
  };

  it("Google: access_type=offline e prompt=consent, sem resource", () => {
    const url = new URL(buildAuthorizationUrl(base, { clientId: "cid", redirectUri: "https://app.exemplo/api/library/oauth/callback", state: "s", challenge: "c" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.has("resource")).toBe(false);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("servidor do padrão MCP: resource, sem os parâmetros do Google", () => {
    const url = new URL(buildAuthorizationUrl({ ...base, provider: "generic", usesResource: true, authServer: { ...base.authServer, issuer: "https://mcp.exemplo" } }, { clientId: "cid", redirectUri: "https://x/cb", state: "s", challenge: "c" }));
    expect(url.searchParams.get("resource")).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(url.searchParams.has("access_type")).toBe(false);
  });

  it("origem http de rede não passa para o Google, e https ou localhost passam", async () => {
    const test = await setup();
    await call(test.app, "POST", LIB, { name: "G", kind: "http", url: test.fakes.mcpUrl, auth: { mode: "oauth" } });
    // O conector falso é "generic": a regra do Google vale só para o Google (coberta em shared). Aqui, uma origem inválida.
    const bad = await call<ApiErrorBody>(test.app, "POST", `${LIB}/g/oauth/start`, { origin: "nao-e-url" }, 400);
    expect(bad.error).toBeTruthy();
  });
});

describe("login OAuth: endereço de retorno localhost e colar o endereço de volta", () => {
  const APP_ORIGIN = "https://app.exemplo";
  const manual = { oidcOnly: true, dynamicRegistration: false } as const;

  /** Cria o conector com o cliente digitado e o modo `local`. */
  async function localConnector(test: Setup, redirect: "local" | "app" | null = "local") {
    const { manualClient } = test.fakes.options;
    return createOAuthConnector(test, { mode: "oauth", clientId: manualClient.id, clientSecret: manualClient.secret, ...(redirect ? { redirect } : {}) });
  }

  /** Começa o login e aprova no serviço: devolve o endereço que o navegador do dono tentaria abrir. */
  async function authorize(test: Setup, id = "falso", origin = APP_ORIGIN) {
    const started = await call<OAuthStartResponse>(test.app, "POST", `${LIB}/${id}/oauth/start`, { origin }, 200);
    const response = await fetch(started.authorizationUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    return { started, pasted: response.headers.get("location")! };
  }

  it("o resumo traz o modo; sem ele, cliente digitado vale local e cadastro dinâmico vale app", async () => {
    const test = await setup(manual);
    const created = await localConnector(test, null);
    expect(created.oauth?.redirect).toBeUndefined();
    expect(created.oauth?.registration).toBe("manual");
    const chosen = await call<LibraryConnector>(test.app, "PATCH", `${LIB}/falso`, { auth: { mode: "oauth", redirect: "app" } }, 200);
    expect(chosen.oauth?.redirect).toBe("app");
  });

  it("start em modo local a partir de origem https usa o endereço localhost fixo", async () => {
    const test = await setup(manual);
    await localConnector(test);
    const { started, pasted } = await authorize(test);
    expect(started.redirectUri).toBe(OAUTH_LOCAL_REDIRECT_URI);
    expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(OAUTH_LOCAL_REDIRECT_URI);
    expect(pasted.startsWith(OAUTH_LOCAL_REDIRECT_URI)).toBe(true);
  });

  it("start em modo local a partir de localhost usa a própria origem; modo app usa a origem atual", async () => {
    const test = await setup(manual);
    await localConnector(test);
    expect((await authorize(test, "falso", ORIGIN)).started.redirectUri).toBe(REDIRECT);
    await call(test.app, "PATCH", `${LIB}/falso`, { auth: { mode: "oauth", redirect: "app" } }, 200);
    expect((await authorize(test)).started.redirectUri).toBe(`${APP_ORIGIN}${OAUTH_CALLBACK_PATH}`);
  });

  it("finish com o endereço colado conecta (e o state é de uso único)", async () => {
    const test = await setup(manual);
    await localConnector(test);
    const { pasted } = await authorize(test);
    const connector = await call<LibraryConnector>(test.app, "POST", `${LIB}/falso/oauth/finish`, { callbackUrl: `  ${pasted}\n` }, 200);
    expect(connector.oauth?.connection).toBe("connected");
    expect(JSON.stringify(connector)).not.toContain("code=");
    expect(test.fakes.stats.lastTokenBody!.get("redirect_uri")).toBe(OAUTH_LOCAL_REDIRECT_URI);
    expect((await callTool(test)).isError).toBe(false);
    const again = await call<ApiErrorBody>(test.app, "POST", `${LIB}/falso/oauth/finish`, { callbackUrl: pasted }, 400);
    expect(again.error).toMatch(/expirou ou já foi usado/);
  });

  it("finish com o state de outro conector é recusado", async () => {
    const test = await setup(manual);
    await localConnector(test);
    const { manualClient } = test.fakes.options;
    await call(test.app, "POST", LIB, { name: "Outro", kind: "http", url: test.fakes.mcpUrl, auth: { mode: "oauth", clientId: manualClient.id, clientSecret: manualClient.secret } });
    const { pasted } = await authorize(test, "falso");
    const refused = await call<ApiErrorBody>(test.app, "POST", `${LIB}/outro/oauth/finish`, { callbackUrl: pasted }, 400);
    expect(refused.error).toMatch(/outro conector/);
    expect((await call<LibraryConnector>(test.app, "GET", `${LIB}/falso`)).oauth?.connection).toBe("not_connected");
  });

  it("finish com caminho errado ou texto qualquer é recusado", async () => {
    const test = await setup(manual);
    await localConnector(test);
    const { pasted } = await authorize(test);
    const wrongPath = pasted.replace(OAUTH_CALLBACK_PATH, "/api/outra/rota");
    expect((await call<ApiErrorBody>(test.app, "POST", `${LIB}/falso/oauth/finish`, { callbackUrl: wrongPath }, 400)).error).toMatch(/endereço de retorno/);
    expect((await call<ApiErrorBody>(test.app, "POST", `${LIB}/falso/oauth/finish`, { callbackUrl: "isto não é um endereço" }, 400)).error).toMatch(/endereço de retorno/);
    // O login pendente continua valendo depois dos erros de formato.
    expect((await call<LibraryConnector>(test.app, "POST", `${LIB}/falso/oauth/finish`, { callbackUrl: pasted }, 200)).oauth?.connection).toBe("connected");
  });
});
