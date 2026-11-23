import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_LOGIN_PATH,
  ENGINE_ACCOUNTS_PATH,
  engineAccountLoginPath,
  type EngineAccountResponse,
  type EngineAccountsResponse,
  type EngineLoginServerMessage,
} from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app";
import { useTempDirs } from "../dev/test-utils";
import { agyTokenFile } from "../engines/accounts/login-status";
import { AuthStore } from "../platform/auth/store";
import { ActivityLog, setActivityLog } from "../workspace/activity/log";
import { seedDataDir } from "../workspace/office/seed";

const FAKE_LOGIN = fileURLToPath(new URL("../engines/terminals/fake-login.mjs", import.meta.url));
const PASSWORD = "senha-segura-teste-123";
const tempDir = useTempDirs();

afterEach(() => {
  setActivityLog(undefined);
});

async function makeWrapper(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_LOGIN}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const res = await app.inject({ method: "POST", url: AUTH_LOGIN_PATH, payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0]! : String(raw ?? "");
  return header.split(";")[0]!;
}

function wsConnect(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body?: string; socket?: WebSocket; messages: EngineLoginServerMessage[] }> {
  return new Promise((resolve) => {
    const messages: EngineLoginServerMessage[] = [];
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body, messages });
        socket.terminate();
      });
    });
    socket.on("message", (raw: Buffer) => {
      messages.push(JSON.parse(raw.toString("utf8")) as EngineLoginServerMessage);
    });
    socket.on("open", () => {
      resolve({ status: 101, socket, messages });
    });
    socket.on("error", () => undefined);
  });
}

async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("tempo esgotado esperando condição no WebSocket de login");
}

describe("WebSocket de login de contas (/api/engines/accounts/:id/login)", () => {
  it("recusa sem cookie (401), recusa quando CYNO_AUTH=off (403) e responde 404/409 para conta ausente ou motor não instalado", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const fakeHome = path.join(root, "fake-home");
    await mkdir(fakeHome, { recursive: true });
    await seedDataDir(dataDir);

    // 1) App com CYNO_AUTH=off (sem senha): recusa abrir login pelo navegador (403).
    const openApp = await buildApp({
      dataDir,
      auth: { open: true, failDelayMs: 0, blocksFile: null },
      engineAccounts: { realHomeDir: fakeHome },
      terminals: { claude: { command: "/nao-existe/claude" }, gemini: { command: "/nao-existe/agy" } },
    });
    await openApp.ready();
    try {
      const res = await openApp.inject({ method: "GET", url: engineAccountLoginPath("padrao", "claude") });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toMatch(/senha|CYNO_AUTH/i);
    } finally {
      await openApp.close();
    }

    // 2) App protegido por senha: sem cookie recusa upgrade (401); com cookie valida 404 e 409.
    const authStore = new AuthStore(dataDir);
    await authStore.setPassword(PASSWORD);
    const app = await buildApp({
      dataDir,
      auth: { open: false, failDelayMs: 0, blocksFile: null },
      engineAccounts: { realHomeDir: fakeHome },
      engineTools: { pathEnv: "/nao-existe", homeDir: fakeHome },
      terminals: { claude: { command: "/nao-existe/claude" }, gemini: { command: "/nao-existe/agy" } },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const cookie = await loginCookie(app);
      const createRes = await app.inject({
        method: "POST",
        url: ENGINE_ACCOUNTS_PATH,
        headers: { cookie },
        payload: { engine: "claude", label: "Conta Teste" },
      });
      expect(createRes.statusCode).toBe(201);
      const { account } = createRes.json<EngineAccountResponse>();

      // Upgrade WS sem cookie -> 401.
      const noCookie = await wsConnect(`ws://${host}${engineAccountLoginPath(account.id)}`);
      expect(noCookie.status).toBe(401);

      // Conta desconhecida -> 404.
      const unknown = await wsConnect(`ws://${host}${engineAccountLoginPath("nao-existe")}`, { cookie });
      expect(unknown.status).toBe(404);

      // Conta padrao sem ?engine -> 400.
      const missingEngine = await wsConnect(`ws://${host}${engineAccountLoginPath("padrao")}`, { cookie });
      expect(missingEngine.status).toBe(400);

      // Motor sem binário instalado -> 409 em pt-BR.
      const notInstalled = await wsConnect(`ws://${host}${engineAccountLoginPath(account.id)}`, { cookie });
      expect(notInstalled.status).toBe(409);
      expect(notInstalled.body).toMatch(/não está instalado/i);
    } finally {
      await app.close();
    }
  });

  it("fluxo completo com cookie e fake-login.mjs (Antigravity e Claude): link, código, login=true, encerra, 409 na 2ª sessão e sem vazar conteúdo na Atividade", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const fakeHome = path.join(root, "fake-home");
    const binDir = path.join(root, "bin");
    await mkdir(fakeHome, { recursive: true });
    await seedDataDir(dataDir);

    const fakeAgy = await makeWrapper(binDir, "agy");
    const fakeClaude = await makeWrapper(binDir, "claude");
    const authStore = new AuthStore(dataDir);
    await authStore.setPassword(PASSWORD);
    const activityLog = new ActivityLog({ dataDir, flushMs: 1_000_000 });

    const app = await buildApp({
      dataDir,
      activity: activityLog,
      auth: { open: false, failDelayMs: 0, blocksFile: null },
      engineAccounts: { realHomeDir: fakeHome, loginCacheTtlMs: 0 },
      engineTools: { pathEnv: binDir, homeDir: fakeHome },
      engineLogin: { pollIntervalMs: 120, successGraceMs: 150, detachGraceMs: 5_000 },
      terminals: {
        claude: { command: fakeClaude },
        gemini: { command: fakeAgy },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const host = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    try {
      const cookie = await loginCookie(app);
      const agyCreate = await app.inject({
        method: "POST",
        url: ENGINE_ACCOUNTS_PATH,
        headers: { cookie },
        payload: { engine: "gemini", label: "Google Extra" },
      });
      expect(agyCreate.statusCode).toBe(201);
      const { account: agyAcc } = agyCreate.json<EngineAccountResponse>();
      const claudeCreate = await app.inject({
        method: "POST",
        url: ENGINE_ACCOUNTS_PATH,
        headers: { cookie },
        payload: { engine: "claude", label: "Claude Extra" },
      });
      expect(claudeCreate.statusCode).toBe(201);
      const { account: claudeAcc } = claudeCreate.json<EngineAccountResponse>();

      // Abre WS de login para a conta Antigravity.
      const conn = await wsConnect(`ws://${host}${engineAccountLoginPath(agyAcc.id)}`, { cookie });
      expect(conn.status).toBe(101);

      await waitFor(() => conn.messages.find((m) => m.type === "hello"));
      expect(conn.messages[0]).toEqual({ type: "hello", engine: "gemini", label: "Google Extra" });

      // Segunda sessão enquanto a primeira está aberta -> 409 em pt-BR.
      const second = await wsConnect(`ws://${host}${engineAccountLoginPath(claudeAcc.id)}`, { cookie });
      expect(second.status).toBe(409);
      expect(second.body).toMatch(/sessão de login aberta/i);

      // Aguarda o link de login na saída do PTY.
      await waitFor(() =>
        conn.messages
          .filter((m) => m.type === "out" || m.type === "replay")
          .map((m) => m.data)
          .join("")
          .includes("https://accounts.google.com/o/oauth2/auth"),
      );

      // Envia resize e cola o código falso.
      conn.socket!.send(JSON.stringify({ type: "resize", cols: 90, rows: 25 }));
      conn.socket!.send(JSON.stringify({ type: "in", data: "CODIGO-SECRETO-AGY-999\r" }));

      // Recebe login=true e depois exit.
      await waitFor(() => conn.messages.find((m) => m.type === "login" && m.loggedIn === true));
      await waitFor(() => conn.messages.find((m) => m.type === "exit"));
      conn.socket!.close();

      // Token foi gravado na pasta isolada da conta (e NUNCA no HOME real).
      const isolatedHome = path.join(dataDir, "platform", "engines", "gemini", "accounts", agyAcc.id, "home");
      expect(existsSync(agyTokenFile(isolatedHome))).toBe(true);
      expect(existsSync(agyTokenFile(fakeHome))).toBe(false);

      // Fluxo completo para Claude agora que a vaga foi liberada.
      const claudeConn = await wsConnect(`ws://${host}${engineAccountLoginPath(claudeAcc.id)}`, { cookie });
      expect(claudeConn.status).toBe(101);
      await waitFor(() =>
        claudeConn.messages
          .filter((m) => m.type === "out" || m.type === "replay")
          .map((m) => m.data)
          .join("")
          .includes("https://claude.ai/oauth/authorize"),
      );
      claudeConn.socket!.send(JSON.stringify({ type: "in", data: "CODIGO-SECRETO-CLAUDE-777\r" }));
      await waitFor(() => claudeConn.messages.find((m) => m.type === "login" && m.loggedIn === true));
      await waitFor(() => claudeConn.messages.find((m) => m.type === "exit"));
      claudeConn.socket!.close();

      // GET /api/engines/accounts agora reflete loggedIn=true nas duas contas extras (e false nas padrão).
      const listRes = await app.inject({ method: "GET", url: ENGINE_ACCOUNTS_PATH, headers: { cookie } });
      expect(listRes.statusCode).toBe(200);
      const { accounts } = listRes.json<EngineAccountsResponse>();
      expect(accounts.find((a) => a.id === agyAcc.id)?.loggedIn).toBe(true);
      expect(accounts.find((a) => a.id === claudeAcc.id)?.loggedIn).toBe(true);
      expect(accounts.find((a) => a.id === "padrao" && a.engine === "gemini")?.loggedIn).toBe(false);

      // Atividade registrou abertura e conclusão sem NENHUM link, code_challenge ou código colado.
      await activityLog.flush();
      const texts: string[] = [];
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
          if (entry.isDirectory()) await walk(path.join(folder, entry.name));
          else texts.push(await readFile(path.join(folder, entry.name), "utf8"));
        }
      };
      await walk(path.join(dataDir, "activity"));
      const joined = texts.join("\n");
      expect(joined).toContain("conta_motor_login_aberto");
      expect(joined).toContain("conta_motor_login_concluido");
      expect(joined).not.toContain("code_challenge");
      expect(joined).not.toContain("CODIGO-SECRETO-AGY-999");
      expect(joined).not.toContain("CODIGO-SECRETO-CLAUDE-777");
      expect(joined).not.toContain("https://accounts.google.com");
      expect(joined).not.toContain("https://claude.ai");
    } finally {
      await activityLog.close();
      await app.close();
    }
  }, 20_000);
});
