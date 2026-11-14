import { findMaestroAgent, type ApiErrorBody, type ForYouItem, type MetricsReport, type ModelSaving, type ServerEvent, type UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, createWorkspace, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import type { McpTool } from "../mcp/protocol";
import { pickGroups } from "../workspace/metrics/compute";
import { renderMetrics } from "../workspace/metrics/render";
import { windowFromPreset } from "../workspace/metrics/window";

const setupApp = useTestApp();
const MIN = 60_000;

/** O relógio do app: 11/11/2026 12:00 em São Paulo (15:00 UTC), que o teste move. */
function fakeClock(start = "2026-11-11T15:00:00.000Z") {
  let ms = Date.parse(start);
  return { now: () => new Date(ms), advance: (by: number) => (ms += by) };
}

async function decidedAfter(setup: Awaited<ReturnType<ReturnType<typeof useTestApp>>>, clock: ReturnType<typeof fakeClock>, waitMs: number, status: "aprovado" | "rejeitado") {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, "Post sobre o evento [aprovar]");
  await setup.log.waitForTask(task.id, "waiting_approval");
  const event = await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id);
  const item = (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item;
  clock.advance(waitMs);
  await call<ForYouItem>(setup.app, "POST", `${wsApi()}/for-you/${item.id}/decision`, status === "rejeitado" ? { status, reason: "tom formal demais" } : { status }, 200);
  return { task, item };
}

describe("API: métricas da Gestão", () => {
  it("GET /metrics: a espera pelo OK e a recusa batem com o que aconteceu; as janelas padrão são 7 e 28 dias", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    await decidedAfter(setup, clock, 12 * MIN, "rejeitado");
    clock.advance(MIN);

    const report = await call<MetricsReport>(setup.app, "GET", `${wsApi()}/metrics`);
    expect(report.v).toBe(1);
    expect(report.workspace).toBe("principal");
    expect(report.timeZone).toBe("America/Sao_Paulo");
    expect(report.now).toBe("2026-11-11T15:13:00.000Z");
    expect(report.windows.rates).toEqual({ from: "2026-11-04T15:13:00.000Z", to: "2026-11-11T15:13:00.000Z" });
    expect(report.windows.medians.from).toBe("2026-10-14T15:13:00.000Z");
    expect(report.approvalWait).toMatchObject({ n: 1, value: 12 * MIN, fewData: true, note: "poucos dados" });
    expect(report.rejectionRate).toMatchObject({ n: 1, hits: 1, value: 1, fewData: true });
    expect(report.rejectionRate.byAgent).toHaveLength(1);
    expect(report.forecast).toEqual({ projects: [], text: "nenhum projeto aberto com tarefas a fazer" });
    expect(report.goals).toEqual({ items: [], text: "nenhuma meta ativa" });
    expect(report.load.maxRunning).toBe(3);
    expect(report.throughput.weeks).toHaveLength(8);
  });

  it("a recusa grava a categoria rápida (e vale mesmo sem o motivo escrito); aprovar ignora; categoria fora da lista dá 400", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const first = await decidedAfter(setup, clock, MIN, "aprovado");
    const items = setup.workspaces.get("principal").forYou.list();
    expect(items.find((item) => item.id === first.item.id)).not.toHaveProperty("rejection");

    const { room, team } = await soloTeam(setup.app, "Outro");
    const make = async (label: string) => {
      const task = await createTask(setup.app, room.id, team.id, `${label} [aprovar]`);
      await setup.log.waitForTask(task.id, "waiting_approval");
      const event = await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id);
      return (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item;
    };
    const decision = (id: string, body: object) => setup.app.inject({ method: "POST", url: `${wsApi()}/for-you/${id}/decision`, payload: body });

    const withBoth = await make("Um");
    const both = await decision(withBoth.id, { status: "rejeitado", reason: "ficou formal", category: "tom" });
    expect(both.statusCode).toBe(200);
    expect(both.json<ForYouItem>().rejection).toEqual({ reason: "ficou formal", category: "tom" });

    const bad = await make("Dois");
    expect((await decision(bad.id, { status: "rejeitado", category: "chato" })).statusCode).toBe(400);
    const only = await decision(bad.id, { status: "rejeitado", category: "fato_errado" });
    expect(only.statusCode).toBe(200);
    expect(only.json<ForYouItem>().rejection).toEqual({ reason: "", category: "fato_errado" });

    const approved = await make("Três");
    const ok = await decision(approved.id, { status: "aprovado", category: "tom" });
    expect(ok.json<ForYouItem>().rejection).toBeUndefined();
  });

  it("from/to em dias de São Paulo (to inclusivo) e group_by escolhe os grupos", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    await decidedAfter(setup, clock, 5 * MIN, "aprovado");
    clock.advance(MIN);

    const day = await call<MetricsReport>(setup.app, "GET", `${wsApi()}/metrics?from=2026-11-10&to=2026-11-11`);
    // 10/11 00:00 SP até agora (o fim do dia 11 passa de agora, então vale agora).
    expect(day.windows.rates).toEqual({ from: "2026-11-10T03:00:00.000Z", to: "2026-11-11T15:06:00.000Z" });
    expect(day.windows.medians).toEqual(day.windows.rates);
    expect(day.approvalWait.n).toBe(1);

    const none = await call<MetricsReport>(setup.app, "GET", `${wsApi()}/metrics?group_by=none`);
    expect(none.approvalWait.byAgent).toEqual([]);
    expect(none.rejectionRate.byAgent).toEqual([]);
    const byAgent = await call<MetricsReport>(setup.app, "GET", `${wsApi()}/metrics?group_by=agent`);
    expect(byAgent.approvalWait.byAgent).toHaveLength(1);
    expect(byAgent.approvalWait.byType).toEqual([]);
  });

  it("pedido ruim: dia inválido, futuro, from depois de to, janela enorme e group_by desconhecido dão 400; fora dos 90 dias, 404; workspace inexistente, 404", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const get = (query: string) => setup.app.inject({ method: "GET", url: `${wsApi()}/metrics${query}` });
    expect((await get("?from=ontem")).statusCode).toBe(400);
    expect((await get("?to=2026-11-12")).statusCode).toBe(400);
    expect((await get("?from=2026-11-10&to=2026-11-09")).statusCode).toBe(400);
    const big = await get("?from=2026-08-20&to=2026-11-11");
    expect(big.statusCode).toBe(400);
    expect((big.json() as ApiErrorBody).error).toContain("60 dias");
    expect((await get("?group_by=cor")).statusCode).toBe(400);
    expect((await get("?from=2026-08-01&to=2026-08-02")).statusCode).toBe(404);
    expect((await get("?from=2026-11-01&to=2026-11-11")).statusCode).toBe(200);
    expect((await setup.app.inject({ method: "GET", url: "/api/w/nao-existe/metrics" })).statusCode).toBe(404);
  });
});

describe("MCP: get_metrics", () => {
  it("o Maestro lê só o dele, em inglês, com o n e a hora do servidor; o Cyno lê um ou todos; agentes de time não têm a ferramenta", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    await decidedAfter(setup, clock, 12 * MIN, "rejeitado");
    await createWorkspace(setup.app, "Segundo");
    clock.advance(MIN);

    const runtime = setup.workspaces.get("principal");
    const maestro = findMaestroAgent(runtime.store.snapshot())!;
    const tool = runtime.officeTools(maestro.id).find((candidate) => candidate.name === "get_metrics");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/^Management numbers computed by code/);
    expect(Object.keys((tool!.input as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(["group_by", "metrics", "window"]);

    const result = await tool!.call({} as never);
    expect(result.isError).toBeUndefined();
    const expected = renderMetrics(pickGroups(await runtime.metrics(windowFromPreset("28d", clock.now().getTime())), "agent"));
    expect(result.text).toBe(expected);
    expect(result.text).toContain("Rejection rate");
    expect(result.text).toContain("(1/1");
    expect(result.text).toContain("few data");
    expect(result.text.trim().split("\n").at(-1)).toMatch(/^Computed by the server at \d\d:\d\d \(America\/Sao_Paulo\); do not recompute/);

    const only = await tool!.call({ metrics: ["rejection"], window: "7d" } as never);
    expect(only.text).toContain("Rejection rate");
    expect(only.text).not.toContain("Deliveries");
    // A ferramenta não acorda ninguém: nenhuma tarefa nova.
    const tasksBefore = runtime.store.snapshot().tasks.length;
    await tool!.call({} as never);
    expect(runtime.store.snapshot().tasks.length).toBe(tasksBefore);

    const cynoTools = (setup.app.cyno as unknown as { platformToolList(): McpTool[] }).platformToolList();
    const cynoTool = cynoTools.find((candidate) => candidate.name === "get_metrics")!;
    expect((await cynoTool.call({ workspace: "principal" } as never)).text).toContain('Metrics for "');
    const all = (await cynoTool.call({} as never)).text;
    expect(all.match(/^Metrics for "/gm)?.length).toBeGreaterThanOrEqual(2);
    expect(all).not.toContain("Cost per delivery");
    expect((await cynoTool.call({ workspace: "nao-existe" } as never)).isError).toBe(true);

    const agent = runtime.store.snapshot().agents.find((candidate) => candidate.id !== maestro.id)!;
    expect(runtime.officeTools(agent.id).map((candidate) => candidate.name)).not.toContain("get_metrics");
  });
});

describe("API: estimativa de economia ao trocar o modelo (GET /metrics/model-saving)", () => {
  const url = (query: string) => `${wsApi()}/metrics/model-saving${query}`;

  it("repreça os últimos 14 dias do agente com o modelo novo e traz o aviso da recusa; só estima e não troca nada", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const { agent } = await soloTeam(setup.app, "Solo");
    const runtime = setup.workspaces.get("principal");
    const usage = (id: string, daysAgo: number, extra: Partial<UsageRecord> = {}) =>
      runtime.usageHistory.append({
        v: 1,
        id,
        at: new Date(clock.now().getTime() - daysAgo * 86_400_000).toISOString(),
        agentId: agent.id,
        provider: "claude",
        model: "claude-sonnet-5-5",
        source: "live",
        measured: true,
        tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0 },
        costUsd: null,
        priceVersion: "teste",
        ...extra,
      });
    await usage("u1", 3);
    await usage("u2", 10);
    await usage("u3", 20);

    const result = await call<ModelSaving>(setup.app, "GET", url(`?agentId=${agent.id}&model=claude-haiku-5-5`));
    expect(result).toMatchObject({ agentId: agent.id, model: "claude-haiku-5-5", state: "estimado", records: 2, days: 14 });
    expect(result.savingPerWeekUsd!).toBeGreaterThan(0);
    expect(result.text).toMatch(/^cerca de US\$ [\d,]+ a menos por semana \(equivalente\)$/);
    expect(result.warning).toContain("trocar o modelo pode piorar");
    // Só estimou: o agente continua como estava.
    expect(runtime.store.snapshot().agents.find((candidate) => candidate.id === agent.id)!.model).toBe(agent.model);

    const empty = await call<ModelSaving>(setup.app, "GET", url(`?agentId=${agent.id}&model=modelo-sem-preco`));
    expect(empty).toMatchObject({ state: "sem_dados", text: "sem dados para estimar", savingPerWeekUsd: null });
  });

  it("agente sem uso devolve \"sem dados para estimar\"; sem agente ou modelo é 400; agente que não existe é 404", async () => {
    const setup = await setupApp();
    const { agent } = await soloTeam(setup.app, "Solo");
    const none = await call<ModelSaving>(setup.app, "GET", url(`?agentId=${agent.id}&model=claude-haiku-5-5`));
    expect(none).toMatchObject({ state: "sem_dados", text: "sem dados para estimar", records: 0 });
    expect((await call<ApiErrorBody>(setup.app, "GET", url("?model=claude-haiku-5-5"), undefined, 400)).error).toMatch(/agente/);
    expect((await call<ApiErrorBody>(setup.app, "GET", url(`?agentId=${agent.id}`), undefined, 400)).error).toMatch(/modelo/);
    await call<ApiErrorBody>(setup.app, "GET", url(`?agentId=${agent.id}&model=${"x".repeat(101)}`), undefined, 400);
    await call<ApiErrorBody>(setup.app, "GET", url("?agentId=nao-existe&model=claude-haiku-5-5"), undefined, 404);
  });
});
