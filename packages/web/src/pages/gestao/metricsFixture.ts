import type { MetricGroup, MetricValue, MetricsReport } from "@cyno/shared";

/** Só para os testes das telas da Gestão: um `MetricsReport` (as 8 semanas até 9/11) vazio, sobre o qual cada teste põe o que quer. */

export const metric = (over: Partial<MetricValue> = {}): MetricValue => ({ value: null, n: 0, prev: null, prevN: 0, fewData: true, ...over });

export const group = (key: string, label: string, over: Partial<MetricValue> & { intensity?: number | null } = {}): MetricGroup => ({ key, label, ...metric(over) });

/** Uma taxa de `hits` em `n` (e `prevHits` em `prevN`), com a seta que o servidor poria. */
export function rate(hits: number, n: number, prevHits = 0, prevN = 0, trend?: MetricValue["trend"]): MetricValue {
  return metric({ value: n > 0 ? hits / n : null, n, hits, prev: prevN > 0 ? prevHits / prevN : null, prevN, fewData: n < 5, ...(trend ? { trend } : {}) });
}

const WEEK_STARTS = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"];

export function makeReport(over: Partial<MetricsReport> = {}): MetricsReport {
  const weeks = WEEK_STARTS.map((start, index) => ({ key: `2026-W${39 + index}`, start, count: 0, avg4: 0, current: index === WEEK_STARTS.length - 1 }));
  const window = { from: "2026-11-06T15:00:00.000Z", to: "2026-11-13T15:00:00.000Z" };
  return {
    v: 1,
    now: "2026-11-13T15:00:00.000Z",
    timeZone: "America/Sao_Paulo",
    windows: { rates: window, medians: { from: "2026-10-16T15:00:00.000Z", to: window.to } },
    prevWindows: { rates: { from: "2026-10-30T15:00:00.000Z", to: window.from }, medians: { from: "2026-09-18T15:00:00.000Z", to: "2026-10-16T15:00:00.000Z" } },
    throughput: { ...metric({ value: 0, prev: 0 }), weeks, agentWeeks: [], byAgent: [], byType: [], byProject: [] },
    cycleTime: { ...metric(), p90: null, workingMs: null, stoppedMs: null, waitingYouMs: null, queuedMs: null, stoppedBy: { agente: null, cota: null, acesso: null }, stoppedExact: false, weeks: weeks.map((week) => ({ key: week.key, n: 0, median: null, p90: null })), byAgent: [] },
    approvalWait: { ...metric(), p90: null, weightInCycle: null, pending: { count: 0, over24h: 0, oldestMs: null, items: [] }, byAgent: [], byType: [] },
    blockedNow: { count: 0, byType: {}, items: [] },
    failureRate: { ...metric(), byAgent: [], byModel: [], agentOnly: metric(), byKind: {}, approx: false },
    rejectionRate: { ...metric(), byAgent: [], byType: [] },
    rework: { ...metric(), avgCount: null, byAgent: [] },
    editRate: { ...metric(), intensity: metric(), byAgent: [], byType: [] },
    costPerDelivery: { ...metric(), totalUsd: 0, deliveries: 0, byAgent: [], byProject: [] },
    queueWait: { ...metric(), p90: null, approx: false, byAgent: [] },
    load: { running: 0, maxRunning: 3, perAgentLimit: 1, queued: 0, agents: [] },
    spend: { usd: 0, prevUsd: 0 },
    quota: { windows: [], blocked: [] },
    forecast: { projects: [], text: "nenhum projeto aberto com tarefas a fazer" },
    goals: { items: [], text: "nenhuma meta ativa" },
    ...over,
  };
}
