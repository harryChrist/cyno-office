import type { CalendarEvent, ListCalendarQuery } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeOffice } from "../test-fixtures";
import { applyCalendarEvent } from "./calendarEvents";

const listCalendar = vi.hoisted(() => vi.fn<(query: ListCalendarQuery) => Promise<CalendarEvent[]>>());
vi.mock("../api/client", () => ({ api: { listCalendar }, describeError: (error: unknown) => String(error) }));
vi.mock("../ws/officeSocket", () => ({ backendUp: async () => true }));

const { useCalendarStore } = await import("./calendarStore");
const { useOfficeStore } = await import("./officeStore");
const { useNavStore } = await import("./navStore");
const initialCalendar = useCalendarStore.getState();
const initialOffice = useOfficeStore.getState();
const range = { from: "2026-11-01", to: "2026-12-05" };

function makeEvent(id: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: id, date: "2026-11-07", done: false, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", ...extra };
}

describe("applyCalendarEvent", () => {
  it("insere, troca, remove e devolve o mesmo array quando nada muda", () => {
    const a = makeEvent("a");
    const items = applyCalendarEvent([], { type: "calendar:upserted", calendarEvent: a });
    expect(items).toEqual([a]);
    const done = makeEvent("a", { done: true, updatedAt: "2026-11-02T10:00:00.000Z" });
    expect(applyCalendarEvent(items, { type: "calendar:upserted", calendarEvent: done })).toEqual([done]);
    expect(applyCalendarEvent(items, { type: "calendar:deleted", id: "a" })).toEqual([]);
    expect(applyCalendarEvent(items, { type: "calendar:deleted", id: "x" })).toBe(items);
  });

  it("ignora uma versão mais antiga que a da lista", () => {
    const newer = makeEvent("a", { title: "novo", updatedAt: "2026-11-03T10:00:00.000Z" });
    const items = [newer];
    expect(applyCalendarEvent(items, { type: "calendar:upserted", calendarEvent: makeEvent("a", { title: "velho" }) })).toBe(items);
  });
});

describe("useCalendarStore", () => {
  beforeEach(() => {
    useCalendarStore.setState(initialCalendar, true);
    useOfficeStore.setState(initialOffice, true);
    useCalendarStore.getState().reset();
    listCalendar.mockReset();
    useNavStore.setState({ workspaceId: "principal" });
  });

  it("carrega o período e reaplica os eventos que chegaram durante o GET", async () => {
    let resolve!: (items: CalendarEvent[]) => void;
    listCalendar.mockReturnValue(new Promise((done) => (resolve = done)));
    const loading = useCalendarStore.getState().load(range);
    expect(listCalendar).toHaveBeenCalledWith(range);
    expect(useCalendarStore.getState().status).toBe("loading");

    const created = makeEvent("novo");
    useCalendarStore.getState().applyEvent({ type: "calendar:upserted", calendarEvent: created });
    useCalendarStore.getState().applyEvent({ type: "calendar:deleted", id: "apagado" });
    resolve([makeEvent("velho"), makeEvent("apagado")]);
    await loading;

    expect(useCalendarStore.getState()).toMatchObject({ status: "ready", range });
    expect(useCalendarStore.getState().items.map((item) => item.id)).toEqual(["velho", "novo"]);
  });

  it("descarta a resposta se o workspace mudou no meio (reset)", async () => {
    let resolve!: (items: CalendarEvent[]) => void;
    listCalendar.mockReturnValue(new Promise((done) => (resolve = done)));
    const loading = useCalendarStore.getState().load(range);
    useNavStore.setState({ workspaceId: "instagram" });
    useCalendarStore.getState().reset();
    resolve([makeEvent("do-principal")]);
    await loading;
    expect(useCalendarStore.getState()).toMatchObject({ items: [], status: "idle", range: null });
  });

  it("sem workspace não chama a API; erro vira mensagem", async () => {
    useNavStore.setState({ workspaceId: null });
    await useCalendarStore.getState().load(range);
    expect(listCalendar).not.toHaveBeenCalled();

    useNavStore.setState({ workspaceId: "principal" });
    listCalendar.mockRejectedValue(new Error("falhou"));
    await useCalendarStore.getState().load(range);
    expect(useCalendarStore.getState()).toMatchObject({ status: "error", error: "Error: falhou" });
  });

  it("o applyEvent do escritório repassa calendar:* sem mexer no escritório", () => {
    const office = makeOffice();
    useOfficeStore.getState().applyEvent({ type: "office:snapshot", office });
    const before = useOfficeStore.getState();
    useOfficeStore.getState().applyEvent({ type: "calendar:upserted", calendarEvent: makeEvent("a") });
    expect(useOfficeStore.getState()).toBe(before);
    expect(useCalendarStore.getState().items.map((item) => item.id)).toEqual(["a"]);
    useOfficeStore.getState().applyEvent({ type: "calendar:deleted", id: "a" });
    expect(useCalendarStore.getState().items).toEqual([]);
  });
});
