import { beforeEach, describe, expect, it } from "vitest";
import { useGoalHitsStore } from "./goalHitsStore";

const evento = (periodKey: string) => ({ type: "routine:goal-hit" as const, routineId: "R-0001", periodKey, title: "Convites", delivered: 2, target: 2, agentId: "ana" });

describe("goalHitsStore", () => {
  beforeEach(() => useGoalHitsStore.getState().reset());

  it("começa vazia (a carga inicial não traz festa) e guarda uma meta por período", () => {
    expect(useGoalHitsStore.getState().hits).toEqual([]);
    useGoalHitsStore.getState().apply(evento("2026-W46"), 1000);
    useGoalHitsStore.getState().apply(evento("2026-W46"), 2000);
    useGoalHitsStore.getState().apply(evento("2026-W47"), 3000);
    expect(useGoalHitsStore.getState().hits.map((hit) => [hit.key, hit.at])).toEqual([["R-0001:2026-W46", 1000], ["R-0001:2026-W47", 3000]]);
  });

  it("ignora os outros eventos", () => {
    useGoalHitsStore.getState().apply({ type: "routine:closed", periodKey: "x", routineIds: [] });
    expect(useGoalHitsStore.getState().hits).toEqual([]);
  });
});
