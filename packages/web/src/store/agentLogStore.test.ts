import type { AgentLogResponse, TaskLogResponse } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLogEntry as entry } from "../test-fixtures";

const getAgentLog = vi.hoisted(() => vi.fn<(agentId: string, limit?: number) => Promise<AgentLogResponse>>());
const getTaskLog = vi.hoisted(() => vi.fn<(taskId: string) => Promise<TaskLogResponse>>());
vi.mock("../api/client", () => ({ api: { getAgentLog, getTaskLog }, describeError: (error: unknown) => String(error) }));
vi.mock("../ws/officeSocket", () => ({ backendUp: async () => true }));

const { useAgentLogStore } = await import("./agentLogStore");
const { useNavStore } = await import("./navStore");
const { useOfficeStore } = await import("./officeStore");

describe("useAgentLogStore", () => {
  beforeEach(() => {
    useNavStore.setState({ workspaceId: "ws" });
    useAgentLogStore.getState().reset();
    getAgentLog.mockReset();
    getTaskLog.mockReset();
  });

  it("carrega o histórico e junta com o que chegou ao vivo antes", async () => {
    useAgentLogStore.getState().apply(entry("e3", { kind: "text", text: "ao vivo" }));
    getAgentLog.mockResolvedValue({ agentId: "ana", entries: [entry("e1", { kind: "text", text: "a" }), entry("e2", { kind: "text", text: "b" })], summary: { activeSubagents: 1 } });
    await useAgentLogStore.getState().loadAgent("ana");
    const state = useAgentLogStore.getState();
    expect(state.byAgent.ana!.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);
    expect(state.summaries.ana).toEqual({ activeSubagents: 1 });
    expect(state.agentLoad.ana).toEqual({ state: "ready" });
    // Já carregado: não busca de novo (a menos que force).
    await useAgentLogStore.getState().loadAgent("ana");
    expect(getAgentLog).toHaveBeenCalledTimes(1);
  });

  it("o log de uma tarefa carregada também recebe os eventos ao vivo; os outros não", async () => {
    getTaskLog.mockResolvedValue({ taskId: "t1", entries: [entry("e1", { kind: "text", text: "a" })], threads: [] });
    await useAgentLogStore.getState().loadTask("t1");
    useAgentLogStore.getState().apply(entry("e2", { kind: "text", text: "sub" }, { thread: "sa1" }));
    useAgentLogStore.getState().apply(entry("e3", { kind: "text", text: "outra" }, { taskId: "t2" }));
    const state = useAgentLogStore.getState();
    expect(state.byTask.t1!.map((item) => item.id)).toEqual(["e1", "e2"]);
    expect(state.byTask.t2).toBeUndefined();
    expect(state.byAgent.ana!.map((item) => item.id)).toEqual(["e2", "e3"]);
  });

  it("erro fica guardado; reset descarta respostas do workspace anterior", async () => {
    getAgentLog.mockRejectedValueOnce(new Error("fora"));
    await useAgentLogStore.getState().loadAgent("ana");
    expect(useAgentLogStore.getState().agentLoad.ana).toEqual({ state: "error", message: "Error: fora" });

    let resolve!: (value: AgentLogResponse) => void;
    getAgentLog.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const pending = useAgentLogStore.getState().loadAgent("ana", true);
    useAgentLogStore.getState().reset();
    resolve({ agentId: "ana", entries: [entry("e1", { kind: "text", text: "velho" })], summary: { activeSubagents: 0 } });
    await pending;
    expect(useAgentLogStore.getState().byAgent).toEqual({});
  });

  it("agent:log pelo officeStore vai para o log; o snapshot invalida o que foi carregado", async () => {
    getAgentLog.mockResolvedValue({ agentId: "ana", entries: [], summary: { activeSubagents: 0 } });
    await useAgentLogStore.getState().loadAgent("ana");
    const generation = useAgentLogStore.getState().generation;
    useOfficeStore.getState().applyEvent({ type: "agent:log", entry: entry("e9", { kind: "text", text: "oi" }) });
    expect(useAgentLogStore.getState().byAgent.ana!.map((item) => item.id)).toEqual(["e9"]);
    useOfficeStore.getState().applyEvent({ type: "office:snapshot", office: { rooms: [], teams: [], agents: [], tasks: [] } });
    expect(useAgentLogStore.getState().agentLoad).toEqual({});
    expect(useAgentLogStore.getState().generation).toBe(generation + 1);
  });
});
