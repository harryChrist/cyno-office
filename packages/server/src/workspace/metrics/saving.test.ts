import type { UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { priceRecord } from "../../engines/usage/usage-aggregate";
import { modelSaving, savingUsd } from "./saving";

/** Estimativa de economia ao trocar o modelo de um agente (relógio fixo; nada de IA). */

const NOW = Date.parse("2026-11-13T15:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

let n = 0;
function record(extra: Partial<UsageRecord> = {}): UsageRecord {
  n += 1;
  return {
    v: 1,
    id: `u${n}`,
    at: at(2),
    agentId: "clara",
    provider: "claude",
    model: "claude-sonnet-5-5",
    source: "live",
    measured: true,
    tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0 },
    costUsd: null,
    priceVersion: "teste",
    ...extra,
  };
}

const clara = { id: "clara", name: "Clara", model: "claude-sonnet-5-5" };
const base = { agent: clara, now: NOW, rejection: { rate: 0.12, n: 25 } };

describe("modelSaving", () => {
  it("reprecifica os turnos dos últimos 14 dias com o modelo novo e divide por 2 para a semana", () => {
    const records = [record(), record({ at: at(9) })];
    const before = priceRecord(records[0]!).cost.usd!;
    const after = priceRecord({ ...records[0]!, model: "claude-haiku-5-5" }).cost.usd!;
    expect(before).toBeGreaterThan(after);
    const result = modelSaving({ ...base, records, model: "claude-haiku-5-5" });
    expect(result.state).toBe("estimado");
    expect(result.records).toBe(2);
    // dois turnos iguais em 14 dias = 1 por semana.
    expect(result.weeklyNowUsd).toBeCloseTo(before, 6);
    expect(result.weeklyNewUsd).toBeCloseTo(after, 6);
    expect(result.savingPerWeekUsd).toBeCloseTo(before - after, 6);
    expect(result.text).toBe(`cerca de ${savingUsd(before - after)} a menos por semana (equivalente)`);
    expect(result.currentModel).toBe("claude-sonnet-5-5");
  });

  it("ignora turno fora da janela, de outro agente, de teste e sem tokens medidos (e conta o que ficou de fora por falta de preço)", () => {
    const records = [
      record({ at: at(15) }),
      record({ agentId: "eco" }),
      record({ test: true }),
      record({ measured: false }),
      record({ tokens: undefined }),
      record(),
      record({ model: "modelo-que-ninguem-conhece" }),
    ];
    const result = modelSaving({ ...base, records, model: "claude-haiku-5-5" });
    expect(result.records).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.note).toMatch(/1 turno ficou de fora/);
  });

  it("sem tokens para reprecificar diz \"sem dados para estimar\", sem inventar número", () => {
    const none = modelSaving({ ...base, records: [record({ tokens: undefined, measured: false }), record({ agentId: "eco" })], model: "claude-haiku-5-5" });
    expect(none).toMatchObject({ state: "sem_dados", text: "sem dados para estimar", savingPerWeekUsd: null, weeklyNowUsd: null, weeklyNewUsd: null, quotaShare: null, quotaText: null, records: 0 });
    expect(none.note).toMatch(/não tem turnos medidos/);
    // Modelo novo sem preço conhecido: nenhum turno entra.
    const unpriced = modelSaving({ ...base, records: [record()], model: "modelo-sem-preco" });
    expect(unpriced).toMatchObject({ state: "sem_dados", text: "sem dados para estimar", savingPerWeekUsd: null });
    expect(unpriced.note).toMatch(/preço conhecido/);
    // Sem nenhum registro.
    expect(modelSaving({ ...base, records: [], model: "claude-haiku-5-5" }).state).toBe("sem_dados");
  });

  it("modelo mais caro vira \"a mais\"; mesmo custo vira \"o mesmo custo\"", () => {
    const dearer = modelSaving({ ...base, agent: { ...clara, model: "claude-haiku-5-5" }, records: [record({ model: "claude-haiku-5-5" })], model: "claude-sonnet-5-5" });
    expect(dearer.savingPerWeekUsd!).toBeLessThan(0);
    expect(dearer.text).toMatch(/^cerca de US\$ [\d,]+ a mais por semana \(equivalente\)$/);
    const same = modelSaving({ ...base, records: [record()], model: "claude-sonnet-5-5" });
    expect(same.text).toBe("cerca do mesmo custo por semana (equivalente)");
  });

  it("a fatia da assinatura só aparece com a cota do motor conhecida e sai do consumo de todos os agentes do motor", () => {
    const records = [record(), record({ agentId: "eco" }), record({ agentId: "eco" })];
    const without = modelSaving({ ...base, records, model: "claude-haiku-5-5" });
    expect(without.quotaShare).toBeNull();
    expect(without.quotaText).toBeNull();
    const withQuota = modelSaving({ ...base, records, model: "claude-haiku-5-5", quotaProviders: new Set(["claude"]) });
    const each = priceRecord(records[0]!).cost.usd!;
    const saved = each - priceRecord({ ...records[0]!, model: "claude-haiku-5-5" }).cost.usd!;
    expect(withQuota.quotaShare).toBeCloseTo(saved / (3 * each), 6);
    expect(withQuota.quotaText).toMatch(/^cerca de \d+% menos do consumo da assinatura do Claude/);
    // Cota de outro motor: não cita.
    expect(modelSaving({ ...base, records, model: "claude-haiku-5-5", quotaProviders: new Set(["gemini"]) }).quotaText).toBeNull();
  });

  it("o aviso traz a taxa de recusa de hoje do agente, ou diz que não há decisões", () => {
    const records = [record()];
    expect(modelSaving({ ...base, records, model: "claude-haiku-5-5" }).warning).toBe("Taxa de recusa de Clara nas últimas semanas: 12% (25 decisões); trocar o modelo pode piorar.");
    expect(modelSaving({ ...base, rejection: { rate: 0, n: 3 }, records, model: "claude-haiku-5-5" }).warning).toBe("Taxa de recusa de Clara nas últimas semanas: 0% (3 decisões, poucos dados); trocar o modelo pode piorar.");
    expect(modelSaving({ ...base, rejection: { rate: null, n: 0 }, records, model: "claude-haiku-5-5" }).warning).toMatch(/Sem decisões suas/);
  });

  it("formata o dólar com vírgula e trata centavos", () => {
    expect(savingUsd(4.1)).toBe("US$ 4,10");
    expect(savingUsd(-0.5)).toBe("US$ 0,50");
    expect(savingUsd(0.004)).toBe("menos de US$ 0,01");
  });
});
