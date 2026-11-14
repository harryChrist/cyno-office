import { describe, expect, it } from "vitest";
import type { UsageRecord } from "@cyno/shared";
import { AGENT_USAGE_MAX_TURNS, AgentUsageLedger } from "./agent-usage";

const turn = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation });

describe("AgentUsageLedger: recarga do histórico em disco", () => {
  const row = (agentId: string, at: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
    v: 1, id: `${agentId}-${at}`, at, agentId, provider: "claude", source: "live", measured: true, costUsd: null, priceVersion: "t",
    tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 1 }, ...extra,
  });

  it("depois de um restart o resumo bate com o arquivo de uso (só linhas ao vivo; nota parcial não conta turno)", () => {
    const ledger = new AgentUsageLedger(() => new Date("2026-11-10T12:00:00Z"));
    ledger.seed([
      row("a1", "2026-11-10T10:00:00Z"),
      row("a1", "2026-11-10T10:05:00Z", { turns: 0 }),
      row("a2", "2026-11-10T11:00:00Z", { measured: false, tokens: undefined }),
      row("a1", "2026-11-10T11:30:00Z", { source: "backfill" }),
      row("a1", "2026-11-01T11:30:00Z"),
    ]);
    const { agents } = ledger.summary("2026-11-10T09:00:00Z");
    expect(agents.map((tally) => [tally.agentId, tally.turns, tally.measuredTurns, tally.inputTokens])).toEqual([
      ["a1", 1, 1, 20],
      ["a2", 1, 0, 0],
    ]);
  });

  it("não duplica o que já foi gravado neste processo", () => {
    let now = Date.parse("2026-11-10T12:00:00Z");
    const ledger = new AgentUsageLedger(() => new Date(now));
    ledger.record("a1", "claude", turn(1, 1));
    now += 1000;
    ledger.seed([row("a1", "2026-11-10T12:00:00Z"), row("a1", "2026-11-10T11:00:00Z")]);
    expect(ledger.summary("2026-11-10T00:00:00Z").agents[0]?.turns).toBe(2);
  });
});

describe("AgentUsageLedger (uso estimado por agente)", () => {
  it("soma turnos e tokens por agente desde `since`, maior uso primeiro", () => {
    let now = Date.parse("2026-11-08T10:00:00Z");
    const ledger = new AgentUsageLedger(() => new Date(now));
    ledger.record("a1", "claude", turn(10, 100, 5000, 50));
    now += 60_000;
    ledger.record("a2", "claude", turn(20, 900));
    ledger.record("a1", "claude", turn(5, 50));
    ledger.record("a3", "gemini");
    now += 60_000;
    const { since, agents } = ledger.summary("2026-11-08T09:00:00Z");
    expect(since).toBe("2026-11-08T09:00:00.000Z");
    expect(agents.map((tally) => [tally.agentId, tally.turns, tally.measuredTurns])).toEqual([
      ["a2", 1, 1],
      ["a1", 2, 2],
      ["a3", 1, 0],
    ]);
    expect(agents[1]).toMatchObject({ provider: "claude", inputTokens: 15, outputTokens: 150, cacheReadTokens: 5000, cacheCreationTokens: 50, lastAt: "2026-11-08T10:01:00.000Z" });
    // Só o que veio depois de `since`.
    expect(ledger.summary("2026-11-08T10:00:30Z").agents.map((tally) => [tally.agentId, tally.turns])).toEqual([
      ["a2", 1],
      ["a1", 1],
      ["a3", 1],
    ]);
  });

  it("sem `since` soma as últimas 5 h; nunca passa de 24 h; descarta o que é mais velho que isso", () => {
    let now = Date.parse("2026-11-08T00:00:00Z");
    const ledger = new AgentUsageLedger(() => new Date(now));
    ledger.record("velho", "claude", turn(1, 1));
    now += 6 * 60 * 60 * 1000;
    ledger.record("novo", "claude", turn(1, 1));
    expect(ledger.summary().agents.map((tally) => tally.agentId)).toEqual(["novo"]);
    expect(ledger.summary("2000-01-01T00:00:00Z").agents.map((tally) => tally.agentId).sort()).toEqual(["novo", "velho"]);
    now += 20 * 60 * 60 * 1000;
    const all = ledger.summary("2000-01-01T00:00:00Z");
    expect(all.since).toBe("2026-11-08T02:00:00.000Z");
    expect(all.agents.map((tally) => tally.agentId)).toEqual(["novo"]);
  });

  it("guarda no máximo AGENT_USAGE_MAX_TURNS turnos", () => {
    const ledger = new AgentUsageLedger(() => new Date("2026-11-08T10:00:00Z"));
    for (let i = 0; i < AGENT_USAGE_MAX_TURNS + 10; i++) ledger.record("a1", "claude");
    expect(ledger.summary().agents[0]!.turns).toBe(AGENT_USAGE_MAX_TURNS);
  });
});
