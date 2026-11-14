import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiErrorBody, CalendarEvent } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { call, createRoom, createWorkspace, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

const createEvent = (app: FastifyInstance, body: object, ws?: string) =>
  call<CalendarEvent>(app, "POST", `${wsApi(ws)}/calendar`, body);

const listEvents = (app: FastifyInstance, query = "", ws?: string) =>
  call<CalendarEvent[]>(app, "GET", `${wsApi(ws)}/calendar${query}`);

async function readCalendarJson(dir: string): Promise<CalendarEvent[]> {
  return JSON.parse(await readFile(path.join(dir, "calendar.json"), "utf8")) as CalendarEvent[];
}

describe("API: calendário", () => {
  it("sem calendar.json a lista é vazia", async () => {
    const { app } = await setupApp();
    expect(await listEvents(app)).toEqual([]);
  });

  it("cria, grava em calendar.json e publica calendar:upserted", async () => {
    const { app, dir, log, store } = await setupApp();
    const created = await createEvent(app, { title: "  Publicar post  ", date: "2026-11-10", time: "09:00", roomId: "projetox", notes: "rascunho pronto" });
    expect(created).toMatchObject({ title: "Publicar post", date: "2026-11-10", time: "09:00", roomId: "projetox", notes: "rascunho pronto", done: false });
    expect(created.createdAt).toBe(created.updatedAt);
    await log.waitFor((event) => event.type === "calendar:upserted" && event.calendarEvent.id === created.id);
    await store.flush();
    expect(await readCalendarJson(dir)).toEqual([created]);
  });

  it("lista no período pedido, na ordem do calendário", async () => {
    const { app } = await setupApp();
    const late = await createEvent(app, { title: "Tarde", date: "2026-11-10", time: "15:00" });
    const allDay = await createEvent(app, { title: "Dia todo", date: "2026-11-10" });
    const early = await createEvent(app, { title: "Cedo", date: "2026-11-10", time: "08:30" });
    const before = await createEvent(app, { title: "Antes", date: "2026-10-31" });
    const after = await createEvent(app, { title: "Depois", date: "2026-12-01" });
    expect((await listEvents(app)).map((event) => event.id)).toEqual([before.id, allDay.id, early.id, late.id, after.id]);
    const november = await listEvents(app, "?from=2026-11-01&to=2026-11-30");
    expect(november.map((event) => event.title)).toEqual(["Dia todo", "Cedo", "Tarde"]);
    expect((await listEvents(app, "?from=2026-11-11")).map((event) => event.id)).toEqual([after.id]);
    expect((await listEvents(app, "?to=2026-10-31")).map((event) => event.id)).toEqual([before.id]);
  });

  it("valida o corpo com mensagens em pt-BR", async () => {
    const { app } = await setupApp();
    const url = `${wsApi()}/calendar`;
    const empty = await call<ApiErrorBody>(app, "POST", url, { title: "", date: "2026-02-30" }, 400);
    expect(empty.error).toBe("Dados inválidos");
    expect(empty.details).toEqual(
      expect.arrayContaining([
        { path: "title", message: "o título não pode ficar vazio" },
        { path: "date", message: expect.stringContaining("data inválida") as string },
      ]),
    );
    const long = await call<ApiErrorBody>(app, "POST", url, { title: "x".repeat(201), date: "2026-11-10" }, 400);
    expect(long.details?.[0]).toEqual({ path: "title", message: "o título pode ter até 200 caracteres" });
    await call(app, "POST", url, { title: "x", date: "2026-11-10", time: "25:00" }, 400);
    await call(app, "POST", url, { title: "x", date: "2026-11-10", id: "meu-id" }, 400);
    const ends = await call<ApiErrorBody>(app, "POST", url, { title: "x", date: "2026-11-10", time: "10:00", endTime: "09:00" }, 400);
    expect(ends.details?.[0]?.path).toBe("endTime");
    await call(app, "GET", `${url}?from=2026-13-01`, undefined, 400);
    await call(app, "GET", `${url}?from=2026-11-30&to=2026-11-01`, undefined, 400);
  });

  it("roomId precisa existir no workspace", async () => {
    const { app } = await setupApp();
    const body = await call<ApiErrorBody>(app, "POST", `${wsApi()}/calendar`, { title: "x", date: "2026-11-10", roomId: "nao-existe" }, 400);
    expect(body.details).toEqual([{ path: "roomId", message: 'a sala "nao-existe" não existe neste workspace' }]);
    const created = await createEvent(app, { title: "x", date: "2026-11-10" });
    await call(app, "PATCH", `${wsApi()}/calendar/${created.id}`, { roomId: "nao-existe" }, 400);
  });

  it("PATCH muda só o que veio, null apaga campos e o horário é conferido junto com o atual", async () => {
    const { app, log } = await setupApp();
    const created = await createEvent(app, { title: "Reunião", date: "2026-11-10", time: "10:00", endTime: "11:00", notes: "pauta" });
    const url = `${wsApi()}/calendar/${created.id}`;
    const done = await call<CalendarEvent>(app, "PATCH", url, { done: true });
    expect(done).toMatchObject({ title: "Reunião", time: "10:00", endTime: "11:00", notes: "pauta", done: true });
    await log.waitFor((event) => event.type === "calendar:upserted" && event.calendarEvent.done);

    const moved = await call<CalendarEvent>(app, "PATCH", url, { date: "2026-11-12", notes: null, roomId: "projetox" });
    expect(moved).toMatchObject({ date: "2026-11-12", roomId: "projetox" });
    expect(moved).not.toHaveProperty("notes");

    const bad = await call<ApiErrorBody>(app, "PATCH", url, { time: "12:00" }, 400);
    expect(bad.details?.[0]?.path).toBe("endTime");

    const allDay = await call<CalendarEvent>(app, "PATCH", url, { time: null });
    expect(allDay).not.toHaveProperty("time");
    expect(allDay).not.toHaveProperty("endTime");

    await call(app, "PATCH", url, { title: null }, 400);
    await call(app, "PATCH", url, { createdAt: "2020-01-01T00:00:00.000Z" }, 400);
  });

  it("DELETE remove, publica calendar:deleted e dá 404 depois", async () => {
    const { app, dir, log, store } = await setupApp();
    const created = await createEvent(app, { title: "Apagar", date: "2026-11-10" });
    const url = `${wsApi()}/calendar/${created.id}`;
    await call(app, "DELETE", url);
    await log.waitFor((event) => event.type === "calendar:deleted" && event.id === created.id);
    await store.flush();
    expect(await readCalendarJson(dir)).toEqual([]);
    const body = await call<ApiErrorBody>(app, "DELETE", url, undefined, 404);
    expect(body.error).toBe(`Evento "${created.id}" não encontrado`);
    await call(app, "PATCH", url, { done: true }, 404);
    await call(app, "DELETE", `${wsApi()}/calendar/..%2Fx`, undefined, 400);
  });

  it("isola os workspaces (dados, eventos e quartos)", async () => {
    const { app, log, workspaces } = await setupApp();
    const other = await createWorkspace(app, "Instagram");
    const otherRoom = await createRoom(app, "Vídeos", {}, other.id);
    const otherHub = workspaces.get(other.id).hub;
    const otherEvents: string[] = [];
    otherHub.subscribe((event) => otherEvents.push(event.type));

    const mine = await createEvent(app, { title: "Só no principal", date: "2026-11-10" });
    expect(await listEvents(app, "", other.id)).toEqual([]);
    expect(otherEvents).not.toContain("calendar:upserted");

    // O quarto de um workspace não vale no outro.
    await call(app, "POST", `${wsApi()}/calendar`, { title: "x", date: "2026-11-10", roomId: otherRoom.id }, 400);
    const theirs = await createEvent(app, { title: "Só no Instagram", date: "2026-11-10", roomId: otherRoom.id }, other.id);
    expect(otherEvents).toContain("calendar:upserted");
    expect(log.events.some((event) => event.type === "calendar:upserted" && event.calendarEvent.id === theirs.id)).toBe(false);

    await call(app, "PATCH", `${wsApi(other.id)}/calendar/${mine.id}`, { done: true }, 404);
    await call(app, "DELETE", `${wsApi(other.id)}/calendar/${mine.id}`, undefined, 404);
    expect((await listEvents(app)).map((event) => event.id)).toEqual([mine.id]);
    await call(app, "GET", "/api/w/nao-existe/calendar", undefined, 404);
  });

  it("recarrega o calendário do disco ao reabrir; arquivo inválido impede abrir", async () => {
    const { app, dataDir, dir, store } = await setupApp();
    const created = await createEvent(app, { title: "Persistente", date: "2026-11-10", time: "08:00" });
    await store.flush();
    await app.close();

    const reopened = await setupApp({ dataDir });
    expect(await listEvents(reopened.app)).toEqual([created]);
    await reopened.app.close();

    await writeFile(path.join(dir, "calendar.json"), JSON.stringify([{ ...created, date: "2026-02-30" }]));
    await expect(setupApp({ dataDir })).rejects.toThrow(/calendar\.json/);
  });
});
