import type { Routine, RoutinesOverview, TrackedItemChange, TrackedItem, TrackedItemsResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

const schedules = [
  { label: "E-mail", days: { kind: "uteis" }, times: ["18:00", "09:00", "13:00"], action: "Leia os e-mails novos" },
  { label: "Conferir", days: { kind: "semana", weekdays: [2, 4] }, times: ["10:00"], action: "Abra os sites" },
];

describe("API: rotinas com horários", () => {
  it("cria acompanhamento (dono por endereço), lista horários, próximas e execuções; pausa e retoma", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app);
    const created = await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", address: `principal/${agent.id}`, schedules });
    expect(created).toMatchObject({ id: "R-0001", type: "acompanhamento", status: "ativa", agentId: agent.id, owner: { address: `principal/${agent.id}` } });
    expect(created.schedules.map((s) => [s.id, s.label, s.times])).toEqual([
      ["S1", "E-mail", ["09:00", "13:00", "18:00"]],
      ["S2", "Conferir", ["10:00"]],
    ]);
    const next = await call<{ next: { scheduleId: string; slotKey: string }[] }>(app, "GET", `${wsApi()}/routines/R-0001/next?count=4`);
    expect(next.next).toHaveLength(4);
    expect(next.next.every((slot) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot.slotKey))).toBe(true);
    expect(await call(app, "GET", `${wsApi()}/routines/R-0001/runs`)).toEqual({ runs: [] });
    const overview = await call<RoutinesOverview>(app, "GET", `${wsApi()}/routines/overview`);
    expect(overview.routines[0]).toMatchObject({ pace: "no_ritmo", routine: { type: "acompanhamento" } });
    expect(overview.routines[0]!.next).toHaveLength(3);
    expect(overview.verdict.total).toBe(0);

    expect((await call<Routine>(app, "PATCH", `${wsApi()}/routines/R-0001`, { status: "pausada" })).status).toBe("pausada");
    expect((await call<{ next: unknown[] }>(app, "GET", `${wsApi()}/routines/R-0001/next`)).next).toEqual([]);
    expect((await call<Routine>(app, "PATCH", `${wsApi()}/routines/R-0001`, { status: "ativa" })).status).toBe("ativa");
    const edited = await call<Routine>(app, "PATCH", `${wsApi()}/routines/R-0001`, { schedules: [{ id: "S1", ...schedules[0], enabled: false }] });
    expect(edited.schedules).toMatchObject([{ id: "S1", enabled: false }]);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/R-0099/next` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/R-0001/next?count=0` })).statusCode).toBe(400);
  });

  it("valida: acompanhamento sem horário, hora inválida, endereço de agente que não existe", async () => {
    const { app } = await setupApp();
    const { agent } = await soloTeam(app);
    const post = (payload: object) => app.inject({ method: "POST", url: `${wsApi()}/routines`, payload });
    const base = { type: "acompanhamento", title: "T", agentId: agent.id };
    expect((await post({ ...base })).statusCode).toBe(400);
    expect((await post({ ...base, schedules: [{ ...schedules[0], times: ["25:00"] }] })).statusCode).toBe(400);
    expect((await post({ ...base, schedules: [{ ...schedules[0], agent: "principal/ninguem" }] })).statusCode).toBe(400);
    expect((await post({ ...base, schedules: [schedules[0]] })).statusCode).toBe(201);
  });

  it("itens acompanhados: lista com resumo e histórico, parar, reabrir, corrigir campo e mudanças recentes", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await soloTeam(app);
    const tracking = { fields: [{ key: "empresa", label: "Empresa", type: "texto", required: true }, { key: "link", label: "Link", type: "link" }], statuses: [{ name: "Inscrito" }, { name: "Entrevista", alert: true }], lifespan: { days: 15, untilTerminal: true }, checkEveryHours: 24 };
    await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules: [schedules[0]], tracking });
    const runtime = workspaces.get("principal");
    runtime.tracking.add("R-0001", { values: { empresa: "Acme" }, sourceKey: "m1" });
    runtime.tracking.add("R-0001", { values: { empresa: "Beta" }, sourceKey: "m2" });

    const listed = await call<TrackedItemsResponse>(app, "GET", `${wsApi()}/routines/R-0001/items`);
    expect(listed.total).toBe(2);
    expect(listed.summary).toMatchObject({ active: 2, changedToday: 2, due: 2 });
    expect(listed.items[0]).toMatchObject({ id: "I-0001", status: "Inscrito", values: { empresa: "Acme" } });
    expect(listed.items[0]!.history[0]).toMatchObject({ field: "criado", to: "Inscrito" });
    const overview = await call<RoutinesOverview>(app, "GET", `${wsApi()}/routines/overview`);
    expect(overview.routines[0]!.tracking).toMatchObject({ active: 2, stopped: 0 });

    const stopped = await call<{ item: TrackedItem }>(app, "POST", `${wsApi()}/routines/R-0001/items/I-0001/stop`, { reason: "desisti" }, 200);
    expect(stopped.item).toMatchObject({ state: "parado", endReason: "usuario" });
    expect((await call<TrackedItemsResponse>(app, "GET", `${wsApi()}/routines/R-0001/items?state=parado`)).items.map((i) => i.id)).toEqual(["I-0001"]);
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/R-0001/items/I-0001/stop`, payload: {} })).statusCode).toBe(400);
    expect((await call<{ item: TrackedItem }>(app, "POST", `${wsApi()}/routines/R-0001/items/I-0001/reopen`, undefined, 200)).item.state).toBe("ativo");

    const edited = await call<{ item: TrackedItem }>(app, "PATCH", `${wsApi()}/routines/R-0001/items/I-0002`, { values: { empresa: "Beta SA" }, status: "Entrevista" });
    expect(edited.item).toMatchObject({ status: "Entrevista", values: { empresa: "Beta SA" } });
    expect((await app.inject({ method: "PATCH", url: `${wsApi()}/routines/R-0001/items/I-0002`, payload: { values: { link: "x" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `${wsApi()}/routines/R-0001/items/I-0002`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/R-0001/items/I-0099/stop`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/routines/R-0099/items` })).statusCode).toBe(404);

    const changes = await call<{ changes: TrackedItemChange[] }>(app, "GET", `${wsApi()}/routines/R-0001/changes?hours=24`);
    expect(changes.changes.map((c) => c.text)).toContain("Beta SA → Entrevista");
    expect(changes.changes.map((c) => c.by)).toContain("usuario");
  });
});
