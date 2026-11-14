import { findMaestroAgent, type ApiErrorBody, type ForYouItem, type GenerateReportResult, type MediaItem, type ReportList, type ServerEvent, type StoredReport } from "@cyno/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { call, createTask, createWorkspace, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import type { McpTool } from "../mcp/protocol";
import { registerWorkspaceReportRoutes } from "./reports";
import type { WorkspaceRuntime } from "../workspace/runtime";

const setupApp = useTestApp();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** O relógio do app: quinta 12/11/2026 12:00 em São Paulo (15:00 UTC), que o teste move. */
function fakeClock(start = "2026-11-12T15:00:00.000Z") {
  let ms = Date.parse(start);
  return { now: () => new Date(ms), advance: (by: number) => (ms += by), set: (iso: string) => (ms = Date.parse(iso)) };
}

async function rejectedAfter(setup: Awaited<ReturnType<ReturnType<typeof useTestApp>>>, clock: ReturnType<typeof fakeClock>, waitMs: number) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, "Post sobre o evento [aprovar]");
  await setup.log.waitForTask(task.id, "waiting_approval");
  const event = await setup.log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === task.id);
  const item = (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item;
  clock.advance(waitMs);
  await call<ForYouItem>(setup.app, "POST", `${wsApi()}/for-you/${item.id}/decision`, { status: "rejeitado", reason: "tom formal demais" }, 200);
}

describe("API: relatórios da Gestão", () => {
  it("lista vazia no começo; 'Gerar agora' faz o parcial da semana, que sai em json, html, md e text", async () => {
    const clock = fakeClock();
    const setup = await setupApp({ now: clock.now });
    const empty = await call<ReportList>(setup.app, "GET", `${wsApi()}/reports`);
    expect(empty.items).toEqual([]);
    expect(empty.settings).toEqual({ dailyAt: "18:30", weekly: "seg 08:30" });
    expect(empty.imageAvailable).toBe(true);

    await rejectedAfter(setup, clock, 12 * MIN);
    const generated = await call<GenerateReportResult>(setup.app, "POST", `${wsApi()}/reports/generate`, { kind: "week" }, 200);
    expect(generated.regenerated).toBe(false);
    expect(generated.report).toMatchObject({ kind: "week", period: "2026-W46", final: false, workspace: "principal", trigger: "manual" });

    const list = await call<ReportList>(setup.app, "GET", `${wsApi()}/reports`);
    expect(list.items.map((item) => [item.kind, item.period, item.final])).toEqual([["week", "2026-W46", false]]);

    const json = await call<StoredReport>(setup.app, "GET", `${wsApi()}/reports/week/2026-W46`);
    expect(json.digest.rejection).toMatchObject({ hits: 1, n: 1 });

    const html = await setup.app.inject({ method: "GET", url: `${wsApi()}/reports/week/2026-W46?format=html` });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(html.body).toContain("Revisão da semana");
    expect(html.body).not.toMatch(/<script|https?:\/\//);

    const md = await setup.app.inject({ method: "GET", url: `${wsApi()}/reports/week/2026-W46?format=md` });
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("# Revisão da semana");
    const text = await setup.app.inject({ method: "GET", url: `${wsApi()}/reports/week/2026-W46?format=text` });
    expect(text.body).toContain("PARTIAL");

    const linked = await setup.app.inject({ method: "GET", url: `${wsApi()}/reports/week/2026-W46?format=html&base=${encodeURIComponent("https://app.exemplo.com")}` });
    expect(linked.statusCode).toBe(200);
  });

  it("período fechado: gerar grava o final e pedir de novo devolve o mesmo, sem refazer", async () => {
    const clock = fakeClock("2026-11-17T12:00:00.000Z");
    const setup = await setupApp({ now: clock.now });
    await rejectedAfter(setup, clock, 12 * MIN);
    // A revisão de sexta passada é a semana 46 (9 a 15/11): fechada.
    const first = await call<GenerateReportResult>(setup.app, "POST", `${wsApi()}/reports/generate`, { kind: "week", period: "2026-W46" }, 200);
    expect(first.report.final).toBe(true);
    clock.advance(2 * HOUR);
    const again = await call<GenerateReportResult>(setup.app, "POST", `${wsApi()}/reports/generate`, { kind: "week", period: "2026-W46" }, 200);
    expect(again.regenerated).toBe(false);
    expect(again.note).toMatch(/já estava fechado/);
    expect(again.report.generatedAt).toBe(first.report.generatedAt);
    // "latest" lê o guardado.
    const latest = await call<StoredReport>(setup.app, "GET", `${wsApi()}/reports/week/latest`);
    expect(latest.period).toBe("2026-W46");
  });

  it("erros: tipo, formato e período inválidos; relatório que não existe; workspace que não existe", async () => {
    const setup = await setupApp({ now: fakeClock().now });
    expect((await call<ApiErrorBody>(setup.app, "GET", `${wsApi()}/reports/ano/2026`, undefined, 400)).error).toMatch(/Tipo de relatório inválido/);
    expect((await call<ApiErrorBody>(setup.app, "GET", `${wsApi()}/reports/week/2026-W46?format=pdf`, undefined, 400)).error).toMatch(/Formato inválido/);
    expect((await call<ApiErrorBody>(setup.app, "GET", `${wsApi()}/reports/week/2026-W46`, undefined, 404)).error).toMatch(/Não há relatório week/);
    expect((await call<ApiErrorBody>(setup.app, "POST", `${wsApi()}/reports/generate`, { kind: "week", period: "2026-W99" }, 400)).error).toMatch(/Período inválido/);
    await call<ApiErrorBody>(setup.app, "POST", `${wsApi()}/reports/generate`, { kind: "ano" }, 400);
    expect((await setup.app.inject({ method: "GET", url: "/api/w/nao-existe/reports" })).statusCode).toBe(404);
    // Período mal escrito é 400 (não 500), em todas as rotas que recebem período (revisão L1).
    for (const bad of ["abc", "2026-W4", "..%2Fx", "2026-13-99x", "2026-11-12"]) {
      expect((await call<ApiErrorBody>(setup.app, "GET", `${wsApi()}/reports/week/${bad}`, undefined, 400)).error).toMatch(/Período inválido/);
    }
    await call(setup.app, "GET", `${wsApi()}/reports/day/2026-W46`, undefined, 400);
    await call(setup.app, "GET", `${wsApi()}/reports/month/abc?format=md`, undefined, 400);
    await call(setup.app, "POST", `${wsApi()}/reports/week/abc/image`, undefined, 400);
    await call(setup.app, "GET", `${wsApi()}/retro/abc`, undefined, 400);
    await call(setup.app, "GET", "/api/cyno/reports/week/abc", undefined, 400);
  });

  it("Imagem: renderiza o HTML pelo navegador do workspace e guarda o PNG na Biblioteca de mídia", async () => {
    const clock = fakeClock("2026-11-17T12:00:00.000Z");
    const setup = await setupApp({ now: clock.now });
    await rejectedAfter(setup, clock, 12 * MIN);
    const runtime = setup.workspaces.get("principal");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");
    const render = vi.spyOn(runtime.browser!, "renderHtml").mockResolvedValue(png);
    // O relatório da semana 46 ainda não foi gerado: a rota só gera a imagem do que existe.
    expect((await call<ApiErrorBody>(setup.app, "POST", `${wsApi()}/reports/week/2026-W46/image`, undefined, 404)).error).toMatch(/Não há relatório/);
    await call(setup.app, "POST", `${wsApi()}/reports/generate`, { kind: "week", period: "2026-W46" }, 200);
    const made = await call<MediaItem>(setup.app, "POST", `${wsApi()}/reports/week/2026-W46/image`, undefined, 201);
    expect(made).toMatchObject({ kind: "image", origin: "html", title: "Revisão da semana 2026-W46" });
    expect(render).toHaveBeenCalledTimes(1);
    const input = render.mock.calls[0]![0];
    expect(input).toMatchObject({ format: "png", scale: 2, fullPage: true, width: 980 });
    expect(input.html).not.toMatch(/<script|https?:\/\//);
    expect(runtime.media.find(made.id)).toBeDefined();
  });

  it("Imagem sem o navegador do workspace: 409 com a explicação; o resto continua", async () => {
    const app = Fastify();
    const runtime = { browser: undefined, reports: { settings: () => ({ dailyAt: "18:30", weekly: "seg 08:30", ai: { daily: false, weekly: false } }), list: async () => [], read: async () => ({}), ensure: async () => undefined }, now: () => new Date() } as unknown as WorkspaceRuntime;
    const { HttpError } = await import("../platform/http/errors");
    app.setErrorHandler((error: Error, _request, reply) => void reply.code(error instanceof HttpError ? error.statusCode : 500).send({ error: error.message }));
    registerWorkspaceReportRoutes(app, () => runtime);
    const response = await app.inject({ method: "POST", url: "/reports/week/2026-W46/image" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Ligue o navegador do workspace/);
    expect((await app.inject({ method: "GET", url: "/reports" })).json().imageAvailable).toBe(false);
  });
});

describe("configurações gestao.* no PATCH do workspace", () => {
  it("guarda só o que mudou, valida o formato, e 'voltar ao padrão' apaga o valor próprio", async () => {
    const setup = await setupApp({ now: fakeClock().now });
    const patch = (body: object, status = 200) => call<{ gestao?: unknown } & ApiErrorBody>(setup.app, "PATCH", "/api/workspaces/principal", body, status);
    expect((await patch({ gestao: { dailyAt: "19:00" } })).gestao).toEqual({ dailyAt: "19:00" });
    expect((await patch({ gestao: { ai: { weekly: true } } })).gestao).toEqual({ dailyAt: "19:00", ai: { weekly: true } });
    expect((await patch({ gestao: { dailyAt: null, weekly: "sex 17:00" } })).gestao).toEqual({ dailyAt: null, weekly: "sex 17:00", ai: { weekly: true } });
    expect((await call<ReportList>(setup.app, "GET", `${wsApi()}/reports`)).settings).toEqual({ dailyAt: null, weekly: "sex 17:00" });
    await patch({ gestao: { dailyAt: "25:99" } }, 400);
    await patch({ gestao: { weekly: "amanhã" } }, 400);
    await patch({ gestao: {} }, 400);
    const reset = await patch({ reset: ["gestao.dailyAt", "gestao.weekly", "gestao.ai"] });
    expect(reset.gestao).toBeUndefined();
    expect((await call<ReportList>(setup.app, "GET", `${wsApi()}/reports`)).settings).toEqual({ dailyAt: "18:30", weekly: "seg 08:30" });
  });
});

describe("MCP: get_report", () => {
  it("o Maestro lê o do próprio workspace em inglês (ou markdown); o Cyno lê um workspace ou a plataforma; agente de time não tem", async () => {
    const clock = fakeClock("2026-11-14T15:00:00.000Z");
    const setup = await setupApp({ now: clock.now });
    await rejectedAfter(setup, clock, 12 * MIN);
    clock.set("2026-11-17T12:00:00.000Z");
    await createWorkspace(setup.app, "Segundo");
    const runtime = setup.workspaces.get("principal");
    const maestro = findMaestroAgent(runtime.store.snapshot())!;
    const tool = runtime.officeTools(maestro.id).find((candidate) => candidate.name === "get_report");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/^The frozen management report of a closed period/);
    expect(Object.keys((tool!.input as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(["format", "kind", "period"]);

    const tasksBefore = runtime.store.snapshot().tasks.length;
    const week = await tool!.call({ kind: "week" } as never);
    expect(week.isError).toBeUndefined();
    expect(week.text).toContain('Week review 2026-W46 of "');
    expect(week.text).toContain("Closed and frozen");
    expect(week.text).toMatch(/rejection 100% \(1\/1, few data\)/);
    // O texto é o do relatório guardado (gerado na hora, porque a semana fechou).
    const stored = await runtime.reports.read("week", "2026-W46");
    expect(stored?.final).toBe(true);
    const md = await tool!.call({ kind: "week", period: "2026-W46", format: "markdown" } as never);
    expect(md.text).toContain("# Revisão da semana");
    expect((await tool!.call({ kind: "week", period: "2026-W99" } as never)).isError).toBe(true);
    // Só lê e gera: nenhuma tarefa nova, ninguém acordado.
    expect(runtime.store.snapshot().tasks.length).toBe(tasksBefore);
    const agent = runtime.store.snapshot().agents.find((candidate) => candidate.id !== maestro.id)!;
    expect(runtime.officeTools(agent.id).map((candidate) => candidate.name)).not.toContain("get_report");

    const cyno = (setup.app.cyno as unknown as { platformToolList(): McpTool[] }).platformToolList();
    const cynoTool = cyno.find((candidate) => candidate.name === "get_report")!;
    expect((await cynoTool.call({ kind: "week", workspace: "principal" } as never)).text).toContain("Week review 2026-W46");
    expect((await cynoTool.call({ kind: "week" } as never)).isError).toBe(true);
    expect((await cynoTool.call({ kind: "day", scope: "platform" } as never)).isError).toBe(true);
    expect((await cynoTool.call({ kind: "week", workspace: "nao-existe" } as never)).isError).toBe(true);
    const platform = await cynoTool.call({ kind: "week", scope: "platform" } as never);
    expect(platform.isError).toBeUndefined();
    expect(platform.text).toContain("Platform week 2026-W46");
    expect(platform.text).toMatch(/Sum of 2 workspaces/);
    const md2 = await cynoTool.call({ kind: "week", scope: "platform", format: "markdown" } as never);
    expect(md2.text).toContain("# Semana da plataforma");
  });
});
