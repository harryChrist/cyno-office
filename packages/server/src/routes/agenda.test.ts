import type { AgendaEvent, AgendaRefusal, AgendaResponse, Availability, CalendarEvent, SlotCheck } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { call, createWorkspace, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { writeAuthFile } from "../platform/auth/store";

const setupApp = useTestApp();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Disponível o tempo todo (o teste usa o relógio de verdade), sem antecedência nem intervalo. */
const OPEN_ALL_DAY = { weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: "00:00", to: "24:00" })), bufferMinutes: 0, minNoticeMinutes: 0 };

const iso = (ms: number) => new Date(ms).toISOString();
/** Daqui a `days` dias, na hora cheia. */
const slot = (days: number, hour = 0) => {
  const base = Math.ceil(Date.now() / HOUR) * HOUR + days * DAY + hour * HOUR;
  return { start: iso(base), end: iso(base + HOUR) };
};
const post = <T>(app: FastifyInstance, body: object, status = 201) => call<T>(app, "POST", "/api/agenda", body, status);

describe("API: Sua agenda", () => {
  it("fica atrás da senha", async () => {
    const test = await setupApp();
    await writeAuthFile(test.dataDir, "senha-de-teste-1");
    for (const [method, url] of [
      ["GET", "/api/agenda"],
      ["POST", "/api/agenda"],
      ["PATCH", "/api/agenda/G-0001"],
      ["DELETE", "/api/agenda/G-0001"],
      ["POST", "/api/agenda/check"],
      ["GET", "/api/agenda/availability"],
      ["PUT", "/api/agenda/availability"],
    ] as const) {
      const response = await test.app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("disponibilidade: padrão seg-sex 9h-18h, grava e recusa janela invertida", async () => {
    const { app } = await setupApp();
    const current = await call<Availability>(app, "GET", "/api/agenda/availability");
    expect(current).toMatchObject({ bufferMinutes: 15, timezone: "America/Sao_Paulo", defaultDurationMinutes: 60 });
    expect(current.weekly).toHaveLength(5);
    const saved = await call<Availability>(app, "PUT", "/api/agenda/availability", { ...current, weekly: [{ weekday: 6, from: "10:00", to: "12:00" }], exceptions: [{ date: "2026-12-25", off: true }] });
    expect(saved.weekly).toEqual([{ weekday: 6, from: "10:00", to: "12:00" }]);
    expect(await call<Availability>(app, "GET", "/api/agenda/availability")).toEqual(saved);
    const bad = await app.inject({ method: "PUT", url: "/api/agenda/availability", payload: { weekly: [{ weekday: 1, from: "12:00", to: "10:00" }] } });
    expect(bad.statusCode).toBe(400);
  });

  it("marca, recusa o choque (409 com 3 sugestões), sobrepõe com confirmação, move e cancela", async () => {
    const { app } = await setupApp();
    await call(app, "PUT", "/api/agenda/availability", OPEN_ALL_DAY);
    const first = slot(2, 17);
    const created = await post<AgendaEvent>(app, { ...first, title: "Reunião", kind: "reuniao", link: "https://meet.example/r", workspace: "principal" });
    expect(created).toMatchObject({ id: "G-0001", by: { kind: "dono" }, workspace: "principal", status: "marcado" });

    const refused = await post<AgendaRefusal>(app, { ...first, title: "Outra" }, 409);
    expect(refused.check).toMatchObject({ ok: false, problem: "conflict", conflicts: [{ id: "G-0001" }] });
    expect(refused.check.nextFree).toHaveLength(3);
    const free = refused.check.nextFree[0]!;
    const second = await post<AgendaEvent>(app, { title: "Outra", ...free });
    expect(second.id).toBe("G-0002");

    // Sobrepor (só o dono, pela tela): confirma com override.
    const forced = await post<AgendaEvent>(app, { ...first, title: "Por cima", override: true });
    expect(forced.id).toBe("G-0003");

    const clash = await call<AgendaRefusal>(app, "PATCH", "/api/agenda/G-0002", { start: first.start, end: first.end }, 409);
    expect(clash.check.problem).toBe("conflict");
    const target = slot(4, 9);
    const moved = await call<AgendaEvent>(app, "PATCH", "/api/agenda/G-0002", target);
    expect(moved).toMatchObject({ start: target.start, movedFrom: free.start });
    const renamed = await call<AgendaEvent>(app, "PATCH", "/api/agenda/G-0002", { title: "Renomeada", notes: "pauta" });
    expect(renamed).toMatchObject({ title: "Renomeada", notes: "pauta", start: target.start });

    const cancelled = await call<AgendaEvent>(app, "DELETE", "/api/agenda/G-0001", undefined, 200);
    expect(cancelled.status).toBe("cancelado");
    expect((await call<AgendaResponse>(app, "GET", "/api/agenda")).events.map((event) => event.id)).toEqual(["G-0003", "G-0002"]);
    expect((await call<AgendaResponse>(app, "GET", "/api/agenda?cancelled=1")).events).toHaveLength(3);
    expect((await app.inject({ method: "PATCH", url: "/api/agenda/G-0404", payload: { title: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/agenda/G-0002", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/agenda", payload: { ...slot(9), title: "WS", workspace: "nao-existe" } })).statusCode).toBe(400);
  });

  it("check confere sem marcar (ignoreId deixa mover o próprio)", async () => {
    const { app } = await setupApp();
    await call(app, "PUT", "/api/agenda/availability", OPEN_ALL_DAY);
    const when = slot(3, 10);
    await post(app, { ...when, title: "A" });
    expect(await call<SlotCheck>(app, "POST", "/api/agenda/check", when, 200)).toMatchObject({ ok: false, problem: "conflict" });
    expect(await call<SlotCheck>(app, "POST", "/api/agenda/check", { ...when, ignoreId: "G-0001" }, 200)).toEqual({ ok: true });
    expect(await call<SlotCheck>(app, "POST", "/api/agenda/check", slot(3, 20), 200)).toEqual({ ok: true });
  });

  it("junta a camada Postagens de cada workspace (sem gerar choque) e as rotinas só se pedidas", async () => {
    const { app } = await setupApp();
    const other = await createWorkspace(app, "Segundo");
    await call(app, "PUT", "/api/agenda/availability", OPEN_ALL_DAY);
    const when = slot(2, 15);
    // O dia é o de São Paulo (UTC-3), onde a agenda vive.
    const day = iso(Date.parse(when.start) - 3 * HOUR).slice(0, 10);
    await call<CalendarEvent>(app, "POST", `${wsApi()}/calendar`, { title: "Post sobre IA", date: day, time: "12:00" });
    await call<CalendarEvent>(app, "POST", `${wsApi(other.id)}/calendar`, { title: "Post do segundo", date: day });
    // Um evento de postagem no mesmo horário não gera choque.
    await post(app, { ...when, title: "Reunião" });
    const response = await call<AgendaResponse>(app, "GET", `/api/agenda?from=${day}&to=${day}`);
    expect(response.events.map((event) => event.title)).toEqual(["Reunião"]);
    expect(response.posts.map((item) => [item.workspace, item.title])).toEqual([
      ["principal", "Post sobre IA"],
      [other.id, "Post do segundo"],
    ]);
    expect(response.workspaces.map((workspace) => workspace.id)).toContain(other.id);
    expect(response.routines).toEqual([]);
    expect((await call<AgendaResponse>(app, "GET", `/api/agenda?from=${day}&to=${day}&posts=0`)).posts).toEqual([]);
    expect((await app.inject({ url: "/api/agenda?from=2026-11-10&to=2026-11-01" })).statusCode).toBe(400);
  });
});
