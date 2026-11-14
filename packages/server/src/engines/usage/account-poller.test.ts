import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import { seedDataDir } from "../../workspace/office/seed";
import { useTempDirs } from "../../dev/test-utils";
import { AccountUsagePoller, CLAUDE_USAGE_URL, STALE_REASONS } from "./account-poller";
import { SubscriptionUsageTracker } from "./subscription-usage";
import { loadUsageFile, persistUsage, saveUsageFile } from "./usage-file";

const TOKEN = "sk-ant-oat01-SEGREDO-de-teste-nao-vaza";
const BODY = {
  five_hour: { utilization: 24, resets_at: "2026-11-08T07:40:00.93+00:00" },
  seven_day: { utilization: 47, resets_at: "2026-11-08T20:00:00.93+00:00" },
  limits: [
    { kind: "session", percent: 24, severity: "normal", resets_at: "2026-11-08T07:40:00.93+00:00", scope: null },
    { kind: "weekly_all", percent: 47, severity: "normal", resets_at: "2026-11-08T20:00:00.93+00:00", scope: null },
    { kind: "weekly_scoped", percent: 85, severity: "warning", resets_at: "2026-11-08T20:00:00.93+00:00", scope: "opus" },
  ],
};

const tempDir = useTempDirs();
afterEach(() => {
  vi.useRealTimers();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function setup(options: { credentials?: unknown; respond?: () => Response | Promise<Response> } = {}) {
  const dir = await tempDir();
  const credentialsFile = path.join(dir, ".credentials.json");
  if (options.credentials !== null) {
    const credentials = options.credentials ?? { claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.parse("2026-11-09T00:00:00Z") } };
    await writeFile(credentialsFile, JSON.stringify(credentials));
  }
  let clock = Date.parse("2026-11-08T05:00:00Z");
  const now = () => new Date(clock);
  const advance = (ms: number) => (clock += ms);
  const tracker = new SubscriptionUsageTracker(now);
  const events: ServerEvent[] = [];
  tracker.hub.subscribe((event) => events.push(event));
  const logs: unknown[] = [];
  const log = { debug: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) };
  const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => (options.respond ? options.respond() : json(200, BODY)));
  const poller = new AccountUsagePoller({ tracker, credentialsFile, fetch: fetch as unknown as typeof globalThis.fetch, now, log, intervalMs: 180_000, backoffMs: 600_000 });
  return { dir, credentialsFile, tracker, events, logs, fetch, poller, advance };
}

describe("AccountUsagePoller", () => {
  it("consulta o endpoint com o token do arquivo e põe o uso da conta no tracker", async () => {
    const { tracker, fetch, poller } = await setup();
    expect(await poller.poll()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(CLAUDE_USAGE_URL);
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "anthropic-beta": "oauth-2025-04-20" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(tracker.get("claude")).toEqual({
      provider: "claude",
      source: "account",
      fetchedAt: "2026-11-08T05:00:00.000Z",
      updatedAt: "2026-11-08T05:00:00.000Z",
      windows: [
        { id: "five_hour", utilization: 0.24, resetsAt: "2026-11-08T07:40:00.930Z", severity: "normal" },
        { id: "seven_day", utilization: 0.47, resetsAt: "2026-11-08T20:00:00.930Z", severity: "normal" },
        { id: "seven_day_opus", utilization: 0.85, resetsAt: "2026-11-08T20:00:00.930Z", severity: "warning" },
      ],
    });
  });

  it("401/403 mantém o último valor e marca como velho, com motivo em pt-BR", async () => {
    let status = 200;
    const { tracker, poller, advance } = await setup({ respond: () => (status === 200 ? json(200, BODY) : json(status, { error: "x" })) });
    await poller.poll();
    status = 401;
    advance(60_000);
    expect(await poller.poll()).toBe(false);
    const usage = tracker.get("claude")!;
    expect(usage.stale).toEqual({ reason: STALE_REASONS.denied, since: "2026-11-08T05:01:00.000Z" });
    expect(usage.windows).toHaveLength(3);
    expect(usage.fetchedAt).toBe("2026-11-08T05:00:00.000Z");
    status = 403;
    await poller.poll();
    expect(tracker.get("claude")!.stale?.reason).toBe(STALE_REASONS.denied);
    status = 200;
    await poller.poll();
    expect(tracker.get("claude")!.stale).toBeUndefined();
  });

  it("sem arquivo de credenciais, sem token ou token expirado: velho, e nem chama a rede", async () => {
    const missing = await setup({ credentials: null });
    await missing.poller.poll();
    expect(missing.tracker.get("claude")).toMatchObject({ windows: [], stale: { reason: STALE_REASONS.noCredentials } });
    expect(missing.fetch).not.toHaveBeenCalled();

    const noToken = await setup({ credentials: { claudeAiOauth: {} } });
    await noToken.poller.poll();
    expect(noToken.tracker.get("claude")?.stale?.reason).toBe(STALE_REASONS.noToken);

    const expired = await setup({ credentials: { claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.parse("2026-11-08T04:00:00Z") } } });
    await expired.poller.poll();
    expect(expired.tracker.get("claude")?.stale?.reason).toBe(STALE_REASONS.expired);
    expect(expired.fetch).not.toHaveBeenCalled();
  });

  it("erro de rede, timeout, HTTP 500 e formato desconhecido também viram velho (nunca lança)", async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => Promise.reject(new TypeError("fetch failed")), STALE_REASONS.network],
      [() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), STALE_REASONS.timeout],
      [() => json(500, {}), `${STALE_REASONS.badResponse} (HTTP 500)`],
      [() => json(200, { surprise: true }), STALE_REASONS.unknownFormat],
      [() => new Response("<html>", { status: 200 }), STALE_REASONS.badResponse],
    ];
    for (const [respond, reason] of cases) {
      const { tracker, poller } = await setup({ respond });
      expect(await poller.poll()).toBe(false);
      expect(tracker.get("claude")?.stale?.reason).toBe(reason);
    }
  });

  it("agenda a próxima no intervalo; depois de uma falha, espera o backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fail = false;
    const { fetch, poller } = await setup({ respond: () => (fail ? json(401, {}) : json(200, BODY)) });
    const advance = async (ms: number) => {
      vi.advanceTimersByTime(ms);
      await poller.idle();
    };
    poller.start();
    await poller.idle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(180_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    fail = true;
    await advance(180_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await advance(180_000);
    expect(fetch).toHaveBeenCalledTimes(3); // em backoff (10 min)
    await advance(420_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    poller.stop();
    await advance(3_600_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("refresh manual: no máximo uma consulta real a cada 30 s; pedidos juntos viram uma só", async () => {
    const { fetch, poller, advance } = await setup();
    const [a, b] = await Promise.all([poller.refresh(), poller.refresh()]);
    expect(a.refreshed && b.refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(10_000);
    const throttled = await poller.refresh();
    expect(throttled.refreshed).toBe(false);
    expect(throttled.usage?.windows).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(25_000);
    expect((await poller.refresh()).refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("o token nunca aparece no estado, nos eventos, nos logs nem no usage.json", async () => {
    let status = 200;
    const { dir, tracker, events, logs, poller } = await setup({ respond: () => json(status, status === 200 ? BODY : { error: `bad token ${TOKEN}` }) });
    const file = path.join(dir, "usage.json");
    const persistence = persistUsage(tracker, file);
    await poller.poll();
    status = 401;
    await poller.poll();
    await persistence.flush();
    const everything = JSON.stringify({ state: tracker.snapshot(), events, logs }) + (await readFile(file, "utf8"));
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("SEGREDO");
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("usage.json", () => {
  it("grava e lê de volta; arquivo ausente, quebrado ou com itens inválidos não quebra", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "usage.json");
    expect(await loadUsageFile(file)).toEqual([]);
    const usage = {
      provider: "claude" as const,
      windows: [{ id: "five_hour", utilization: 0.24, resetsAt: "2026-11-08T07:40:00.930Z", severity: "normal" }],
      updatedAt: "2026-11-08T05:00:00.000Z",
      source: "account" as const,
      fetchedAt: "2026-11-08T05:00:00.000Z",
    };
    await saveUsageFile(file, [usage]);
    expect(await loadUsageFile(file)).toEqual([usage]);
    await writeFile(file, JSON.stringify({ version: 1, usage: [{ provider: "claude", windows: "x" }, { ...usage, provider: "codex" }, usage] }));
    expect((await loadUsageFile(file)).map((item) => item.provider)).toEqual(["codex", "claude"]);
    await writeFile(file, "{ quebrado");
    expect(await loadUsageFile(file)).toEqual([]);
  });

  it("o app carrega o último uso no boot e a rota de refresh consulta a conta (fetch falso)", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const credentialsFile = path.join(dataDir, "creds.json");
    await writeFile(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
    const fetch = vi.fn(async () => json(200, BODY));
    const accountUsage = { credentialsFile, fetch: fetch as unknown as typeof globalThis.fetch, intervalMs: 0 };

    const first = await buildApp({ auth: { open: true }, dataDir, accountUsage });
    await first.ready();
    await vi.waitFor(() => expect(first.workspaces.usage.get("claude")?.source).toBe("account"));
    const refresh = await first.inject({ method: "POST", url: "/api/usage/refresh" });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({ refreshed: false, usage: { provider: "claude" } });
    expect(refresh.body).not.toContain(TOKEN);
    await first.close();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Restart com a consulta desligada: o medidor volta com o último valor salvo.
    const second = await buildApp({ auth: { open: true }, dataDir });
    await second.ready();
    expect(second.workspaces.usage.get("claude")).toMatchObject({ source: "account", fetchedAt: expect.any(String) });
    expect(second.workspaces.usage.get("claude")!.windows).toHaveLength(3);
    const disabled = await second.inject({ method: "POST", url: "/api/usage/refresh" });
    expect(disabled.statusCode).toBe(503);
    await second.close();
  });
});
