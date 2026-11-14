import type { OfficeState } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeOffice, makeTask } from "../test-fixtures";

const getOffice = vi.hoisted(() => vi.fn<() => Promise<OfficeState>>());
vi.mock("../api/client", () => ({ api: { getOffice }, describeError: (error: unknown) => String(error) }));
const backendUp = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("../ws/officeSocket", () => ({ backendUp }));

const { useOfficeStore } = await import("./officeStore");
const { useNavStore } = await import("./navStore");
const initialState = useOfficeStore.getState();

describe("useOfficeStore", () => {
  beforeEach(() => {
    useOfficeStore.setState(initialState, true);
    getOffice.mockReset();
    backendUp.mockReset();
    backendUp.mockResolvedValue(true);
    useNavStore.setState({ workspaceId: "principal" });
  });

  it("sem workspace escolhido não chama a API; reset esquece o escritório", async () => {
    useNavStore.setState({ workspaceId: null });
    await useOfficeStore.getState().load();
    expect(getOffice).not.toHaveBeenCalled();

    useOfficeStore.getState().applyEvent({ type: "office:snapshot", office: makeOffice() });
    useOfficeStore.getState().reset();
    expect(useOfficeStore.getState()).toMatchObject({ office: null, status: "idle", live: false });
  });

  it("descarta a resposta do GET se o workspace mudou no meio", async () => {
    let resolve!: (office: OfficeState) => void;
    getOffice.mockReturnValue(new Promise((done) => (resolve = done)));
    const loading = useOfficeStore.getState().load();
    await Promise.resolve();
    useNavStore.setState({ workspaceId: "instagram" });
    resolve(makeOffice());
    await loading;
    expect(useOfficeStore.getState().office).toBeNull();
  });

  it("aplica o snapshot e os eventos seguintes pelo reducer", () => {
    const { applyEvent } = useOfficeStore.getState();
    applyEvent({ type: "task:upserted", task: makeTask("t9") });
    expect(useOfficeStore.getState().office).toBeNull();

    applyEvent({ type: "office:snapshot", office: makeOffice() });
    applyEvent({ type: "task:upserted", task: makeTask("t9", { status: "in_progress" }) });
    applyEvent({ type: "task:progress", taskId: "t9", agentId: "ana", progress: 0.5, message: "meio" });

    const state = useOfficeStore.getState();
    expect(state).toMatchObject({ status: "ready", live: true });
    expect(state.office?.tasks.find((task) => task.id === "t9")?.status).toBe("in_progress");
    expect(state.progress.t9?.progress).toBe(0.5);
  });

  it("não troca o estado (referência) quando o evento não muda nada", () => {
    useOfficeStore.getState().applyEvent({ type: "office:snapshot", office: makeOffice() });
    const before = useOfficeStore.getState();
    before.applyEvent({ type: "agent:deleted", id: "ninguem" });
    expect(useOfficeStore.getState()).toBe(before);
  });

  it("GET /api/office não sobrescreve um snapshot que chegou antes", async () => {
    let resolve!: (office: OfficeState) => void;
    getOffice.mockReturnValue(new Promise((done) => (resolve = done)));
    const loading = useOfficeStore.getState().load();

    const live = makeOffice();
    useOfficeStore.getState().applyEvent({ type: "office:snapshot", office: live });
    resolve({ ...makeOffice(), tasks: [] });
    await loading;

    expect(useOfficeStore.getState().office).toBe(live);
    expect(useOfficeStore.getState().status).toBe("ready");
  });

  it("usa o GET enquanto não há snapshot e marca erro se falhar sem dados", async () => {
    const office = makeOffice();
    getOffice.mockResolvedValueOnce(office);
    await useOfficeStore.getState().load();
    expect(useOfficeStore.getState()).toMatchObject({ office, status: "ready", live: false });

    useOfficeStore.setState(initialState, true);
    getOffice.mockRejectedValueOnce(new Error("fora do ar"));
    await useOfficeStore.getState().load();
    expect(useOfficeStore.getState()).toMatchObject({ office: null, status: "error", error: "fora do ar" });
  });

  it("não chama a API com o backend fora (o snapshot do WS preenche depois)", async () => {
    backendUp.mockResolvedValue(false);
    await useOfficeStore.getState().load();
    expect(getOffice).not.toHaveBeenCalled();
    expect(useOfficeStore.getState()).toMatchObject({ office: null, status: "loading", error: null });
  });

  it("guarda o status do WebSocket", () => {
    useOfficeStore.getState().setSocketStatus("open");
    expect(useOfficeStore.getState().socket).toBe("open");
  });
});
