import { projectDefaults, projectTaskDefaults, type ForYouItem, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { computeMetrics, type MetricsSnapshot } from "./compute";
import { advanceWork, buildForecastStats, forecastAll, forecastProject, forecastSentence, type ForecastStats } from "./forecast";
import { makeHistory } from "./fixtures/make-history";
import { renderMetrics } from "./render";

// "Agora": quinta, 12/11/2026 12:00 em São Paulo (15:00Z). Nada aqui lê o relógio nem o fuso da máquina.
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(ms).toISOString();
const sp = (local: string): number => Date.parse(`${local}-03:00`);

/** Cinco amostras: mediana 60 min, p25 45 min, p75 75 min (posto mais próximo). */
const SPREAD = [30, 45, 60, 75, 90].map((minutes) => minutes * MIN);
const FLAT = [60, 60, 60, 60, 60].map((minutes) => minutes * MIN);

function stats(over: Partial<ForecastStats> & { agents?: Record<string, readonly number[]> } = {}): ForecastStats {
  const { agents, ...rest } = over;
  return { stepMs: new Map(Object.entries(agents ?? { clara: SPREAD })), workspaceMs: [], approvalWaits: new Map(), dispatch: { maxRunning: 3, perAgent: 1 }, quotaResumeAt: new Map(), ...rest };
}

function leaf(ref: string, over: Partial<ProjectTask> = {}, agentId = "clara"): ProjectTask {
  return { ...projectTaskDefaults(), ref, title: `Tarefa ${ref}`, briefing: "", ownerId: agentId, steps: [{ agentId, what: "x", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", status: "a_fazer", updatedAt: at(NOW), ...over };
}

function project(tasks: ProjectTask[], over: Partial<Project> = {}): Project {
  return { ...projectDefaults(), id: "p1", kind: "projeto", title: "Site novo", origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, tasks, createdAt: at(NOW - 5 * DAY), updatedAt: at(NOW), approvedAt: at(NOW - 5 * DAY), ...over };
}

const chain = (count: number, agentId = "clara"): ProjectTask[] => Array.from({ length: count }, (_, i) => leaf(`T${i + 1}`, i === 0 ? {} : { dependsOn: [`T${i}`] }, agentId));

describe("forecastProject: o fim provável e a faixa (p25 a p75)", () => {
  it("cadeia de 3 tarefas do mesmo agente: soma das medianas (3 h); a faixa vai de 2 h 15 a 3 h 45", () => {
    const result = forecastProject(project(chain(3)), stats(), NOW);
    expect(result).toMatchObject({ state: "previsto", remaining: 3, n: 5, basis: "5 tarefas", confidence: "media", workMs: 3 * HOUR, criticalMs: 3 * HOUR });
    expect(result.at).toBe(at(NOW + 3 * HOUR));
    expect(result.low).toBe(at(NOW + 2.25 * HOUR));
    expect(result.high).toBe(at(NOW + 3.75 * HOUR));
    expect(result.verdict).toBeUndefined();
  });

  it("as mesmas 3 tarefas em paralelo com 3 agentes: 1 h; com maxRunning 2 vira 1 h 30 (total / p); com um agente só, 3 h", () => {
    const three = [leaf("T1", {}, "a"), leaf("T2", {}, "b"), leaf("T3", {}, "c")];
    const agents = { a: FLAT, b: FLAT, c: FLAT };
    expect(forecastProject(project(three), stats({ agents }), NOW).at).toBe(at(NOW + HOUR));
    expect(forecastProject(project(three), stats({ agents, dispatch: { maxRunning: 2, perAgent: 1 } }), NOW).at).toBe(at(NOW + 1.5 * HOUR));
    const oneAgent = [leaf("T1"), leaf("T2"), leaf("T3")];
    expect(forecastProject(project(oneAgent), stats({ agents: { clara: FLAT } }), NOW).at).toBe(at(NOW + 3 * HOUR));
  });

  it("o caminho crítico manda quando é maior que total / p: A(2 h) -> B(2 h) em cadeia e C(1 h) à parte levam 4 h", () => {
    const tasks = [leaf("T1", {}, "a"), leaf("T2", { dependsOn: ["T1"] }, "a"), leaf("T3", {}, "c")];
    const agents = { a: [2, 2, 2, 2, 2].map((h) => h * HOUR), c: FLAT };
    const result = forecastProject(project(tasks), stats({ agents }), NOW);
    expect(result).toMatchObject({ workMs: 5 * HOUR, criticalMs: 4 * HOUR });
    expect(result.at).toBe(at(NOW + 4 * HOUR));
  });

  it("dependência numa tarefa-mãe espera as subtarefas dela (a cadeia S1 -> S2 -> T3)", () => {
    const mother = leaf("M", { steps: [], ownerId: "", status: "backlog" });
    const tasks = [mother, leaf("S1", { parent: "M" }, "a"), leaf("S2", { parent: "M", dependsOn: ["S1"] }, "b"), leaf("T3", { dependsOn: ["M"] }, "c")];
    const result = forecastProject(project(tasks), stats({ agents: { a: FLAT, b: FLAT, c: FLAT } }), NOW);
    expect(result).toMatchObject({ remaining: 3, criticalMs: 3 * HOUR });
    expect(result.at).toBe(at(NOW + 3 * HOUR));
  });

  it("a etapa em andamento só falta o que não fez (no mínimo 10%) e a que espera o seu OK já fez o trabalho", () => {
    const running = (elapsedMin: number) => leaf("T1", { status: "em_andamento", steps: [{ agentId: "clara", what: "x", status: "em_andamento", startedAt: at(NOW - elapsedMin * MIN) }] });
    expect(forecastProject(project([running(40)]), stats({ agents: { clara: FLAT } }), NOW).at).toBe(at(NOW + 20 * MIN));
    expect(forecastProject(project([running(59)]), stats({ agents: { clara: FLAT } }), NOW).at).toBe(at(NOW + 6 * MIN));
    const waiting = leaf("T1", { status: "esperando_voce", waitingSince: at(NOW - HOUR), approvalType: "post", steps: [{ agentId: "clara", what: "x", status: "em_andamento", startedAt: at(NOW - 2 * HOUR) }] });
    // Sem 5 decisões do tipo, a espera típica é 4 h; já esperou 1 h, faltam 3 h.
    expect(forecastProject(project([waiting]), stats({ agents: { clara: FLAT } }), NOW).at).toBe(at(NOW + 3 * HOUR));
  });

  it("espera pelo OK do dono: 4 h por tarefa com aprovação quando o tipo tem menos de 5 decisões; com 5 ou mais, a mediana dele", () => {
    const tasks = [leaf("T1", { approvalType: "post" })];
    expect(forecastProject(project(tasks), stats({ agents: { clara: FLAT } }), NOW).at).toBe(at(NOW + HOUR + 4 * HOUR));
    const waits = new Map([["post", [1, 1, 2, 2, 3].map((h) => h * HOUR)]]);
    expect(forecastProject(project(tasks), stats({ agents: { clara: FLAT }, approvalWaits: waits }), NOW).at).toBe(at(NOW + HOUR + 2 * HOUR));
  });

  it("sem 3 amostras do agente usa as do workspace; sem elas, a média geral (confiança baixa); sem nada, 'sem previsão ainda'", () => {
    const tasks = [leaf("T1", {}, "beto")];
    const own = stats({ agents: { beto: [HOUR] }, workspaceMs: FLAT });
    // Base emprestada dos outros agentes: por mais amostras que tenha, a confiança fica em baixa e a previsão diz que a base não é dele.
    expect(forecastProject(project(tasks), own, NOW)).toMatchObject({ n: 5, confidence: "baixa", borrowed: true });
    expect(forecastProject(project(tasks), stats({ agents: { beto: [HOUR] }, workspaceMs: Array.from({ length: 40 }, () => HOUR) }), NOW)).toMatchObject({ n: 40, confidence: "baixa", borrowed: true });
    // Com histórico próprio não há marca de base emprestada.
    expect(forecastProject(project(tasks), stats({ agents: { beto: FLAT } }), NOW).borrowed).toBeUndefined();
    expect(forecastProject(project(tasks), own, NOW).at).toBe(at(NOW + HOUR));
    const avg = forecastProject(project(tasks), stats({ agents: {}, average: { ms: 2 * HOUR, n: 4 } }), NOW);
    expect(avg).toMatchObject({ state: "previsto", confidence: "baixa", n: 4, borrowed: true });
    // Só a média: sem distribuição, a faixa é 0,7x e 1,5x.
    expect(avg.at).toBe(at(NOW + 2 * HOUR));
    expect(avg.low).toBe(at(NOW + 1.4 * HOUR));
    expect(avg.high).toBe(at(NOW + 3 * HOUR));
    const none = forecastProject(project(tasks), stats({ agents: {} }), NOW);
    expect(none).toMatchObject({ state: "sem_previsao", reason: "Faltam tarefas concluídas deste agente para estimar", remaining: 1 });
    expect(none.at).toBeUndefined();
  });

  it("n < 5 = baixa, < 15 = média, o resto alta", () => {
    const many = (count: number) => Array.from({ length: count }, () => HOUR);
    const confidenceOf = (n: number) => forecastProject(project(chain(1)), stats({ agents: { clara: many(n) } }), NOW).confidence;
    expect(confidenceOf(3)).toBe("baixa");
    expect(confidenceOf(5)).toBe("media");
    expect(confidenceOf(14)).toBe("media");
    expect(confidenceOf(15)).toBe("alta");
  });

  it("cota esgotada empurra o começo até a hora em que ela volta", () => {
    const resume = NOW + 5 * HOUR;
    const result = forecastProject(project(chain(3)), stats({ agents: { clara: FLAT }, quotaResumeAt: new Map([["clara", resume]]) }), NOW);
    expect(result.at).toBe(at(resume + 3 * HOUR));
    // Cota que já voltou não empurra nada.
    expect(forecastProject(project(chain(3)), stats({ agents: { clara: FLAT }, quotaResumeAt: new Map([["clara", NOW - HOUR]]) }), NOW).at).toBe(at(NOW + 3 * HOUR));
  });
});

describe("veredito contra o prazo", () => {
  const sample = (dueAt: number) => forecastProject(project(chain(3), { dueAt: at(dueAt) }), stats(), NOW);

  it("no prazo: o fim lento (p75 = 3 h 45) cabe antes do prazo", () => {
    expect(sample(NOW + 5 * HOUR).verdict).toBe("no_prazo");
  });
  it("apertado: o fim lento passa do prazo, o provável (3 h) não", () => {
    const result = sample(NOW + 3.5 * HOUR);
    expect(result.verdict).toBe("apertado");
    expect(result.lateByMs).toBeUndefined();
  });
  it("atrasa: o provável já passa do prazo e diz por quanto", () => {
    const result = sample(NOW + 2 * HOUR);
    expect(result).toMatchObject({ verdict: "atrasa", lateByMs: HOUR });
  });
  it("um projeto já atrasado (prazo no passado) atrasa pelo tempo que falta mais o que já passou", () => {
    const result = sample(NOW - DAY);
    expect(result).toMatchObject({ verdict: "atrasa", lateByMs: DAY + 3 * HOUR });
  });
});

describe("calendário: ritmo do projeto, janela de horário e horas por dia", () => {
  it("pace.window fecha à noite: 3 h de trabalho às 17h numa janela 09-18 terminam na sexta às 11h", () => {
    const start = sp("2026-11-12T17:00:00");
    const result = forecastProject(project(chain(3), { pace: { window: { from: "09:00", to: "18:00" } } }), stats({ agents: { clara: FLAT } }), start);
    expect(result.at).toBe(at(sp("2026-11-13T11:00:00")));
  });

  it("agora fora da janela: espera abrir (sábado 10h numa janela 09-18 começa às 09h de sábado)", () => {
    const end = advanceWork(sp("2026-11-14T07:00:00"), HOUR, { window: { from: "09:00", to: "18:00" } });
    expect(end).toBe(sp("2026-11-14T10:00:00"));
  });

  it("janela que atravessa a meia-noite (22:00-06:00) anda de noite", () => {
    const end = advanceWork(sp("2026-11-12T23:00:00"), 3 * HOUR, { window: { from: "22:00", to: "06:00" } });
    expect(end).toBe(sp("2026-11-13T02:00:00"));
  });

  it("hoursPerDay: 2 h por dia, 5 h de trabalho às 12h de quinta terminam sábado à 02h (descontando o que já trabalhou hoje)", () => {
    const tasks = chain(5);
    const result = forecastProject(project(tasks, { pace: { hoursPerDay: 2 } }), stats({ agents: { clara: FLAT } }), NOW);
    expect(result.at).toBe(at(sp("2026-11-14T01:00:00")));
    const worked = forecastProject(project(tasks, { pace: { hoursPerDay: 2 }, worked: { "2026-11-12": HOUR } }), stats({ agents: { clara: FLAT } }), NOW);
    expect(worked.at).toBe(at(sp("2026-11-14T02:00:00")));
  });

  it("sem ritmo, anda 24 h por dia", () => {
    expect(advanceWork(NOW, 30 * HOUR, undefined)).toBe(NOW + 30 * HOUR);
  });
});

describe("a frase pronta", () => {
  it("'No ritmo atual termina na quinta, 12 (entre quarta e sábado). Prazo: sexta, 13.'", () => {
    const now = sp("2026-11-09T12:00:00");
    const text = forecastSentence({ at: sp("2026-11-12T16:00:00"), low: sp("2026-11-11T10:00:00"), high: sp("2026-11-14T10:00:00"), dueAt: sp("2026-11-13T18:00:00"), now });
    expect(text).toBe("No ritmo atual termina na quinta, 12 (entre quarta e sábado). Prazo: sexta, 13.");
  });
  it("hoje e amanhã dizem a hora; fim em sábado leva 'no'; mês fora do corrente entra se passa de duas semanas", () => {
    expect(forecastSentence({ at: NOW + 3 * HOUR, low: NOW + 2 * HOUR, high: NOW + 4 * HOUR, now: NOW })).toBe("No ritmo atual termina hoje às 15h.");
    expect(forecastSentence({ at: sp("2026-11-13T10:30:00"), low: sp("2026-11-13T09:00:00"), high: sp("2026-11-13T12:00:00"), dueAt: sp("2026-11-13T18:00:00"), now: NOW })).toBe("No ritmo atual termina amanhã às 10h30. Prazo: amanhã às 18h.");
    expect(forecastSentence({ at: sp("2026-11-14T10:00:00"), low: sp("2026-11-14T09:00:00"), high: sp("2026-11-14T12:00:00"), now: NOW })).toBe("No ritmo atual termina no sábado, 14.");
    expect(forecastSentence({ at: sp("2026-12-03T10:00:00"), low: sp("2026-12-03T09:00:00"), high: sp("2026-12-03T12:00:00"), now: NOW })).toBe("No ritmo atual termina na quinta, 3 de dez.");
  });
  it("nada a fazer (todas concluídas)", () => {
    const result = forecastProject(project([leaf("T1", { status: "concluida" })]), stats(), NOW);
    expect(result).toMatchObject({ state: "previsto", remaining: 0, text: "Nada a fazer: todas as tarefas já terminaram." });
  });
});

describe("buildForecastStats: o que vem do histórico", () => {
  const done = (ref: string, agentId: string, finishedAgoH: number, minutes: number, taskId: string): ProjectTask =>
    leaf(ref, { status: "concluida", steps: [{ agentId, what: "x", status: "feita", taskId, startedAt: at(NOW - finishedAgoH * HOUR - minutes * MIN), finishedAt: at(NOW - finishedAgoH * HOUR) }], startedAt: at(NOW - finishedAgoH * HOUR - minutes * MIN), finishedAt: at(NOW - finishedAgoH * HOUR) }, agentId);
  const item = (over: Partial<ForYouItem>): ForYouItem => ({ id: "A-1", agentId: "clara", roomId: "q", type: "post", status: "aprovado", meta: {}, text: "x", originalText: "x", editedByUser: false, createdAt: at(NOW - 5 * HOUR), ...over });
  const base = { forYou: [] as ForYouItem[], dispatch: { maxRunning: 3, perAgent: 1 }, quota: [], agents: [{ id: "clara", name: "Clara", engine: "claude" as const }] };

  it("conta só etapas concluídas nos últimos 28 dias, por agente, e tira a espera do dono de dentro da etapa", () => {
    const tasks = [done("T1", "clara", 2, 60, "x1"), done("T2", "clara", 30 * 24, 60, "x2"), done("T3", "clara", 5, 90, "x3")];
    const forYou = [item({ taskId: "x1", createdAt: at(NOW - 3 * HOUR), decidedAt: at(NOW - 2 * HOUR - 30 * MIN), decidedBy: "usuario" })];
    const result = buildForecastStats({ ...base, projects: [project(tasks)], forYou }, NOW);
    // T1: 60 min de etapa menos 30 min de espera pelo dono = 30 min; T2 fica fora da janela; T3: 90 min.
    expect([...result.stepMs.get("clara")!].sort((a, b) => a - b)).toEqual([30 * MIN, 90 * MIN]);
    expect(result.workspaceMs).toHaveLength(2);
    expect(result.approvalWaits.get("post")).toEqual([30 * MIN]);
    // A média geral usa todas as concluídas de todos os tempos (precisa de 3).
    expect(result.average).toMatchObject({ n: 3 });
  });

  it("cota acima de 90% empurra o agente do motor para a hora em que volta; bloqueio de cota do runtime também", () => {
    const quota = [{ provider: "claude" as const, windows: [{ id: "five_hour", utilization: 0.95, resetsAt: at(NOW + 2 * HOUR) }], updatedAt: at(NOW - MIN), fetchedAt: at(NOW - MIN) }];
    const result = buildForecastStats({ ...base, projects: [], quota }, NOW);
    expect(result.quotaResumeAt.get("clara")).toBe(NOW + 2 * HOUR);
    const low = buildForecastStats({ ...base, projects: [], quota: [{ ...quota[0]!, windows: [{ id: "five_hour", utilization: 0.5, resetsAt: at(NOW + 2 * HOUR) }] }] }, NOW);
    expect(low.quotaResumeAt.size).toBe(0);
    const blocked = buildForecastStats({ ...base, projects: [], engineBlocks: [{ agentId: "clara", block: { reason: "quota", resetsAt: at(NOW + 4 * HOUR) } }] }, NOW);
    expect(blocked.quotaResumeAt.get("clara")).toBe(NOW + 4 * HOUR);
  });
});

describe("forecastAll e o relatório", () => {
  const agents = ["clara", "eco", "beto", "dani", "leo"].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
  const snapshotOf = (history: ReturnType<typeof makeHistory>): MetricsSnapshot => ({ agents, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 }, goals: [] });

  it("a semente de 28 dias tem um projeto atrasado, um apertado e um no prazo; os sem tarefa a fazer ficam de fora e o pior vem primeiro", () => {
    const history = makeHistory({ now: NOW, days: 28, seed: 7, agents, goals: true });
    const forecast = forecastAll(snapshotOf(history), NOW);
    expect(forecast.projects.map((entry) => [entry.title, entry.verdict])).toEqual([
      ["Site novo", "atrasa"],
      ["Lançamento do webinar", "apertado"],
      ["Relatório do mês", "no_prazo"],
    ]);
    expect(forecast.projects.every((entry) => entry.state === "previsto" && entry.low! <= entry.at! && entry.at! <= entry.high!)).toBe(true);
    expect(forecast.text).toBe("3 projeto(s): 1 atrasa, 1 apertado, 1 no prazo");
  });

  it("projeto sem prazo não tem veredito; pausado, de rotina e o Avulsas não entram", () => {
    const open = project(chain(2), { id: "a", title: "Sem prazo" });
    const paused = project(chain(2), { id: "b", title: "Pausado", status: "pausado" });
    const routine = project(chain(2), { id: "c", title: "Rotina", origin: "rotina" });
    const forecast = forecastAll({ agents: [{ id: "clara", name: "Clara" }], projects: [open, paused, routine], forYou: [], dispatch: { maxRunning: 3, perAgent: 1 }, quota: [] }, NOW);
    expect(forecast.projects).toHaveLength(1);
    expect(forecast.projects[0]).toMatchObject({ title: "Sem prazo", state: "sem_previsao" });
    expect(forecast.projects[0]!.verdict).toBeUndefined();
  });

  it("computeMetrics traz forecast e goals; renderMetrics escreve em inglês, com o n e a confiança", () => {
    const history = makeHistory({ now: NOW, days: 28, seed: 7, agents, goals: true });
    const report = computeMetrics(snapshotOf(history), { now: NOW });
    expect(report.forecast.projects).toHaveLength(3);
    const text = renderMetrics(report, { metrics: ["forecast", "goals"] });
    expect(text).toContain("Forecast of open projects");
    expect(text).toMatch(/"Site novo" \(2 tasks left\): ends .* -> late by/);
    expect(text).toMatch(/\(n=\d+, confidence (low|medium|high)\)/);
    expect(text).toContain("Goals this period: nenhuma meta ativa");
    expect(renderMetrics(report, { metrics: ["throughput"] })).not.toContain("Forecast");
  });
});

describe("forecastProject: esperas de OK dentro do calendário (revisão M3)", () => {
  const TEN = [10, 10, 10, 10, 10].map((minutes) => minutes * MIN);
  const ids = ["a", "b", "c", "d", "e", "f"];
  const agentsOf = (list: readonly string[]) => Object.fromEntries(list.map((id) => [id, TEN]));
  const approved = (ref: string, agentId: string, over: Partial<ProjectTask> = {}): ProjectTask => leaf(ref, { approvalType: "post", ...over }, agentId);

  it("6 tarefas independentes de 10 min, todas com OK e 6 agentes: termina em 4 h 10 min (espera em paralelo), não em 24 h", () => {
    const tasks = ids.map((id, i) => approved(`T${i + 1}`, id));
    const result = forecastProject(project(tasks), stats({ agents: agentsOf(ids), dispatch: { maxRunning: 6, perAgent: 1 } }), NOW);
    expect(result.at).toBe(at(NOW + 4 * HOUR + 10 * MIN));
    expect(result.low).toBe(result.at);
    expect(result.high).toBe(result.at);
  });

  it("cadeia de 3 aprovações: as esperas somam ao longo da cadeia (3 x 4 h 10 min)", () => {
    const tasks = [approved("T1", "a"), approved("T2", "b", { dependsOn: ["T1"] }), approved("T3", "c", { dependsOn: ["T2"] })];
    const result = forecastProject(project(tasks), stats({ agents: agentsOf(["a", "b", "c"]) }), NOW);
    expect(result.at).toBe(at(NOW + 12.5 * HOUR));
  });

  it("grafo misto: ramo com 2 OKs em cadeia (8 h 20) e ramo curto com 1 OK em paralelo: manda o ramo longo", () => {
    const tasks = [approved("T1", "a"), approved("T2", "b", { dependsOn: ["T1"] }), approved("T3", "c"), leaf("T4", {}, "d")];
    const result = forecastProject(project(tasks), stats({ agents: agentsOf(["a", "b", "c", "d"]) }), NOW);
    expect(result.at).toBe(at(NOW + 8 * HOUR + 20 * MIN));
  });

  it("a faixa p25-p75 segue coerente: com esperas amostradas, low < at < high", () => {
    const waits = [1, 2, 3, 4, 5].map((hours) => hours * HOUR);
    const tasks = ids.slice(0, 3).map((id, i) => approved(`T${i + 1}`, id));
    const result = forecastProject(project(tasks), stats({ agents: agentsOf(["a", "b", "c"]), approvalWaits: new Map([["post", waits]]) }), NOW);
    expect(Date.parse(result.low!)).toBeLessThan(Date.parse(result.at!));
    expect(Date.parse(result.at!)).toBeLessThan(Date.parse(result.high!));
  });
});
