import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_GESTAO, gestaoSettings, sumDigests, type GestaoOverrides, type MetricsReport, type StoredReport, type TodayView } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeMetrics, deliveriesOf, type MetricsSnapshot } from "../metrics/compute";
import { makeHistory } from "../metrics/fixtures/make-history";
import { buildMonthReport } from "./build";
import { quotaWindowLabel, reportModel } from "./model";
import { dailyDue, latestClosed, monthClosedBy, periodOf, weeklyDue, weeksOfMonth } from "./period";
import { renderReportHtml } from "./render-html";
import { mdText, renderReportMarkdown } from "./render-md";
import { renderReportText } from "./render-text";
import { ReportScheduler } from "./scheduler";
import { ReportService, type ReportDeps } from "./service";
import { ReportStore } from "./store";
import { PlatformReports } from "../../platform/reports/platform-reports";

// Dias e semanas de São Paulo (UTC-3 o ano todo). Nada aqui lê o relógio nem o fuso da máquina.
const sp = (local: string): number => Date.parse(`${local}-03:00`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AGENTS = ["clara", "eco", "beto", "dani", "leo"].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
// Domingo 15/11 à noite: a semana W46 (9 a 15/11) tem dado; a segunda 16/11 08:30 é o horário da revisão.
const HISTORY_NOW = sp("2026-11-15T21:00:00");
const history = makeHistory({ now: HISTORY_NOW, days: 28, seed: 7, agents: AGENTS, goals: true });

const TODAY: TodayView = {
  workspace: "ws",
  day: "2026-11-15",
  now: [],
  projects: [],
  routines: { ran: [], running: [], upcoming: [{ routineId: "R-0900", title: "Comentários", at: "2026-11-15T22:30:00.000Z", label: "19:30", agent: "Clara" }], skipped: [] },
  changes: [],
  goals: [],
  agenda: [{ id: "e1", title: "Reunião com o cliente", start: "2026-11-15T23:00:00.000Z", end: "2026-11-16T00:00:00.000Z", kind: "reuniao" }],
  waiting: { count: 0, oldest: [] },
  waitingForYou: 0,
  done: [],
  at: "2026-11-15T21:00:00.000Z",
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyno-reports-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Harness = { service: ReportService; clock: { now: number }; settings: { own: GestaoOverrides | undefined }; metricsCalls: () => number; ai: ReturnType<typeof vi.fn>; data: { projects: typeof history.projects }; store: ReportStore };

function harness(over: Partial<ReportDeps> = {}, start = sp("2026-11-16T08:30:00")): Harness {
  const clock = { now: start };
  const settings: { own: GestaoOverrides | undefined } = { own: undefined };
  const data = { projects: history.projects };
  const ai = vi.fn(async () => "Semana boa.");
  let calls = 0;
  const snapshot = (): MetricsSnapshot => ({ agents: AGENTS, tasks: history.tasks, projects: data.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } });
  const store = new ReportStore(path.join(dir, "reports"));
  const service = new ReportService({
    workspaceId: "ws",
    workspaceName: () => "Workspace de teste",
    store,
    now: () => new Date(clock.now),
    settings: () => gestaoSettings(settings.own),
    metrics: async (window) => {
      calls += 1;
      return computeMetrics(snapshot(), { now: clock.now, from: window.from, to: window.to, workspace: "ws" });
    },
    deliveries: () => deliveriesOf({ projects: data.projects, routines: history.routines, entries: history.entries }),
    results: () => [{ routineId: "R-0900", periodKey: "2026-W46", target: 3, delivered: 3, outcome: "bateu" }, { routineId: "R-0901", periodKey: "2026-W46", target: 5, delivered: 2, outcome: "nao_bateu" }],
    routineTitle: (id) => (id === "R-0900" ? "Comentários" : id),
    names: () => Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.name])),
    today: () => TODAY,
    nextTasks: () => [{ title: "Escrever o post de sexta", project: "Blog", agent: "Clara" }],
    ai,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...over,
  });
  return { service, clock, settings, metricsCalls: () => calls, ai, data, store };
}

describe("períodos (dia e semana de São Paulo, nunca o fuso da máquina)", () => {
  it("a semana vai da segunda à segunda e o mês é o da quinta-feira de cada semana", () => {
    const week = periodOf("week", "2026-W46")!;
    expect(new Date(week.from).toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(new Date(week.to).toISOString()).toBe("2026-11-16T03:00:00.000Z");
    // Novembro de 2026: quintas 5, 12, 19 e 26 => semanas 45 a 48; a 44 (26/10 a 1/11) é de outubro; a 49 é de dezembro.
    expect(weeksOfMonth("2026-11").map((w) => w.key)).toEqual(["2026-W45", "2026-W46", "2026-W47", "2026-W48"]);
    expect(monthClosedBy(periodOf("week", "2026-W48")!)?.key).toBe("2026-11");
    expect(monthClosedBy(periodOf("week", "2026-W47")!)).toBeUndefined();
    expect(periodOf("week", "2026-W99")).toBeUndefined();
    expect(periodOf("day", "2026-02-30")).toBeUndefined();
  });

  it("o último período fechado: ontem, a semana passada, o mês passado", () => {
    const now = sp("2026-11-16T08:30:00");
    expect(latestClosed("day", now).key).toBe("2026-11-15");
    expect(latestClosed("week", now).key).toBe("2026-W46");
    expect(latestClosed("month", now).key).toBe("2026-10");
    // O mês fecha com a última semana dele: depois da segunda 30/11 já é novembro.
    expect(latestClosed("month", sp("2026-11-30T10:00:00")).key).toBe("2026-11");
  });

  it("o horário do dia: antes da hora vale o de ontem; depois, o de hoje", () => {
    expect(dailyDue("18:30", sp("2026-11-16T18:29:00"))?.period.key).toBe("2026-11-15");
    expect(dailyDue("18:30", sp("2026-11-16T18:30:00"))?.period.key).toBe("2026-11-16");
    expect(dailyDue("25:00", sp("2026-11-16T18:30:00"))).toBeUndefined();
  });

  it("a revisão 'seg 08:30' na segunda fecha a semana que passou; 'sex 17:00' fecha a semana do próprio horário", () => {
    expect(weeklyDue("seg 08:30", sp("2026-11-16T08:29:00"))?.period.key).toBe("2026-W45");
    expect(weeklyDue("seg 08:30", sp("2026-11-16T08:30:00"))?.period.key).toBe("2026-W46");
    expect(weeklyDue("seg 08:30", sp("2026-11-19T10:00:00"))?.period.key).toBe("2026-W46");
    expect(weeklyDue("sex 17:00", sp("2026-11-13T17:00:00"))?.period.key).toBe("2026-W46");
    expect(weeklyDue("sex 17:00", sp("2026-11-13T16:59:00"))?.period.key).toBe("2026-W45");
  });

  it("as configurações: padrão 18:30 e 'seg 08:30', IA desligada; valor inválido guardado volta ao padrão", () => {
    expect(gestaoSettings(undefined)).toEqual(DEFAULT_GESTAO);
    expect(gestaoSettings({ dailyAt: null }).dailyAt).toBeNull();
    expect(gestaoSettings({ dailyAt: "99:99", weekly: "xx" })).toEqual(DEFAULT_GESTAO);
    expect(gestaoSettings({ ai: { weekly: true } }).ai).toEqual({ daily: false, weekly: true });
  });
});

describe("relatório congelado", () => {
  it("o de um período fechado não muda quando os dados mudam depois", async () => {
    const h = harness();
    const first = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    expect(first.report.final).toBe(true);
    expect(first.report.digest.deliveries).toBeGreaterThan(0);
    // Os dados mudam depois: some tudo.
    h.data.projects = [];
    h.clock.now += 3 * DAY;
    const again = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    expect(again.regenerated).toBe(false);
    expect(again.report).toEqual(first.report);
    expect((await h.service.read("week", "2026-W46"))?.digest.deliveries).toBe(first.report.digest.deliveries);
    expect((await h.service.ensure("week", "2026-W46"))?.generatedAt).toBe(first.report.generatedAt);
  });

  it("o parcial (Gerar agora no meio da semana) é refeito; o final, não", async () => {
    const h = harness({}, sp("2026-11-12T12:00:00"));
    const partial = await h.service.generate("week", undefined, { trigger: "manual" });
    expect(partial.report).toMatchObject({ period: "2026-W46", final: false });
    h.clock.now = sp("2026-11-13T12:00:00");
    const again = await h.service.generate("week", undefined, { trigger: "manual" });
    expect(again.regenerated).toBe(true);
    expect(again.report.generatedAt).not.toBe(partial.report.generatedAt);
    h.clock.now = sp("2026-11-16T09:00:00");
    const closed = await h.service.generate("week", "2026-W46", { trigger: "schedule" });
    expect(closed.report.final).toBe(true);
    h.data.projects = [];
    expect((await h.service.generate("week", "2026-W46", { trigger: "manual" })).report.generatedAt).toBe(closed.report.generatedAt);
  });

  it("get_report de um período aberto monta parcial sem gravar; de um fechado, grava", async () => {
    const h = harness({}, sp("2026-11-12T12:00:00"));
    const open = await h.service.ensure("week", "2026-W46");
    expect(open?.final).toBe(false);
    expect(await h.service.read("week", "2026-W46")).toBeUndefined();
    const closed = await h.service.ensure("week", "2026-W45");
    expect(closed?.final).toBe(true);
    expect(await h.service.read("week", "2026-W45")).toBeDefined();
    expect(await h.service.ensure("week", "2026-W99")).toBeUndefined();
  });

  it("'latest': o final guardado de hoje vale mais que o de ontem", async () => {
    const h = harness({}, sp("2026-11-15T18:30:00"));
    await h.service.generate("day", "2026-11-15", { trigger: "schedule", ceremony: true });
    h.clock.now = sp("2026-11-15T20:00:00");
    expect((await h.service.ensure("day", "latest"))?.period).toBe("2026-11-15");
    h.clock.now = sp("2026-11-16T10:00:00");
    expect((await h.service.ensure("day", "latest"))?.period).toBe("2026-11-15");
  });

  it("o dia traz o mesmo dia da semana passada e, gerado dentro do dia, o que vem a seguir", async () => {
    const h = harness({}, sp("2026-11-15T18:30:00"));
    const { report } = await h.service.generate("day", "2026-11-15", { trigger: "schedule", ceremony: true });
    expect(report.final).toBe(true);
    expect(report.sections.live).toBe(true);
    expect(report.sections.compare?.day).toBe("2026-11-08");
    expect(report.sections.next?.routines[0]?.title).toBe("Comentários");
    expect(report.sections.next?.agenda[0]?.title).toBe("Reunião com o cliente");
    expect(report.sections.next?.tasks[0]?.title).toBe("Escrever o post de sexta");
    // Um dia passado pedido depois não finge saber "o que vem a seguir" daquele dia.
    h.clock.now = sp("2026-11-20T10:00:00");
    const old = (await h.service.generate("day", "2026-11-14", { trigger: "mcp" })).report;
    expect(old.sections.live).toBe(false);
    expect(old.sections.next).toBeUndefined();
    expect(reportModel(old).warnings.join(" ")).toContain("Gerado depois do período");
  });
});

describe("agendador: o horário vencido gera uma vez", () => {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const schedulerOf = (h: Harness, weekSettled?: (period: string) => void) => new ReportScheduler({ reports: h.service, settings: () => h.settings.own, now: () => new Date(h.clock.now), log, ...(weekSettled ? { weekSettled } : {}) });

  it("antes da hora não gera; na hora gera o dia e a semana uma vez só (passadas seguintes não refazem a conta)", async () => {
    const h = harness({}, sp("2026-11-16T08:29:00"));
    const scheduler = schedulerOf(h);
    await scheduler.tick();
    // 08:29 de segunda: o último horário devido do dia foi o de ontem, e o da semana, o da segunda passada (a semana 45).
    expect((await h.store.list("day")).map((r) => r.period)).toEqual(["2026-11-15"]);
    expect((await h.store.list("week")).map((r) => r.period)).toEqual(["2026-W45"]);
    h.clock.now = sp("2026-11-16T08:30:00");
    await scheduler.tick();
    expect((await h.store.list("week")).map((r) => r.period)).toEqual(["2026-W46", "2026-W45"]);
    const calls = h.metricsCalls();
    await scheduler.tick();
    await scheduler.tick();
    expect(h.metricsCalls()).toBe(calls);
  });

  it("a retrospectiva sai junto da revisão da semana, uma vez, com o período da semana fechada (e uma falha dela não derruba a revisão)", async () => {
    const h = harness({}, sp("2026-11-16T08:30:00"));
    const generate = vi.fn(async () => undefined);
    const scheduler = new ReportScheduler({ reports: h.service, settings: () => h.settings.own, now: () => new Date(h.clock.now), log, retro: { generate } });
    await scheduler.tick();
    await scheduler.tick();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("schedule", "2026-W46");
    expect((await h.store.list("week")).map((r) => r.period)).toContain("2026-W46");

    // Se a retrospectiva falhar, a revisão da semana continua guardada.
    const broken = harness({}, sp("2026-11-16T08:30:00"));
    const failing = new ReportScheduler({ reports: broken.service, settings: () => broken.settings.own, now: () => new Date(broken.clock.now), log, retro: { generate: async () => Promise.reject(new Error("falhou")) } });
    await failing.tick();
    expect((await broken.store.list("week")).map((r) => r.period)).toContain("2026-W46");
  });

  it("reiniciar o servidor não gera de novo (o arquivo final é a marca)", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    await schedulerOf(h).tick();
    const before = (await h.store.list("week")).find((r) => r.period === "2026-W46")!;
    const calls = h.metricsCalls();
    await schedulerOf(h).tick();
    expect(h.metricsCalls()).toBe(calls);
    expect((await h.store.list("week")).find((r) => r.period === "2026-W46")?.generatedAt).toBe(before.generatedAt);
  });

  it("servidor desligado por vários dias: ao voltar tenta só o ÚLTIMO período devido, sem fila de atrasados", async () => {
    const h = harness({}, sp("2026-11-18T07:00:00"));
    await schedulerOf(h).tick();
    // 07:00 de quarta: o último horário do dia foi o de terça (17/11, sem movimento nos dados: não vira relatório) e o da semana o de
    // segunda (16/11, que fecha a W46). Só isso foi calculado: 2 contas do dia (o dia e o mesmo dia da semana passada) e 1 da semana.
    expect((await h.store.list("day")).map((r) => r.period)).toEqual([]);
    expect((await h.store.list("week")).map((r) => r.period)).toEqual(["2026-W46"]);
    expect(h.metricsCalls()).toBe(3);
    // Num dia com movimento, o último devido é gerado (e só ele).
    const busy = harness({}, sp("2026-11-16T07:00:00"));
    await schedulerOf(busy).tick();
    expect((await busy.store.list("day")).map((r) => r.period)).toEqual(["2026-11-15"]);
  });

  it("dailyAt nulo: o dia não gera sozinho; a semana continua", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    h.settings.own = { dailyAt: null };
    await schedulerOf(h).tick();
    expect(await h.store.list("day")).toEqual([]);
    expect((await h.store.list("week")).length).toBe(1);
  });

  it("período sem movimento nenhum não vira relatório (e a semana é dada como resolvida)", async () => {
    const h = harness({}, sp("2026-12-07T09:00:00"));
    const settled = vi.fn();
    await schedulerOf(h, settled).tick();
    expect(await h.store.list("week")).toEqual([]);
    expect(settled).toHaveBeenCalledWith("2026-W49");
  });

  it("a última semana do mês também fecha o mensal, somando as semanas guardadas", async () => {
    const h = harness({}, sp("2026-11-30T08:30:00"));
    // Semanas 45 e 46 já guardadas (as 47 e 48 não: o mês diz de quantas saiu).
    await h.service.generate("week", "2026-W45", { trigger: "manual" });
    await h.service.generate("week", "2026-W46", { trigger: "manual" });
    await schedulerOf(h).tick();
    const month = await h.service.read("month", "2026-11");
    expect(month).toBeDefined();
    expect(month!.weeks!.map((w) => w.period)).toEqual(["2026-W45", "2026-W46"]);
    expect(month!.missing).toEqual(["2026-W47", "2026-W48"]);
  });

  it("o relógio da passada não deixa duas passadas correrem juntas", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    const scheduler = schedulerOf(h);
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect((await h.store.list("week")).filter((r) => r.period === "2026-W46")).toHaveLength(1);
  });
});

describe("retenção: o dia fica 90 dias; semana e mês não se apagam", () => {
  it("apaga só os resumos do dia com mais de 90 dias", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    const base = (await h.service.generate("week", "2026-W46", { trigger: "manual" })).report;
    const day = (key: string): StoredReport => ({ ...base, kind: "day", period: key });
    await h.store.write(day("2026-08-17"));
    await h.store.write(day("2026-08-18"));
    await h.store.write(day("2026-11-15"));
    await h.store.write({ ...base, period: "2025-W01" });
    const removed = await h.store.pruneDays(h.clock.now);
    expect(removed).toBe(1);
    expect((await h.store.list("day")).map((r) => r.period)).toEqual(["2026-11-15", "2026-08-18"]);
    expect((await h.store.list("week")).map((r) => r.period)).toContain("2025-W01");
  });

  it("arquivo ilegível ou nome estranho é ignorado, e chave com barra é recusada", async () => {
    const h = harness();
    await mkdir(path.join(dir, "reports", "week"), { recursive: true });
    await writeFile(path.join(dir, "reports", "week", "2026-W01.json"), "{ não é json");
    await writeFile(path.join(dir, "reports", "week", "lixo.json"), "{}");
    expect(await h.store.list("week")).toEqual([]);
    await expect(h.store.read("week", "../../etc")).rejects.toThrow();
    expect(await readdir(path.join(dir, "reports", "week"))).toContain("2026-W01.json");
  });
});

describe("o Markdown de um relatório de referência", () => {
  it("revisão da semana W46, do histórico fabricado (semente 7), com o parágrafo de IA", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const markdown = renderReportMarkdown({ ...report, ai: { text: "A semana foi mais forte que a passada.", at: report.generatedAt, by: "Maestro" } });
    expect(markdown).toMatchSnapshot();
    // O dólar é sempre equivalente, nunca "gasto do mês" solto.
    expect(markdown).toContain("equivalente");
    expect(markdown).not.toMatch(/gasto do m[eê]s/i);
  });

  it("o texto do MCP (inglês) cita o n, diz 'equivalent' e que está congelado", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const text = renderReportText(report);
    expect(text).toContain("Closed and frozen");
    expect(text).toMatch(/equivalent/);
    expect(text).toMatch(/\(n=\d+/);
    expect(text).toContain("do not recompute");
  });
});

const external = /https?:\/\/|<script|@import|<link|<img|<iframe|<object|<embed|url\s*\(|src\s*=|xlink:href|\son\w+\s*=/i;

/** A semana W46 do histórico esvaziada: nenhuma entrega, nenhuma amostra, nenhum gasto. */
function quietWeek(report: StoredReport): StoredReport {
  const copy = structuredClone(report);
  const metrics = copy.metrics!;
  for (const key of ["throughput", "cycleTime", "approvalWait", "rejectionRate", "rework", "editRate", "failureRate", "costPerDelivery"] as const) {
    Object.assign(metrics[key], { n: 0, prevN: 0, value: null, prev: null, hits: 0 });
  }
  metrics.throughput.weeks = metrics.throughput.weeks.map((week) => ({ ...week, count: 0, avg4: 0 }));
  metrics.spend = { usd: 0, prevUsd: 0 };
  copy.digest = { ...copy.digest, deliveries: 0, spendUsd: 0, costPerDelivery: null };
  copy.sections = { ...copy.sections, agents: [], otherDeliveries: [] };
  return copy;
}

type Win = NonNullable<StoredReport["metrics"]>["quota"]["windows"][number];
const win = (provider: string, id: string, label: string, percent: number, text: string): Win => ({ provider, id, label, state: "value", percent, resetsAt: "2026-11-15T20:00:00.003Z", text, pace: null, warn: false });

describe("o relatório de uma semana quieta lê como página curta e calma", () => {
  it("sem entregas: o gráfico vira uma frase, a tabela só tem linhas com valor e as seções vazias viram uma linha apagada", async () => {
    const h = harness();
    const report = quietWeek((await h.service.generate("week", "2026-W46", { trigger: "manual" })).report);
    const model = reportModel(report);
    expect(model.series).toBeUndefined();
    expect(model.seriesNote?.text).toContain("Nenhuma entrega nas últimas");
    expect(model.compare.every((row) => row.now !== "—" || row.prev !== "—")).toBe(true);
    expect(model.compare.map((row) => row.label)).not.toContain("Entregas");
    const html = renderReportHtml(report);
    expect(html).not.toContain("<svg");
    expect(html).toContain("ainda não há série para desenhar");
    expect(html).toContain('class="quiet"');
    expect(html).not.toMatch(/<h2>O que cada agente fez<\/h2>/);
    expect(html).not.toContain("sem amostras");
    expect(html).not.toMatch(external);
    expect(html).not.toMatch(/<h2>Entregas por semana/);
  });

  it("nenhuma linha com valor: a tabela some e entra a frase pedida", async () => {
    const h = harness();
    const report = quietWeek((await h.service.generate("week", "2026-W46", { trigger: "manual" })).report);
    const model = reportModel(report);
    expect(model.compare).toEqual([]);
    expect(model.compareNote).toBe("Sem entregas nesta semana: ainda não há o que comparar.");
    const html = renderReportHtml(report);
    expect(html).toContain("Sem entregas nesta semana: ainda não há o que comparar.");
    expect(html).not.toContain("<th>Indicador</th>");
    expect(renderReportMarkdown(report)).toContain("Sem entregas nesta semana");
  });

  it("com entregas o gráfico e a tabela continuam como antes", async () => {
    const h = harness();
    const report = (await h.service.generate("week", "2026-W46", { trigger: "manual" })).report;
    const model = reportModel(report);
    expect(model.series).toBeDefined();
    expect(model.seriesNote).toBeUndefined();
    expect(renderReportHtml(report)).toContain("<svg");
  });
});

describe("a cota do relatório", () => {
  const windows: Win[] = [
    win("Claude", "five_hour", "5 h", 2, "Claude Code: 5 h em 2%, volta às 19:00"),
    win("Claude", "seven_day", "semana", 64, "Claude Code: semana em 64%, volta às 15/11 17:00"),
    win("Claude", "seven_day_fable", "seven_day_fable", 52, "Claude Code: seven_day_fable em 52%, volta às 15/11 17:00"),
    win("Antigravity", "five_hour", "Sessão 5h", 4, "Antigravity: Sessão 5h em 4%, volta às 15:17"),
    win("Antigravity", "seven_day", "Semana", 20, "Antigravity: Semana em 20%, volta às 15/11 01:28"),
    win("Antigravity", "five_hour_claude_gpt", "Sessão 5h", 0, "Antigravity: Sessão 5h em 0%, volta às 19:04"),
    win("Antigravity", "seven_day_claude_gpt", "Semana", 0, "Antigravity: Semana em 0%, volta às 20/11 14:04"),
    win("Antigravity", "seven_day_gemini_4_argon", "Semana", 0, "Antigravity: Semana em 0%, volta às 20/11 14:04"),
    win("Freebuff", "daily_hours", "Horas do dia", 0, "Freebuff: Horas do dia em 0%, volta às 00:01"),
  ];
  const withQuota = async (list: Win[]): Promise<StoredReport> => {
    const h = harness();
    const report = structuredClone((await h.service.generate("week", "2026-W46", { trigger: "manual" })).report);
    report.metrics!.quota = { windows: list, blocked: [] };
    return report;
  };

  it("agrupa por motor, com nome de gente, o maior uso primeiro, sem id cru e sem janela parada em 0%", async () => {
    const report = await withQuota(windows);
    const quota = reportModel(report).cost.quota;
    expect(quota.engines.map((engine) => engine.name)).toEqual(["Claude Code", "Antigravity"]);
    expect(quota.engines[0]!.rows.map((row) => `${row.label} ${row.percent}`)).toEqual(["Semana 64", "Semana · Fable 52", "Sessão 5h 2"]);
    expect(quota.engines[1]!.rows.map((row) => row.label)).toEqual(["Modelos Gemini · Semana", "Modelos Gemini · Sessão 5h"]);
    expect(quota.idle).toContain("Antigravity (Claude e GPT, Gemini 4 Argon)");
    expect(quota.idle).toContain("Freebuff");
    const html = renderReportHtml(report);
    expect(html).not.toMatch(/seven_day|five_hour|daily_hours/);
    expect(html).not.toMatch(/Cota: /);
    expect(html).toContain("Semana · Fable");
    expect(html).not.toMatch(external);
    const md = renderReportMarkdown(report);
    expect(md).not.toMatch(/seven_day|five_hour/);
    expect(md).toContain("Claude Code: Semana 64%");
  });

  it("mesma janela repetida aparece uma vez; tudo em 0% mostra tudo", async () => {
    const dup = win("Antigravity", "seven_day_claude_gpt", "Semana", 0, "Antigravity: Semana em 0%, volta às 20/11 14:04");
    const report = await withQuota([dup, { ...dup }, win("Freebuff", "daily_hours", "Horas do dia", 0, "Freebuff: Horas do dia em 0%, volta às 00:01")]);
    const quota = reportModel(report).cost.quota;
    expect(quota.engines.flatMap((engine) => engine.rows.map((row) => row.label))).toEqual(["Claude e GPT · Semana", "Horas do dia"]);
    expect(quota.idle).toBe("");
  });

  it("o aviso de cota alta usa o nome de gente", async () => {
    const report = await withQuota([win("Claude", "seven_day_fable", "seven_day_fable", 91, "Claude Code: seven_day_fable em 91%, volta às 15/11 17:00")]);
    const lines = reportModel(report).attention.find((block) => block.title === "Cota acima de 85%")!.lines;
    expect(lines).toEqual(["Claude Code: Semana · Fable em 91%, volta às 15/11 17:00"]);
  });

  it("rótulos: ids de escopo viram texto, rótulo pronto da fonte é mantido", () => {
    expect(quotaWindowLabel({ id: "seven_day_fable", label: "seven_day_fable" })).toBe("Semana · Fable");
    expect(quotaWindowLabel({ id: "seven_day_opus", label: "semana (Opus)" })).toBe("Semana · Opus");
    expect(quotaWindowLabel({ id: "daily_hours", label: "Horas do dia" })).toBe("Horas do dia");
    expect(quotaWindowLabel({ id: "weird_window", label: "weird_window" })).toBe("Weird Window");
  });
});

describe("o HTML é uma página só, sem rede", () => {
  it("não tem pedido externo nenhum, nem script, nem fonte, nem imagem (semana, dia e mês)", async () => {
    const h = harness({}, sp("2026-11-30T08:30:00"));
    const week = (await h.service.generate("week", "2026-W46", { trigger: "manual" })).report;
    const day = (await h.service.generate("day", "2026-11-14", { trigger: "manual" })).report;
    const month = (await h.service.generate("month", "2026-11", { trigger: "manual" })).report;
    for (const report of [week, day, month]) {
      const html = renderReportHtml(report);
      expect(html).not.toMatch(external);
      expect(html).toContain("@media print");
      expect(html).toContain("@page");
      expect(html.startsWith("<!doctype html>")).toBe(true);
    }
  });

  it("escapa o que vem dos dados (título com HTML não vira marcação) e só vira link com a origem do app", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const evil: StoredReport = {
      ...report,
      workspaceName: '<img src=x onerror=alert(1)>',
      sections: { ...report.sections, agents: [{ agentId: "a", name: "<b>Ana</b>", count: 1, deliveries: [{ title: '"><script>alert(1)</script>', at: report.from, kind: "projeto", projectId: "p1", ref: "T1" }] }] },
    };
    const plain = renderReportHtml(evil);
    expect(plain).not.toContain("<script");
    expect(plain).not.toContain("<img");
    expect(plain).not.toMatch(/\sonerror\s*=(?![^<]*&)/);
    expect(plain).not.toContain("href=");
    const linked = renderReportHtml(evil, { linkBase: "https://app.exemplo.com/" });
    expect(linked).toContain('href="https://app.exemplo.com/#/ws/trabalho/tarefas/p1/T1"');
    expect(linked).not.toContain("<script");
    // Origem que não é só `http(s)://host` não vira link.
    expect(renderReportHtml(evil, { linkBase: 'javascript:alert(1)' })).not.toContain("href=");
  });

  it("tem SVG de barras com a semana tracejada e a média de 4 semanas", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const html = renderReportHtml(report);
    expect(html).toContain("<svg");
    expect(html).toContain('class="bar cur"');
    expect(html).toContain("média de 4 semanas");
  });
});

describe("o relatório não mostra o tamanho da amostra (n=) ao dono", () => {
  it("HTML e Markdown de dia, semana e mês não têm 'n='", async () => {
    const h = harness();
    for (const [kind, key] of [["day", "2026-11-14"], ["week", "2026-W46"], ["month", "2026-11"]] as const) {
      const { report } = await h.service.generate(kind, key, { trigger: "manual" });
      expect(renderReportHtml(report), `${kind} html`).not.toMatch(/\bn=\d/);
      expect(renderReportMarkdown(report), `${kind} md`).not.toMatch(/\bn=\d/);
      const m = reportModel(report);
      expect(JSON.stringify([m.kpis, m.compare]), `${kind} model`).not.toMatch(/\bn=\d/);
    }
  });

  it("poucos dados aparece sem contagem, e o valor da tabela não quebra de linha", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const few = { ...report, metrics: { ...report.metrics!, cycleTime: { ...report.metrics!.cycleTime, n: 3, fewData: true, trend: undefined } } };
    const model = reportModel(few);
    expect(model.kpis.find((k) => k.label === "Tempo até entregar")!.sub).toMatch(/poucos dados$/);
    expect(model.compare.find((r) => r.label.startsWith("Tempo até entregar"))!.note).toBe("poucos dados");
    expect(renderReportHtml(report)).toContain("td.num{white-space:nowrap}");
  });
});

describe("seta só com 5 ou mais amostras nos dois períodos", () => {
  const metricsOf = async (): Promise<{ report: StoredReport; metrics: MetricsReport }> => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    return { report, metrics: report.metrics! };
  };
  const withThroughput = (report: StoredReport, patch: Partial<MetricsReport["throughput"]>): StoredReport => ({ ...report, metrics: { ...report.metrics!, throughput: { ...report.metrics!.throughput, ...patch } } });

  it("8 contra 5 sobe; 4 contra 8 não tem seta e diz 'poucos dados'", async () => {
    const { report } = await metricsOf();
    const up = reportModel(withThroughput(report, { value: 8, n: 8, prev: 5, prevN: 5, fewData: false, trend: "up" }));
    expect(up.compare.find((row) => row.label === "Entregas")).toMatchObject({ now: "8", prev: "5", arrow: "up" });
    const few = reportModel(withThroughput(report, { value: 4, n: 4, prev: 8, prevN: 8, fewData: true, trend: undefined, note: "poucos dados" }));
    const row = few.compare.find((entry) => entry.label === "Entregas")!;
    expect(row.arrow).toBeUndefined();
    expect(row.note).toBe("poucos dados");
    expect(renderReportMarkdown(withThroughput(report, { value: 4, n: 4, prev: 8, prevN: 8, fewData: true, trend: undefined }))).toContain("| Entregas | 4 | 8 | — | poucos dados |");
  });

  it("no relatório real, toda seta tem n >= 5 dos dois lados", async () => {
    const { report, metrics } = await metricsOf();
    const m = metrics;
    const pairs: [string, { n: number; prevN: number }][] = [
      ["Entregas", m.throughput],
      ["Tempo até entregar (mediana)", m.cycleTime],
      ["Espera pelo seu OK (mediana)", m.approvalWait],
      ["Recusado por você", m.rejectionRate],
      ["Refeito a pedido", m.rework],
      ["Você editou o texto", m.editRate],
      ["Falhas das tarefas", m.failureRate],
      ["Custo por entrega (rateado, equivalente)", m.costPerDelivery],
    ];
    const rows = reportModel(report).compare;
    for (const [label, metric] of pairs) {
      const row = rows.find((entry) => entry.label === label)!;
      if (row.arrow) expect(Math.min(metric.n, metric.prevN)).toBeGreaterThanOrEqual(5);
    }
  });

  it("o dia só põe seta contra o mesmo dia da semana passada com 5 entregas dos dois lados", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    const { report } = await h.service.generate("day", "2026-11-14", { trigger: "manual" });
    const bump = (deliveries: number, before: number): StoredReport => ({ ...report, digest: { ...report.digest, deliveries }, sections: { ...report.sections, compare: { day: "2026-11-07", deliveries: before, spendUsd: 0 } } });
    expect(reportModel(bump(7, 5)).compare[0]!.arrow).toBe("up");
    expect(reportModel(bump(7, 4)).compare[0]!.arrow).toBeUndefined();
    expect(reportModel(bump(3, 9)).compare[0]!.arrow).toBeUndefined();
  });
});

describe("mensal: a soma das semanas guardadas", () => {
  it("soma entregas, gasto e taxas (hits/n); as semanas que faltam ficam em `missing`", async () => {
    const h = harness({}, sp("2026-12-01T09:00:00"));
    const w45 = (await h.service.generate("week", "2026-W45", { trigger: "manual" })).report;
    const w46 = (await h.service.generate("week", "2026-W46", { trigger: "manual" })).report;
    const month = buildMonthReport({ period: periodOf("month", "2026-11")!, now: h.clock.now, workspace: "ws", workspaceName: "W", final: true, trigger: "manual", weeks: [w45, w46], expected: weeksOfMonth("2026-11"), names: {} });
    expect(month.digest.deliveries).toBe(w45.digest.deliveries + w46.digest.deliveries);
    expect(month.digest.spendUsd).toBeCloseTo(w45.digest.spendUsd + w46.digest.spendUsd, 8);
    expect(month.digest.rejection).toEqual({ hits: w45.digest.rejection.hits + w46.digest.rejection.hits, n: w45.digest.rejection.n + w46.digest.rejection.n });
    expect(month.digest).toEqual(sumDigests([w45.digest, w46.digest]));
    expect(month.missing).toEqual(["2026-W47", "2026-W48"]);
    const model = reportModel(month);
    expect(model.warnings.join(" ")).toContain("Faltam 2 semanas guardadas");
    expect(model.weeks).toHaveLength(2);
    expect(renderReportMarkdown(month)).toContain("## Semanas guardadas");
    // O agente que mais entregou no mês soma as semanas.
    const total = month.sections.agents.reduce((sum, agent) => sum + agent.count, 0);
    expect(total).toBe(w45.sections.agents.reduce((sum, agent) => sum + agent.count, 0) + w46.sections.agents.reduce((sum, agent) => sum + agent.count, 0));
  });

  it("o mensal gerado pelo serviço lê só semanas finais (parcial não entra)", async () => {
    const h = harness({}, sp("2026-11-12T12:00:00"));
    await h.service.generate("week", undefined, { trigger: "manual" });
    h.clock.now = sp("2026-12-01T09:00:00");
    const month = (await h.service.generate("month", "2026-11", { trigger: "manual" })).report;
    expect(month.weeks).toEqual([]);
    expect(month.missing).toHaveLength(4);
  });
});

describe("o parágrafo de IA", () => {
  it("com as chaves desligadas (o padrão) nada é pedido ao Maestro, nem na hora marcada nem na mão", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    const scheduler = new ReportScheduler({ reports: h.service, settings: () => h.settings.own, now: () => new Date(h.clock.now), log: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    await scheduler.tick();
    await h.service.generate("week", "2026-W45", { trigger: "manual" });
    await h.service.generate("day", "2026-11-14", { trigger: "manual" });
    await h.service.generate("month", "2026-11", { trigger: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.ai).not.toHaveBeenCalled();
    expect((await h.service.read("week", "2026-W46"))?.ai).toBeUndefined();
  });

  it("com ai.weekly ligada: pede um parágrafo só da semana final, grava e não mexe nos números", async () => {
    const h = harness({}, sp("2026-11-16T09:00:00"));
    h.settings.own = { ai: { weekly: true } };
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    await vi.waitFor(async () => expect((await h.service.read("week", "2026-W46"))?.ai?.text).toBe("Semana boa."));
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.ai.mock.calls[0]![0]).toMatchObject({ kind: "week", period: "2026-W46" });
    expect(h.ai.mock.calls[0]![0].markdown).toContain("# Revisão da semana");
    const stored = (await h.service.read("week", "2026-W46"))!;
    expect({ ...stored, ai: undefined }).toEqual({ ...report, ai: undefined });
    // O dia continua sem IA (ai.daily desligada) e a parcial da semana também não gasta.
    await h.service.generate("day", "2026-11-14", { trigger: "manual" });
    h.clock.now = sp("2026-11-18T12:00:00");
    await h.service.generate("week", undefined, { trigger: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.ai).toHaveBeenCalledTimes(1);
  });

  it("sem resposta do Maestro, o relatório fica só com os números", async () => {
    const h = harness({ ai: async () => undefined });
    h.settings.own = { ai: { weekly: true } };
    await h.service.generate("week", "2026-W46", { trigger: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await h.service.read("week", "2026-W46"))?.ai).toBeUndefined();
  });
});

describe("semana da plataforma: gerada depois que o último workspace fecha a semana", () => {
  it("no boot, o primeiro workspace resolver antes de o segundo abrir não fecha a semana sem ele", async () => {
    const a = harness();
    const dirPlatform = path.join(dir, "platform-reports-boot");
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    // O segundo workspace ainda não abriu (não está em `workspaces()`), mas já está cadastrado (`expected`).
    const platform = new PlatformReports({ dir: dirPlatform, workspaces: () => [{ id: "a", name: "A", reports: a.service }], expected: () => ["a", "b"], now: () => new Date(a.clock.now), log });
    platform.settled("a", "2026-W46");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await platform.read("2026-W46")).toBeUndefined();
    platform.settled("b", "2026-W46");
    await vi.waitFor(async () => expect(await platform.read("2026-W46")).toBeDefined());
  });

  it("só gera quando todos resolveram; soma os workspaces, grava uma vez e não muda depois", async () => {
    const a = harness();
    const b = harness({ workspaceId: "outro", workspaceName: () => "Outro" });
    const dirPlatform = path.join(dir, "platform-reports");
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const platform = new PlatformReports({ dir: dirPlatform, workspaces: () => [{ id: "a", name: "A", reports: a.service }, { id: "b", name: "B", reports: b.service }], now: () => new Date(a.clock.now), log });
    platform.settled("a", "2026-W46");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await platform.read("2026-W46")).toBeUndefined();
    platform.settled("b", "2026-W46");
    await vi.waitFor(async () => expect(await platform.read("2026-W46")).toBeDefined());
    const report = (await platform.read("2026-W46"))!;
    const week = (await a.service.weekFor("2026-W46"))!;
    expect(report.workspaces.map((block) => block.workspace)).toEqual(["a", "b"]);
    expect(report.total.deliveries).toBe(week.digest.deliveries * 2);
    expect(report.total).toEqual(sumDigests([week.digest, week.digest]));
    expect(report.workspaces[0]!.bestAgent).toBe(week.sections.agents[0]!.name);
    // Congelada: mexer nos dados depois não muda; pedir "latest" lê a guardada.
    a.data.projects = [];
    b.data.projects = [];
    expect((await platform.ensure("2026-W46"))?.generatedAt).toBe(report.generatedAt);
    expect((await platform.ensure("latest"))?.period).toBe("2026-W46");
    expect(await platform.ensure("2026-W99")).toBeUndefined();
  });
});

describe("agendador: falha não fecha a semana (revisão L8)", () => {
  it("só avisa a plataforma depois de gerar; a falha é registrada e tentada de novo com espera, sem repetir a cada minuto", async () => {
    const errors: unknown[] = [];
    const log = { info: () => undefined, warn: () => undefined, error: (entry: unknown) => errors.push(entry) };
    const control = { broken: true, calls: 0 };
    const h = harness({
      metrics: async (window) => {
        control.calls += 1;
        if (control.broken) throw new Error("disco cheio");
        return computeMetrics({ agents: AGENTS, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } }, { now: sp("2026-11-16T08:30:00"), from: window.from, to: window.to, workspace: "ws" });
      },
    }, sp("2026-11-16T08:30:00"));
    const settled: string[] = [];
    const scheduler = new ReportScheduler({ reports: h.service, settings: () => h.settings.own, now: () => new Date(h.clock.now), log, weekSettled: (period) => settled.push(period) });

    await scheduler.tick();
    expect(settled).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(await h.store.list("week")).toEqual([]);

    // Um minuto depois ainda está na espera: nem tenta (sem enxurrada).
    const callsAfterFirst = control.calls;
    h.clock.now += 60_000;
    await scheduler.tick();
    expect(control.calls).toBe(callsAfterFirst);
    expect(settled).toEqual([]);

    // Passada a espera e consertado o problema: gera, avisa a plataforma uma vez e não refaz.
    control.broken = false;
    h.clock.now += 5 * 60_000;
    await scheduler.tick();
    expect(new Set(settled)).toEqual(new Set(["2026-W46"]));
    expect((await h.store.list("week")).map((r) => r.period)).toContain("2026-W46");
    const calls = control.calls;
    await scheduler.tick();
    expect(control.calls).toBe(calls);
  });

  it("semana sem movimento conta como resolvida (não é falha)", async () => {
    const h = harness({}, sp("2026-11-23T09:00:00")); // W47 sem dado no histórico
    const settled: string[] = [];
    const scheduler = new ReportScheduler({ reports: h.service, settings: () => h.settings.own, now: () => new Date(h.clock.now), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, weekSettled: (period) => settled.push(period) });
    await scheduler.tick();
    expect(settled).toEqual(["2026-W47"]);
  });
});

describe("relatório final nunca é trocado por parcial (revisão M4)", () => {
  it("a corrida: 'Gerar agora' parcial preso no cálculo, a cerimônia final conclui, o parcial termina por último; o disco fica final", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const h = harness({
      metrics: async (window) => {
        if (first) {
          first = false;
          await gate;
        }
        return computeMetrics({ agents: AGENTS, tasks: history.tasks, projects: history.projects, forYou: history.forYou, usage: history.usage, routines: history.routines, entries: history.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } }, { now: sp("2026-11-12T18:30:00"), from: window.from, to: window.to, workspace: "ws" });
      },
    }, sp("2026-11-12T18:30:00"));
    const partial = h.service.generate("day", "2026-11-12", { trigger: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ceremony = await h.service.generate("day", "2026-11-12", { trigger: "schedule", ceremony: true });
    expect(ceremony.report.final).toBe(true);
    release();
    const late = await partial;
    const onDisk = await h.store.read("day", "2026-11-12");
    expect(onDisk?.final).toBe(true);
    expect(onDisk?.trigger).toBe("schedule");
    expect(late.report.final).toBe(true); // quem pediu recebe o final guardado
  });

  it("o store recusa trocar final por parcial e refazer o conteúdo, mas aceita o parágrafo de IA", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    expect(report.final).toBe(true);
    expect(await h.store.write({ ...report, final: false })).toBe(false);
    expect(await h.store.write({ ...report, trigger: "manual", digest: { ...report.digest, deliveries: report.digest.deliveries + 1 } })).toBe(false);
    expect((await h.store.read("week", "2026-W46"))?.digest.deliveries).toBe(report.digest.deliveries);
    expect(await h.store.write({ ...report, ai: { text: "Semana boa.", at: report.from, by: "Maestro" } })).toBe(true);
    expect((await h.store.read("week", "2026-W46"))?.ai?.text).toBe("Semana boa.");
    // Um parcial pode ser trocado por outro parcial, e por um final.
    const partial = await h.service.generate("day", "2026-11-16", { trigger: "manual" });
    expect(partial.report.final).toBe(false);
    expect(await h.store.write({ ...partial.report, generatedAt: report.from })).toBe(true);
  });
});

describe("texto dos dados no Markdown e links só http(s) (revisão L6 e L7)", () => {
  const hostile = "Post\n## injetado\n> citação\n- item [clique](javascript:alert(1)) <script>alert(2)</script> `código`";

  async function weekWith(deliveries: { title: string; url?: string }[]): Promise<StoredReport> {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const sections = report.sections!;
    const agent = sections.agents[0]!;
    const { projectId: _p, ref: _r, ...base } = agent.deliveries[0]!;
    return { ...report, sections: { ...sections, agents: [{ ...agent, name: "Clara\n# Título falso", count: deliveries.length, deliveries: deliveries.map((delivery) => ({ ...base, ...delivery })) }, ...sections.agents.slice(1)] } };
  }

  it("título de tarefa e nome de agente não criam título, citação, lista, link nem HTML; a linha continua uma só", async () => {
    const md = renderReportMarkdown(await weekWith([{ title: hostile }]));
    const lines = md.split("\n");
    expect(lines.filter((line) => /^#{1,6} (injetado|Título falso)/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^> /.test(line) && line.includes("citação"))).toEqual([]);
    expect(md).not.toMatch(/(^|[^\\])</); // todo "<" dos dados vem com a barra de escape
    expect(md).not.toContain("](javascript");
    expect(md).not.toMatch(/(^|[^\\])\[clique\]/);
    expect(md).not.toMatch(/(^|[^\\])`código`/);
    // Tudo do título ficou na mesma linha do item.
    const item = lines.find((line) => line.includes("injetado"))!;
    expect(item).toContain("injetado");
    expect(item).toContain("citação");
  });

  it("pontuação comum continua legível: sem barra de escape em vírgula, ponto, dois-pontos, parênteses e aspas", () => {
    expect(mdText('Resposta ao comentário: "ok", (rascunho) - 50% pronto.')).toBe('Resposta ao comentário: "ok", (rascunho) - 50% pronto.');
    expect(mdText("# título")).toBe("\\# título");
    expect(mdText("- lista")).toBe("\\- lista");
    expect(mdText("1. um")).toBe("\\1. um");
    expect(mdText("a\r\nb")).toBe("a b");
  });

  it("link do relatório: só http(s) vira link, no Markdown e no HTML; javascript:, data: e file: ficam como texto", async () => {
    const report = await weekWith([
      { title: "Bom", url: "https://exemplo.com/post/1" },
      { title: "Ruim 1", url: "javascript:alert(1)" },
      { title: "Ruim 2", url: "data:text/html,<b>x</b>" },
      { title: "Ruim 3", url: "file:///etc/passwd" },
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("[Bom](https://exemplo.com/post/1)");
    for (const bad of ["javascript:alert", "data:text", "file:///"]) expect(md).not.toMatch(new RegExp(`\\]\\(${bad}`));
    expect(md).toContain("Ruim 1");
    const html = renderReportHtml(report, { linkBase: "https://app.exemplo.com" });
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toContain("https://exemplo.com/post/1");
    expect(hrefs.filter((href) => !/^https?:\/\//.test(href!))).toEqual([]);
    expect(html).toContain("javascript:alert(1)"); // aparece, mas como texto escapado, não como endereço
  });
});

describe("durações no HTML não quebram entre número e unidade (revisão L9)", () => {
  it("'2 h 58 min' fica junto nas células da tabela, nos cartões e nas linhas", async () => {
    const h = harness();
    const { report } = await h.service.generate("week", "2026-W46", { trigger: "manual" });
    const html = renderReportHtml(report);
    const body = html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(body).toMatch(/\d&nbsp;(h|min|d)\b/);
    // Nenhuma duração em texto ("2 h 58 min", "32 min", "1 d 11 h") sobra com espaço comum entre o número e a unidade.
    const text = body.replace(/<[^>]+>/g, "|");
    expect(text).not.toMatch(/\d (d|h|min)\b/);
  });
});
