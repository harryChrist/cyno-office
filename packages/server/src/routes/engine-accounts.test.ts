import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_ACCOUNTS_PATH,
  engineAccountItemPath,
  type ActivityEntry,
  type EngineAccountResponse,
  type EngineAccountsResponse,
  MAX_ACCOUNTS_PER_ENGINE,
  type UsageRefreshResponse,
} from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { ActivityLog, setActivityLog } from "../workspace/activity/log";
import { seedDataDir } from "../workspace/office/seed";

const setupApp = useTestApp();
const tempDir = useTempDirs();

afterEach(() => {
  setActivityLog(undefined);
});

const CLAUDE_BODY = {
  five_hour: { utilization: 42, resets_at: "2026-11-23T15:00:00Z" },
  seven_day: { utilization: 55, resets_at: "2026-11-29T00:00:00Z" },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("API: contas extras por motor (/api/engines/accounts)", () => {
  it("CRUD completo, validações, 404/409, teto técnico por motor, sem vazar pasta nem credencial e com registro na Atividade", async () => {
    const fakeHome = await tempDir();
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const activityLog = new ActivityLog({ dataDir });
    const entries: ActivityEntry[] = [];
    activityLog.onAppend((entry) => entries.push(entry));

    const test = await setupApp({
      dataDir,
      activity: activityLog,
      engineAccounts: { realHomeDir: fakeHome },
    });

    // Lista inicial traz só as contas padrão sintéticas (`padrao`, `isDefault: true`, `loggedIn: false`).
    expect(await call<EngineAccountsResponse>(test.app, "GET", ENGINE_ACCOUNTS_PATH)).toEqual({
      accounts: [
        { id: "padrao", engine: "claude", label: "Padrão", isDefault: true, loggedIn: false },
        { id: "padrao", engine: "gemini", label: "Padrão", isDefault: true, loggedIn: false },
      ],
    });

    // Conta padrão não pode ser renomeada nem apagada.
    await call(test.app, "PATCH", engineAccountItemPath("padrao"), { label: "Outro" }, 400);
    await call(test.app, "DELETE", engineAccountItemPath("padrao"), undefined, 400);

    // Validação do body (motor inválido, rótulo vazio, campo desconhecido)
    await call(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "freebuff", label: "X" }, 400);
    await call(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: "   " }, 400);
    await call(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: "Ok", dir: "/tmp" }, 400);

    // Criação (201) sem expor caminho em disco
    const createdRes = await test.app.inject({ method: "POST", url: ENGINE_ACCOUNTS_PATH, payload: { engine: "claude", label: "Trabalho" } });
    expect(createdRes.statusCode).toBe(201);
    expect(createdRes.body).not.toContain(dataDir);
    expect(createdRes.body).not.toContain("platform");
    const { account: claude1 } = createdRes.json<EngineAccountResponse>();
    expect(claude1).toMatchObject({ id: "trabalho", engine: "claude", label: "Trabalho" });

    // Rótulo repetido no mesmo motor = 409; em motor diferente = 201
    await call(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: "trabalho" }, 409);
    const { account: gemini1 } = await call<EngineAccountResponse>(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "gemini", label: "Trabalho" }, 201);
    expect(gemini1.engine).toBe("gemini");

    // PATCH renomeia; id desconhecido ou malicioso = 404; duplicado no mesmo motor = 409
    const { account: claude2 } = await call<EngineAccountResponse>(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: "Secundária" }, 201);
    await call(test.app, "PATCH", engineAccountItemPath("nao-existe"), { label: "X" }, 404);
    await call(test.app, "PATCH", engineAccountItemPath("ab"), { label: "X" }, 404);
    await call(test.app, "PATCH", engineAccountItemPath(claude2.id), { label: "Trabalho" }, 409);
    const { account: renamed } = await call<EngineAccountResponse>(test.app, "PATCH", engineAccountItemPath(claude2.id), { label: "Equipe B" }, 200);
    expect(renamed.label).toBe("Equipe B");

    // Teto técnico de contas por motor
    for (let i = 3; i <= MAX_ACCOUNTS_PER_ENGINE; i += 1) {
      await call(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: `Conta ${i}` }, 201);
    }
    await call(test.app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: `Conta ${MAX_ACCOUNTS_PER_ENGINE + 1}` }, 409);

    // DELETE remove (204) e segundo DELETE dá 404
    const del = await test.app.inject({ method: "DELETE", url: engineAccountItemPath(claude1.id) });
    expect(del.statusCode).toBe(204);
    await call(test.app, "DELETE", engineAccountItemPath(claude1.id), undefined, 404);
    await call(test.app, "DELETE", engineAccountItemPath("nao-existe"), undefined, 404);

    // Lista final sem a conta removida e sem nenhum caminho em disco
    const listRes = await test.app.inject({ method: "GET", url: ENGINE_ACCOUNTS_PATH });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).not.toContain(dataDir);
    const list = listRes.json<EngineAccountsResponse>();
    expect(list.accounts.some((item) => item.id === claude1.id)).toBe(false);
    expect(list.accounts.some((item) => item.id === gemini1.id)).toBe(true);

    // Atividade registrou criar, renomear e remover (em pt-BR, ator usuario, sem caminho)
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("conta_motor_criada");
    expect(actions).toContain("conta_motor_renomeada");
    expect(actions).toContain("conta_motor_removida");
    expect(entries.every((entry) => entry.actor === "usuario")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(dataDir);
    expect(JSON.stringify(entries)).not.toContain(fakeHome);

    await activityLog.close();
  });

  it("todas as rotas de contas ficam atrás da autenticação existente", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    await seedDataDir(dataDir);
    const app = await buildApp({ dataDir, auth: { open: false }, engineAccounts: { realHomeDir: fakeHome } });
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: ENGINE_ACCOUNTS_PATH })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: ENGINE_ACCOUNTS_PATH, payload: { engine: "claude", label: "A" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "PATCH", url: engineAccountItemPath("conta-a"), payload: { label: "B" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "DELETE", url: engineAccountItemPath("conta-a") })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("integra com AccountPollerManager e POST /api/usage/refresh por accountId (mínimo de 30 s por conta)", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    await seedDataDir(dataDir);

    let clock = Date.parse("2026-11-23T12:00:00Z");
    const now = () => new Date(clock);
    const defaultCreds = path.join(dataDir, "default-creds.json");
    await writeFile(defaultCreds, JSON.stringify({ claudeAiOauth: { accessToken: "tok-padrao" } }));

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      const pct = auth === "Bearer tok-extra" ? 77 : 22;
      return json(200, { ...CLAUDE_BODY, five_hour: { utilization: pct, resets_at: "2026-11-23T15:00:00Z" } });
    });

    const app = await buildApp({
      auth: { open: true },
      dataDir,
      now,
      engineAccounts: { realHomeDir: fakeHome },
      accountUsage: { credentialsFile: defaultCreds, fetch: fetchFn as unknown as typeof globalThis.fetch, intervalMs: 0 },
    });
    await app.ready();
    try {
      await vi.waitFor(() => expect(app.workspaces.usage.get("claude")?.source).toBe("account"));

      // Cria conta extra e grava .credentials.json na pasta isolada dela
      const { account } = await call<EngineAccountResponse>(app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "claude", label: "Extra" }, 201);
      // A consulta automática disparada ao criar falha por falta de credenciais (não derruba a padrão)
      await vi.waitFor(() => expect(app.workspaces.usage.get("claude", account.id)?.stale).toBeDefined());
      expect(app.workspaces.usage.get("claude")?.stale).toBeUndefined();
      expect(app.workspaces.usage.get("claude")?.windows[0]?.utilization).toBe(0.22);

      // Grava credenciais válidas na conta extra e testa limite de 30 s + refresh manual
      const accountCreds = path.join(dataDir, "platform", "engines", "claude", "accounts", account.id, ".credentials.json");
      await writeFile(accountCreds, JSON.stringify({ claudeAiOauth: { accessToken: "tok-extra" } }));

      clock += 10_000;
      const throttled = await call<UsageRefreshResponse>(app, "POST", "/api/usage/refresh", { provider: "claude", accountId: account.id }, 200);
      expect(throttled.refreshed).toBe(false);

      clock += 25_000;
      const refreshed = await call<UsageRefreshResponse>(app, "POST", "/api/usage/refresh", { provider: "claude", accountId: account.id }, 200);
      expect(refreshed.refreshed).toBe(true);
      expect(refreshed.accountId).toBe(account.id);
      expect(refreshed.usage).toMatchObject({ provider: "claude", accountId: account.id, source: "account" });
      expect(refreshed.usage?.windows[0]?.utilization).toBe(0.77);

      // Conta desconhecida ou de outro motor -> 404; motor desligado (gemini) -> 503
      await call(app, "POST", "/api/usage/refresh", { provider: "claude", accountId: "nao-existe" }, 404);
      await call(app, "POST", "/api/usage/refresh", { provider: "gemini", accountId: account.id }, 404);
      const { account: geminiAcc } = await call<EngineAccountResponse>(app, "POST", ENGINE_ACCOUNTS_PATH, { engine: "gemini", label: "Google Extra" }, 201);
      await call(app, "POST", "/api/usage/refresh", { provider: "gemini", accountId: geminiAcc.id }, 503);

      // Remover conta esquece o uso dela sem mexer na conta padrão
      await call(app, "DELETE", engineAccountItemPath(account.id), undefined, 204);
      expect(app.workspaces.usage.get("claude", account.id)).toBeUndefined();
      expect(app.workspaces.usage.get("claude")?.windows[0]?.utilization).toBe(0.22);
    } finally {
      await app.close();
    }
  });
});
