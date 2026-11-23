import { readFileSync } from "node:fs";
import { engineBlock, quotaBlock, type ServerEvent } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import { seedDataDir } from "../../workspace/office/seed";
import { useTempDirs } from "../../dev/test-utils";
import { ANTIGRAVITY_STALE_REASONS, AntigravityUsagePoller, type RunCli } from "./antigravity-poller";
import { parseAntigravityUsage } from "./antigravity-usage";
import { SubscriptionUsageTracker } from "./subscription-usage";

/** Saída real de `agy -p /usage --output-format json` (agy 1.5.3, 2026-11-09). */
const RAW = readFileSync(new URL("./fixtures/agy-usage.json", import.meta.url), "utf8");
const REAL = JSON.parse(RAW) as unknown;

const tempDir = useTempDirs();

describe("parseAntigravityUsage (cota da conta Google no Antigravity)", () => {
  it("lê a saída real: um grupo principal (Gemini) e os outros com sufixo, uso = 1 − o que sobra", () => {
    const windows = parseAntigravityUsage(REAL)!;
    expect(windows.map((window) => window.id)).toEqual(["seven_day", "five_hour", "seven_day_claude_gpt", "five_hour_claude_gpt", "seven_day_gemini_4_argon"]);
    const byId = Object.fromEntries(windows.map((window) => [window.id, window]));
    expect(byId.five_hour).toMatchObject({ label: "Sessão 5h", group: "Modelos Gemini", appliesTo: ["gemini"], resetsAt: "2026-11-09T08:43:56.000Z" });
    expect(byId.five_hour!.utilization).toBeCloseTo(1 - 0.9943987131118774, 6);
    expect(byId.seven_day).toMatchObject({ label: "Semana", group: "Modelos Gemini" });
    expect(byId.five_hour_claude_gpt).toMatchObject({ label: "Sessão 5h", group: "Claude e GPT", appliesTo: ["claude", "gpt"], utilization: 0 });
    expect(byId.seven_day_gemini_4_argon).toMatchObject({ label: "Semana", group: "Gemini 4 Argon", appliesTo: ["gemini 4 argon"] });
  });

  it("aceita só o `data`; ignora bucket desligado ou sem número; formato desconhecido = null", () => {
    const data = {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.25, reset_time: "2026-11-09T08:00:00Z" },
            { id: "gemini-weekly", window: "weekly", disabled: true, remaining_fraction: 1 },
            { id: "x", window: "weekly", remaining_fraction: "muito" },
          ],
        },
      ],
    };
    expect(parseAntigravityUsage(data)).toEqual([
      { id: "five_hour", utilization: 0.75, resetsAt: "2026-11-09T08:00:00.000Z", label: "Sessão 5h", group: "Modelos Gemini", appliesTo: ["gemini"] },
    ]);
    expect(parseAntigravityUsage({ command: { name: "usage", data: { groups: [] } } })).toBeNull();
    expect(parseAntigravityUsage({ status: "SUCCESS" })).toBeNull();
    expect(parseAntigravityUsage("texto")).toBeNull();
  });

  it("cota de um grupo esgotada só segura os agentes dos modelos dele", () => {
    const windows = parseAntigravityUsage(REAL)!.map((window) =>
      window.id === "five_hour_claude_gpt" ? { ...window, utilization: 1, resetsAt: "2026-11-09T09:26:51Z" } : window,
    );
    const usage = { provider: "gemini" as const, windows, updatedAt: "2026-11-09T04:00:00Z" };
    const now = Date.parse("2026-11-09T05:00:00Z");
    expect(quotaBlock(usage, now, "claude-opus-5-5-high")).toEqual({ resetsAt: "2026-11-09T09:26:51Z" });
    expect(quotaBlock(usage, now, "gemini-3.8-flash-low")).toBeUndefined();
    expect(quotaBlock(usage, now)).toBeDefined(); // sem modelo: todas as janelas (o relógio das filas)
    // Agente sem modelo no Antigravity = o padrão da CLI (um Gemini): não fica preso.
    expect(engineBlock("gemini", { usage: [usage], now })).toBeUndefined();
    expect(engineBlock("gemini", { usage: [usage], now }, "Claude Sonnet 5.5 (High)")).toEqual({ reason: "quota", resetsAt: "2026-11-09T09:26:51Z" });
    // A semana do Argon esgotada segura o Argon, não o Flash.
    const argon = { ...usage, windows: windows.map((window) => (window.id === "seven_day_gemini_4_argon" ? { ...window, utilization: 1 } : { ...window, utilization: 0.1 })) };
    expect(quotaBlock(argon, now, "gemini-4-argon-high")).toBeDefined();
    expect(quotaBlock(argon, now, "gemini-3.8-flash-high")).toBeUndefined();
  });
});

describe("AntigravityUsagePoller", () => {
  function setup(run: RunCli) {
    let clock = Date.parse("2026-11-09T05:00:00Z");
    const now = () => new Date(clock);
    const tracker = new SubscriptionUsageTracker(now);
    const events: ServerEvent[] = [];
    tracker.hub.subscribe((event) => events.push(event));
    const poller = new AntigravityUsagePoller({ tracker, now, run, command: "agy-falso", intervalMs: 300_000, backoffMs: 600_000 });
    return { tracker, events, poller, advance: (ms: number) => (clock += ms) };
  }

  it("roda `agy -p /usage --output-format json` sem chave de API e põe a cota no tracker", async () => {
    const run = vi.fn<RunCli>(async () => `aviso qualquer\n${RAW}`);
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "chave-paga-nao-vai";
    try {
      const { tracker, poller } = setup(run);
      expect(await poller.poll()).toBe(true);
      poller.stop();
      const [command, args, options] = run.mock.calls[0]!;
      expect(command).toBe("agy-falso");
      expect(args).toEqual(["-p", "/usage", "--output-format", "json"]);
      expect(options.env.GEMINI_API_KEY).toBeUndefined();
      expect(options.timeoutMs).toBe(30_000);
      expect(tracker.get("gemini")).toMatchObject({ provider: "gemini", source: "account", fetchedAt: "2026-11-09T05:00:00.000Z" });
      expect(tracker.get("gemini")!.windows).toHaveLength(5);
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
    }
  });

  it("falhas viram aviso de dado velho com o motivo (e o último valor fica)", async () => {
    let fail: unknown = undefined;
    let output = RAW;
    const run: RunCli = async () => {
      if (fail) throw fail;
      return output;
    };
    const { tracker, poller, advance } = setup(run);
    await poller.poll();
    const reasonAfter = async (error: unknown, stdout = RAW) => {
      fail = error;
      output = stdout;
      advance(60_000);
      await poller.poll();
      return tracker.get("gemini")!.stale?.reason;
    };
    expect(await reasonAfter(Object.assign(new Error("spawn agy-falso ENOENT"), { code: "ENOENT" }))).toBe(ANTIGRAVITY_STALE_REASONS.missing);
    expect(await reasonAfter(Object.assign(new Error("morto"), { killed: true, signal: "SIGTERM" }))).toBe(ANTIGRAVITY_STALE_REASONS.timeout);
    expect(await reasonAfter(Object.assign(new Error("exit 1"), { code: 1, stderr: "You are not logged into Antigravity." }))).toBe(ANTIGRAVITY_STALE_REASONS.login);
    expect(await reasonAfter(undefined, JSON.stringify({ status: "ERROR", response: "boom" }))).toBe(ANTIGRAVITY_STALE_REASONS.failed);
    expect(await reasonAfter(undefined, JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: {} } }))).toBe(ANTIGRAVITY_STALE_REASONS.unknownFormat);
    expect(tracker.get("gemini")!.windows).toHaveLength(5);
    // Voltou a responder: o aviso some.
    expect(await reasonAfter(undefined)).toBeUndefined();
    poller.stop();
  });

  it("no app: a rota de refresh aceita o motor (Antigravity) e 503 quando a consulta dele está desligada", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const run = vi.fn<RunCli>(async () => RAW);
    const app = await buildApp({ auth: { open: true }, dataDir, antigravityUsage: { run, intervalMs: 0 } });
    await app.ready();
    await vi.waitFor(() => expect(app.workspaces.usage.get("gemini")?.source).toBe("account"));
    const refresh = await app.inject({ method: "POST", url: "/api/usage/refresh", payload: { provider: "gemini" } });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({ refreshed: false, usage: { provider: "gemini" } });
    const claude = await app.inject({ method: "POST", url: "/api/usage/refresh", payload: { provider: "claude" } });
    expect(claude.statusCode).toBe(503);
    const bad = await app.inject({ method: "POST", url: "/api/usage/refresh", payload: { provider: "mock" } });
    expect(bad.statusCode).toBe(400);
    await app.close();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passa env (HOME da conta) via sanitizeChildEnv e separa o uso por accountId", async () => {
    const run = vi.fn<RunCli>(async () => RAW);
    const tracker = new SubscriptionUsageTracker(() => new Date("2026-11-09T05:00:00Z"));
    const poller = new AntigravityUsagePoller({
      tracker,
      run,
      command: "agy-falso",
      accountId: "google-extra",
      env: { HOME: "/tmp/perfil-google/home" },
      intervalMs: 0,
    });
    expect(await poller.poll()).toBe(true);
    const [, , options] = run.mock.calls[0]!;
    expect(options.env.HOME).toBe("/tmp/perfil-google/home");
    expect(tracker.get("gemini", "google-extra")).toMatchObject({ provider: "gemini", accountId: "google-extra", source: "account" });
    expect(tracker.get("gemini")).toBeUndefined();
    poller.stop();
  });
});
