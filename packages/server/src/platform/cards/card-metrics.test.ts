import { cardSummarySchema, type Card, type ForYouItem, type ServerEvent, type UsageRecord } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeMetrics, type MetricsSnapshot } from "../../workspace/metrics/compute";
import { makeHistory } from "../../workspace/metrics/fixtures/make-history";
import { buildCard, cardMetrics, type CardInput } from "./card";
import { CardIndex, type CardSource } from "./card-index";

// "Agora": quinta, 12/11/2026 12:00 em São Paulo (15:00 UTC). Sem relógio nem fuso da máquina.
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const AGENTS = ["rapido", "editado", "recusado", "lento", "cota"].map((id) => ({ id, name: id }));

function snapshotOf(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  const history = makeHistory({ now: NOW, days: 21, seed: 7, agents: AGENTS, retro: true });
  return { agents: AGENTS, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 }, ...over };
}

describe("CardMetrics: os mesmos números da aba Gestão", () => {
  it("bate com o computeMetrics completo (o da rota /metrics) na mesma janela: entregas, mediana, espera, travados e gasto", () => {
    const snapshot = snapshotOf();
    const full = computeMetrics(snapshot, { now: NOW, workspace: "lab" });
    const card = cardMetrics(snapshot, NOW);
    expect(card.throughput7d).toBe(full.throughput.n);
    expect(card.throughputPrev7d).toBe(full.throughput.prevN);
    expect(card.medianCycleMs).toBe(full.cycleTime.value);
    expect(card.oldestWaitMs).toBe(full.approvalWait.pending.oldestMs);
    expect(card.waiting).toBe(full.approvalWait.pending.count);
    expect(card.blocked).toBe(full.blockedNow.count);
    expect(card.weekCostUsd).toBe(full.spend.usd);
    // O fixture dá movimento de verdade: o teste não passa só com zeros.
    expect(card.throughput7d).toBeGreaterThan(0);
    expect(card.weekCostUsd).toBeGreaterThan(0);
    expect(card.oldestWaitMs).toBeGreaterThan(0);
  });

  it("o modo leve não calcula a previsão (o resto é igual)", () => {
    const snapshot = snapshotOf();
    const light = computeMetrics(snapshot, { now: NOW, light: true });
    const full = computeMetrics(snapshot, { now: NOW });
    expect(light.forecast.projects).toEqual([]);
    expect(full.forecast.projects.length).toBeGreaterThan(0);
    expect({ ...light, forecast: undefined }).toEqual({ ...full, forecast: undefined });
  });

  it("as regras da retrospectiva esperando o dono não entram na espera, nem nas recusas, nem nos itens do time", () => {
    const base = snapshotOf();
    const rule: ForYouItem = { id: "A-9999", agentId: "rapido", roomId: "seed-quarto", type: "outro", status: "pendente", meta: {}, text: "Regra", originalText: "Regra", editedByUser: false, kind: "regra", createdAt: new Date(NOW - 5 * 24 * 3_600_000).toISOString() };
    const withRule = snapshotOf({ forYou: [...base.forYou, rule] });
    expect(cardMetrics(withRule, NOW)).toEqual(cardMetrics(base, NOW));
    expect(computeMetrics(withRule, { now: NOW }).approvalWait.pending.items.some((entry) => entry.id === "A-9999")).toBe(false);
  });

  it("a ficha leva o bloco `metrics` quando recebe o retrato, e não leva quando não recebe", () => {
    const input = (metrics?: MetricsSnapshot): CardInput => ({
      workspace: "lab",
      name: "Lab",
      summary: cardSummarySchema.parse({ summary: "" }),
      office: { rooms: [], teams: [], agents: [] },
      terminals: {},
      access: { allowedDomains: [] },
      connectors: [],
      routines: [],
      projects: [],
      forYou: [],
      engineBlocked: () => false,
      usage: [],
      turns5h: 0,
      now: new Date(NOW),
      ...(metrics ? { metrics } : {}),
    });
    expect(buildCard(input()).metrics).toBeUndefined();
    expect(buildCard(input(snapshotOf())).metrics).toMatchObject({ throughput7d: expect.any(Number), weekCostUsd: expect.any(Number) });
  });
});

describe("CardIndex: o gasto da semana vem do disco e refaz a ficha quando muda", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lê o gasto de forma assíncrona e recalcula (com o debounce de sempre) só quando a leitura mudou", async () => {
    const office = { rooms: [], teams: [], agents: [] } as never;
    let records: UsageRecord[] = [];
    const reads = { usage: 0 };
    const listeners = new Set<(event: ServerEvent) => void>();
    const source: CardSource = {
      id: "lab",
      name: "Lab",
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onSummaryChange: () => () => undefined,
      read: () => ({ summary: cardSummarySchema.parse({ summary: "" }), office, terminals: {}, access: { allowedDomains: [] }, connectors: [], routines: [], projects: [], forYou: [], engineBlocked: () => false, usage: [], turns5h: 0, metrics: { ...snapshotOf(), usage: [] } }),
      usage: async () => {
        reads.usage += 1;
        return records;
      },
    };
    const index = new CardIndex({ sources: () => [source], subscribeList: () => () => undefined, now: () => new Date(NOW), debounceMs: 2000 });
    const changes: string[][] = [];
    index.subscribe((workspaces) => changes.push(workspaces));
    const cost = (): number | undefined => (index.cards()[0] as Card).metrics?.weekCostUsd;
    expect(cost()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.usage).toBe(1);

    // O gasto da semana chega: depois do debounce a ficha sai com o valor novo.
    const record: UsageRecord = { id: "u1", at: new Date(NOW - 3_600_000).toISOString(), agentId: "rapido", provider: "claude", model: "claude-sonnet-5-5", measured: true, tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0 }, turns: 1, source: "live" } as unknown as UsageRecord;
    records = [record];
    listeners.forEach((listener) => listener({ type: "task:upserted" } as ServerEvent));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(cost()).toBeGreaterThan(0);
    expect(changes.length).toBeGreaterThan(0);
    // Uma leitura igual não marca de novo (não vira laço).
    const reads2 = reads.usage;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads.usage).toBe(reads2);
  });
});
