import type { BudgetLimits, ServerEvent, UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { priceRecord } from "../../engines/usage/usage-aggregate";
import { BudgetWatcher, budgetPeriodBounds, type BudgetSource } from "./budget-watcher";

let seq = 0;
const record = (at: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  v: 1,
  id: `r${(seq += 1)}`,
  at,
  agentId: "eco",
  provider: "claude",
  model: "claude-sonnet-5-5",
  source: "live",
  measured: true,
  tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
  costUsd: 0,
  priceVersion: "x",
  ...extra,
});

/** Quanto custa uma linha-padrão (1 milhão de entrada): a unidade das contas dos testes. */
const UNIT = priceRecord(record("2026-11-12T15:00:00.000Z")).cost.usd!;

type Raised = { ref: string; level: string; text: string; expiresAt?: number; replay?: boolean };

function setup(limits: BudgetLimits, records: UsageRecord[], nowIso = "2026-11-12T15:00:00.000Z") {
  const clock = { now: new Date(nowIso) };
  const state = { limits, records };
  const raised: Raised[] = [];
  const cleared: string[][] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const source: BudgetSource = {
    id: "ws",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: async (from, to) => state.records.filter((item) => Date.parse(item.at) >= from && Date.parse(item.at) < to),
  };
  const watcher = new BudgetWatcher({
    sources: () => [source],
    subscribeList: () => () => undefined,
    limits: () => state.limits,
    usdBrl: () => 5,
    updatedAt: () => undefined,
    attention: {
      raiseBudget: (input) => raised.push(input),
      clearBudget: (keep) => cleared.push(keep ? ["filtro"] : []),
    },
    now: () => clock.now,
    debounceMs: 1,
    log: { warn: () => undefined },
  });
  const spendEvent = () => {
    for (const listener of listeners) listener({ type: "usage:agents", turn: { agentId: "eco", provider: "claude", at: clock.now.toISOString() } } as ServerEvent);
  };
  return { watcher, clock, state, raised, cleared, spendEvent };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("BudgetWatcher: orçamento de consumo equivalente (só avisa)", () => {
  it("sem orçamento definido: nada aparece e nada avisa", async () => {
    const { watcher, raised } = setup({}, [record("2026-11-12T14:00:00.000Z")]);
    await watcher.start();
    expect((await watcher.status()).periods).toEqual([]);
    expect(raised).toEqual([]);
    await watcher.close();
  });

  it("abaixo de 80%: a barra mostra o consumo e não avisa", async () => {
    const { watcher, raised } = setup({ dayUsd: UNIT * 10 }, [record("2026-11-12T14:00:00.000Z")]);
    await watcher.start();
    const status = await watcher.status();
    expect(status.periods).toHaveLength(1);
    expect(status.periods[0]).toMatchObject({ period: "day", limitUsd: UNIT * 10, step: 0, tone: "ok" });
    expect(status.periods[0]!.percent).toBeCloseTo(10, 5);
    expect(status.periods[0]!.spentBrl).toBeCloseTo(UNIT * 5, 6);
    expect(raised).toEqual([]);
    await watcher.close();
  });

  it("os degraus: 80% avisa (warn) uma vez, 100% avisa (alert) uma vez, e repetir o gasto não avisa de novo", async () => {
    const { watcher, raised, state, spendEvent, clock } = setup({ dayUsd: UNIT * 10 }, [record("2026-11-12T14:00:00.000Z")]);
    await watcher.start();
    // 8 de 10 = 80%.
    for (let i = 0; i < 7; i += 1) state.records.push(record("2026-11-12T14:30:00.000Z"));
    clock.now = new Date("2026-11-12T15:30:00.000Z");
    spendEvent();
    await wait(30);
    await watcher.idle();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ level: "warn", ref: "dia-2026-11-12-80" });
    expect(raised[0]!.text).toContain("Orçamento hoje em 80%");
    expect(raised[0]!.text).toContain("equiv.");
    // Mais um turno sem chegar em 100%: nada novo.
    state.records.push(record("2026-11-12T15:31:00.000Z"));
    clock.now = new Date("2026-11-12T15:31:30.000Z");
    spendEvent();
    await wait(30);
    await watcher.idle();
    expect(raised).toHaveLength(1);
    // Chega em 100% (10 de 10) e passa (11 de 10).
    state.records.push(record("2026-11-12T15:32:00.000Z"));
    clock.now = new Date("2026-11-12T15:32:30.000Z");
    spendEvent();
    await wait(30);
    await watcher.idle();
    expect(raised).toHaveLength(2);
    expect(raised[1]).toMatchObject({ level: "alert", ref: "dia-2026-11-12-100", expiresAt: budgetPeriodBounds("day", clock.now.getTime()).endMs });
    expect(raised[1]!.text).toContain("estourado");
    state.records.push(record("2026-11-12T15:33:00.000Z"));
    clock.now = new Date("2026-11-12T15:33:30.000Z");
    spendEvent();
    await wait(30);
    await watcher.idle();
    expect(raised).toHaveLength(2);
    await watcher.close();
  });

  it("no boot um período já estourado entra quieto (replay), uma vez só, pelo degrau mais alto", async () => {
    const records = Array.from({ length: 12 }, () => record("2026-11-12T14:00:00.000Z"));
    const { watcher, raised } = setup({ dayUsd: UNIT * 10 }, records);
    await watcher.start();
    expect(raised.map((item) => [item.ref, item.replay])).toEqual([["dia-2026-11-12-100", true]]);
    await watcher.close();
  });

  it("a virada de período avisa de novo: o dia seguinte começa do zero", async () => {
    const records = Array.from({ length: 9 }, () => record("2026-11-12T14:00:00.000Z"));
    const { watcher, raised, state, clock, spendEvent } = setup({ dayUsd: UNIT * 10 }, records);
    await watcher.start();
    expect(raised).toHaveLength(1);
    // 13/11 (São Paulo): zero gasto; depois 8 turnos.
    clock.now = new Date("2026-11-13T12:00:00.000Z");
    for (let i = 0; i < 8; i += 1) state.records.push(record("2026-11-13T11:00:00.000Z"));
    spendEvent();
    await wait(30);
    await watcher.idle();
    expect(raised.map((item) => item.ref)).toEqual(["dia-2026-11-12-80", "dia-2026-11-13-80"]);
    await watcher.close();
  });

  it("o dia vira à meia-noite de São Paulo (03:00 UTC), a semana na segunda e o mês no dia 1", () => {
    expect(new Date(budgetPeriodBounds("day", Date.parse("2026-11-13T02:59:00.000Z")).startMs).toISOString()).toBe("2026-11-12T03:00:00.000Z");
    expect(new Date(budgetPeriodBounds("day", Date.parse("2026-11-13T03:00:00.000Z")).startMs).toISOString()).toBe("2026-11-13T03:00:00.000Z");
    // 12/11/2026 é quinta: a semana começa na segunda, 09/11.
    expect(budgetPeriodBounds("week", Date.parse("2026-11-12T15:00:00.000Z")).key).toBe("semana-2026-11-09");
    expect(new Date(budgetPeriodBounds("week", Date.parse("2026-11-12T15:00:00.000Z")).endMs).toISOString()).toBe("2026-11-16T03:00:00.000Z");
    expect(budgetPeriodBounds("month", Date.parse("2026-11-12T15:00:00.000Z")).key).toBe("mes-2026-11");
    expect(new Date(budgetPeriodBounds("month", Date.parse("2026-12-31T20:00:00.000Z")).endMs).toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });

  it("a linha suspeita não entra na conta (ela fica fora do total, como em Gastos) e o parcial entra", async () => {
    const records = [
      record("2026-11-12T14:00:00.000Z"),
      record("2026-11-12T14:00:00.000Z", { suspect: "output" }),
      record("2026-11-12T14:00:00.000Z", { partial: true, turns: 0 }),
    ];
    const { watcher } = setup({ dayUsd: UNIT * 10 }, records);
    await watcher.start();
    expect((await watcher.status()).periods[0]!.spentUsd).toBeCloseTo(UNIT * 2, 6);
    await watcher.close();
  });

  it("um limite novo já ultrapassado avisa na hora; tirar o limite limpa os alertas", async () => {
    const records = Array.from({ length: 5 }, () => record("2026-11-12T14:00:00.000Z"));
    const { watcher, raised, state, cleared } = setup({}, records);
    await watcher.start();
    expect(raised).toEqual([]);
    state.limits = { dayUsd: UNIT * 4 };
    await watcher.limitsChanged();
    expect(raised.map((item) => [item.ref, item.replay])).toEqual([["dia-2026-11-12-100", undefined]]);
    state.limits = {};
    await watcher.limitsChanged();
    expect(cleared.at(-1)).toEqual(["filtro"]);
    await watcher.close();
  });

  it("semana e mês somam os dias anteriores do período", async () => {
    // Segunda 09/11 e domingo 01/11: a semana pega só a segunda; o mês pega as duas.
    const records = [record("2026-11-09T15:00:00.000Z"), record("2026-11-01T15:00:00.000Z"), record("2026-10-31T15:00:00.000Z")];
    const { watcher } = setup({ weekUsd: UNIT * 4, monthUsd: UNIT * 8 }, records);
    await watcher.start();
    const periods = new Map((await watcher.status()).periods.map((item) => [item.period, item]));
    expect(periods.get("week")!.spentUsd).toBeCloseTo(UNIT, 6);
    expect(periods.get("month")!.spentUsd).toBeCloseTo(UNIT * 2, 6);
    await watcher.close();
  });
});
