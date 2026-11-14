import type { PlatformRoutinesToday, Routine, RoutineDetail, RoutineRun, RoutinesToday, TrackedItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

const midnight = [{ label: "Madrugada", days: { kind: "todo_dia" }, times: ["00:00"], action: "Leia os e-mails" }];
const tracking = { fields: [{ key: "empresa", label: "Empresa", type: "texto", required: true }], statuses: [{ name: "Inscrito" }, { name: "Entrevista" }, { name: "Recusado", terminal: true }], lifespan: { days: 15, untilTerminal: true } };

describe("API: rotinas, acabamento", () => {
  it("horário novo com a hora de hoje já passada: a resposta diz 'primeira execução: amanhã às 0h' e 'Rodar agora' dispara uma execução avulsa sem empilhar", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app);
    const created = await call<Routine & { firstRuns: { scheduleId: string; text: string }[] }>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules: midnight, tracking });
    expect(created.firstRuns).toMatchObject([{ scheduleId: "S1", text: "primeira execução: amanhã às 0h" }]);
    const detail = await call<RoutineDetail>(app, "GET", `${wsApi()}/routines/R-0001`);
    expect(detail.item.firstRuns).toHaveLength(1);

    const first = await call<{ run: RoutineRun }>(app, "POST", `${wsApi()}/routines/R-0001/schedules/S1/run`, undefined, 200);
    expect(first.run).toMatchObject({ scheduleId: "S1", outcome: "rodando" });
    // A execução anterior ainda está aberta: a segunda é pulada ("não empilhar").
    const second = await call<{ run: RoutineRun }>(app, "POST", `${wsApi()}/routines/R-0001/schedules/S1/run`, undefined, 200);
    expect(second.run).toMatchObject({ outcome: "pulada", skipReason: expect.stringContaining("ainda está aberta") });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/R-0001/schedules/S9/run` })).statusCode).toBe(404);
    await call<Routine>(app, "PATCH", `${wsApi()}/routines/R-0001`, { status: "pausada" });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/R-0001/schedules/S1/run` })).statusCode).toBe(409);
  });

  it("próximas com from/to devolvem só o período pedido", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app);
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules: [{ label: "Dia", days: { kind: "todo_dia" }, times: ["09:00", "18:00"], action: "x" }], tracking });
    const from = new Date(Date.now() + 2 * 86_400_000);
    const to = new Date(from.getTime() + 3 * 86_400_000);
    const { next } = await call<{ next: { at: string }[] }>(app, "GET", `${wsApi()}/routines/R-0001/next?from=${from.toISOString()}&to=${to.toISOString()}&count=200`);
    expect(next.length).toBeGreaterThanOrEqual(6);
    expect(next.length).toBeLessThanOrEqual(8);
    expect(next.every((slot) => Date.parse(slot.at) >= from.getTime() && Date.parse(slot.at) < to.getTime())).toBe(true);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/R-0001/next?from=${to.toISOString()}&to=${from.toISOString()}` })).statusCode).toBe(400);
  });

  it("apagar: só encerrada ou proposta; leva itens e histórico; 409 para rotina viva", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await soloTeam(app);
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules: midnight, tracking });
    const runtime = workspaces.get("principal");
    runtime.tracking.add("R-0001", { values: { empresa: "Acme" }, sourceKey: "m1" });
    expect((await app.inject({ method: "DELETE", url: `${wsApi()}/routines/R-0001` })).statusCode).toBe(409);
    await call<Routine>(app, "PATCH", `${wsApi()}/routines/R-0001`, { status: "arquivada" });
    expect(await call(app, "DELETE", `${wsApi()}/routines/R-0001`, undefined, 200)).toEqual({ removed: "R-0001" });
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/R-0001` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${wsApi()}/routines/R-0001` })).statusCode).toBe(404);
    expect(runtime.routines.list()).toHaveLength(0);
  });

  it("reabrir item encerrado por status final ou por prazo: volta ao status anterior não final, com validade nova", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await soloTeam(app);
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules: midnight, tracking });
    const runtime = workspaces.get("principal");
    runtime.tracking.add("R-0001", { values: { empresa: "Acme" }, sourceKey: "m1" });
    runtime.tracking.update("R-0001", "I-0001", { status: "Entrevista" });
    runtime.tracking.update("R-0001", "I-0001", { status: "Recusado" });
    expect(runtime.tracking.get("R-0001", "I-0001")).toMatchObject({ state: "encerrado", status: "Recusado", endReason: "terminal" });
    const reopened = await call<{ item: TrackedItem }>(app, "POST", `${wsApi()}/routines/R-0001/items/I-0001/reopen`, undefined, 200);
    expect(reopened.item).toMatchObject({ state: "ativo", status: "Entrevista" });
    expect(reopened.item.expiresAt).toBeDefined();
    expect(reopened.item.endedAt).toBeUndefined();
  });

  it("pular o próximo período da meta", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app);
    const created = await call<Routine>(app, "POST", `${wsApi()}/routines`, { title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 3, agentId: agent.id });
    const skipped = await call<Routine>(app, "PATCH", `${wsApi()}/routines/${created.id}`, { skipNextPeriod: true });
    expect(skipped.skipPeriods).toHaveLength(1);
    const current = await call<Routine>(app, "PATCH", `${wsApi()}/routines/${created.id}`, { skipThisPeriod: true });
    expect(current.skipPeriods).toHaveLength(2);
    expect(new Set(current.skipPeriods).size).toBe(2);
    const undone = await call<Routine>(app, "PATCH", `${wsApi()}/routines/${created.id}`, { skipNextPeriod: false });
    expect(undone.skipPeriods).toHaveLength(1);
  });

  it("rotinas de hoje: do workspace e da plataforma", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await soloTeam(app);
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules: [{ label: "Fim do dia", days: { kind: "todo_dia" }, times: ["23:59"], action: "x" }], tracking });
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 3, agentId: agent.id });
    const runtime = workspaces.get("principal");
    runtime.tracking.add("R-0001", { values: { empresa: "Acme" }, sourceKey: "m1", status: "Inscrito" });
    const today = await call<RoutinesToday>(app, "GET", `${wsApi()}/routines/today`);
    expect(today.workspace).toBe("principal");
    expect(today.goals).toMatchObject([{ routineId: "R-0002", title: "Posts", done: 0, target: 3, period: "week" }]);
    expect(today.changes.map((change) => change.item)).toContain("Acme");
    expect(today.running).toEqual([]);
    // O horário de 23:59 ainda vai rodar hoje (a menos que o teste rode depois disso).
    if (new Date().getHours() < 23) expect(today.upcoming).toMatchObject([{ routineId: "R-0001", label: "Fim do dia", agent: expect.any(String) }]);
    const platform = await call<PlatformRoutinesToday>(app, "GET", "/api/routines/today");
    expect(platform.workspaces.map((part) => part.workspace)).toContain("principal");
    expect(platform.goals.every((goal) => typeof goal.workspace === "string")).toBe(true);
    expect(platform.changes.length).toBeGreaterThan(0);
  });

  it("'Tentar de novo' em rotina não bloqueada é inofensivo e responde a rotina", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app);
    const created = await call<Routine>(app, "POST", `${wsApi()}/routines`, { title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 3, agentId: agent.id });
    const retried = await call<{ routine: Routine }>(app, "POST", `${wsApi()}/routines/${created.id}/retry`, undefined, 200);
    expect(retried.routine).toMatchObject({ id: created.id, status: "ativa" });
    expect(retried.routine.blocked).toBeUndefined();
  });
});
