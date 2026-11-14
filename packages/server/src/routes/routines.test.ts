import type { ForYouItem, ManagementSummary, Routine, RoutineDetail, RoutinesOverview } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

const body = (teamId: string, extra: object = {}) => ({ title: "Convites", unit: "convite", kind: "invite", site: "linkedin.com", target: 10, teamId, instruction: "Convide devs", ...extra });

describe("API: rotinas", () => {
  it("cria direto (ativa), mostra no overview com ritmo e dono, e devolve o detalhe", async () => {
    const { app } = await setupApp();
    const { team } = await soloTeam(app);
    const created = await call<Routine>(app, "POST", `${wsApi()}/routines`, body(team.id, { target: 100, needsApproval: false }));
    expect(created).toMatchObject({ id: "R-0001", status: "ativa", target: 60, needsApproval: false, createdBy: "usuario", teamId: team.id });
    const overview = await call<RoutinesOverview>(app, "GET", `${wsApi()}/routines/overview`);
    expect(overview.verdict.total).toBe(1);
    expect(overview.routines).toHaveLength(1);
    expect(overview.routines[0]).toMatchObject({
      delivered: 0,
      registered: 0,
      dailyCap: 15,
      owner: { kind: "team", id: team.id },
      openTask: null,
      history: [],
      cost: { periodUsd: 0, perUnitUsd: null },
    });
    expect(overview.routines[0]!.periodKey).toMatch(/^\d{4}-W\d{2}$/);
    const detail = await call<RoutineDetail>(app, "GET", `${wsApi()}/routines/R-0001`);
    expect(detail.item.routine.id).toBe("R-0001");
    expect(detail).toMatchObject({ entries: [], executions: [], decisions: [] });
  });

  it("valida o corpo: dono obrigatório, site válido, meta positiva", async () => {
    const { app } = await setupApp();
    const { team, agent } = await soloTeam(app);
    const post = (payload: object) => app.inject({ method: "POST", url: `${wsApi()}/routines`, payload });
    expect((await post({ ...body(team.id), teamId: undefined })).statusCode).toBe(400);
    expect((await post(body(team.id, { agentId: agent.id }))).statusCode).toBe(400);
    expect((await post(body(team.id, { site: "não é site" }))).statusCode).toBe(400);
    expect((await post(body(team.id, { target: 0 }))).statusCode).toBe(400);
    expect((await post(body("nao-existe"))).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/xyz` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/R-0099` })).statusCode).toBe(404);
  });

  it("PATCH (só o usuário): meta, sem OK, pausar/retomar, pular semana e arquivar", async () => {
    const { app } = await setupApp();
    const { team } = await soloTeam(app);
    await call(app, "POST", `${wsApi()}/routines`, body(team.id));
    const patch = (payload: object) => call<Routine>(app, "PATCH", `${wsApi()}/routines/R-0001`, payload);
    expect(await patch({ target: 4, needsApproval: false, dailyCap: 3 })).toMatchObject({ target: 4, needsApproval: false, dailyCap: 3 });
    expect(await patch({ status: "pausada" })).toMatchObject({ status: "pausada" });
    expect(await patch({ status: "ativa" })).toMatchObject({ status: "ativa" });
    expect((await patch({ skipThisPeriod: true })).skipPeriods).toHaveLength(1);
    expect((await patch({ skipThisPeriod: false })).skipPeriods).toHaveLength(0);
    const overview = await call<RoutinesOverview>(app, "GET", `${wsApi()}/routines/overview`);
    expect(overview.routines[0]!.dailyCap).toBe(3);
    expect(await patch({ status: "encerrada" })).toMatchObject({ status: "encerrada" });
    expect((await call<RoutinesOverview>(app, "GET", `${wsApi()}/routines/overview`)).routines).toHaveLength(0);
    expect((await app.inject({ method: "PATCH", url: `${wsApi()}/routines/R-0001`, payload: { status: "proposta" } })).statusCode).toBe(400);
  });

  it("PATCH muda o site e o tipo (com validação); o alvo e o teto diário se ajustam ao novo tipo", async () => {
    const { app } = await setupApp();
    const { team } = await soloTeam(app);
    await call(app, "POST", `${wsApi()}/routines`, body(team.id));
    const url = `${wsApi()}/routines/R-0001`;
    const patch = (payload: object) => call<Routine>(app, "PATCH", url, payload);
    expect(await patch({ site: "WWW.Instagram.com" })).toMatchObject({ site: "instagram.com" });
    expect(await patch({ kind: "post" })).toMatchObject({ kind: "post" });
    // Post: no máximo 1 por dia (7 por semana).
    expect((await patch({ kind: "post", target: 20 })).target).toBe(7);
    expect((await app.inject({ method: "PATCH", url, payload: { site: "https://instagram.com/x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, payload: { kind: "inexistente" } })).statusCode).toBe(400);
  });

  it("proposta do Maestro vira cartão 'rotina' no Para você; aprovar ativa com os ajustes do usuário", async () => {
    const { app, workspaces } = await setupApp();
    const { team } = await soloTeam(app);
    const runtime = workspaces.get("principal");
    const { routine } = runtime.routines.propose({ title: "Comentários", unit: "comentário", kind: "comment", site: "linkedin.com", target: 30, teamId: team.id, instruction: "Comente com respeito" });
    const items = await call<ForYouItem[]>(app, "GET", `${wsApi()}/for-you`);
    const card = items.find((item) => item.kind === "rotina")!;
    expect(card).toMatchObject({ status: "pendente", routineId: routine.id, routine: { mode: "criar", target: 30, needsApproval: true, limits: { daily: 8 } } });
    // Não dá para reabrir; a decisão ativa a rotina com os ajustes.
    const decided = await call<ForYouItem>(app, "POST", `${wsApi()}/for-you/${card.id}/decision`, { status: "aprovado", routine: { needsApproval: false, target: 12, dailyCap: 4 } }, 200);
    expect(decided.status).toBe("aprovado");
    const active = await call<RoutineDetail>(app, "GET", `${wsApi()}/routines/${routine.id}`);
    expect(active.item.routine).toMatchObject({ status: "ativa", needsApproval: false, target: 12, dailyCap: 4 });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/for-you/${card.id}/decision`, payload: { status: "pendente" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${wsApi()}/for-you/${card.id}/decision`, payload: { status: "aprovado" } })).statusCode).toBe(409);
  });

  it("recusar ou descartar a proposta arquiva e nada é vigiado", async () => {
    const { app, workspaces } = await setupApp();
    const { team } = await soloTeam(app);
    const runtime = workspaces.get("principal");
    runtime.routines.propose({ title: "A", unit: "x", kind: "post", site: "linkedin.com", target: 2, teamId: team.id, instruction: "" });
    runtime.routines.propose({ title: "B", unit: "x", kind: "post", site: "linkedin.com", target: 2, teamId: team.id, instruction: "" });
    const items = (await call<ForYouItem[]>(app, "GET", `${wsApi()}/for-you`)).filter((item) => item.kind === "rotina");
    await call(app, "POST", `${wsApi()}/for-you/${items[0]!.id}/decision`, { status: "rejeitado" }, 200);
    await call(app, "POST", `${wsApi()}/for-you/${items[1]!.id}/cancel`, { reason: "não quero" }, 200);
    expect(runtime.routines.get("R-0001").status).toBe("encerrada");
    expect(runtime.routines.get("R-0002").status).toBe("encerrada");
  });

  it("GET /management/summary: metas, espera do usuário, tarefas, cota e gasto da semana", async () => {
    const { app, workspaces } = await setupApp();
    const { team } = await soloTeam(app);
    const runtime = workspaces.get("principal");
    await call(app, "POST", `${wsApi()}/routines`, body(team.id));
    runtime.routines.propose({ title: "Pendente", unit: "x", kind: "post", site: "linkedin.com", target: 2, teamId: team.id, instruction: "" });
    const summary = await call<ManagementSummary>(app, "GET", `${wsApi()}/management/summary`);
    expect(summary.goals.total).toBe(1);
    expect(summary.waiting.count).toBe(1);
    expect(summary.waiting.oldestAt).not.toBeNull();
    expect(summary.waiting.olderThan24h).toBe(0);
    expect(summary.tasks).toEqual({ failedToday: [], waitingApproval: [], blockedByEngine: [] });
    expect(summary.weekSpend).toMatchObject({ costUsd: 0, costBrl: 0, turns: 0 });
    expect(summary.weekSpend.periodKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(Array.isArray(summary.quota)).toBe(true);
  });
});
