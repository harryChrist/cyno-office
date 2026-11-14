import type { AgentUsageResponse, AgentUsageTurn } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentUsage = vi.hoisted(() => vi.fn<(since?: string) => Promise<AgentUsageResponse>>());
vi.mock("../api/client", () => ({ api: { agentUsage }, describeError: (error: unknown) => String(error) }));

const { addAgentTurn, useAgentUsageStore } = await import("./agentUsageStore");
const { useNavStore } = await import("./navStore");

const SINCE = "2026-11-09T00:00:00.000Z";
const tokens = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 });
const turn = (agentId: string, at: string, usage = tokens(100, 100)): AgentUsageTurn => ({ agentId, provider: "claude", at, usage });

describe("addAgentTurn", () => {
  it("soma no agente, cria quem não tinha e reordena (maior uso primeiro)", () => {
    let summary: AgentUsageResponse = { since: SINCE, agents: [] };
    summary = addAgentTurn(summary, turn("ana", "2026-11-09T01:00:00.000Z", tokens(10, 10)));
    summary = addAgentTurn(summary, turn("bia", "2026-11-09T02:00:00.000Z", tokens(100, 100)));
    expect(summary.agents.map((tally) => tally.agentId)).toEqual(["bia", "ana"]);
    summary = addAgentTurn(summary, turn("ana", "2026-11-09T03:00:00.000Z", tokens(500, 0)));
    expect(summary.agents.map((tally) => [tally.agentId, tally.turns, tally.inputTokens])).toEqual([
      ["ana", 2, 510],
      ["bia", 1, 100],
    ]);
    expect(summary.agents[0]!.lastAt).toBe("2026-11-09T03:00:00.000Z");
  });

  it("turno sem tokens conta só o turno; turno de antes do começo da soma não entra", () => {
    const base: AgentUsageResponse = { since: SINCE, agents: [] };
    const unmeasured = addAgentTurn(base, { agentId: "gem", provider: "gemini", at: "2026-11-09T01:00:00.000Z" });
    expect(unmeasured.agents[0]).toMatchObject({ turns: 1, measuredTurns: 0, inputTokens: 0 });
    expect(addAgentTurn(base, turn("ana", "2026-11-08T23:00:00.000Z"))).toBe(base);
  });
});

describe("useAgentUsageStore", () => {
  beforeEach(() => {
    useAgentUsageStore.getState().reset();
    agentUsage.mockReset();
    useNavStore.setState({ workspaceId: "principal" });
  });

  it("um GET só; o turno que chega durante o GET entra por cima sem contar duas vezes", async () => {
    let resolve!: (response: AgentUsageResponse) => void;
    agentUsage.mockReturnValue(new Promise((done) => (resolve = done)));
    const loading = useAgentUsageStore.getState().load(SINCE);
    // Um já contado pelo server (mesmo lastAt) e um novo, depois da resposta.
    useAgentUsageStore.getState().apply(turn("ana", "2026-11-09T01:00:00.000Z"));
    useAgentUsageStore.getState().apply(turn("ana", "2026-11-09T02:00:00.000Z"));
    resolve({
      since: SINCE,
      agents: [{ agentId: "ana", provider: "claude", turns: 1, measuredTurns: 1, ...tokens(100, 100), lastAt: "2026-11-09T01:00:00.000Z" }],
    });
    await loading;
    expect(useAgentUsageStore.getState().data?.agents[0]).toMatchObject({ turns: 2, inputTokens: 200 });
    // Depois, só os eventos: nenhum GET novo.
    useAgentUsageStore.getState().apply(turn("ana", "2026-11-09T03:00:00.000Z"));
    expect(useAgentUsageStore.getState().data?.agents[0]).toMatchObject({ turns: 3 });
    expect(agentUsage).toHaveBeenCalledTimes(1);
  });

  it("sem dados carregados, o evento é ignorado (o próximo GET já traz o turno)", () => {
    useAgentUsageStore.getState().apply(turn("ana", "2026-11-09T01:00:00.000Z"));
    expect(useAgentUsageStore.getState().data).toBeUndefined();
  });
});
