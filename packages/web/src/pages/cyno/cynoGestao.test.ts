import type { Card, CardMetrics } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { gestaoRow, gestaoRows, shortAge, throughputTrend, usdLabel } from "./cynoGestao";

const NOW = new Date("2026-11-12T15:00:00.000Z");
const metrics = (over: Partial<CardMetrics> = {}): CardMetrics => ({ throughput7d: 12, throughputPrev7d: 8, medianCycleMs: 5_000_000, oldestWaitMs: 9 * 3_600_000, waiting: 5, blocked: 2, atRisk: 1, weekCostUsd: 6.4, ...over });
const card = (workspace: string, name: string, over: Partial<Card> = {}): Card => ({ workspace, name, summary: { summary: "", by: "dono" }, team: { rooms: [], agents: [], maestro: { engine: "claude", status: "parado" } }, engines: [], sites: [], connectors: [], routines: [], projects: { active: [], counts: {} }, deliveries: [], waitingForYou: 0, waitingIds: [], usage: { turns5h: 0 }, updatedAt: NOW.toISOString(), ...over });

describe("bloco Gestão da página do Cyno", () => {
  it("seta só com 5 ou mais entregas nas duas semanas, e só quando muda 10% ou mais", () => {
    expect(throughputTrend({ throughput7d: 12, throughputPrev7d: 8 })).toBe("up");
    expect(throughputTrend({ throughput7d: 5, throughputPrev7d: 9 })).toBe("down");
    expect(throughputTrend({ throughput7d: 10, throughputPrev7d: 10 })).toBe("flat");
    expect(throughputTrend({ throughput7d: 4, throughputPrev7d: 20 })).toBeUndefined();
    expect(throughputTrend({ throughput7d: 20, throughputPrev7d: 4 })).toBeUndefined();
  });

  it("a linha de um workspace: entregas, esperando você (com o mais antigo), travados, prazos, gasto e cota", () => {
    const row = gestaoRow(card("a", "Alfa", { metrics: metrics(), usage: { turns5h: 3, windowPercent: 86, windowEngine: "claude" } }), NOW);
    expect(row).toMatchObject({ name: "Alfa", pending: false, deliveries: "entregas 7 d: 12", trend: "up", waiting: "5 esperando você (mais antigo há 9 h)", blocked: "2 travados", atRisk: "1 prazo em risco", cost: "US$ 6,40 na semana (equiv.)", quota: "cota 86%" });
    expect(row.waitingLate).toBe(false);
  });

  it("a idade do item mais antigo soma o tempo desde que a ficha foi calculada, e mais de 24 h avisa", () => {
    const row = gestaoRow(card("a", "Alfa", { metrics: metrics({ oldestWaitMs: 20 * 3_600_000 }), updatedAt: new Date(NOW.getTime() - 5 * 3_600_000).toISOString() }), NOW);
    expect(row.waiting).toContain("há 25 h");
    expect(row.waitingLate).toBe(true);
  });

  it("nada a dizer: 'nada esperando você', 'nada travado' e 'prazos ok'; sem a conta ainda: 'calculando…'", () => {
    const calm = gestaoRow(card("a", "Alfa", { metrics: metrics({ waiting: 0, oldestWaitMs: null, blocked: 0, atRisk: 0, throughput7d: 2, throughputPrev7d: 1 }) }), NOW);
    expect(calm).toMatchObject({ waiting: "nada esperando você", blocked: "nada travado", atRisk: "prazos ok" });
    expect(calm.trend).toBeUndefined();
    expect(calm.quota).toBeUndefined();
    expect(gestaoRow(card("b", "Beta"), NOW)).toMatchObject({ pending: true, deliveries: "calculando…" });
  });

  it("quem mais espera você (e mais está travado) vem primeiro; empate pelo nome", () => {
    const rows = gestaoRows([card("c", "Calma", { metrics: metrics({ waiting: 0, blocked: 0, atRisk: 0 }) }), card("a", "Alfa", { metrics: metrics({ waiting: 1 }) }), card("b", "Beta", { metrics: metrics({ waiting: 4 }) }), card("d", "Atrás")], NOW);
    expect(rows.map((row) => row.name)).toEqual(["Beta", "Alfa", "Atrás", "Calma"]);
  });

  it("formatadores: idade curta e dólar", () => {
    expect(shortAge(30_000)).toBe("1 min");
    expect(shortAge(35 * 60_000)).toBe("35 min");
    expect(shortAge(9 * 3_600_000)).toBe("9 h");
    expect(shortAge(50 * 3_600_000)).toBe("2 d");
    expect(usdLabel(6.4)).toBe("US$ 6,40");
  });
});
