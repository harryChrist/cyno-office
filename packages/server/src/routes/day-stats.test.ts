import { findMaestroAgent, type ApiErrorBody, type DayStats, type DayStatsDaysResponse, type DayStatsRangeResponse, type ForYouItem, type PlatformDayStats, type ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, createWorkspace, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import type { McpTool } from "../mcp/protocol";
import { renderDayStats, renderPlatformDayStats } from "../workspace/day-stats/text";

const setupApp = useTestApp();
const MIN = 60_000;

/** O relógio do app: 11/11/2026 12:00 em São Paulo (15:00 UTC), que o teste move. */
function fakeClock(start = "2026-11-11T15:00:00.000Z") {
  let ms = Date.parse(start);
  return { now: () => new Date(ms), advance: (by: number) => (ms += by), set: (to: string) => (ms = Date.parse(to)) };
}

async function approvedAfter(setup: Awaited<ReturnType<ReturnType<typeof useTestApp>>>, clock: ReturnType<typeof fakeClock>, waitMs: number) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, "Post sobre o evento [aprovar]");
  await setup.log.waitForTask(task.id, "waiting_approval");
  const event = await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id);
  const item = (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item;
  clock.advance(waitMs);
  await call<ForYouItem>(setup.app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "aprovado" }, 200);
  return { task, item };
}

describe("API: Meu dia (day-stats)", () => {
  it("GET /day-stats: 'Esperando você' bate com a espera do item e a rota traz a cobertura e as 24 horas", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const { item } = await approvedAfter(setup, clock, 12 * MIN);
    clock.advance(MIN);

    const stats = await call<DayStats>(setup.app, "GET", `${wsApi()}/day-stats`);
    expect(stats.day).toBe("2026-11-11");
    expect(stats.hours).toHaveLength(24);
    expect(stats.totals.ms.waiting_owner).toBe(12 * MIN);
    expect(stats.totals).toMatchObject({ waits: 1, longestWaitMs: 12 * MIN, waitWallMs: 12 * MIN });
    expect(stats.waits).toEqual([expect.objectContaining({ forYouIds: [item.id], ms: 12 * MIN, open: false, agentName: expect.any(String) })]);
    expect(stats.agents[0]).toMatchObject({ waits: 1, ms: { waiting_owner: 12 * MIN } });
    // O relógio nasceu neste boot: hoje só vale a partir dele.
    expect(stats.coverage.states).toBe("partial");
    expect(stats.coverage.clockFrom).toBeDefined();
    expect(stats.compare).toEqual({});
    // A soma das horas é a do dia.
    expect(stats.hours.reduce((sum, hour) => sum + hour.ms.waiting_owner, 0)).toBe(12 * MIN);

    const same = await call<DayStats>(setup.app, "GET", `${wsApi()}/day-stats?day=2026-11-11`);
    expect(same.totals.ms.waiting_owner).toBe(12 * MIN);
  });

  it("item ainda pendente é uma espera aberta que cresce com o relógio", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const { room, team } = await soloTeam(setup.app, "Solo");
    const task = await createTask(setup.app, room.id, team.id, "Post [aprovar]");
    await setup.log.waitForTask(task.id, "waiting_approval");
    await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id);
    clock.advance(20 * MIN);
    const stats = await call<DayStats>(setup.app, "GET", `${wsApi()}/day-stats`);
    expect(stats.totals.ms.waiting_owner).toBe(20 * MIN);
    expect(stats.waits[0]).toMatchObject({ open: true, ms: 20 * MIN });
    clock.advance(10 * MIN);
    expect((await call<DayStats>(setup.app, "GET", `${wsApi()}/day-stats`)).totals.ms.waiting_owner).toBe(30 * MIN);
  });

  it("dia inválido ou no futuro: 400; fora dos 90 dias: 404; workspace inexistente: 404", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const get = (query: string) => setup.app.inject({ method: "GET", url: `${wsApi()}/day-stats${query}` });
    expect((await get("?day=ontem")).statusCode).toBe(400);
    expect((await get("?day=2026-02-30")).statusCode).toBe(400);
    const future = await get("?day=2026-11-12");
    expect(future.statusCode).toBe(400);
    expect((future.json() as ApiErrorBody).error).toContain("ainda não chegou");
    expect((await get("?day=2026-08-12")).statusCode).toBe(404);
    expect((await get("?day=2026-08-13")).statusCode).toBe(200);
    expect((await setup.app.inject({ method: "GET", url: "/api/w/nao-existe/day-stats" })).statusCode).toBe(404);
  });

  it("GET /day-stats/range traz os dias do intervalo (até 31) e /days lista os que têm dado", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    await approvedAfter(setup, clock, 5 * MIN);
    const range = await call<DayStatsRangeResponse>(setup.app, "GET", `${wsApi()}/day-stats/range?from=2026-11-09&to=2026-11-11`);
    expect(range.days.map((day) => day.day)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(range.days[2]!.totals.ms.waiting_owner).toBe(5 * MIN);
    expect(range.days[0]!.totals.waits).toBe(0);
    expect((await setup.app.inject({ method: "GET", url: `${wsApi()}/day-stats/range?from=2026-11-11&to=2026-11-09` })).statusCode).toBe(400);
    expect((await setup.app.inject({ method: "GET", url: `${wsApi()}/day-stats/range?from=2026-09-01&to=2026-11-11` })).statusCode).toBe(400);
    expect((await setup.app.inject({ method: "GET", url: `${wsApi()}/day-stats/range?from=2026-11-10` })).statusCode).toBe(200); // `to` ausente = hoje

    const days = await call<DayStatsDaysResponse>(setup.app, "GET", `${wsApi()}/day-stats/days`);
    expect(days.days).toContain("2026-11-11");
    expect(days.clockFrom).toBeDefined();
  });

  it("compara com ontem: um dia anterior com espera entra nas comparações", async () => {
    const clock = fakeClock("2026-11-10T15:00:00.000Z");
    const setup = await setupApp({ now: clock.now });
    await approvedAfter(setup, clock, 30 * MIN);
    clock.set("2026-11-11T15:00:00.000Z");
    const stats = await call<DayStats>(setup.app, "GET", `${wsApi()}/day-stats`);
    expect(stats.totals.waits).toBe(0);
    // Hoje (sem esperas) contra ontem (30 min): isEmptyDay do atual não impede a comparação; o de ontem tem dados.
    expect(stats.compare?.yesterday).toMatchObject({ day: "2026-11-10" });
    expect(stats.compare!.yesterday!.metrics.waitingOwnerMs).toMatchObject({ base: 30 * MIN, current: 0, delta: -30 * MIN, pct: -100, sense: "better" });
    expect(stats.compare!.avg7).toMatchObject({ days: 1 });
  });

  it("GET /api/day-stats soma os workspaces; o Maestro lê só o dele e o texto sai em inglês", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    await approvedAfter(setup, clock, 12 * MIN);
    await createWorkspace(setup.app, "Segundo");
    clock.advance(MIN);

    const platform = await call<PlatformDayStats>(setup.app, "GET", "/api/day-stats");
    expect(platform.workspaces.length).toBeGreaterThanOrEqual(2);
    expect(platform.totals.ms.waiting_owner).toBe(12 * MIN);
    expect(platform.waits).toHaveLength(1);
    expect(platform.waits[0]).toMatchObject({ workspace: "principal" });
    expect((await setup.app.inject({ method: "GET", url: "/api/day-stats?day=2027-01-01" })).statusCode).toBe(400);
    expect(renderPlatformDayStats(platform)).toContain("Waiting for the owner: 12 min in 1 wait");

    const runtime = setup.workspaces.get("principal");
    const maestro = findMaestroAgent(runtime.store.snapshot())!;
    const tool = runtime.officeTools(maestro.id).find((candidate) => candidate.name === "get_day_stats");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/^How the day went/);
    const result = await tool!.call({} as never);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Day 2026-11-11");
    expect(result.text).toContain("Waiting for the owner: 12 min in 1 wait, longest 12 min");
    expect(result.text).toBe(renderDayStats(await runtime.dayStats(undefined)));
    // Dia ruim: o erro volta como texto para o modelo corrigir.
    const bad = await tool!.call({ day: "amanha" } as never);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("AAAA-MM-DD");
    // O Maestro não aceita escolher outro workspace: o campo não existe.
    expect(Object.keys((tool!.input as unknown as { shape: Record<string, unknown> }).shape)).toEqual(["day"]);
    // O Cyno (a plataforma) lê todos os workspaces, ou um deles pelo nome.
    const cynoTools = (setup.app.cyno as unknown as { platformToolList(): McpTool[] }).platformToolList();
    const cynoTool = cynoTools.find((candidate) => candidate.name === "get_day_stats")!;
    expect((await cynoTool.call({} as never)).text).toBe(renderPlatformDayStats(platform));
    expect((await cynoTool.call({ workspace: "principal" } as never)).text).toContain('workspace principal');
    expect((await cynoTool.call({ workspace: "nao-existe" } as never)).isError).toBe(true);
    expect((await cynoTool.call({ day: "2099-01-01" } as never)).isError).toBe(true);
    // Os agentes de time não têm a ferramenta.
    const agent = runtime.store.snapshot().agents.find((candidate) => candidate.id !== maestro.id)!;
    expect(runtime.officeTools(agent.id).map((candidate) => candidate.name)).not.toContain("get_day_stats");
  });
});
