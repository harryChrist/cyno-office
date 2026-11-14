import { projectDefaults, projectTaskDefaults, type ForYouItem, type MetricsReport, type Project, type ProjectTask, type RoutineEntry, type SubscriptionUsage, type Task, type UsageRecord } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { computeMetrics, deliveriesOf, pickGroups, type MetricsSnapshot } from "./compute";
import { makeHistory } from "./fixtures/make-history";
import { renderMetrics } from "./render";
import { diceSimilarity, editIntensity } from "./similarity";
import { median, nearestRank, p90 } from "./stats";

// "Agora": quinta, 12/11/2026 12:00 em São Paulo (15:00 UTC). Nada aqui lê o relógio nem o fuso da máquina.
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(ms).toISOString();
const sp = (local: string): number => Date.parse(`${local}-03:00`); // São Paulo é UTC-3 o ano todo (sem horário de verão desde 2019)

const AGENTS = [
  { id: "clara", name: "Clara" },
  { id: "eco", name: "Eco" },
];

function leaf(ref: string, over: Partial<ProjectTask> & { finishedAt?: string } = {}): ProjectTask {
  return { ...projectTaskDefaults(), ref, title: `Tarefa ${ref}`, briefing: "", ownerId: "clara", steps: [], current: 0, dependsOn: [], priority: "normal", status: "concluida", updatedAt: at(NOW), ...over };
}

function project(id: string, tasks: ProjectTask[], over: Partial<Project> = {}): Project {
  return { ...projectDefaults(), id, kind: "projeto", title: `Projeto ${id}`, origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, tasks, createdAt: at(NOW - 30 * DAY), updatedAt: at(NOW), ...over };
}

function item(id: string, over: Partial<ForYouItem> = {}): ForYouItem {
  return { id, agentId: "clara", roomId: "q", type: "comentario", status: "aprovado", meta: {}, text: "x", originalText: "x", editedByUser: false, createdAt: at(NOW - 3 * DAY), ...over };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, roomId: "q", teamId: "t", agentId: "clara", prompt: id, status: "done", createdAt: at(NOW - DAY), updatedAt: at(NOW - HOUR), ...over };
}

function snapshot(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return { agents: AGENTS, tasks: [], projects: [], forYou: [], usage: [], routines: [{ id: "R-0001", title: "Comentários" }], entries: [], quota: [], dispatch: { maxRunning: 3, perAgent: 1 }, ...over };
}

/** Janela de 7 dias terminando em NOW (e a anterior, de 7 a 14 dias atrás). */
const week = { from: NOW - 7 * DAY, to: NOW };

describe("estatísticas: posto mais próximo, sem interpolar", () => {
  it("n ímpar: a mediana é o do meio e o p90 é o 5º de 5", () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3);
    expect(p90([5, 1, 3, 2, 4])).toBe(5);
  });
  it("n par: a mediana é o menor dos dois do meio, e o p90 de 10 é o 9º", () => {
    expect(median([40, 10, 30, 20])).toBe(20);
    expect(p90([40, 10, 30, 20])).toBe(40);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toBe(9);
  });
  it("sem amostra: null; uma amostra: ela mesma", () => {
    expect(median([])).toBeNull();
    expect(nearestRank([7], 0.9)).toBe(7);
  });
});

describe("similaridade de edição (Dice sobre bigramas de palavras)", () => {
  it("textos iguais = 1; sem palavras em comum = 0", () => {
    expect(diceSimilarity("a b c d", "a b c d")).toBe(1);
    expect(diceSimilarity("um dois três", "quatro cinco seis")).toBe(0);
  });
  it("'a b c d' contra 'a b c e': 2 bigramas em comum de 3 e 3 => 2·2/6", () => {
    expect(diceSimilarity("a b c d", "a b c e")).toBeCloseTo(4 / 6, 10);
    expect(editIntensity("a b c d", "a b c e")).toBeCloseTo(1 / 3, 10);
  });
  it("cortar um emoji muda o texto (ele conta como palavra)", () => {
    expect(editIntensity("Boa leitura 🎉 vale a pena", "Boa leitura vale a pena")).toBeGreaterThan(0.2);
  });
  it("maiúsculas e pontuação não contam; dois textos vazios são iguais", () => {
    expect(diceSimilarity("Olá, Mundo bonito!", "olá mundo bonito")).toBe(1);
    expect(diceSimilarity("", "...")).toBe(1);
  });
});

describe("vazão e a definição de entrega", () => {
  it("conta tarefa de projeto concluída; pulada, em grupo e a que uma rotina abriu ficam de fora", () => {
    const projects = [
      project("p1", [leaf("T1", { finishedAt: at(NOW - 1 * DAY) }), leaf("T2", { skipped: true, finishedAt: at(NOW - 1 * DAY) }), leaf("T3", { status: "a_fazer" }), leaf("G1", { group: true, finishedAt: at(NOW - DAY) })]),
      project("p2", [leaf("T1", { finishedAt: at(NOW - 2 * DAY) })], { origin: "rotina" }),
    ];
    const deliveries = deliveriesOf({ projects, routines: [], entries: [] });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ groupKey: "p1", costRoot: "p1" });
  });

  it("uma entrega de rotina não conta duas vezes: a folha da rotina (origem rotina) sai, a entrada `entregue` fica", () => {
    const avulsas: Project = { ...project("avulsas", [leaf("S1", { finishedAt: at(NOW - DAY), meta: { requestId: "r1", origin: "rotina", createdAt: at(NOW - DAY - HOUR) } }), leaf("S2", { finishedAt: at(NOW - DAY), meta: { requestId: "r2", origin: "usuario", createdAt: at(NOW - DAY - HOUR) } })]), system: "avulsas" };
    const entries: RoutineEntry[] = [
      { id: "e1", routineId: "R-0001", periodKey: "2026-W46", url: "https://x/1", taskId: "r1", agentId: "clara", stage: "entregue", at: at(NOW - DAY), settledAt: at(NOW - DAY + MIN) },
      { id: "e2", routineId: "R-0001", periodKey: "2026-W46", url: "https://x/2", taskId: "r1", agentId: "clara", stage: "registrado", at: at(NOW - DAY) },
      { id: "e3", routineId: "R-0001", periodKey: "2026-W46", url: "https://x/3", taskId: "r1", agentId: "clara", stage: "descartado", at: at(NOW - DAY) },
    ];
    const report = computeMetrics(snapshot({ projects: [avulsas], entries }), { now: NOW, ...week });
    // S2 (do usuário) + a entrada entregue = 2; a S1 da rotina e as entradas registrada/descartada não contam.
    expect(report.throughput.value).toBe(2);
    expect(report.throughput.byType.map((group) => [group.key, group.value]).sort()).toEqual([["rotina", 1], ["sem tipo", 1]]);
  });

  it("a janela que cruza a virada da semana separa as entregas na segunda 00:00 de São Paulo (nada de UTC)", () => {
    // Domingo 8/11 23:30 SP (02:30Z de segunda no UTC!) é da semana 45; segunda 9/11 00:30 SP é da 46.
    const tasks = [leaf("T1", { finishedAt: at(sp("2026-11-08T23:30:00")) }), leaf("T2", { finishedAt: at(sp("2026-11-09T00:30:00")) }), leaf("T3", { finishedAt: at(sp("2026-11-10T10:00:00")) }), leaf("T4", { finishedAt: at(sp("2026-11-04T10:00:00")) })];
    const report = computeMetrics(snapshot({ projects: [project("p1", tasks)] }), { now: NOW, from: sp("2026-11-08T00:00:00"), to: NOW });
    const byKey = Object.fromEntries(report.throughput.weeks.map((w) => [w.key, w.count]));
    expect(byKey["2026-W45"]).toBe(2); // 4/11 e domingo 23:30
    expect(byKey["2026-W46"]).toBe(2); // segunda 00:30 e terça
    expect(report.throughput.weeks).toHaveLength(8);
    expect(report.throughput.weeks.at(-1)).toMatchObject({ key: "2026-W46", current: true, start: "2026-11-09" });
    // Dentro da janela [8/11 00:00, agora): T1, T2 e T3 (a T4 é de 4/11).
    expect(report.throughput.value).toBe(3);
    expect(report.throughput.prev).toBe(1); // a T4, que cai na janela anterior (de 1/11 a 8/11)
  });

  it("média móvel de 4 semanas: (semana atual + 3 anteriores) / 4", () => {
    const finish = (days: number) => at(NOW - days * DAY);
    // W46 (esta): 2; W45: 4; W44: 6; W43: 0.
    const tasks = [leaf("A", { finishedAt: finish(1) }), leaf("B", { finishedAt: finish(2) })];
    for (let i = 0; i < 4; i += 1) tasks.push(leaf(`C${i}`, { finishedAt: finish(7 + i) }));
    for (let i = 0; i < 6; i += 1) tasks.push(leaf(`D${i}`, { finishedAt: finish(14 + (i % 4)) }));
    const report = computeMetrics(snapshot({ projects: [project("p1", tasks)] }), { now: NOW });
    const weeks = report.throughput.weeks;
    expect(weeks.at(-1)!.count).toBe(2);
    expect(weeks.at(-2)!.count).toBe(4);
    expect(weeks.at(-3)!.count).toBe(6);
    expect(weeks.at(-1)!.avg4).toBe((2 + 4 + 6 + 0) / 4);
  });
});

describe("tempo até entregar (ciclo)", () => {
  const done = (id: string, cycleH: number, workH = 0) => project(id, [leaf("T1", { steps: [{ agentId: "clara", what: "x", status: "feita", startedAt: at(NOW - 5 * DAY), finishedAt: at(NOW - 5 * DAY + workH * HOUR) }] })], { status: "concluido", createdAt: at(NOW - 5 * DAY), finishedAt: at(NOW - 5 * DAY + cycleH * HOUR) });

  it("n par (4): mediana pelo posto mais próximo (a 2ª) e p90 (a 4ª)", () => {
    const projects = [1, 2, 3, 4].map((hours) => done(`p${hours}`, hours));
    const report = computeMetrics(snapshot({ projects }), { now: NOW, ...week });
    expect(report.cycleTime).toMatchObject({ n: 4, value: 2 * HOUR, p90: 4 * HOUR, fewData: true, note: "poucos dados" });
    expect(report.cycleTime.trend).toBeUndefined();
  });

  it("n ímpar (5): mediana é a 3ª, p90 a 5ª; sem aviso de poucos dados", () => {
    const projects = [1, 2, 3, 4, 5].map((hours) => done(`p${hours}`, hours));
    const report = computeMetrics(snapshot({ projects }), { now: NOW, ...week });
    expect(report.cycleTime).toMatchObject({ n: 5, value: 3 * HOUR, p90: 5 * HOUR, fewData: false });
    expect(report.cycleTime.note).toBeUndefined();
  });

  it("parte o ciclo em trabalhando e parado, e o parado em 'esperando você' e fila", () => {
    // Ciclo de 10 h; 2 h trabalhando; o dono demorou 5 h (decidiu 5 h depois de pedido); o resto (3 h) é fila.
    const p = done("p1", 10, 2);
    const items = [item("A-0001", { projectId: "p1", createdAt: at(NOW - 5 * DAY + 3 * HOUR), decidedAt: at(NOW - 5 * DAY + 8 * HOUR), decidedBy: "usuario" })];
    const report = computeMetrics(snapshot({ projects: [p], forYou: items }), { now: NOW, ...week });
    expect(report.cycleTime).toMatchObject({ value: 10 * HOUR, workingMs: 2 * HOUR, stoppedMs: 8 * HOUR, waitingYouMs: 5 * HOUR, queuedMs: 3 * HOUR });
    expect(report.approvalWait.weightInCycle).toBeCloseTo(0.5, 10);
  });
});

describe("espera pelo OK, recusa e edição", () => {
  it("espera: mediana e p90 só dos decididos pelo dono; pendentes pelo tempo; Automático fora", () => {
    const items = [
      item("A-0001", { createdAt: at(NOW - 3 * HOUR), decidedAt: at(NOW - 3 * HOUR + 10 * MIN), decidedBy: "usuario" }),
      item("A-0002", { createdAt: at(NOW - 3 * HOUR), decidedAt: at(NOW - 3 * HOUR + 20 * MIN), decidedBy: "usuario" }),
      item("A-0003", { createdAt: at(NOW - 3 * HOUR), decidedAt: at(NOW - 3 * HOUR + 30 * MIN) }),
      item("A-0004", { createdAt: at(NOW - 3 * HOUR), decidedAt: at(NOW - 3 * HOUR + 1 * MIN), decidedBy: "automatico" }),
      item("A-0005", { status: "pendente", createdAt: at(NOW - 30 * HOUR) }),
      item("A-0006", { status: "pendente", createdAt: at(NOW - 2 * HOUR), agentId: "eco" }),
    ];
    const report = computeMetrics(snapshot({ forYou: items }), { now: NOW, ...week });
    expect(report.approvalWait).toMatchObject({ n: 3, value: 20 * MIN, p90: 30 * MIN, fewData: true, note: "poucos dados" });
    expect(report.approvalWait.pending).toMatchObject({ count: 2, over24h: 1, oldestMs: 30 * HOUR });
    expect(report.approvalWait.pending.items[0]).toMatchObject({ id: "A-0005", ageMs: 30 * HOUR });
  });

  it("recusa: só o que o dono decidiu (aprovado/recusado, texto); Automático, plano e pendente ficam de fora; por agente e por tipo", () => {
    const decided = (id: string, status: ForYouItem["status"], over: Partial<ForYouItem> = {}) => item(id, { status, decidedAt: at(NOW - DAY), decidedBy: "usuario", ...over });
    const items = [
      decided("A-0001", "rejeitado", { agentId: "eco", rejection: { reason: "tom formal demais" } }),
      decided("A-0002", "rejeitado", { agentId: "eco" }),
      decided("A-0003", "aprovado", { agentId: "eco" }),
      decided("A-0004", "aprovado", { agentId: "clara" }),
      decided("A-0005", "aprovado", { agentId: "clara", type: "post" }),
      decided("A-0006", "rejeitado", { agentId: "clara", decidedBy: "automatico" }),
      decided("A-0007", "rejeitado", { agentId: "clara", kind: "plano" }),
      item("A-0008", { status: "pendente" }),
    ];
    const report = computeMetrics(snapshot({ forYou: items }), { now: NOW, ...week });
    expect(report.rejectionRate).toMatchObject({ n: 5, hits: 2, value: 0.4 });
    expect(report.rejectionRate.byAgent.find((group) => group.key === "eco")).toMatchObject({ label: "Eco", n: 3, hits: 2, value: 2 / 3 });
    expect(report.rejectionRate.byAgent.find((group) => group.key === "clara")).toMatchObject({ n: 2, hits: 0, value: 0 });
    expect(report.rejectionRate.byType.find((group) => group.key === "comentario")).toMatchObject({ n: 4, hits: 2 });
  });

  it("edição: taxa = editados / aprovados; intensidade = 1 - Dice (mediana dos editados)", () => {
    const approved = (id: string, over: Partial<ForYouItem> = {}) => item(id, { decidedAt: at(NOW - DAY), decidedBy: "usuario", ...over });
    const items = [
      approved("A-0001", { editedByUser: true, originalText: "a b c d", text: "a b c e" }), // 1/3
      approved("A-0002", { editedByUser: true, originalText: "um dois três", text: "quatro cinco seis" }), // 1
      approved("A-0003", { editedByUser: true, originalText: "x y z w", text: "x y z w v" }),
      approved("A-0004"),
      item("A-0005", { status: "rejeitado", decidedAt: at(NOW - DAY), editedByUser: true, originalText: "p q", text: "r s" }),
    ];
    const report = computeMetrics(snapshot({ forYou: items }), { now: NOW, ...week });
    expect(report.editRate).toMatchObject({ n: 4, hits: 3, value: 0.75 });
    // Intensidades: 1/3, 1 e 1 - 2·3/(3+4)=1/7; mediana (posto mais próximo, n=3) = a 2ª ordenada = 1/3.
    expect(report.editRate.intensity.n).toBe(3);
    expect(report.editRate.intensity.value).toBeCloseTo(1 / 3, 10);
  });
});

describe("falha, refeito, travados e carga", () => {
  it("a tarefa cancelada não é falha e não entra na conta: 3 feitas, 1 falha e 1 cancelada = 25%", () => {
    const tasks = [task("t1"), task("t2"), task("t3", { agentId: "eco" }), task("t4", { status: "failed" }), task("t5", { status: "failed", outcome: "cancelled" }), task("req", { role: "request", status: "failed" })];
    const report = computeMetrics(snapshot({ tasks }), { now: NOW, ...week });
    expect(report.failureRate).toMatchObject({ n: 4, hits: 1, value: 0.25 });
    expect(report.failureRate.byAgent.find((group) => group.key === "clara")).toMatchObject({ n: 3, hits: 1 });
  });

  it("refeito a pedido: concluídas com `rework.count > 0` / concluídas, e a média de refações", () => {
    const rework = (count: number) => ({ count });
    const tasks = [leaf("T1", { finishedAt: at(NOW - DAY), rework: rework(2) }), leaf("T2", { finishedAt: at(NOW - DAY), rework: rework(1) }), leaf("T3", { finishedAt: at(NOW - DAY) }), leaf("T4", { finishedAt: at(NOW - DAY) })];
    const report = computeMetrics(snapshot({ projects: [project("p1", tasks)] }), { now: NOW, ...week });
    expect(report.rework).toMatchObject({ n: 4, hits: 2, value: 0.5, avgCount: 0.75 });
  });

  it("travados agora: bloqueio gravado, espera de mais de 2 h e falha não resolvida, do mais velho ao mais novo", () => {
    const tasks = [
      leaf("T1", { status: "a_fazer", blocked: { type: "cota", note: "Eco sem cota", since: at(NOW - 5 * HOUR) } }),
      leaf("T2", { status: "esperando_voce", waitingSince: at(NOW - 9 * HOUR) }),
      leaf("T3", { status: "a_fazer", waitingSince: at(NOW - 1 * HOUR) }), // menos de 2 h: ainda não é "travado"
      leaf("T4", { status: "falhou", failure: "x", finishedAt: at(NOW - 2 * HOUR) }),
      leaf("T5", { status: "concluida" }),
    ];
    const report = computeMetrics(snapshot({ projects: [project("p1", tasks)] }), { now: NOW });
    expect(report.blockedNow.count).toBe(3);
    expect(report.blockedNow.items.map((entry) => [entry.ref, entry.type, entry.ageMs])).toEqual([
      ["T2", "voce", 9 * HOUR],
      ["T1", "cota", 5 * HOUR],
      ["T4", "falha", 2 * HOUR],
    ]);
    expect(report.blockedNow.byType).toEqual({ voce: 1, cota: 1, falha: 1 });
  });

  it("carga por agente (agora) contra o limite de paralelo", () => {
    const tasks = [task("a", { status: "in_progress" }), task("b", { status: "queued" }), task("c", { status: "queued", agentId: "eco" }), task("d", { status: "waiting_approval", agentId: "eco" }), task("req", { role: "request", status: "in_progress" })];
    const usage: UsageRecord[] = [{ ...record("u1", "clara", {}), durationMs: 90 * MIN, at: at(NOW - 2 * DAY) }, { ...record("u2", "clara", {}), durationMs: 30 * MIN, at: at(NOW - 10 * DAY) }];
    const report = computeMetrics(snapshot({ tasks, usage }), { now: NOW });
    expect(report.load).toMatchObject({ running: 1, maxRunning: 3, perAgentLimit: 1, queued: 2 });
    expect(report.load.agents.find((agent) => agent.id === "clara")).toMatchObject({ doing: 1, queued: 1, waiting: 0, workedMs7d: 90 * MIN });
    expect(report.load.agents.find((agent) => agent.id === "eco")).toMatchObject({ doing: 0, queued: 1, waiting: 1 });
  });
});

function record(id: string, agentId: string, over: Partial<UsageRecord>): UsageRecord {
  return { v: 1, id, at: at(NOW - DAY), agentId, provider: "claude", model: "claude-sonnet-5-5", source: "seed", measured: true, costUsd: null, priceVersion: "seed", ...over };
}

describe("custo por entrega (equivalente à API)", () => {
  it("1 M de entrada + 100 mil de saída no Sonnet 5.5 = US$ 2 + US$ 1 = US$ 3; duas entregas do projeto = US$ 1,50 cada", () => {
    const tasks = [leaf("T1", { finishedAt: at(NOW - DAY) }), leaf("T2", { finishedAt: at(NOW - DAY) })];
    const usage = [record("u1", "clara", { rootTaskId: "p1", taskId: "t1", tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0 } })];
    const report = computeMetrics(snapshot({ projects: [project("p1", tasks)], usage }), { now: NOW, ...week });
    expect(report.costPerDelivery).toMatchObject({ deliveries: 2, n: 2 });
    expect(report.costPerDelivery.totalUsd).toBeCloseTo(3, 10);
    expect(report.costPerDelivery.value).toBeCloseTo(1.5, 10);
    expect(report.costPerDelivery.byProject[0]).toMatchObject({ key: "p1", n: 2 });
    expect(report.costPerDelivery.byProject[0]!.value).toBeCloseTo(1.5, 10);
  });

  it("gasto de teste e registro de valor impossível não entram", () => {
    const tasks = [leaf("T1", { finishedAt: at(NOW - DAY) })];
    const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
    const usage = [record("u1", "clara", { rootTaskId: "p1", tokens }), record("u2", "clara", { rootTaskId: "p1", tokens, test: true })];
    const report = computeMetrics(snapshot({ projects: [project("p1", tasks)], usage }), { now: NOW, ...week });
    expect(report.costPerDelivery.totalUsd).toBeCloseTo(2, 10);
  });

  it("spend soma o gasto de tudo na janela (também o que não virou entrega) e o da janela anterior", () => {
    const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
    const usage = [record("u1", "clara", { tokens }), record("u2", "eco", { tokens, at: at(NOW - 10 * DAY) }), record("u3", "eco", { tokens, test: true })];
    const report = computeMetrics(snapshot({ usage }), { now: NOW });
    expect(report.spend.usd).toBeCloseTo(2, 10);
    expect(report.spend.prevUsd).toBeCloseTo(2, 10);
  });

  it("a entrega de rotina leva o custo da tarefa da rotina", () => {
    const entries: RoutineEntry[] = [{ id: "e1", routineId: "R-0001", periodKey: "2026-W46", url: "https://x/1", taskId: "rt1", agentId: "clara", stage: "entregue", at: at(NOW - DAY) }];
    const usage = [record("u1", "clara", { taskId: "rt1", rootTaskId: "rt1", tokens: { input: 500_000, output: 0, cacheRead: 0, cacheCreation: 0 } })];
    const report = computeMetrics(snapshot({ entries, usage }), { now: NOW, ...week });
    expect(report.costPerDelivery.value).toBeCloseTo(1, 10);
    expect(report.costPerDelivery.byProject[0]).toMatchObject({ key: "rotina:R-0001", label: "Comentários" });
  });
});

describe("cota", () => {
  const usage = (over: Partial<SubscriptionUsage["windows"][number]> = {}, updatedAt = NOW - MIN): SubscriptionUsage[] => [{ provider: "claude", updatedAt: at(updatedAt), windows: [{ id: "five_hour", utilization: 0.86, resetsAt: at(NOW + 2 * HOUR), ...over }] }];

  it("frase pronta e ritmo: 86% com 3 das 5 horas passadas = ritmo 1,43 (acima de 1,2, aviso)", () => {
    const report = computeMetrics(snapshot({ quota: usage() }), { now: NOW });
    expect(report.quota.windows[0]).toMatchObject({ label: "5 h", state: "value", percent: 86, pace: 1.43, warn: true });
    // 17:00 UTC = 14:00 em São Paulo.
    expect(report.quota.windows[0]!.text).toBe("Claude Code: 5 h em 86%, volta às 14:00");
  });

  it("janela que já renovou não mostra o número velho", () => {
    const report = computeMetrics(snapshot({ quota: usage({ resetsAt: at(NOW - 10 * MIN) }, NOW - HOUR) }), { now: NOW });
    expect(report.quota.windows[0]).toMatchObject({ state: "renewed", percent: null, pace: null, warn: false, text: "Claude: 5 h renovada" });
  });
});

describe("janelas padrão e a comparação com o período anterior", () => {
  it("sem from/to: 7 dias para taxas e 28 para medianas, cada uma com a anterior do mesmo tamanho", () => {
    const report = computeMetrics(snapshot(), { now: NOW });
    expect(report.windows.rates).toEqual({ from: at(NOW - 7 * DAY), to: at(NOW) });
    expect(report.windows.medians).toEqual({ from: at(NOW - 28 * DAY), to: at(NOW) });
    expect(report.prevWindows.rates).toEqual({ from: at(NOW - 14 * DAY), to: at(NOW - 7 * DAY) });
    expect(report.prevWindows.medians).toEqual({ from: at(NOW - 56 * DAY), to: at(NOW - 28 * DAY) });
  });

  it("seta só com 5 ou mais amostras nos dois períodos: 8 entregas contra 5 sobe; 4 contra 8 não tem seta", () => {
    const finish = (days: number) => at(NOW - days * DAY);
    const many = [...Array.from({ length: 8 }, (_, i) => leaf(`N${i}`, { finishedAt: finish(1 + (i % 5)) })), ...Array.from({ length: 5 }, (_, i) => leaf(`P${i}`, { finishedAt: finish(8 + i) }))];
    const up = computeMetrics(snapshot({ projects: [project("p1", many)] }), { now: NOW, ...week });
    expect(up.throughput).toMatchObject({ value: 8, prev: 5, trend: "up", fewData: false });
    const few = [...Array.from({ length: 4 }, (_, i) => leaf(`N${i}`, { finishedAt: finish(1 + i) })), ...Array.from({ length: 8 }, (_, i) => leaf(`P${i}`, { finishedAt: finish(8 + (i % 5)) }))];
    const down = computeMetrics(snapshot({ projects: [project("p1", few)] }), { now: NOW, ...week });
    expect(down.throughput).toMatchObject({ value: 4, prev: 8, fewData: true, note: "poucos dados" });
    expect(down.throughput.trend).toBeUndefined();
  });
});

describe("histórico fabricado (fixture) e o texto do get_metrics", () => {
  const agents = ["clara", "eco", "beto", "dani", "leo"].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
  const build = (seed: number) => makeHistory({ now: NOW, days: 28, seed, agents });
  const snap = (history: ReturnType<typeof build>): MetricsSnapshot => ({ agents, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } });

  it("é determinístico: a mesma semente dá o mesmo histórico e o mesmo relatório", () => {
    expect(JSON.stringify(build(7))).toBe(JSON.stringify(build(7)));
    expect(JSON.stringify(build(7))).not.toBe(JSON.stringify(build(8)));
    expect(computeMetrics(snap(build(7)), { now: NOW })).toEqual(computeMetrics(snap(build(7)), { now: NOW }));
  });

  it("marca o que fabricou como semente (gasto `seed`, Atividade `data.seed`, itens `meta.seed`)", () => {
    const history = build(7);
    expect(history.usage.length).toBeGreaterThan(50);
    expect(history.usage.every((entry) => entry.source === "seed")).toBe(true);
    expect(history.activity.every((entry) => entry.data?.seed === true)).toBe(true);
    expect(history.forYou.every((entry) => entry.meta.seed === "1")).toBe(true);
    expect(history.tasks.every((entry) => entry.id.startsWith("seed-"))).toBe(true);
  });

  it("os perfis aparecem nos números: o `recusado` é o mais recusado, o `editado` o mais editado e o dono demora de minutos a mais de 1 dia", () => {
    const report = computeMetrics(snap(build(7)), { now: NOW, from: NOW - 28 * DAY, to: NOW });
    const worstRejected = [...report.rejectionRate.byAgent].filter((group) => group.n >= 8).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
    expect(worstRejected?.key).toBe("beto");
    const mostEdited = [...report.editRate.byAgent].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
    expect(mostEdited?.key).toBe("eco");
    expect(report.approvalWait.p90).toBeGreaterThan(2 * HOUR);
    expect(report.approvalWait.value).toBeLessThan(2 * HOUR);
    expect(report.approvalWait.pending.oldestMs).toBeGreaterThan(2 * DAY - HOUR);
    expect(report.blockedNow.byType.cota).toBe(1);
    expect(report.throughput.weeks).toHaveLength(8);
  });

  it("renderMetrics: cita o n, diz 'few data' sem seta e termina com a hora do servidor", () => {
    const report = pickGroups(computeMetrics(snap(build(7)), { now: NOW, from: NOW - 28 * DAY, to: NOW }), "agent");
    const text = renderMetrics(report);
    expect(text).toContain("Rejection rate");
    expect(text).toMatch(/\(n=\d+/);
    expect(text).toMatch(/few data/);
    expect(text.trim().split("\n").at(-1)).toBe("Computed by the server at 12:00 (America/Sao_Paulo); do not recompute or search the Activity for these numbers.");
    expect(renderMetrics(report, { metrics: ["rejection"] })).not.toContain("Deliveries");
  });
});

describe("por agente: entregas por semana e tempo até entregar", () => {
  it("agentWeeks traz as 8 semanas de cada agente (mais entregas primeiro) e cycleTime.byAgent a mediana dos projetos que ele entregou", () => {
    const done = (id: string, agentId: string, daysAgo: number, cycleH: number) =>
      project(id, [leaf("T1", { finishedAt: at(NOW - daysAgo * DAY + cycleH * HOUR), steps: [{ agentId, what: "x", status: "feita", startedAt: at(NOW - daysAgo * DAY), finishedAt: at(NOW - daysAgo * DAY + HOUR) }] })], { status: "concluido", createdAt: at(NOW - daysAgo * DAY), finishedAt: at(NOW - daysAgo * DAY + cycleH * HOUR) });
    const projects = [done("a", "clara", 1, 2), done("b", "clara", 2, 4), done("c", "clara", 9, 6), done("d", "eco", 3, 10)];
    const report = computeMetrics(snapshot({ projects }), { now: NOW });
    const { agentWeeks } = report.throughput;
    expect(agentWeeks.map((row) => row.key)).toEqual(["clara", "eco"]);
    expect(agentWeeks[0]!.counts).toHaveLength(8);
    expect(agentWeeks[0]!.counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(agentWeeks[0]!.counts.at(-1)).toBe(2);
    expect(report.cycleTime.byAgent.find((group) => group.key === "clara")).toMatchObject({ n: 3, value: 4 * HOUR, fewData: true });
    expect(report.cycleTime.byAgent.find((group) => group.key === "eco")).toMatchObject({ n: 1, value: 10 * HOUR });
    // Por semana: W46 (esta) tem os projetos a (2 h) e b (4 h) e o d (10 h); W45 tem o c (6 h).
    const weeks = Object.fromEntries(report.cycleTime.weeks.map((week) => [week.key, week]));
    expect(report.cycleTime.weeks).toHaveLength(8);
    expect(weeks["2026-W46"]).toMatchObject({ n: 3, median: 4 * HOUR, p90: 10 * HOUR });
    expect(weeks["2026-W45"]).toMatchObject({ n: 1, median: 6 * HOUR });
    expect(report.cycleTime.weeks.at(0)).toMatchObject({ n: 0, median: null, p90: null });
    expect(pickGroups(report, "none").throughput.agentWeeks).toEqual([]);
    expect(pickGroups(report, "none").cycleTime.byAgent).toEqual([]);
  });
});

describe("group_by", () => {
  it("none tira todos os grupos; routine fica só com as rotinas; agent tira tipo e projeto", () => {
    const history = makeHistory({ now: NOW, days: 28, seed: 7, agents: AGENTS });
    const report: MetricsReport = computeMetrics({ agents: AGENTS, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } }, { now: NOW, from: NOW - 28 * DAY, to: NOW });
    expect(report.throughput.byAgent.length).toBeGreaterThan(0);
    const none = pickGroups(report, "none");
    expect([none.throughput.byAgent, none.throughput.byType, none.throughput.byProject, none.rejectionRate.byAgent, none.editRate.byType]).toEqual([[], [], [], [], []]);
    const routine = pickGroups(report, "routine");
    expect(routine.throughput.byProject.every((group) => group.key.startsWith("rotina:"))).toBe(true);
    expect(routine.throughput.byProject.length).toBe(1);
    const agent = pickGroups(report, "agent");
    expect(agent.throughput.byType).toEqual([]);
    expect(agent.throughput.byAgent.length).toBeGreaterThan(0);
  });
});

describe("custo por entrega: rateado por entrega, sem repetir o dólar entre janelas (revisão M2)", () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }; // US$ 2 no Sonnet 5.5
  const twoWindows = (p: Project, usage: UsageRecord[]) => ({
    now: computeMetrics(snapshot({ projects: [p], usage }), { now: NOW, ...week }),
    before: computeMetrics(snapshot({ projects: [p], usage }), { now: NOW - 7 * DAY, from: NOW - 14 * DAY, to: NOW - 7 * DAY }),
  });

  it("projeto de US$ 2 com T1 há 10 dias e T2 ontem: US$ 1 em cada janela, nunca US$ 2 nas duas", () => {
    const p = project("p1", [leaf("T1", { finishedAt: at(NOW - 10 * DAY) }), leaf("T2", { finishedAt: at(NOW - DAY) })]);
    const { now, before } = twoWindows(p, [record("u1", "clara", { at: at(NOW - 10 * DAY), rootTaskId: "p1", tokens })]);
    expect(now.costPerDelivery.totalUsd).toBeCloseTo(1, 10);
    expect(now.costPerDelivery.value).toBeCloseTo(1, 10);
    expect(now.costPerDelivery.prev).toBeCloseTo(1, 10);
    expect(before.costPerDelivery.totalUsd).toBeCloseTo(1, 10);
    expect(now.costPerDelivery.totalUsd + before.costPerDelivery.totalUsd).toBeCloseTo(2, 10);
    expect(now.spend.usd).toBe(0); // o gasto real da janela segue sendo o gasto real
  });

  it("projeto com uma entrega só: leva o custo todo", () => {
    const p = project("p1", [leaf("T1", { finishedAt: at(NOW - DAY) })]);
    const { now } = twoWindows(p, [record("u1", "clara", { rootTaskId: "p1", tokens })]);
    expect(now.costPerDelivery.value).toBeCloseTo(2, 10);
  });

  it("entrega de projeto sem registro de uso: custo 0 (não some nem vira nulo)", () => {
    const p = project("p1", [leaf("T1", { finishedAt: at(NOW - DAY) })]);
    const { now } = twoWindows(p, []);
    expect(now.costPerDelivery).toMatchObject({ deliveries: 1, totalUsd: 0, value: 0 });
  });

  it("por agente e por projeto somam o total da janela", () => {
    const p1 = project("p1", [leaf("T1", { finishedAt: at(NOW - 10 * DAY), ownerId: "eco" }), leaf("T2", { finishedAt: at(NOW - DAY) }), leaf("T3", { finishedAt: at(NOW - 2 * DAY), ownerId: "eco" })]);
    const p2 = project("p2", [leaf("T1", { finishedAt: at(NOW - DAY), ownerId: "eco" })]);
    const usage = [record("u1", "clara", { rootTaskId: "p1", tokens: { ...tokens, input: 3_000_000 } }), record("u2", "eco", { rootTaskId: "p2", tokens })];
    const report = computeMetrics(snapshot({ projects: [p1, p2], usage }), { now: NOW, ...week });
    const c = report.costPerDelivery;
    expect(c.deliveries).toBe(3);
    expect(c.totalUsd).toBeCloseTo(2 + 2 + 2, 10); // p1: 2 entregas na janela x US$ 2; p2: US$ 2
    const sumOf = (groups: { value: number | null; n: number }[]) => groups.reduce((acc, g) => acc + (g.value ?? 0) * g.n, 0);
    expect(sumOf(c.byAgent)).toBeCloseTo(c.totalUsd, 10);
    expect(sumOf(c.byProject)).toBeCloseTo(c.totalUsd, 10);
  });
});
