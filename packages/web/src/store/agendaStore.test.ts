import { agendaEventSchema, availabilitySchema, type AgendaEvent } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listAgenda = vi.fn();
vi.mock("../api/client", () => ({ api: { listAgenda: (...args: unknown[]) => listAgenda(...args) }, describeError: (error: unknown) => String(error) }));
vi.mock("../ws/cynoSocket", () => ({ connectCynoSocket: vi.fn(() => () => undefined) }));

const { upsertAgendaEvent, useAgendaStore } = await import("./agendaStore");

const ev = (id: number, start: string, extra: Partial<AgendaEvent> = {}): AgendaEvent =>
  agendaEventSchema.parse({ id: `G-${String(id).padStart(4, "0")}`, title: `E${id}`, start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), createdAt: "2026-11-01T00:00:00.000Z", ...extra });

beforeEach(() => {
  listAgenda.mockReset();
  useAgendaStore.setState({ events: [], posts: [], routines: [], availability: null, workspaces: [], range: null, status: "idle", error: null });
});

describe("upsertAgendaEvent", () => {
  it("insere em ordem de início, troca pelo id e não deixa uma versão antiga sobrescrever", () => {
    const a = ev(1, "2026-11-10T20:00:00.000Z");
    const b = ev(2, "2026-11-10T18:00:00.000Z");
    expect(upsertAgendaEvent([a], b).map((event) => event.id)).toEqual(["G-0002", "G-0001"]);
    const cancelled = { ...a, status: "cancelado" as const, updatedAt: "2026-11-02T00:00:00.000Z" };
    const afterCancel = upsertAgendaEvent([a], cancelled);
    expect(afterCancel[0]!.status).toBe("cancelado");
    expect(upsertAgendaEvent(afterCancel, a)[0]!.status).toBe("cancelado");
  });
});

describe("useAgendaStore", () => {
  it("carrega o período e aplica o que chegou ao vivo durante a busca", async () => {
    const availability = availabilitySchema.parse({});
    let finish!: (value: unknown) => void;
    listAgenda.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const loading = useAgendaStore.getState().load({ from: "2026-11-09", to: "2026-11-15", routines: false });
    expect(useAgendaStore.getState().status).toBe("loading");
    // Um compromisso novo chega pelo websocket antes de o GET voltar.
    useAgendaStore.getState().applyEvent({ type: "agenda:upserted", event: ev(3, "2026-11-11T20:00:00.000Z") });
    finish({ events: [ev(1, "2026-11-10T20:00:00.000Z")], posts: [], routines: [], availability, workspaces: [{ id: "a", name: "A" }] });
    await loading;
    const state = useAgendaStore.getState();
    expect(state.status).toBe("ready");
    expect(state.events.map((event) => event.id)).toEqual(["G-0001", "G-0003"]);
    expect(state.workspaces).toEqual([{ id: "a", name: "A" }]);
    expect(listAgenda).toHaveBeenCalledWith({ from: "2026-11-09", to: "2026-11-15", routines: false, cancelled: true });
  });

  it("a disponibilidade nova chega ao vivo; erro de rede vira estado de erro", async () => {
    useAgendaStore.getState().applyEvent({ type: "agenda:availability", availability: availabilitySchema.parse({ bufferMinutes: 5 }) });
    expect(useAgendaStore.getState().availability?.bufferMinutes).toBe(5);
    listAgenda.mockRejectedValue(new Error("sem rede"));
    await useAgendaStore.getState().load({ from: "2026-11-09", to: "2026-11-15", routines: true });
    expect(useAgendaStore.getState()).toMatchObject({ status: "error", error: "Error: sem rede" });
  });
});
