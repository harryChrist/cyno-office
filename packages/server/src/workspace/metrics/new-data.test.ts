import { projectDefaults, projectTaskDefaults, type OfficeState, type Project, type ProjectTask, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { overviewItem, type OverviewRoutines } from "../routines/overview";
import { computeMetrics, type MetricsSnapshot } from "./compute";
import { makeHistory, stripNewFields } from "./fixtures/make-history";
import { renderMetrics } from "./render";

// "Agora": quinta, 12/11/2026 12:00 em São Paulo (15:00Z). Nada aqui lê o relógio nem o fuso da máquina.
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(ms).toISOString();
const AGENTS = [
  { id: "clara", name: "Clara" },
  { id: "eco", name: "Eco" },
];

function leaf(ref: string, over: Partial<ProjectTask> = {}): ProjectTask {
  return { ...projectTaskDefaults(), ref, title: `Tarefa ${ref}`, briefing: "", ownerId: "clara", steps: [], current: 0, dependsOn: [], priority: "normal", status: "concluida", updatedAt: at(NOW), ...over };
}
function project(id: string, tasks: ProjectTask[], over: Partial<Project> = {}): Project {
  return { ...projectDefaults(), id, kind: "projeto", title: `Projeto ${id}`, origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, tasks, createdAt: at(NOW - 30 * DAY), updatedAt: at(NOW), ...over };
}
function task(id: string, over: Partial<Task> = {}): Task {
  return { id, roomId: "q", teamId: "t", agentId: "clara", prompt: id, status: "done", createdAt: at(NOW - DAY), updatedAt: at(NOW - HOUR), ...over };
}
function snapshot(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return { agents: AGENTS, tasks: [], projects: [], forYou: [], usage: [], routines: [], entries: [], quota: [], dispatch: { maxRunning: 3, perAgent: 1 }, ...over };
}

describe("taxa de falha: falha do agente separada de motor, cota e acesso (failureKind)", () => {
  const ran = [task("d1"), task("d2"), task("d3"), task("d4")];
  const failed = (id: string, failureKind?: Task["failureKind"], agentId = "clara") => task(id, { status: "failed", agentId, ...(failureKind ? { failureKind } : {}) });

  it("a taxa geral conta todas; a do agente tira motor, cota e acesso; mostra as origens", () => {
    const tasks = [...ran, failed("f1", "agente"), failed("f2", "cota"), failed("f3", "motor"), failed("f4", "acesso")];
    const { failureRate } = computeMetrics(snapshot({ tasks }), { now: NOW });
    expect(failureRate).toMatchObject({ n: 8, hits: 4, value: 0.5, approx: false });
    expect(failureRate.agentOnly).toMatchObject({ n: 8, hits: 1, value: 1 / 8 });
    expect(failureRate.byKind).toEqual({ agente: 1, cota: 1, motor: 1, acesso: 1 });
    expect(failureRate.byAgent.find((group) => group.key === "clara")).toMatchObject({ hits: 1, n: 8 });
  });

  it("falha sem origem gravada (tarefa antiga) conta como do agente e a taxa é marcada como aproximada; cancelada continua fora", () => {
    const cancelled = task("c1", { status: "failed", outcome: "cancelled", failureKind: "cancelada" });
    const { failureRate } = computeMetrics(snapshot({ tasks: [...ran, failed("old"), failed("f2", "cota"), cancelled] }), { now: NOW });
    expect(failureRate).toMatchObject({ n: 6, hits: 2, approx: true });
    expect(failureRate.agentOnly.hits).toBe(1);
    expect(failureRate.byKind).toEqual({ desconhecida: 1, cota: 1 });
  });

  it("o texto diz 'aproximado' quando falta a origem e lista as origens quando ela existe", () => {
    const exact = renderMetrics(computeMetrics(snapshot({ tasks: [...ran, failed("f1", "agente"), failed("f2", "cota")] }), { now: NOW }), { metrics: ["failure"] });
    expect(exact).toContain("agent-only failures (without engine, quota and access)");
    expect(exact).toContain("by origin: 1 agent, 1 quota");
    expect(exact).not.toContain("approximate");
    const old = renderMetrics(computeMetrics(snapshot({ tasks: [...ran, failed("old")] }), { now: NOW }), { metrics: ["failure"] });
    expect(old).toContain("approximate: some failures have no recorded origin");
    expect(old).toContain("1 unknown origin (older task)");
  });
});

describe("tempo até entregar: o parado por motivo vem dos bloqueios gravados (blockedSpans)", () => {
  const done = (id: string, finishedAgoDays: number, over: Partial<ProjectTask> = {}): Project => {
    const finishedAt = NOW - finishedAgoDays * DAY;
    const createdAt = finishedAt - 10 * HOUR;
    return project(id, [leaf("T1", { steps: [{ agentId: "clara", what: "x", status: "feita", startedAt: at(createdAt + 6 * HOUR), finishedAt: at(createdAt + 8 * HOUR) }], finishedAt: at(finishedAt), ...over })], { status: "concluido", createdAt: at(createdAt), finishedAt: at(finishedAt) });
  };
  const spans = [
    { type: "cota" as const, since: at(NOW - 3 * DAY - 9 * HOUR), until: at(NOW - 3 * DAY - 7 * HOUR) },
    { type: "agente" as const, since: at(NOW - 3 * DAY - 7 * HOUR), until: at(NOW - 3 * DAY - 6.5 * HOUR) },
  ];

  it("projeto com histórico: parado por tipo exato (2 h de cota, 30 min de outro agente)", () => {
    const { cycleTime } = computeMetrics(snapshot({ projects: [done("a", 3, { blockedSpans: spans })] }), { now: NOW });
    expect(cycleTime).toMatchObject({ stoppedExact: true, stoppedBy: { cota: 2 * HOUR, agente: 30 * MIN, acesso: 0 } });
    // O ciclo é de 10 h, o trabalho de 2 h: o parado (8 h) continua sendo a conta de sempre.
    expect(cycleTime.stoppedMs).toBe(8 * HOUR);
  });

  it("projeto antigo (sem blockedSpans): não é exato e `stoppedBy` fica sem valor; os números de antes não mudam", () => {
    const withSpans = computeMetrics(snapshot({ projects: [done("a", 3, { blockedSpans: spans })] }), { now: NOW }).cycleTime;
    const legacy = computeMetrics(snapshot({ projects: [done("a", 3)] }), { now: NOW }).cycleTime;
    expect(legacy).toMatchObject({ stoppedExact: false, stoppedBy: { cota: null, agente: null, acesso: null } });
    expect(legacy.stoppedMs).toBe(withSpans.stoppedMs);
    expect(legacy.value).toBe(withSpans.value);
    expect(legacy.workingMs).toBe(withSpans.workingMs);
  });

  it("mistura: só um dos projetos tem o histórico -> `stoppedExact` é falso e a mediana usa só quem tem", () => {
    const { cycleTime } = computeMetrics(snapshot({ projects: [done("a", 3, { blockedSpans: spans }), done("b", 4)] }), { now: NOW });
    expect(cycleTime.stoppedExact).toBe(false);
    expect(cycleTime.stoppedBy.cota).toBe(2 * HOUR);
  });

  it("o texto diz 'approximate' sem histórico e lista os motivos com ele", () => {
    const exact = renderMetrics(computeMetrics(snapshot({ projects: [done("a", 3, { blockedSpans: spans })] }), { now: NOW }), { metrics: ["cycle_time"] });
    expect(exact).toContain("Stopped by recorded reason: another agent 30min, no quota 2h, no access 0min.");
    const legacy = renderMetrics(computeMetrics(snapshot({ projects: [done("a", 3)] }), { now: NOW }), { metrics: ["cycle_time"] });
    expect(legacy).toContain("Stopped time by reason is approximate");
  });
});

describe("espera na fila (queuedAt) por agente", () => {
  const started = (ref: string, agentId: string, queuedMinAgo: number, startedMinAgo: number, over: Partial<ProjectTask> = {}): ProjectTask =>
    leaf(ref, { ownerId: agentId, steps: [{ agentId, what: "x", status: "feita", startedAt: at(NOW - startedMinAgo * MIN), finishedAt: at(NOW - (startedMinAgo - 10) * MIN) }], startedAt: at(NOW - startedMinAgo * MIN), ...(queuedMinAgo >= 0 ? { queuedAt: at(NOW - queuedMinAgo * MIN) } : {}), ...over });

  it("exato com queuedAt: começou - entrou na fila; por agente, mediana e p90", () => {
    const tasks = [started("T1", "clara", 100, 70), started("T2", "clara", 200, 140), started("T3", "eco", 300, 60)];
    const { queueWait } = computeMetrics(snapshot({ projects: [project("p", tasks)] }), { now: NOW });
    expect(queueWait).toMatchObject({ n: 3, value: 60 * MIN, approx: false, fewData: true });
    expect(queueWait.byAgent.find((group) => group.key === "clara")).toMatchObject({ n: 2, value: 30 * MIN });
    expect(queueWait.byAgent.find((group) => group.key === "eco")).toMatchObject({ n: 1, value: 240 * MIN });
  });

  it("sem queuedAt (tarefa antiga): aproximado, desde que a dependência terminou ou o projeto foi aprovado", () => {
    const first = started("T1", "clara", -1, 300, { finishedAt: at(NOW - 280 * MIN) });
    const second = started("T2", "clara", -1, 200, { dependsOn: ["T1"] });
    const { queueWait } = computeMetrics(snapshot({ projects: [project("p", [first, second], { approvedAt: at(NOW - 320 * MIN) })] }), { now: NOW });
    expect(queueWait.approx).toBe(true);
    // T1: aprovado há 320 min, começou há 300 = 20 min; T2: T1 terminou há 280, começou há 200 = 80 min.
    expect(queueWait.n).toBe(2);
    expect(queueWait.value).toBe(20 * MIN);
    expect(renderMetrics(computeMetrics(snapshot({ projects: [project("p", [first, second], { approvedAt: at(NOW - 320 * MIN) })] }), { now: NOW }), { metrics: ["cycle_time"] })).toContain("approximate (some tasks have no queue timestamp)");
  });

  it("tarefa que ainda não começou, pulada ou de entregável não entra", () => {
    const waiting = leaf("T1", { status: "a_fazer", steps: [{ agentId: "clara", what: "x", status: "pendente" }], queuedAt: at(NOW - HOUR) });
    const group = leaf("G", { group: true, steps: [], status: "backlog" });
    const { queueWait } = computeMetrics(snapshot({ projects: [project("p", [waiting, group])] }), { now: NOW });
    expect(queueWait.n).toBe(0);
  });
});

describe("registros antigos: sem os campos novos tudo continua calculando", () => {
  const agents = ["clara", "eco", "beto", "dani", "leo"].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
  const snap = (history: ReturnType<typeof makeHistory>): MetricsSnapshot => ({ agents, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } });

  it("a semente com e sem os campos novos dá os mesmos números de antes, só marcando o que é aproximado", () => {
    const fresh = makeHistory({ now: NOW, days: 28, seed: 7, agents });
    const old = stripNewFields(fresh);
    expect(old.tasks.some((entry) => entry.failureKind)).toBe(false);
    expect(old.projects.flatMap((entry) => entry.tasks).some((entry) => entry.queuedAt || entry.blockedSpans)).toBe(false);
    expect(old.forYou.some((entry) => entry.rejection?.category)).toBe(false);
    const a = computeMetrics(snap(fresh), { now: NOW, from: NOW - 28 * DAY, to: NOW });
    const b = computeMetrics(snap(old), { now: NOW, from: NOW - 28 * DAY, to: NOW });
    expect(b.throughput).toEqual(a.throughput);
    expect(b.cycleTime.value).toBe(a.cycleTime.value);
    expect(b.cycleTime.stoppedMs).toBe(a.cycleTime.stoppedMs);
    expect(b.rejectionRate).toEqual(a.rejectionRate);
    expect(b.failureRate.value).toBe(a.failureRate.value);
    expect(b.forecast).toEqual(a.forecast);
    // O que muda: sem origem, a falha por cota vira "do agente" e a conta fica aproximada.
    expect(a.failureRate.approx).toBe(false);
    expect(b.failureRate.approx).toBe(true);
    expect(b.failureRate.agentOnly.hits).toBeGreaterThanOrEqual(a.failureRate.agentOnly.hits ?? 0);
    expect(a.cycleTime.stoppedExact).toBe(false);
    expect(b.queueWait.approx).toBe(true);
    expect(a.queueWait.approx).toBe(false);
  });

  it("a semente marca as recusas com a categoria e as falhas do agente de cota com a origem", () => {
    const history = makeHistory({ now: NOW, days: 28, seed: 7, agents });
    const refused = history.forYou.filter((entry) => entry.status === "rejeitado");
    expect(refused.length).toBeGreaterThan(5);
    expect(refused.every((entry) => entry.rejection?.category)).toBe(true);
    expect(refused.filter((entry) => entry.rejection?.reason === "tom formal demais").every((entry) => entry.rejection?.category === "tom")).toBe(true);
    const kinds = new Set(history.tasks.filter((entry) => entry.status === "failed" && entry.outcome !== "cancelled").map((entry) => entry.failureKind));
    expect(kinds.has("cota")).toBe(true);
    expect(kinds.has("agente")).toBe(true);
  });
});

describe("metas: a projeção chega ao relatório e ao cartão da meta", () => {
  const agents = ["clara", "eco", "beto", "dani", "leo"].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
  const history = makeHistory({ now: NOW, days: 28, seed: 7, agents, goals: true });
  const state = { rooms: [], teams: [], agents: [], tasks: [] } as unknown as OfficeState;
  const routines = { entries: history.entries, todayCount: () => 0, history: () => [], ownerOf: () => undefined, statsFor: () => ({ prepared: 0, approved: 0, dismissed: 0 }) } as unknown as OverviewRoutines;
  const items = history.routines.map((routine) => overviewItem({ routines, state: { read: () => state }, now: new Date(NOW) }, routine));
  const projection = (id: string) => items.find((item) => item.routine.id === id)!.projection!;

  it("a meta que fecha: 4 de 5 entregues, 6 entregas nos últimos 7 dias com dias preferidos (terça e quinta pesam o dobro)", () => {
    expect(projection("R-0901")).toMatchObject({ target: 5, delivered: 4, n: 6, closes: true, daysLeft: 2, periodKey: "2026-W46" });
    expect(projection("R-0901").text).toBe("no ritmo atual bate a meta");
  });

  it("a meta que não fecha: 2 de 12 e o ritmo (3 entregas em 5 dias úteis) leva a 2 de 12", () => {
    expect(projection("R-0902")).toMatchObject({ target: 12, delivered: 2, n: 3, closes: false, projected: 2 });
    expect(projection("R-0902").text).toBe("no ritmo atual fecha em 2 de 12 (poucos dados)");
  });

  it("rotina sem alvo de meta não tem projeção; o relatório lista as metas e diz quantas fecham", () => {
    const goals = items.flatMap((item) => (item.projection ? [item.projection] : []));
    const report = computeMetrics({ agents, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 }, goals }, { now: NOW });
    expect(report.goals.items.map((goal) => goal.routineId).sort()).toEqual(["R-0900", "R-0901", "R-0902"]);
    expect(report.goals.text).toMatch(/^\d de \d metas abertas fecham no ritmo atual$/);
    const text = renderMetrics(report, { metrics: ["goals"] });
    expect(text).toContain('"Posts do blog" 4/5');
    expect(text).toContain("on pace to hit the target");
    expect(text).toContain('"Conexões" 2/12');
    expect(text).toContain("projected 2 of 12");
    expect(text).toMatch(/\(n=3, confidence low, 1\.5 working days left\)/);
  });

  it("rotina encerrada ou proposta não projeta", () => {
    const routine = { ...history.routines.find((candidate) => candidate.id === "R-0901")!, status: "proposta" as const };
    expect(overviewItem({ routines, state: { read: () => state }, now: new Date(NOW) }, routine).projection).toBeUndefined();
  });
});
