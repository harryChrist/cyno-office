import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "@cyno/shared";
import type { EngineProbe } from "../terminals/engines";
import { EngineAccountStore } from "./account-store";
import { AccountLoginChecker, LOGIN_CACHE_TTL_MS, agyTokenFile } from "./login-status";

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
