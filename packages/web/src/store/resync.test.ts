import type { AgentUsageResponse, BrowserState, Connector, ForYouItem, ServerEvent } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeOffice } from "../test-fixtures";

const api = vi.hoisted(() => ({
  getOffice: vi.fn(),
  listForYou: vi.fn(),
  listForYouTypes: vi.fn(),
  listConnectors: vi.fn(),
  getBrowser: vi.fn(),
  listCalendar: vi.fn(),
  agentUsage: vi.fn(),
  getAgentLog: vi.fn(),
}));
vi.mock("../api/client", () => ({ api, describeError: (error: unknown) => String(error) }));
vi.mock("../ws/officeSocket", () => ({ backendUp: async () => true }));

const { useOfficeStore } = await import("./officeStore");
const { useNavStore } = await import("./navStore");
const { useConnectorsStore } = await import("./connectorsStore");
const { useBrowserStore } = await import("./browserStore");
const { useCalendarStore } = await import("./calendarStore");
const { useAgentLogStore } = await import("./agentLogStore");
const { useAgentUsageStore } = await import("./agentUsageStore");
const initialState = useOfficeStore.getState();

const forYouItem = { id: "A-0001", agentId: "ana", roomId: "projetox", type: "post", status: "pending", meta: {}, text: "oi" } as unknown as ForYouItem;
const connector = { id: "c1", name: "GitHub" } as unknown as Connector;
const browser: BrowserState = { enabled: true, running: true, tabs: [] };

function snapshot(extra: Partial<Extract<ServerEvent, { type: "office:snapshot" }>> = {}): ServerEvent {
  return { type: "office:snapshot", office: makeOffice(), forYou: [forYouItem], forYouTypes: [], connectors: [connector], browser, epoch: "e1", seq: 10, ...extra };
}

describe("ressincronização: snapshot completo x replay", () => {
  beforeEach(() => {
    useOfficeStore.setState(initialState, true);
    useOfficeStore.getState().reset();
    useCalendarStore.getState().reset();
    useAgentLogStore.getState().reset();
    for (const fn of Object.values(api)) fn.mockReset();
    api.listCalendar.mockResolvedValue([]);
    api.agentUsage.mockResolvedValue({ since: "2026-11-09T00:00:00.000Z", agents: [] } satisfies AgentUsageResponse);
    useNavStore.setState({ workspaceId: "principal" });
  });

  it("o snapshot traz 'Para você', conectores e navegador: nada de GET", () => {
    useOfficeStore.getState().applyEvent(snapshot());
    expect(useOfficeStore.getState().forYou).toEqual([forYouItem]);
    expect(useOfficeStore.getState().forYouTypes).toEqual([]);
    expect(useConnectorsStore.getState().list).toEqual([connector]);
    expect(useBrowserStore.getState().browser).toEqual(browser);
    expect(api.listForYou).not.toHaveBeenCalled();
    expect(api.listConnectors).not.toHaveBeenCalled();
    expect(api.getBrowser).not.toHaveBeenCalled();
    // Primeira conexão: o calendário e o uso por agente ficam para quem os abrir.
    expect(api.listCalendar).not.toHaveBeenCalled();
  });

  it("snapshot depois de já estar ao vivo (server reiniciou): recarrega calendário, logs abertos e uso por agente", async () => {
    const { applyEvent } = useOfficeStore.getState();
    applyEvent(snapshot());
    await useCalendarStore.getState().load({ from: "2026-11-01", to: "2026-11-30" });
    await useAgentUsageStore.getState().load("2026-11-09T00:00:00.000Z");
    api.listCalendar.mockClear();
    api.agentUsage.mockClear();
    const generation = useAgentLogStore.getState().generation;

    applyEvent(snapshot({ epoch: "e2", seq: 0, forYou: [] }));
    expect(useOfficeStore.getState().forYou).toEqual([]);
    expect(api.listCalendar).toHaveBeenCalledWith({ from: "2026-11-01", to: "2026-11-30" });
    expect(api.agentUsage).toHaveBeenCalledTimes(1);
    expect(useAgentLogStore.getState().generation).toBe(generation + 1);
  });

  it("reconexão com replay (sync:resumed): só aplica os eventos, sem recarregar nada nem piscar", async () => {
    const { applyEvent } = useOfficeStore.getState();
    applyEvent(snapshot());
    await useCalendarStore.getState().load({ from: "2026-11-01", to: "2026-11-30" });
    api.listCalendar.mockClear();
    const before = useOfficeStore.getState();
    const generation = useAgentLogStore.getState().generation;

    applyEvent({ type: "sync:resumed", epoch: "e1", since: 10, until: 12, replayed: 2 });
    expect(useOfficeStore.getState()).toBe(before);
    applyEvent({ type: "foryou:upserted", item: { ...forYouItem, id: "A-0002" } });
    applyEvent({ type: "calendar:upserted", calendarEvent: { id: "ev1", title: "Perdida", date: "2026-11-10", done: false, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" } });

    expect(useOfficeStore.getState().forYou?.map((item) => item.id)).toEqual(["A-0001", "A-0002"]);
    expect(useCalendarStore.getState().items.map((item) => item.id)).toEqual(["ev1"]);
    expect(api.listCalendar).not.toHaveBeenCalled();
    expect(api.listForYou).not.toHaveBeenCalled();
    expect(useAgentLogStore.getState().generation).toBe(generation);
  });

  it("server antigo (snapshot sem 'Para você'/conectores/navegador): busca por GET como antes", async () => {
    api.listForYou.mockResolvedValue([forYouItem]);
    api.listForYouTypes.mockResolvedValue([]);
    api.listConnectors.mockResolvedValue([connector]);
    api.getBrowser.mockResolvedValue(browser);
    useOfficeStore.getState().applyEvent({ type: "office:snapshot", office: makeOffice() });
    await vi.waitFor(() => expect(useConnectorsStore.getState().list).toEqual([connector]));
    await vi.waitFor(() => expect(useOfficeStore.getState().forYou).toEqual([forYouItem]));
    expect(api.getBrowser).toHaveBeenCalled();
  });

  it("usage:agents soma o turno no 'Por agente' já carregado", async () => {
    useOfficeStore.getState().applyEvent(snapshot());
    await useAgentUsageStore.getState().load("2026-11-09T00:00:00.000Z");
    useOfficeStore.getState().applyEvent({
      type: "usage:agents",
      turn: { agentId: "ana", provider: "claude", at: "2026-11-09T01:00:00.000Z", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1 } },
    });
    expect(useAgentUsageStore.getState().data?.agents).toEqual([
      { agentId: "ana", provider: "claude", turns: 1, measuredTurns: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1, lastAt: "2026-11-09T01:00:00.000Z" },
    ]);
    expect(api.agentUsage).toHaveBeenCalledTimes(1);
  });
});
