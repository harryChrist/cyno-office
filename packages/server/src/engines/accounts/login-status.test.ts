import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "@cyno/shared";
import type { EngineBinary, EngineProbe } from "../terminals/engines";
import { EngineAccountStore } from "./account-store";
import {
  AGY_PROBE_CACHE_MS,
  AGY_PROBE_TIMEOUT_MS,
  AccountLoginChecker,
  LOGIN_CACHE_TTL_MS,
  agyTokenFile,
  agyUsageSucceeded,
  type AccountLoginCheckerOptions,
} from "./login-status";

describe("AccountLoginChecker (estado de login por conta + cache curto)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });
  const temp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyno-login-status-"));
    dirs.push(dir);
    return dir;
  };

  it("Agy: falso sem arquivo, verdadeiro com o arquivo, e NUNCA lê o conteúdo do token", async () => {
    const root = await temp();
    const dataDir = path.join(root, "data");
    const fakeRealHome = path.join(root, "real-home");
    await mkdir(fakeRealHome, { recursive: true });

    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeRealHome });
    const account = await store.create("gemini", "Google Trabalho");
    const probe = vi.fn<EngineProbe>(async () => ({ ok: false, stdout: "" }));

    let clock = 1_000_000;
    const checker = new AccountLoginChecker({
      store,
      resolveBinary: (engine) => ({ command: engine === "claude" ? "claude" : "agy" }),
      realHomeDir: fakeRealHome,
      probe,
      now: () => clock,
      platform: "linux",
    });

    // Sem arquivo: falso para padrão e conta extra.
    expect(await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(false);
    expect(await checker.check({ engine: "gemini", accountId: account.id, isDefault: false })).toBe(false);

    // Cria o arquivo na conta extra com permissão 0o000 (ninguém pode LER o conteúdo, só stat na pasta 0o700).
    const accountHome = store.profileEnv(account).HOME!;
    const tokenFile = agyTokenFile(accountHome);
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, "TOKEN-SECRETO-NAO-LER", { mode: 0o600 });
    await chmod(tokenFile, 0o000);

    try {
      // Cache de 10 s ainda segura o resultado anterior.
      expect(await checker.check({ engine: "gemini", accountId: account.id, isDefault: false })).toBe(false);
      // checkFresh ignora o cache e detecta o arquivo mesmo com modo 0o000 (prova que não lê o conteúdo).
      expect(await checker.checkFresh({ engine: "gemini", accountId: account.id, isDefault: false })).toBe(true);
      // Conta padrão continua falsa.
      clock += LOGIN_CACHE_TTL_MS + 1;
      expect(await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(false);

      // Cria o arquivo no HOME real falso -> conta padrão vira verdadeira.
      const defaultToken = agyTokenFile(fakeRealHome);
      await mkdir(path.dirname(defaultToken), { recursive: true });
      await writeFile(defaultToken, "TOKEN-PADRAO", { mode: 0o600 });
      clock += LOGIN_CACHE_TTL_MS + 1;
      expect(await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(true);
      // Nenhum processo foi disparado para o Antigravity.
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await chmod(tokenFile, 0o600).catch(() => undefined);
    }
  });

  it("Claude: roda `auth status` com CLAUDE_CONFIG_DIR da conta, lê só `loggedIn` e faz cache de 10 s", async () => {
    const root = await temp();
    const dataDir = path.join(root, "data");
    const fakeRealHome = path.join(root, "real-home");
    await mkdir(fakeRealHome, { recursive: true });

    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeRealHome });
    const account = await store.create("claude", "Anthropic Equipe");
    const calls: { command: string; args: string[]; env?: Record<string, string> }[] = [];

    const probe: EngineProbe = async (command, args, _timeoutMs, env) => {
      calls.push({ command, args, env });
      if (env?.CLAUDE_CONFIG_DIR === store.profileDir(account)) {
        return { ok: true, stdout: JSON.stringify({ loggedIn: true, email: "segredo@exemplo.com", plan: "max" }) };
      }
      return { ok: false, stdout: JSON.stringify({ loggedIn: false }) };
    };

    let clock = 5_000_000;
    const checker = new AccountLoginChecker({
      store,
      resolveBinary: () => ({ command: "/fake/claude" }),
      realHomeDir: fakeRealHome,
      probe,
      now: () => clock,
      platform: "linux",
    });

    const list1 = await checker.listWithStatus();
    expect(list1).toEqual([
      { id: DEFAULT_ACCOUNT_ID, engine: "claude", label: "Padrão", isDefault: true, loggedIn: false },
      { id: DEFAULT_ACCOUNT_ID, engine: "gemini", label: "Padrão", isDefault: true, loggedIn: false },
      { id: account.id, engine: "claude", label: "Anthropic Equipe", createdAt: account.createdAt, loggedIn: true },
    ]);
    expect(JSON.stringify(list1)).not.toContain("segredo@exemplo.com");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ command: "/fake/claude", args: ["auth", "status"], env: undefined });
    expect(calls[1]).toEqual({ command: "/fake/claude", args: ["auth", "status"], env: { CLAUDE_CONFIG_DIR: store.profileDir(account) } });

    // Dentro de 10 s: cache evita disparar novos processos.
    clock += 5_000;
    await checker.listWithStatus();
    expect(calls).toHaveLength(2);

    // Após 10 s: consulta novamente.
    clock += 6_000;
    await checker.listWithStatus();
    expect(calls).toHaveLength(4);
  });

  it("no Windows (win32), usa USERPROFILE do ambiente como pasta pessoal padrão do Antigravity", async () => {
    const root = await temp();
    const dataDir = path.join(root, "data");
    const winProfile = path.join(root, "win-user");
    const tokenFile = agyTokenFile(winProfile);
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, "fake", { mode: 0o600 });

    const store = await EngineAccountStore.open(dataDir, { realHomeDir: winProfile, platform: "win32" });
    const checker = new AccountLoginChecker({
      store,
      resolveBinary: (engine) => ({ command: engine === "claude" ? "claude" : "agy" }),
      env: { USERPROFILE: winProfile },
      platform: "win32",
      probe: async () => ({ ok: false, stdout: "" }),
    });
    expect(await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(true);
  });
});

describe("Antigravity no Windows (login pelo Gerenciador de Credenciais)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });

  const makeChecker = async (options: {
    platform?: NodeJS.Platform;
    probe?: EngineProbe;
    now?: () => number;
    geminiBinary?: EngineBinary;
    cacheTtlMs?: number;
  } = {}) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyno-login-agy-win-"));
    dirs.push(root);
    const realHomeDir = path.join(root, "real-home");
    const extraHomeDir = path.join(root, "extra-home");
    await mkdir(realHomeDir, { recursive: true });
    await mkdir(extraHomeDir, { recursive: true });

    const store: AccountLoginCheckerOptions["store"] = {
      list: () => [],
      get: () => undefined,
      profileEnv: () => ({ USERPROFILE: extraHomeDir, HOME: extraHomeDir }),
    };

    const probe = options.probe ?? vi.fn<EngineProbe>(async () => ({ ok: false, stdout: "" }));
    const checker = new AccountLoginChecker({
      store,
      resolveBinary: (engine) => (engine === "gemini" ? (options.geminiBinary ?? { command: "agy" }) : { command: "claude" }),
      realHomeDir,
      probe,
      ...(options.now ? { now: options.now } : {}),
      ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
      platform: options.platform ?? "win32",
    });

    return { checker, realHomeDir, extraHomeDir };
  };

  it("agyUsageSucceeded reconhece SUCCESS na última linha JSON e rejeita demais saídas", () => {
    expect(agyUsageSucceeded('Aviso: inicializando...\r\nOutra linha de log\r\n{"status":"SUCCESS","quota":{}}\r\n')).toBe(true);
    expect(agyUsageSucceeded('{"status":"PENDING"}\n{"status":"SUCCESS"}')).toBe(true);
    expect(agyUsageSucceeded('{"status":"UNAUTHENTICATED"}')).toBe(false);
    expect(agyUsageSucceeded('{"status":"ERROR"}')).toBe(false);
    expect(agyUsageSucceeded("Usuário não autenticado\nFaça login primeiro")).toBe(false);
    expect(agyUsageSucceeded("{json-invalido")).toBe(false);
    expect(agyUsageSucceeded('{"status":"SUCCESS"}\n{json quebrado')).toBe(false);
    expect(agyUsageSucceeded("")).toBe(false);
    expect(agyUsageSucceeded("   \r\n  ")).toBe(false);
  });

  it("win32 sem arquivo de token na conta padrão: loggedIn true quando o probe devolve ok e status SUCCESS", async () => {
    const probe = vi.fn<EngineProbe>(async () => ({
      ok: true,
      stdout: 'Aviso de inicialização\n{"status":"SUCCESS"}',
    }));
    const { checker } = await makeChecker({
      platform: "win32",
      probe,
      geminiBinary: { command: "agy", prefixArgs: ["--no-color"] },
    });

    const loggedIn = await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true });

    expect(loggedIn).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("agy", ["--no-color", "-p", "/usage", "--output-format", "json"], AGY_PROBE_TIMEOUT_MS);
  });

  it("win32 sem arquivo de token na conta padrão: loggedIn false quando status != SUCCESS ou ok false", async () => {
    const probeOutroStatus = vi.fn<EngineProbe>(async () => ({
      ok: true,
      stdout: JSON.stringify({ status: "UNAUTHENTICATED" }),
    }));
    const { checker: checkerOutroStatus } = await makeChecker({ platform: "win32", probe: probeOutroStatus });

    expect(await checkerOutroStatus.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(false);
    expect(probeOutroStatus).toHaveBeenCalledTimes(1);

    const probeFalha = vi.fn<EngineProbe>(async () => ({
      ok: false,
      stdout: JSON.stringify({ status: "SUCCESS" }),
    }));
    const { checker: checkerFalha } = await makeChecker({ platform: "win32", probe: probeFalha });

    expect(await checkerFalha.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(false);
    expect(probeFalha).toHaveBeenCalledTimes(1);
  });

  it("win32 mantém o resultado do probe em cache por AGY_PROBE_CACHE_MS e consulta de novo após expirar", async () => {
    let clock = 2_000_000;
    const probe = vi.fn<EngineProbe>(async () => ({ ok: true, stdout: JSON.stringify({ status: "UNAUTHENTICATED" }) }));
    probe.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ status: "SUCCESS" }) });
    const { checker } = await makeChecker({
      platform: "win32",
      probe,
      now: () => clock,
    });
    const target = { engine: "gemini" as const, accountId: DEFAULT_ACCOUNT_ID, isDefault: true };

    // Primeira consulta dispara o probe.
    expect(await checker.checkFresh(target)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);

    // Dentro de AGY_PROBE_CACHE_MS (mesmo ignorando o cache curto de 10 s via checkFresh): reaproveita o cache do probe.
    clock += AGY_PROBE_CACHE_MS - 1;
    expect(await checker.checkFresh(target)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);

    // Ao atingir AGY_PROBE_CACHE_MS: dispara o probe novamente e atualiza o estado.
    clock += 1;
    expect(await checker.checkFresh(target)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("linux sem arquivo de token: devolve false e NÃO chama o probe", async () => {
    const probe = vi.fn<EngineProbe>(async () => ({ ok: true, stdout: JSON.stringify({ status: "SUCCESS" }) }));
    const { checker } = await makeChecker({ platform: "linux", probe });

    expect(await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("win32 com conta extra (não padrão) sem arquivo de token: devolve false e NÃO chama o probe", async () => {
    const probe = vi.fn<EngineProbe>(async () => ({ ok: true, stdout: JSON.stringify({ status: "SUCCESS" }) }));
    const { checker } = await makeChecker({ platform: "win32", probe });

    expect(await checker.check({ engine: "gemini", accountId: "google-trabalho", isDefault: false })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("win32 com o arquivo de token presente na conta padrão: devolve true sem chamar o probe", async () => {
    const probe = vi.fn<EngineProbe>(async () => ({ ok: false, stdout: "" }));
    const { checker, realHomeDir } = await makeChecker({ platform: "win32", probe });

    const tokenFile = agyTokenFile(realHomeDir);
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, "TOKEN-FAKE", { mode: 0o600 });

    expect(await checker.check({ engine: "gemini", accountId: DEFAULT_ACCOUNT_ID, isDefault: true })).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
