import { describe, expect, it } from "vitest";
import { projectGoal, weightedDays, type GoalProjectionInput } from "./goal-projection";

// "Agora": quinta, 12/11/2026 12:00 em São Paulo (15:00Z). Nada aqui lê o relógio nem o fuso da máquina.
const NOW = new Date("2026-11-12T15:00:00.000Z");
const DAY = 86_400_000;
const sp = (local: string): number => Date.parse(`${local}-03:00`);

/** `n` entregas espalhadas pelos últimos 7 dias. */
const spread = (n: number): number[] => Array.from({ length: n }, (_, i) => NOW.getTime() - (i + 1) * 0.9 * DAY);

function input(over: Partial<GoalProjectionInput> = {}): GoalProjectionInput {
  return { routineId: "R-1", title: "Posts", goal: { target: 10, period: "week" }, now: NOW, delivered: 2, expected: 6, pace: "atrasada", deliveredAt: spread(5), ...over };
}

describe("dias úteis ponderados", () => {
  it("só dia útil conta (a fração do dia que cai no intervalo); fim de semana vale zero", () => {
    // Quinta 12:00 até domingo 24:00: meia quinta + sexta = 1,5 dia.
    expect(weightedDays(NOW.getTime(), sp("2026-11-16T00:00:00"), undefined)).toBeCloseTo(1.5, 10);
    // Os 7 dias para trás: meia quinta + sex + seg + ter + qua + meia quinta = 5.
    expect(weightedDays(NOW.getTime() - 7 * DAY, NOW.getTime(), undefined)).toBeCloseTo(5, 10);
  });
  it("dia preferido pesa o dobro, mesmo no fim de semana", () => {
    expect(weightedDays(NOW.getTime() - 7 * DAY, NOW.getTime(), [2, 4])).toBeCloseTo(7, 10);
    expect(weightedDays(sp("2026-11-14T00:00:00"), sp("2026-11-16T00:00:00"), [6])).toBeCloseTo(2, 10);
  });
  it("intervalo vazio ou invertido = 0", () => {
    expect(weightedDays(10, 10, undefined)).toBe(0);
    expect(weightedDays(20, 10, undefined)).toBe(0);
  });
});

describe("projeção da meta: entregues + ritmo dos 7 dias x dias úteis restantes", () => {
  it("5 entregas em 5 dias úteis = 1 por dia; faltam 1,5 dia: 2 + 1,5 = 3 (para baixo) de 10, não fecha", () => {
    const projection = projectGoal(input());
    expect(projection).toMatchObject({ n: 5, ratePerDay: 1, daysLeft: 1.5, projected: 3, closes: false, confidence: "media", periodKey: "2026-W46" });
    expect(projection.text).toBe("no ritmo atual fecha em 3 de 10");
  });

  it("fecha quando o projetado alcança o alvo", () => {
    const projection = projectGoal(input({ goal: { target: 4, period: "week" }, delivered: 3 }));
    expect(projection).toMatchObject({ projected: 4, closes: true });
    expect(projection.text).toBe("no ritmo atual bate a meta");
  });

  it("dias preferidos entram dobrados nos dois lados da conta", () => {
    // 7 entregas em 7 dias ponderados = 1 por dia ponderado; restam 2 (meia quinta preferida + sexta): 1 + 2 = 3.
    const projection = projectGoal(input({ goal: { target: 10, period: "week", preferredDays: [2, 4] }, delivered: 1, deliveredAt: spread(7) }));
    expect(projection).toMatchObject({ n: 7, ratePerDay: 1, daysLeft: 2, projected: 3 });
  });

  it("poucos dados (n < 5) dizem isso e a confiança é baixa; sem entregas o projetado é o que já foi entregue", () => {
    const few = projectGoal(input({ deliveredAt: spread(2) }));
    expect(few.confidence).toBe("baixa");
    expect(few.text).toBe("no ritmo atual fecha em 2 de 10 (poucos dados)");
    expect(few.text).not.toMatch(/n=/);
    const none = projectGoal(input({ deliveredAt: [] }));
    expect(none).toMatchObject({ n: 0, ratePerDay: 0, projected: 2, closes: false });
  });

  it("só olha os últimos 7 dias e só entregas até agora; confiança sobe com n (15 ou mais = alta)", () => {
    const old = [NOW.getTime() - 8 * DAY, NOW.getTime() - 20 * DAY, NOW.getTime() + DAY];
    expect(projectGoal(input({ deliveredAt: old })).n).toBe(0);
    expect(projectGoal(input({ deliveredAt: Array.from({ length: 15 }, (_, i) => NOW.getTime() - (i + 1) * 0.4 * DAY) })).confidence).toBe("alta");
  });

  it("meta batida, pausada e a do mês (dias úteis até o fim do mês)", () => {
    expect(projectGoal(input({ delivered: 10, pace: "concluida" }))).toMatchObject({ closes: true, text: "meta batida" });
    expect(projectGoal(input({ paused: true, pace: "pausada" })).text).toBe("pausada: sem projeção");
    const month = projectGoal(input({ goal: { target: 40, period: "month" }, delivered: 10 }));
    expect(month.periodKey).toBe("2026-M11");
    // Meia quinta + sexta 13 + 3 semanas cheias (16 a 20, 23 a 27) + segunda 30 = 12,5 dias úteis.
    expect(month.daysLeft).toBe(12.5);
    expect(month.projected).toBe(Math.floor(10 + 12.5));
  });
});
