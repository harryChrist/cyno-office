import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { localDayKey, type SpendSettingsResponse, type UsageHistoryResponse, type UsageRecord, type UsageTaskHistoryResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, principalDir, useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

const record = (id: string, at: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  v: 1,
  id,
  at,
  agentId: "eco",
  agentName: "Eco",
  provider: "claude",
  model: "claude-opus-5-5",
  source: "live",
  measured: true,
  tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0 },
  costUsd: 6,
  priceVersion: "2026-11-10",
  ...extra,
});

describe("rotas do histórico de gastos", () => {
  it("GET /usage/history agrupa por agente e por pedido, com custo em USD e BRL pela cotação editável", async () => {
    const { app, dataDir } = await setupApp();
    const dir = path.join(principalDir(dataDir), "usage");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "2026-11.jsonl"),
      [
        record("a", "2026-11-05T12:00:00.000Z", { taskId: "pedido-1", rootTaskId: "pedido-1", taskTitle: "Pedido apagado" }),
        record("b", "2026-11-06T12:00:00.000Z", { agentId: "radar", agentName: "Radar", provider: "gemini", model: "gemini-3.8-flash-low" }),
        record("c", "2026-12-01T12:00:00.000Z"),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const response = await app.inject({ method: "GET", url: `${API}/usage/history?from=2026-11-01&to=2026-11-30&groupBy=agent` });
    expect(response.statusCode).toBe(200);
    const body = response.json<UsageHistoryResponse>();
    expect(body.groups.map((group) => [group.label, group.totals.turns])).toEqual([
      ["Eco", 1],
      ["Radar", 1],
    ]);
    // Opus 5.5: 1M de entrada (US$ 4) + 100 mil de saída (US$ 2); Gemini 3.8 Flash: 0,75 + 0,375.
    expect(body.overall.costUsd).toBeCloseTo(6 + 1.125, 10);
    expect(body.overall.costBrl).toBeCloseTo((6 + 1.125) * body.usdBrl, 10);
    expect(body.prices.sources.length).toBeGreaterThan(0);

    const put = await app.inject({ method: "PUT", url: "/api/settings/spend", payload: { usdBrl: 6 } });
    expect(put.json<SpendSettingsResponse>()).toMatchObject({ usdBrl: 6 });
    const byTask = (await app.inject({ method: "GET", url: `${API}/usage/history?from=2026-11-01&to=2026-11-30&groupBy=task` })).json<UsageHistoryResponse>();
    expect(byTask.usdBrl).toBe(6);
    expect(byTask.groups[0]).toMatchObject({ key: "pedido-1", label: "Pedido apagado" });
    expect(byTask.groups[0]!.totals.costBrl).toBeCloseTo(36, 10);

    const detail = await app.inject({ method: "GET", url: `${API}/usage/history/task/pedido-1` });
    expect(detail.json<UsageTaskHistoryResponse>()).toMatchObject({ taskId: "pedido-1", title: "Pedido apagado", totals: { turns: 1 } });
    expect((await app.inject({ method: "GET", url: `${API}/usage/history/task/nenhum` })).statusCode).toBe(404);

    expect((await app.inject({ method: "GET", url: `${API}/usage/history?from=2026-11-30&to=2026-11-01` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${API}/usage/history?groupBy=ano` })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings/spend", payload: { usdBrl: 0 } })).statusCode).toBe(400);
  });

  it("a guarda de sanidade e o turno cortado: /usage/history mostra `flags`, /usage/task-costs e a diária usam a mesma conta", async () => {
    const { app, dataDir } = await setupApp();
    const dir = path.join(principalDir(dataDir), "usage");
    await mkdir(dir, { recursive: true });
    const day = new Date().toISOString();
    const small = { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 };
    await writeFile(
      path.join(dir, `${day.slice(0, 7)}.jsonl`),
      [
        record("ok", day, { taskId: "t1", rootTaskId: "t1", tokens: small }),
        record("cut", day, { taskId: "t1", rootTaskId: "t1", tokens: small, partial: true, turns: 0 }),
        record("bad", day, { taskId: "t1", rootTaskId: "t1", tokens: { ...small, output: 600_000 }, suspect: "output" }),
        record("neg", day, { taskId: "t2", rootTaskId: "t2", tokens: { ...small, output: -4 } }),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    // O dia do histórico é o de São Paulo: entre 00h e 03h UTC ele ainda é o dia anterior ao da data em UTC.
    const today = localDayKey(new Date(day));
    const history = (await app.inject({ method: "GET", url: `${API}/usage/history?from=${today}&to=${today}&groupBy=day` })).json<UsageHistoryResponse>();
    expect(history.overall.turns).toBe(1);
    expect(history.flags.suspect).toMatchObject({ records: 2, reasons: { output: 1, negative: 1 } });
    expect(history.flags.partial).toMatchObject({ records: 1, tokens: 2000 });
    // O parcial soma no total (a API cobrou): dois "pequenos" de 2000 tokens.
    expect(history.overall.totalTokens).toBe(4000);

    const costs = (await app.inject({ method: "GET", url: `${API}/usage/task-costs` })).json<{ tasks: Record<string, { costUsd: number; tokens: number }> }>();
    expect(Object.keys(costs.tasks)).toEqual(["t1"]);
    expect(costs.tasks.t1!.tokens).toBe(4000);
    expect(costs.tasks.t1!.costUsd).toBeCloseTo(history.overall.costUsd, 10);

    // "Meu dia" lê a mesma conta da página Gastos: os números batem.
    const dayStats = (await app.inject({ method: "GET", url: `${API}/day-stats` })).json<{ totals: unknown; providers: { totalTokens: number; costUsd: number }[] }>();
    expect(dayStats.providers.reduce((sum, provider) => sum + provider.totalTokens, 0)).toBe(history.overall.totalTokens);
    expect(dayStats.providers.reduce((sum, provider) => sum + provider.costUsd, 0)).toBeCloseTo(history.overall.costUsd, 10);
  });
});

