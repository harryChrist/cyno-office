import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { EngineAccountStore } from "../accounts/account-store";
import { STALE_REASONS } from "./account-poller";
import { AccountPollerManager } from "./account-pollers";
import { ANTIGRAVITY_STALE_REASONS, type RunCli } from "./antigravity-poller";
import { SubscriptionUsageTracker } from "./subscription-usage";

const tempDir = useTempDirs();
const AGY_RAW = readFileSync(new URL("./fixtures/agy-usage.json", import.meta.url), "utf8");
const CLAUDE_BODY = {
  five_hour: { utilization: 35, resets_at: "2026-11-23T15:00:00Z" },
  seven_day: { utilization: 60, resets_at: "2026-11-29T00:00:00Z" },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AccountPollerManager", () => {
  it("cria poller ao criar conta, isola credenciais/HOME, não derruba outras contas na falta de login e limpa ao remover", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    let clock = Date.parse("2026-11-23T10:00:00Z");
    const now = () => new Date(clock);
    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome, now });
    const tracker = new SubscriptionUsageTracker(now);

    const claudeOk = await store.create("claude", "Trabalho");
    const claudeSemLogin = await store.create("claude", "Nova");
    const geminiOk = await store.create("gemini", "Google Extra");
    const geminiSemLogin = await store.create("gemini", "Google Nova");

    // Só a conta `claudeOk` tem credenciais válidas; `claudeSemLogin` não tem arquivo.
    await writeFile(store.credentialsFile(claudeOk), JSON.stringify({ claudeAiOauth: { accessToken: "tok-trabalho" } }));

    const fetchFn = vi.fn(async () => json(200, CLAUDE_BODY));
    const runCli = vi.fn<RunCli>(async (_command, _args, { env }) => {
      if (env.HOME === store.profileEnv(geminiOk).HOME) return AGY_RAW;
      throw Object.assign(new Error("exit 1"), { code: 1, stderr: "Not logged in" });
    });

    const pollers = new AccountPollerManager({
      store,
      tracker,
      claude: { fetch: fetchFn as unknown as typeof globalThis.fetch, intervalMs: 0 },
      gemini: { run: runCli, command: "agy-falso", intervalMs: 0 },
      staggerMs: 0,
      now,
    });

    pollers.start();
    await pollers.idle();

    expect(tracker.get("claude", claudeOk.id)).toMatchObject({ provider: "claude", accountId: claudeOk.id, source: "account" });
    expect(tracker.get("claude", claudeSemLogin.id)).toMatchObject({ provider: "claude", accountId: claudeSemLogin.id, stale: { reason: STALE_REASONS.noCredentials } });
    expect(tracker.get("gemini", geminiOk.id)).toMatchObject({ provider: "gemini", accountId: geminiOk.id, source: "account" });
    expect(tracker.get("gemini", geminiSemLogin.id)).toMatchObject({ provider: "gemini", accountId: geminiSemLogin.id, stale: { reason: ANTIGRAVITY_STALE_REASONS.login } });
    expect(tracker.get("claude")).toBeUndefined();

    // Refresh manual respeita o mínimo de 30 s por conta de forma independente
    clock += 10_000;
    expect((await pollers.refresh(claudeOk.id))?.refreshed).toBe(false);
    clock += 25_000;
    expect((await pollers.refresh(claudeOk.id))?.refreshed).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // Nova conta adicionada depois do start já dispara o poller
    const claudeExtra = await store.create("claude", "Extra");
    await writeFile(path.join(store.profileEnv(claudeExtra).CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-extra" } }));
    pollers.add(claudeExtra);
    await pollers.idle();
    expect(tracker.get("claude", claudeExtra.id)?.source).toBe("account");

    // Remover para o poller e esquece o uso no tracker
    await pollers.remove(claudeExtra);
    expect(tracker.get("claude", claudeExtra.id)).toBeUndefined();
    expect(tracker.get("claude", claudeOk.id)).toBeDefined();

    pollers.stop();
    await pollers.idle();
  });

  it("quando os pollers padrão estão desligados (sem opções claude/gemini), não cria nenhum poller", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome });
    const tracker = new SubscriptionUsageTracker();
    const acc = await store.create("claude", "Trabalho");

    const pollers = new AccountPollerManager({ store, tracker });
    pollers.start();
    await pollers.idle();

    expect(pollers.getPoller(acc.id)).toBeUndefined();
    expect(await pollers.refresh(acc.id)).toBeUndefined();
    expect(tracker.snapshot()).toEqual([]);
  });
});

describe("AccountPollerManager: muitas contas", () => {
  it("escalona o início dos pollers e limita as consultas simultâneas", async () => {
    const dataDir = await tempDir();
    const fakeHome = await tempDir();
    const store = await EngineAccountStore.open(dataDir, { realHomeDir: fakeHome });
    const tracker = new SubscriptionUsageTracker();
    for (let i = 1; i <= 6; i += 1) {
      const account = await store.create("claude", `Conta ${i}`);
      await writeFile(store.credentialsFile(account), JSON.stringify({ claudeAiOauth: { accessToken: `tok-${i}` } }));
    }
    let running = 0;
    let peak = 0;
    let started = 0;
    const fetchFn = vi.fn(async () => {
      started += 1;
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      return json(200, CLAUDE_BODY);
    });
    const pollers = new AccountPollerManager({
      store,
      tracker,
      claude: { fetch: fetchFn as unknown as typeof globalThis.fetch, intervalMs: 0 },
      concurrency: 2,
      staggerMs: 20,
    });
    pollers.start();
    // Logo após o início só a primeira conta consultou: as outras esperam a vez delas.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBeLessThan(6);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await pollers.idle();
    expect(started).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(tracker.listAccounts("claude")).toHaveLength(6);
    pollers.stop();
  });
});
