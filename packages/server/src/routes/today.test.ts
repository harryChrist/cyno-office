import { findMaestroAgent, type PlatformToday, type Routine, type TodayView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

describe("API: o painel Hoje", () => {
  it("GET /api/w/:ws/today e GET /api/today trazem metas, mudanças, compromissos e o que espera o dono", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await soloTeam(app);
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 3, agentId: agent.id });
    // Um compromisso daqui a pouco, no dia de hoje: marcado pelo dono, sem workspace.
    const start = new Date(Date.now() + 60_000);
    start.setUTCSeconds(0, 0);
    const booked = await app.agenda.book({ title: "Call de alinhamento", start: start.toISOString(), end: new Date(start.getTime() + 1_800_000).toISOString() }, { kind: "dono" }, { override: true });
    expect(booked.ok).toBe(true);

    const view = await call<TodayView>(app, "GET", `${wsApi()}/today`);
    expect(view.workspace).toBe("principal");
    expect(view.goals).toMatchObject([{ title: "Posts", done: 0, target: 3, period: "week" }]);
    expect(view.waiting).toEqual({ count: 0, oldest: [] });
    expect(view.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // O compromisso do dono (sem workspace) entra no painel do workspace se cair no mesmo dia de São Paulo.
    expect(Array.isArray(view.agenda)).toBe(true);

    const platform = await call<PlatformToday>(app, "GET", "/api/today");
    expect(platform.workspaces.map((part) => part.workspace)).toContain("principal");
    expect(platform.waiting.count).toBe(0);
    expect(platform.workspaces.find((part) => part.workspace === "principal")!.agenda.every((item) => item.workspace === "principal")).toBe(true);

    // O mesmo dado vira texto no `get_today` do Maestro (sem acordar ninguém).
    const runtime = workspaces.get("principal");
    const maestro = findMaestroAgent(runtime.store.snapshot());
    const tool = runtime.officeTools(maestro!.id).find((candidate) => candidate.name === "get_today");
    expect(tool).toBeDefined();
    const result = await tool!.call({} as never);
    expect(result.text).toContain("workspace principal");
    expect(result.text).toContain("Goals: Posts 0/3");
  });

  it("workspace inexistente: 404", async () => {
    const { app } = await setupApp();
    expect((await app.inject({ method: "GET", url: "/api/w/nao-existe/today" })).statusCode).toBe(404);
  });
});
