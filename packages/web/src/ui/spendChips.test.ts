import { describe, expect, it } from "vitest";
import { agentUsageChips, taskCostText } from "./spendChips";

describe("agentUsageChips", () => {
  it("sem gasto nenhum, nenhum chip (agente que ainda não trabalhou hoje não mostra zero)", () => {
    expect(agentUsageChips({})).toEqual([]);
    expect(agentUsageChips({ today: { tokens: 0, costUsd: 0, turns: 0 }, task: { tokens: 0, costUsd: 0 } })).toEqual([]);
  });

  it("\"Esta tarefa\" primeiro e \"Hoje\" depois, sempre com \"equiv.\"", () => {
    const chips = agentUsageChips({ task: { tokens: 82_000, costUsd: 0.31 }, today: { tokens: 1_250_000, costUsd: 4.1, turns: 12 } });
    expect(chips.map((chip) => [chip.key, chip.label, chip.tokens, chip.cost])).toEqual([
      ["task", "Esta tarefa", "82 mil tokens", "US$ 0,31 equiv."],
      ["today", "Hoje", "1,3 mi tokens", "US$ 4,10 equiv."],
    ]);
    expect(chips[1]!.title).toContain("12 turnos");
  });

  it("valores pequenos: tokens inteiros, centavos e o \"menos de um centavo\"", () => {
    const [chip] = agentUsageChips({ today: { tokens: 950, costUsd: 0.0004, turns: 1 } });
    expect(chip).toMatchObject({ tokens: "950 tokens", cost: "< US$ 0,01 equiv." });
    expect(chip!.title).toContain("1 turno)");
    expect(agentUsageChips({ today: { tokens: 2500, costUsd: 0.02, turns: 2 } })[0]!.tokens).toBe("2,5 mil tokens");
  });
});

describe("taskCostText", () => {
  it("o que a tarefa custou; sem gasto, nada", () => {
    expect(taskCostText(undefined)).toBeUndefined();
    expect(taskCostText({ tokens: 0, costUsd: 0 })).toBeUndefined();
    expect(taskCostText({ tokens: 82_000, costUsd: 0.31 })).toBe("US$ 0,31 equiv. · 82 mil tokens");
  });
});
