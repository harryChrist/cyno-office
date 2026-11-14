import { readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { AUTH_2FA_DISABLE_PATH, AUTH_2FA_ENABLE_PATH, AUTH_2FA_SETUP_PATH, AUTH_COOKIE, AUTH_LOGIN_2FA_PATH, AUTH_SECURITY_PATH, AUTH_SETUP_PATH, AUTH_UNBLOCK_PATH, OFFICE_MCP_PATH, type AuthStatus, type LoginResult, type SecurityState, type TwoFactorEnabled, type TwoFactorSetup } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { useTestApp } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";
import { seedDataDir } from "../../workspace/office/seed";
import { hashPassword, verifyPassword } from "./password";
import { SETUP_CODE_FILE } from "./routes";
import { AuthStore, SESSION_TTL_MS, readAuthFile, resetTotp, writeAuthFile } from "./store";
import { hashRecoveryCode, totpCode } from "./totp";

// scrypt de produção (N = 2^17) leva centenas de ms por hash: os testes que logam várias vezes usam um custo baixo.
vi.setConfig({ testTimeout: 30_000 });
const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keylen: 64 } as const;
const PASSWORD = "senha-de-teste-1";
const setupApp = useTestApp();
const tempDir = useTempDirs();

type App = Awaited<ReturnType<typeof setupApp>>["app"];

const login = (app: App, password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { password }, headers });

/** O "ao_session=..." do Set-Cookie, pronto para o header Cookie. */
function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
}

async function protectedApp() {
  const test = await setupApp({ auth: { open: false } });
  await writeAuthFile(test.dataDir, PASSWORD, new Date(), FAST_SCRYPT);
  return test;
}

describe("hash da senha", () => {
  it("verifica a senha certa e recusa a errada; sal aleatório, parâmetros gravados", async () => {
    const a = await hashPassword("segredo-123");
    const b = await hashPassword("segredo-123");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(a).toMatchObject({ algo: "scrypt", params: { N: 131072, r: 8, p: 1, keylen: 64 } });
    expect(JSON.stringify(a)).not.toContain("segredo-123");
    expect(await verifyPassword("segredo-123", a)).toBe(true);
    expect(await verifyPassword("segredo-124", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("hashes antigos (N = 2^14) continuam valendo, porque os parâmetros ficam gravados", async () => {
    const old = await hashPassword("senha-antiga-1", { N: 16384, r: 8, p: 1, keylen: 64 });
    expect(old.params.N).toBe(16384);
    expect(await verifyPassword("senha-antiga-1", old)).toBe(true);
    expect(await verifyPassword("senha-antiga-2", old)).toBe(false);
  });
});

describe("sessões", () => {
  it("expira 30 dias depois do último uso (deslizante) e sobrevive a reinício", async () => {
    const dir = await tempDir();
    let now = Date.parse("2026-01-01T00:00:00Z");
    await writeAuthFile(dir, PASSWORD);
    const store = new AuthStore(dir, () => new Date(now));
    const token = await store.createSession("Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537");
    expect(await store.validate(token)).toBe(true);

    now += SESSION_TTL_MS - 1000;
    expect(await store.validate(token)).toBe(true); // renova
    now += SESSION_TTL_MS - 1000;
    expect(await store.validate(token)).toBe(true); // ainda dentro de 30 dias do último uso

    // O arquivo só tem o hash do token e um rótulo curto do aparelho.
    await store.flush();
    const file = await readFile(path.join(dir, "auth-sessions.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).toContain("Chrome · Linux");

    const restarted = new AuthStore(dir, () => new Date(now));
    expect(await restarted.validate(token)).toBe(true);
    now += SESSION_TTL_MS + 1000;
    expect(await restarted.validate(token)).toBe(false);
    expect(await restarted.validate(undefined)).toBe(false);
    await Promise.all([store.flush(), restarted.flush()]);
  });

  it("senha nova (auth.json reescrito) invalida as sessões antigas sem reiniciar", async () => {
    const dir = await tempDir();
    await writeAuthFile(dir, PASSWORD);
    const store = new AuthStore(dir);
    const token = await store.createSession(undefined);
    expect(await store.validate(token)).toBe(true);
    await writeAuthFile(dir, "outra-senha-9");
    expect(await store.validate(token)).toBe(false);
    expect(await store.checkPassword("outra-senha-9")).toBe(true);
    await rm(path.join(dir, "auth.json"));
    expect(await store.enabled()).toBe(false);
    await store.flush();
  });
});

describe("CYNO_AUTH=off (open)", () => {
  it("sem senha o app fica aberto e o status diz enabled:false; a configuração inicial fica desligada", async () => {
    const { app } = await setupApp();
    expect((await app.inject({ url: "/api/auth/status" })).json<AuthStatus>()).toEqual({ enabled: false, authenticated: true });
    expect((await app.inject({ url: "/api/workspaces" })).statusCode).toBe(200);
    expect((await login(app, "qualquer")).statusCode).toBe(409);
    const setup = await app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: "AAAA-BBBB-CCCC", password: "senha-de-teste-1" } });
    expect(setup.statusCode).toBe(409);
  });
});

describe("portão com senha", () => {
  it("rotas protegidas dão 401; status, login e health ficam abertos", async () => {
    const { app } = await protectedApp();
    for (const url of ["/api/workspaces", "/api/w/principal/office", "/api/w/principal/media", "/api/w/principal/media/M-0001/file", "/api/engines", "/api/activity/system", "/api/nao-existe", "/api/w/principal/browser/screens"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toEqual({ error: "Sessão ausente ou expirada" });
    }
    expect((await app.inject({ method: "POST", url: "/api/w/principal/media?fileName=a.png", payload: "x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/password", payload: { current: PASSWORD, next: "nova-senha-123" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/status" })).json<AuthStatus>()).toEqual({ enabled: true, authenticated: false });
  });

  it("login certo dá cookie HttpOnly; com ele as rotas abrem; logout fecha", async () => {
    const { app } = await protectedApp();
    expect((await login(app, "errada")).json()).toEqual({ error: "Senha incorreta" });
    const ok = await login(app, PASSWORD);
    expect(ok.statusCode).toBe(200);
    const setCookie = String(ok.headers["set-cookie"]);
    expect(setCookie).toMatch(new RegExp(`^${AUTH_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`));
    const cookie = cookieOf(ok);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/status", headers: { cookie } })).json<AuthStatus>()).toEqual({ enabled: true, authenticated: true });
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie } })).statusCode).toBe(401);
  });

  it("Secure só quando a requisição veio por https (x-forwarded-proto ou cf-visitor)", async () => {
    const { app } = await protectedApp();
    expect(String((await login(app, PASSWORD)).headers["set-cookie"])).not.toContain("Secure");
    expect(String((await login(app, PASSWORD, { "x-forwarded-proto": "https" })).headers["set-cookie"])).toContain("; Secure");
    expect(String((await login(app, PASSWORD, { "x-forwarded-proto": "https,http" })).headers["set-cookie"])).toContain("; Secure");
    expect(String((await login(app, PASSWORD, { "cf-visitor": '{"scheme":"https"}' })).headers["set-cookie"])).toContain("; Secure");
    expect(String((await login(app, PASSWORD, { "x-forwarded-proto": "http" })).headers["set-cookie"])).not.toContain("Secure");
  });

  it("5 senhas erradas do mesmo IP bloqueiam; outro IP segue livre", async () => {
    const { app } = await protectedApp();
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    for (let i = 0; i < 4; i++) expect((await login(app, "errada", from("9.9.9.9"))).statusCode).toBe(401);
    expect((await login(app, "errada", from("9.9.9.9"))).statusCode).toBe(429); // a 5ª já bloqueia
    const blocked = await login(app, PASSWORD, from("9.9.9.9"));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "Muitas tentativas, espere alguns minutos", retryAfterSeconds: 15 * 60 });
    expect(Number(blocked.headers["retry-after"])).toBe(15 * 60);
    expect((await login(app, PASSWORD, from("8.8.8.8"))).statusCode).toBe(200);
  });

  it("trocar a senha derruba as outras sessões e a antiga deixa de entrar", async () => {
    const { app } = await protectedApp();
    const mine = cookieOf(await login(app, PASSWORD));
    const other = cookieOf(await login(app, PASSWORD));
    const wrong = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, payload: { current: "errada", next: "nova-senha-123" } });
    expect(wrong.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, payload: { current: PASSWORD, next: "curta" } })).statusCode).toBe(400);
    const changed = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, payload: { current: PASSWORD, next: "nova-senha-123" } });
    expect(changed.statusCode).toBe(204);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie: other } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie: mine } })).statusCode).toBe(401);
    const fresh = cookieOf(changed);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie: fresh } })).statusCode).toBe(200);
    expect((await login(app, PASSWORD)).statusCode).toBe(401);
    expect((await login(app, "nova-senha-123")).statusCode).toBe(200);
  });

  it("logout-all derruba todas as sessões", async () => {
    const { app } = await protectedApp();
    const a = cookieOf(await login(app, PASSWORD));
    const b = cookieOf(await login(app, PASSWORD));
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: { cookie: a } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie: b } })).statusCode).toBe(401);
  });

  it("o MCP segue só com o token do agente (sem cookie): token ausente ou inválido continua recusado", async () => {
    const { app } = await protectedApp();
    const noToken = await app.inject({ method: "POST", url: OFFICE_MCP_PATH, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toEqual({ error: "Token MCP inválido" });
    const badToken = await app.inject({ method: "POST", url: OFFICE_MCP_PATH, headers: { authorization: "Bearer nao-existe" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(badToken.json()).toEqual({ error: "Token MCP inválido" });
    // Um cookie de sessão não vale como token MCP.
    const cookie = cookieOf(await login(app, PASSWORD));
    expect((await app.inject({ method: "POST", url: OFFICE_MCP_PATH, headers: { cookie }, payload: {} })).json()).toEqual({ error: "Token MCP inválido" });
    expect((await app.inject({ method: "GET", url: OFFICE_MCP_PATH })).statusCode).toBe(405);
  });

  it("WebSockets (eventos, terminal do Maestro, stream do navegador) recusam o upgrade sem sessão e aceitam com ela", async () => {
    const { app } = await protectedApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const cookie = cookieOf(await login(app, PASSWORD));

    const status = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(`ws://${host}${path}`, { headers });
        socket.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
        socket.on("open", () => {
          resolve(101);
          socket.close();
        });
        socket.on("error", () => undefined);
      });

    for (const path of ["/ws", "/ws?workspace=principal", "/api/w/principal/maestro/terminal", "/api/w/principal/browser/stream", "/api/w/principal/terminals/x/stream"]) {
      expect(await status(path), path).toBe(401);
    }
    expect(await status("/ws", { cookie })).toBe(101);
  });
});

/** Um IP "de fora" como o proxy do Vite o põe no fim do x-forwarded-for. */
const from = (ip: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": ip, ...extra });
const CODE_PATTERN = /[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}/;

/** App fechado, sem senha, capturando o quadro com o código de configuração. */
async function freshInstall(extra: { now?: () => Date } = {}) {
  const lines: string[] = [];
  const test = await setupApp({ auth: { open: false, announce: (banner) => lines.push(...banner) }, ...extra });
  const code = () => lines.join("\n").match(CODE_PATTERN)?.[0];
  return { ...test, code, lines };
}

describe("seguro desde a instalação (sem auth.json)", () => {
  it("o app não fica aberto: tudo responde 401 menos status, configuração inicial e health", async () => {
    const { app } = await freshInstall();
    expect((await app.inject({ url: "/api/auth/status" })).json<AuthStatus>()).toEqual({ enabled: false, authenticated: false, setupRequired: true });
    for (const url of ["/api/workspaces", "/api/w/principal/office", "/api/engines", "/api/auth/security", "/api/nao-existe"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toEqual({ error: "Configuração inicial pendente: crie a senha" });
    }
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await login(app, "qualquer")).statusCode).toBe(409);
  });

  it("WebSockets também são recusados sem senha criada", async () => {
    const { app } = await freshInstall();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(url);
      socket.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.on("open", () => {
        resolve(101);
        socket.close();
      });
      socket.on("error", () => undefined);
    });
    expect(status).toBe(401);
  });

  it("o server gera um código no formato XXXX-XXXX-XXXX e o mostra de forma bem visível", async () => {
    const { app, code, lines } = await freshInstall();
    await app.ready();
    expect(code()).toMatch(CODE_PATTERN);
    expect(lines.join("\n")).toContain("falta criar a senha");
    // Pedir o status de novo não troca o código.
    const first = code();
    await app.inject({ url: "/api/auth/status" });
    expect(code()).toBe(first);
  });

  it("código certo cria o auth.json (0600), já abre a sessão e invalida o código", async () => {
    const { app, code, dataDir } = await freshInstall();
    await app.ready();
    // O código também fica num arquivo 0600, para o `npm run auth:code` mostrar sem caçar no log.
    const codeFile = path.join(dataDir, SETUP_CODE_FILE);
    expect((await readFile(codeFile, "utf8")).trim()).toBe(code());
    expect((await stat(codeFile)).mode & 0o777).toBe(0o600);
    const done = await app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: code(), password: PASSWORD } });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ enabled: true, authenticated: true });
    await expect(stat(codeFile)).rejects.toThrow();
    expect((await stat(path.join(dataDir, "auth.json"))).mode & 0o777).toBe(0o600);
    const cookie = cookieOf(done);
    expect((await app.inject({ url: "/api/workspaces", headers: { cookie } })).statusCode).toBe(200);
    expect((await login(app, PASSWORD)).statusCode).toBe(200);
    // Reuso do código: a senha já existe.
    const again = await app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: code(), password: "outra-senha-99" } });
    expect(again.statusCode).toBe(409);
    expect((await login(app, "outra-senha-99")).statusCode).toBe(401);
  });

  it("aceita o código em minúsculas, sem hífen ou com espaços", async () => {
    const { app, code } = await freshInstall();
    await app.ready();
    const typed = code()!.toLowerCase().replaceAll("-", " ");
    expect((await app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: typed, password: PASSWORD } })).statusCode).toBe(200);
  });

  it("código errado dá 403 e conta no bloqueio por IP; o certo, depois do bloqueio, também é recusado", async () => {
    const { app, code } = await freshInstall();
    await app.ready();
    const setup = (codeValue: string, ip: string) => app.inject({ method: "POST", url: AUTH_SETUP_PATH, headers: from(ip), payload: { code: codeValue, password: PASSWORD } });
    for (let i = 0; i < 4; i++) {
      const wrong = await setup("AAAA-AAAA-AAAA", "9.9.9.9");
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toEqual({ error: "Código de configuração incorreto" });
    }
    const fifth = await setup("AAAA-AAAA-AAAA", "9.9.9.9");
    expect(fifth.statusCode).toBe(429);
    expect(Number(fifth.headers["retry-after"])).toBe(15 * 60);
    // Bloqueado: nem o código certo passa.
    expect((await setup(code()!, "9.9.9.9")).statusCode).toBe(429);
    // Outro IP segue livre.
    expect((await setup(code()!, "8.8.8.8")).statusCode).toBe(200);
  });

  it("senha curta é recusada sem gastar o código", async () => {
    const { app, code } = await freshInstall();
    await app.ready();
    expect((await app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: code(), password: "curta" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: code(), password: PASSWORD } })).statusCode).toBe(200);
  });

  it("duas requisições juntas com o código certo criam uma senha só", async () => {
    const { app, code } = await freshInstall();
    await app.ready();
    const results = await Promise.all([PASSWORD, "outra-senha-99"].map((password) => app.inject({ method: "POST", url: AUTH_SETUP_PATH, payload: { code: code(), password } })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
});

describe("IP real e bloqueio nas rotas", () => {
  it("cabeçalhos forjados não escapam do bloqueio: o salto posto pelo proxy é o que vale", async () => {
    const { app } = await protectedApp();
    for (let i = 0; i < 5; i++) {
      // O cliente troca o que manda; o proxy do Vite acrescenta o IP real (192.168.1.20) no fim.
      await login(app, "errada", { "x-forwarded-for": `10.0.0.${i}, 192.168.1.20`, "cf-connecting-ip": `11.0.0.${i}` });
    }
    const blocked = await login(app, PASSWORD, { "x-forwarded-for": "10.9.9.9, 192.168.1.20", "cf-connecting-ip": "11.9.9.9" });
    expect(blocked.statusCode).toBe(429);
  });

  it("túnel local: o cf-connecting-ip vale quando o último salto é loopback", async () => {
    const { app } = await protectedApp();
    const tunnel = (ip: string) => ({ "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": ip });
    for (let i = 0; i < 5; i++) await login(app, "errada", tunnel("203.0.113.9"));
    expect((await login(app, PASSWORD, tunnel("203.0.113.9"))).statusCode).toBe(429);
    expect((await login(app, PASSWORD, tunnel("203.0.113.10"))).statusCode).toBe(200);
  });

  it("5 erros bloqueiam por 15 min e o tempo vem no 429; a escalada dobra; acertar antes zera as falhas", async () => {
    let clock = Date.parse("2026-03-01T12:00:00Z");
    const { app, dataDir } = await setupApp({ now: () => new Date(clock), auth: { open: false } });
    await writeAuthFile(dataDir, PASSWORD, new Date(), FAST_SCRYPT);
    for (let i = 0; i < 4; i++) await login(app, "errada", from("7.7.7.7"));
    expect((await login(app, PASSWORD, from("7.7.7.7"))).statusCode).toBe(200); // acerto zera as 4 falhas
    for (let i = 0; i < 4; i++) expect((await login(app, "errada", from("7.7.7.7"))).statusCode).toBe(401);
    const first = await login(app, "errada", from("7.7.7.7"));
    expect(first.statusCode).toBe(429);
    expect(first.json()).toMatchObject({ retryAfterSeconds: 900 });
    clock += 5 * 60_000;
    expect((await login(app, PASSWORD, from("7.7.7.7"))).headers["retry-after"]).toBe("600");
    clock += 10 * 60_000 + 1000;
    for (let i = 0; i < 4; i++) await login(app, "errada", from("7.7.7.7"));
    const second = await login(app, "errada", from("7.7.7.7"));
    expect(second.json()).toMatchObject({ retryAfterSeconds: 1800 });
  });

  it("trocar a senha com a senha atual errada também conta; o bloqueio vale para a troca", async () => {
    const { app } = await protectedApp();
    const cookie = cookieOf(await login(app, PASSWORD));
    const change = (current: string) => app.inject({ method: "POST", url: "/api/auth/password", headers: from("6.6.6.6", { cookie }), payload: { current, next: "nova-senha-123" } });
    for (let i = 0; i < 4; i++) expect((await change("errada")).statusCode).toBe(403);
    expect((await change("errada")).statusCode).toBe(429);
    expect((await change(PASSWORD)).statusCode).toBe(429);
  });

  it("o bloqueio sobrevive a reiniciar o app (auth-blocks.json)", async () => {
    const dir = await tempDir();
    await seedDataDir(dir);
    await writeAuthFile(dir, PASSWORD, new Date(), FAST_SCRYPT);
    const blocksFile = path.join(dir, "auth-blocks.json");
    const first = await setupApp({ dataDir: dir, auth: { open: false, blocksFile } });
    for (let i = 0; i < 5; i++) await login(first.app, "errada", from("5.5.5.5"));
    await first.app.close(); // fecha e espera a gravação
    const second = await setupApp({ dataDir: dir, auth: { open: false, blocksFile } });
    expect((await login(second.app, PASSWORD, from("5.5.5.5"))).statusCode).toBe(429);
    expect((await login(second.app, PASSWORD, from("5.5.5.6"))).statusCode).toBe(200);
  });

  it("Segurança: lista IPs bloqueados e falhas; desbloquear pela sessão libera o IP; sem sessão, 401", async () => {
    const { app } = await protectedApp();
    expect((await app.inject({ url: AUTH_SECURITY_PATH })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: AUTH_UNBLOCK_PATH, payload: { ip: "4.4.4.4" } })).statusCode).toBe(401);
    for (let i = 0; i < 5; i++) await login(app, "errada", from("4.4.4.4"));
    await login(app, "errada", from("4.4.4.5"));
    const cookie = cookieOf(await login(app, PASSWORD, from("192.168.1.2")));
    const state = (await app.inject({ url: AUTH_SECURITY_PATH, headers: from("192.168.1.2", { cookie }) })).json<SecurityState>();
    expect(state.twoFactor).toBe(false);
    expect(state.yourIp).toBe("192.168.1.2");
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ ip: "4.4.4.4", attempts: 5 });
    expect(Date.parse(state.blocks[0]!.until)).toBeGreaterThan(Date.now());
    expect(state.failures.length).toBe(6);
    expect(state.failures[0]).toMatchObject({ ip: "4.4.4.5", kind: "senha" });
    expect(JSON.stringify(state)).not.toContain("errada");

    expect((await login(app, PASSWORD, from("4.4.4.4"))).statusCode).toBe(429);
    const unblock = await app.inject({ method: "POST", url: AUTH_UNBLOCK_PATH, headers: { cookie }, payload: { ip: "4.4.4.4" } });
    expect(unblock.statusCode).toBe(204);
    expect((await login(app, PASSWORD, from("4.4.4.4"))).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: AUTH_UNBLOCK_PATH, headers: { cookie }, payload: { ip: "4.4.4.4" } })).statusCode).toBe(404);
  });
});

describe("verificação em duas etapas (TOTP)", () => {
  /** App com senha, relógio controlado (passos de 30 s) e uma sessão. */
  async function twoFactorApp() {
    let clock = Date.parse("2026-03-01T12:00:10Z");
    const test = await setupApp({ now: () => new Date(clock), auth: { open: false } });
    await writeAuthFile(test.dataDir, PASSWORD, new Date(), FAST_SCRYPT);
    const cookie = cookieOf(await login(test.app, PASSWORD));
    const advance = (ms: number) => void (clock += ms);
    return { ...test, cookie, now: () => clock, advance };
  }
  type Ctx = Awaited<ReturnType<typeof twoFactorApp>>;

  async function enable(ctx: Ctx) {
    const setup = (await ctx.app.inject({ method: "POST", url: AUTH_2FA_SETUP_PATH, headers: { cookie: ctx.cookie } })).json<TwoFactorSetup>();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.uri).toBe(`otpauth://totp/Cyno?secret=${setup.secret}&issuer=Cyno&algorithm=SHA1&digits=6&period=30`);
    const response = await ctx.app.inject({ method: "POST", url: AUTH_2FA_ENABLE_PATH, headers: { cookie: ctx.cookie }, payload: { code: totpCode(setup.secret, ctx.now()) } });
    expect(response.statusCode).toBe(200);
    return { secret: setup.secret, recoveryCodes: response.json<TwoFactorEnabled>().recoveryCodes };
  }
  /** Avança um passo de 30 s e devolve o código novo. */
  const step = (ctx: Ctx, secret: string) => {
    ctx.advance(30_000);
    return totpCode(secret, ctx.now());
  };
  const second = (ctx: Ctx, token: string, code: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: "POST", url: AUTH_LOGIN_2FA_PATH, headers, payload: { token, code } });

  it("ativa só depois de confirmar um código válido, e mostra 10 códigos de recuperação (guardados só como hash)", async () => {
    const ctx = await twoFactorApp();
    const setup = (await ctx.app.inject({ method: "POST", url: AUTH_2FA_SETUP_PATH, headers: { cookie: ctx.cookie } })).json<TwoFactorSetup>();
    expect((await ctx.app.inject({ url: AUTH_SECURITY_PATH, headers: { cookie: ctx.cookie } })).json<SecurityState>().twoFactor).toBe(false);
    const wrong = await ctx.app.inject({ method: "POST", url: AUTH_2FA_ENABLE_PATH, headers: { cookie: ctx.cookie }, payload: { code: "000000" } });
    expect(wrong.statusCode).toBe(400);
    expect(await readAuthFile(ctx.dataDir).then((file) => file?.totp)).toBeUndefined();

    const ok = await ctx.app.inject({ method: "POST", url: AUTH_2FA_ENABLE_PATH, headers: { cookie: ctx.cookie }, payload: { code: totpCode(setup.secret, ctx.now()) } });
    const { recoveryCodes } = ok.json<TwoFactorEnabled>();
    expect(recoveryCodes).toHaveLength(10);
    const file = await readAuthFile(ctx.dataDir);
    expect(file?.totp?.secret).toBe(setup.secret);
    expect(file?.totp?.recovery).toEqual(recoveryCodes.map(hashRecoveryCode));
    const raw = await readFile(path.join(ctx.dataDir, "auth.json"), "utf8");
    for (const code of recoveryCodes) expect(raw).not.toContain(code);
    expect((await stat(path.join(ctx.dataDir, "auth.json"))).mode & 0o777).toBe(0o600);
    const state = (await ctx.app.inject({ url: AUTH_SECURITY_PATH, headers: { cookie: ctx.cookie } })).json<SecurityState>();
    expect(state).toMatchObject({ twoFactor: true, recoveryRemaining: 10 });
    // Ligar de novo: já está ligado.
    expect((await ctx.app.inject({ method: "POST", url: AUTH_2FA_SETUP_PATH, headers: { cookie: ctx.cookie } })).statusCode).toBe(409);
  });

  it("login em dois passos: a senha certa só dá um token curto (não é sessão); o código certo cria a sessão", async () => {
    const ctx = await twoFactorApp();
    const { secret } = await enable(ctx);
    const first = await login(ctx.app, PASSWORD, from("3.3.3.3"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const body = first.json<LoginResult>();
    expect(body).toMatchObject({ enabled: true, authenticated: false });
    expect(body.twoFactorToken).toBeTruthy();
    // O token não vale como sessão.
    expect((await ctx.app.inject({ url: "/api/workspaces", headers: { cookie: `${AUTH_COOKIE}=${body.twoFactorToken}` } })).statusCode).toBe(401);

    const code = step(ctx, secret);
    const done = await second(ctx, body.twoFactorToken!, code, from("3.3.3.3"));
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ enabled: true, authenticated: true });
    expect((await ctx.app.inject({ url: "/api/workspaces", headers: { cookie: cookieOf(done) } })).statusCode).toBe(200);
    // O token é de uma vez só.
    expect((await second(ctx, body.twoFactorToken!, step(ctx, secret), from("3.3.3.3"))).statusCode).toBe(401);
  });

  it("o mesmo código não vale duas vezes", async () => {
    const ctx = await twoFactorApp();
    const { secret } = await enable(ctx);
    const code = step(ctx, secret);
    const a = (await login(ctx.app, PASSWORD)).json<LoginResult>().twoFactorToken!;
    expect((await second(ctx, a, code)).statusCode).toBe(200);
    const b = (await login(ctx.app, PASSWORD)).json<LoginResult>().twoFactorToken!;
    expect((await second(ctx, b, code)).statusCode).toBe(401);
    expect((await second(ctx, b, step(ctx, secret))).statusCode).toBe(200);
  });

  it("código de recuperação vale uma única vez", async () => {
    const ctx = await twoFactorApp();
    const { recoveryCodes } = await enable(ctx);
    const token = async () => (await login(ctx.app, PASSWORD)).json<LoginResult>().twoFactorToken!;
    const code = recoveryCodes[3]!;
    expect((await second(ctx, await token(), code.toLowerCase())).statusCode).toBe(200);
    expect((await second(ctx, await token(), code)).statusCode).toBe(401);
    expect((await second(ctx, await token(), recoveryCodes[4]!)).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: AUTH_SECURITY_PATH, headers: { cookie: ctx.cookie } })).json<SecurityState>().recoveryRemaining).toBe(8);
  });

  it("códigos errados contam no bloqueio por IP; o token é do IP que digitou a senha", async () => {
    const ctx = await twoFactorApp();
    const { secret } = await enable(ctx);
    const ip = from("2.2.2.2");
    const token = (await login(ctx.app, PASSWORD, ip)).json<LoginResult>().twoFactorToken!;
    for (let i = 0; i < 4; i++) {
      const wrong = await second(ctx, token, "111111", ip);
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({ error: "Código incorreto" });
    }
    const fifth = await second(ctx, token, "111111", ip);
    expect(fifth.statusCode).toBe(429);
    // Bloqueado: nem a senha certa, nem o código certo.
    expect((await login(ctx.app, PASSWORD, ip)).statusCode).toBe(429);
    expect((await second(ctx, token, totpCode(secret, ctx.now() + 30_000), ip)).statusCode).toBe(429);
    // Outro IP não herda o token.
    expect((await second(ctx, token, totpCode(secret, ctx.now() + 30_000), from("2.2.2.3"))).statusCode).toBe(401);
  });

  it("saber a senha não zera as falhas de código", async () => {
    const ctx = await twoFactorApp();
    await enable(ctx);
    const ip = from("1.2.3.4");
    for (let round = 0; round < 4; round++) {
      const token = (await login(ctx.app, PASSWORD, ip)).json<LoginResult>().twoFactorToken!;
      await second(ctx, token, "111111", ip);
    }
    const token = (await login(ctx.app, PASSWORD, ip)).json<LoginResult>().twoFactorToken!;
    expect((await second(ctx, token, "111111", ip)).statusCode).toBe(429);
  });

  it("o token expira em 5 minutos", async () => {
    const ctx = await twoFactorApp();
    const { secret } = await enable(ctx);
    const token = (await login(ctx.app, PASSWORD)).json<LoginResult>().twoFactorToken!;
    ctx.advance(5 * 60_000 + 1000);
    expect((await second(ctx, token, totpCode(secret, ctx.now()))).statusCode).toBe(401);
  });

  it("trocar a senha mantém o 2FA", async () => {
    const ctx = await twoFactorApp();
    await enable(ctx);
    const changed = await ctx.app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: ctx.cookie }, payload: { current: PASSWORD, next: "nova-senha-123" } });
    expect(changed.statusCode).toBe(204);
    expect((await readAuthFile(ctx.dataDir))?.totp).toBeDefined();
    expect((await login(ctx.app, "nova-senha-123")).json<LoginResult>().twoFactorToken).toBeTruthy();
  });

  it("desligar pede a senha E um código; errar conta no bloqueio", async () => {
    const ctx = await twoFactorApp();
    const { secret } = await enable(ctx);
    const disable = (password: string, code: string) => ctx.app.inject({ method: "POST", url: AUTH_2FA_DISABLE_PATH, headers: { cookie: ctx.cookie }, payload: { password, code } });
    expect((await disable("errada", step(ctx, secret))).statusCode).toBe(403);
    expect((await disable(PASSWORD, "000000")).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: AUTH_SECURITY_PATH, headers: { cookie: ctx.cookie } })).json<SecurityState>().twoFactor).toBe(true);
    expect((await disable(PASSWORD, step(ctx, secret))).statusCode).toBe(204);
    expect((await readAuthFile(ctx.dataDir))?.totp).toBeUndefined();
    expect((await login(ctx.app, PASSWORD)).json()).toEqual({ enabled: true, authenticated: true });
    expect((await disable(PASSWORD, "000000")).statusCode).toBe(409);
  });

  it("CLI de emergência (reset-2fa) desliga o 2FA sem mexer na senha", async () => {
    const ctx = await twoFactorApp();
    await enable(ctx);
    expect(await resetTotp(ctx.dataDir)).toBe(true);
    expect(await resetTotp(ctx.dataDir)).toBe(false);
    expect((await readAuthFile(ctx.dataDir))?.totp).toBeUndefined();
    expect((await login(ctx.app, PASSWORD)).json()).toEqual({ enabled: true, authenticated: true });
  });

  it("rotas do 2FA exigem sessão", async () => {
    const ctx = await twoFactorApp();
    for (const url of [AUTH_2FA_SETUP_PATH, AUTH_2FA_ENABLE_PATH, AUTH_2FA_DISABLE_PATH]) {
      expect((await ctx.app.inject({ method: "POST", url, payload: { code: "000000", password: PASSWORD } })).statusCode, url).toBe(401);
    }
  });
});
