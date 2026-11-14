import { describe, expect, it } from "vitest";
import {
  buildDayStats,
  buildPlatformDayStats,
  CLOCK_STATES,
  compareDays,
  dayKeyOf,
  dayRange,
  daySentence,
  emptyClockBucket,
  emptyStateDayFile,
  forEachHour,
  formatDayDuration,
  HOUR_MS,
  isEmptyDay,
  mergeIntervals,
  MIN_WAIT_MS,
  ownerWaits,
  parseDayQuery,
  parseStateDayFile,
  taskState,
  TOP_WAITS,
  WAIT_JOIN_MS,
  zeroClockMs,
  type DayStats,
  type StateDayFile,
} from "./day-stats";
import type { ForYouItem } from "./for-you";
import type { Project, ProjectTask } from "./projects";
import type { Task } from "./types";

// 11/11/2026 em São Paulo (UTC-3): o dia vai de 03:00Z a 03:00Z.
const DAY = "2026-11-11";
const AT = (hhmm: string, day = "2026-11-11") => `${day}T${hhmm}:00.000Z`;
const MS = (hhmm: string, day = "2026-11-11") => Date.parse(AT(hhmm, day));
const NOW = MS("20:00");

const item = (over: Partial<ForYouItem> & { id: string }): ForYouItem =>
  ({ agentId: "eco", roomId: "sala", type: "post", status: "aprovado", meta: {}, text: "", originalText: "", editedByUser: false, createdAt: AT("12:00"), ...over }) as ForYouItem;
const task = (over: Partial<Task> & { id: string }): Task => ({ roomId: "sala", teamId: "time", prompt: "x", agentId: "eco", status: "done", createdAt: AT("10:00"), updatedAt: AT("12:00"), ...over }) as Task;
const planTask = (over: Partial<ProjectTask>): ProjectTask =>
  ({ ref: "T1", title: "Roteiro", briefing: "", ownerId: "eco", steps: [], current: 0, dependsOn: [], priority: "normal", doneWhen: [], status: "em_andamento", rework: { count: 0 }, updatedAt: AT("12:00"), ...over }) as ProjectTask;
const project = (over: Partial<Project> = {}): Project =>
  ({ id: "site", kind: "projeto", title: "Site novo", origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, worked: {}, tasks: [], createdAt: AT("01:00"), updatedAt: AT("01:00"), ...over }) as Project;

describe("tempo em São Paulo", () => {
  it("o dia comum dura 24 h e o dia de mudança de horário de verão, 23 h e 25 h", () => {
    const hours = (day: string) => {
      const { start, end } = dayRange(day);
      return (end - start) / HOUR_MS;
    };
    expect(hours("2026-11-11")).toBe(24);
    expect(hours("2018-11-04")).toBe(23);
    expect(hours("2019-02-16")).toBe(25);
    expect(dayRange("2026-11-11").start).toBe(Date.parse("2026-11-11T03:00:00Z"));
    expect(dayKeyOf(Date.parse("2026-11-12T02:59:59Z"))).toBe("2026-11-11");
    expect(dayKeyOf(Date.parse("2026-11-12T03:00:00Z"))).toBe("2026-11-12");
  });

  it("forEachHour parte o intervalo nas viradas de hora; mergeIntervals une o que se toca", () => {
    const parts: Array<[number, number]> = [];
    forEachHour(MS("12:30"), MS("14:15"), (hour, ms) => parts.push([hour, ms]));
    expect(parts).toEqual([
      [MS("12:00"), 30 * 60_000],
      [MS("13:00"), HOUR_MS],
      [MS("14:00"), 15 * 60_000],
    ]);
    expect(
      mergeIntervals([
        [5, 9],
        [1, 3],
        [3, 4],
        [8, 12],
        [20, 20],
      ]),
    ).toEqual([
      [1, 4],
      [5, 12],
    ]);
  });
});

describe("taskState (tabela)", () => {
  const running = { task: { status: "in_progress" as const } };
  const queued = { task: { status: "queued" as const } };
  const blocked = (type: "voce" | "agente" | "cota" | "acesso") => ({ task: { status: "queued" as const }, planTask: { status: "em_andamento" as const, blocked: { type, note: "", since: "" } } });
  const cases: Array<[string, Parameters<typeof taskState>[0], string | null]> = [
    ["em andamento, terminal ocupado", { ...running, terminal: "busy" }, "working"],
    ["em andamento, sem terminal conhecido (simulado)", running, "working"],
    ["em andamento, terminal subindo", { ...running, terminal: "starting" }, "working"],
    ["em andamento, terminal parado", { ...running, terminal: "stopped" }, null],
    ["na fila", queued, "queued"],
    ["esperando aprovação do dono", { task: { status: "waiting_approval" } }, null],
    ["concluída", { task: { status: "done" } }, null],
    ["falhada", { task: { status: "failed" } }, null],
    ["registro do pedido do Maestro", { task: { role: "request", status: "in_progress" } }, null],
    ["projeto pausado", { ...running, project: { status: "pausado" } }, null],
    ["projeto proposto", { ...queued, project: { status: "proposto" } }, null],
    ["etapa concluída", { ...running, planTask: { status: "concluida" } }, null],
    ["etapa esperando você", { ...running, planTask: { status: "esperando_voce" } }, null],
    ["bloqueio por outro agente", blocked("agente"), "waiting_agent"],
    ["bloqueio por cota", blocked("cota"), "engine_blocked"],
    ["bloqueio por acesso", blocked("acesso"), "engine_blocked"],
    ["bloqueio por você não conta aqui", blocked("voce"), null],
    ["pedido de ajuda aberto vence o bloqueio de agente", { task: { status: "queued" }, planTask: { status: "em_andamento", help: [{ agentId: "eco", what: "?", at: "" }], blocked: { type: "agente", note: "", since: "" } } }, "waiting_maestro"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(taskState(input)).toBe(expected);
  });
});

describe("ownerWaits", () => {
  it("cartão de regra (kind regra) não é espera de agente: nem a pendente nem a decidida entram (revisão L4)", () => {
    const rule = (id: string, over: Partial<ForYouItem> = {}) => item({ id, kind: "regra", status: "pendente", createdAt: AT("12:00"), ...over });
    const result = ownerWaits([rule("A-1"), rule("A-2", { status: "aprovado", decidedAt: AT("12:30") }), item({ id: "A-3", createdAt: AT("12:00"), decidedAt: AT("12:10") })], [], NOW);
    expect(result.waits.map((wait) => wait.forYouIds)).toEqual([["A-3"]]);
    expect(result.longestMs).toBe(600_000);
    expect(result.wallMs).toBe(600_000);
  });

  it("espera simples: início, fim, duração, de quem e de quê", () => {
    const result = ownerWaits([item({ id: "A-1", taskId: "t1", projectId: "site", createdAt: AT("12:00"), decidedAt: AT("12:10") })], [], NOW);
    expect(result.waits).toEqual([expect.objectContaining({ forYouIds: ["A-1"], taskId: "t1", projectId: "site", agentId: "eco", type: "post", kind: "aprovacao", start: MS("12:00"), end: MS("12:10"), open: false })]);
    expect(result.longestMs).toBe(600_000);
    expect(result.wallMs).toBe(600_000);
  });

  it("esperas sobrepostas de agentes diferentes: o tempo de relógio une os intervalos", () => {
    const result = ownerWaits(
      [
        item({ id: "A-1", taskId: "t1", createdAt: AT("12:00"), decidedAt: AT("12:30") }),
        item({ id: "A-2", taskId: "t2", agentId: "ana", createdAt: AT("12:20"), decidedAt: AT("13:00") }),
        item({ id: "A-3", taskId: "t3", agentId: "beto", createdAt: AT("14:00"), decidedAt: AT("14:10") }),
      ],
      [],
      NOW,
    );
    expect(result.waits).toHaveLength(3);
    // 12:00-13:00 (união) + 14:00-14:10.
    expect(result.wallMs).toBe(3_600_000 + 600_000);
    // A soma por espera seria maior que o relógio.
    expect(result.waits.reduce((sum, wait) => sum + wait.end - wait.start, 0)).toBe(1_800_000 + 2_400_000 + 600_000);
  });

  it("lote da mesma tarefa decidido item a item vira uma espera só (até o último)", () => {
    const result = ownerWaits(
      [
        item({ id: "A-1", taskId: "t1", groupId: "g", createdAt: AT("12:00"), decidedAt: AT("12:05") }),
        item({ id: "A-2", taskId: "t1", groupId: "g", createdAt: AT("12:00"), decidedAt: AT("12:20") }),
      ],
      [],
      NOW,
    );
    expect(result.waits).toEqual([expect.objectContaining({ forYouIds: ["A-1", "A-2"], start: MS("12:00"), end: MS("12:20") })]);
  });

  it("itens colados (até 1,5 s entre um e outro) viram uma espera; afastados, duas", () => {
    const joined = ownerWaits(
      [
        item({ id: "A-1", taskId: "t1", createdAt: AT("12:00"), decidedAt: AT("12:10") }),
        item({ id: "A-2", taskId: "t1", createdAt: new Date(MS("12:10") + WAIT_JOIN_MS).toISOString(), decidedAt: AT("12:30") }),
      ],
      [],
      NOW,
    );
    expect(joined.waits).toHaveLength(1);
    const apart = ownerWaits(
      [
        item({ id: "A-1", taskId: "t1", createdAt: AT("12:00"), decidedAt: AT("12:10") }),
        item({ id: "A-2", taskId: "t1", createdAt: AT("12:11"), decidedAt: AT("12:30") }),
      ],
      [],
      NOW,
    );
    expect(apart.waits).toHaveLength(2);
  });

  it("aprovado em segundos (abaixo da espera mínima) some; no limite conta", () => {
    const quick = ownerWaits([item({ id: "A-1", createdAt: AT("12:00"), decidedAt: "2026-11-11T12:00:02.000Z" })], [], NOW);
    expect(quick.waits).toEqual([]);
    expect(quick.wallMs).toBe(0);
    const edge = ownerWaits([item({ id: "A-1", createdAt: AT("12:00"), decidedAt: new Date(MS("12:00") + MIN_WAIT_MS).toISOString() })], [], NOW);
    expect(edge.waits).toHaveLength(1);
  });

  it("item ainda pendente espera até agora (aberta); o Modo Automático e o cancelado sem data não contam", () => {
    const result = ownerWaits(
      [
        item({ id: "A-1", status: "pendente", createdAt: AT("19:00") }),
        item({ id: "A-2", decidedBy: "automatico", createdAt: AT("12:00"), decidedAt: AT("12:30") }),
        item({ id: "A-3", status: "cancelado", createdAt: AT("12:00") }),
        item({ id: "A-4", status: "cancelado", createdAt: AT("13:00"), decidedAt: AT("13:10") }),
      ],
      [],
      NOW,
    );
    expect(result.waits.map((wait) => [wait.forYouIds[0], wait.open, wait.end - wait.start])).toEqual([
      ["A-4", false, 600_000],
      ["A-1", true, 3_600_000],
    ]);
  });

  it("espera que atravessa a meia-noite aparece nos dois dias com a duração inteira", () => {
    // 11/11 23:30 -> 12/11 00:30 em São Paulo.
    const wait = item({ id: "A-1", taskId: "t1", createdAt: "2026-11-12T02:30:00.000Z", decidedAt: "2026-11-12T03:30:00.000Z" });
    const first = ownerWaits([wait], [], NOW, { range: dayRange("2026-11-11") });
    const second = ownerWaits([wait], [], NOW, { range: dayRange("2026-11-12") });
    expect(first.waits).toHaveLength(1);
    expect(second.waits).toHaveLength(1);
    expect(first.longestMs).toBe(3_600_000);
    // O relógio é cortado na janela de cada dia.
    expect(first.wallMs).toBe(1_800_000);
    expect(second.wallMs).toBe(1_800_000);
    expect(ownerWaits([wait], [], NOW, { range: dayRange("2026-11-13") }).waits).toEqual([]);
  });

  it("as dez maiores, da maior para a menor", () => {
    const items = Array.from({ length: 14 }, (_, index) => item({ id: `A-${index}`, taskId: `t${index}`, createdAt: AT("10:00"), decidedAt: new Date(MS("10:00") + (index + 1) * 60_000).toISOString() }));
    const result = ownerWaits(items, [], NOW);
    expect(result.waits).toHaveLength(14);
    expect(result.top).toHaveLength(TOP_WAITS);
    expect(result.top[0]!.forYouIds).toEqual(["A-13"]);
    expect(result.top[9]!.forYouIds).toEqual(["A-4"]);
  });

  it("projeto e sprint saem do item, da tarefa ou da etapa do projeto", () => {
    const projects = [project({ tasks: [planTask({ ref: "T1", sprintId: "S1" })] })];
    const fromTask = ownerWaits([item({ id: "A-1", taskId: "t1", createdAt: AT("12:00"), decidedAt: AT("12:10") })], [task({ id: "t1", work: { projectId: "site", ref: "T1", step: 0 } })], NOW, { projects });
    expect(fromTask.waits[0]).toMatchObject({ projectId: "site", sprintId: "S1" });
    const fromItem = ownerWaits([item({ id: "A-2", projectId: "site", sprintId: "S2", kind: "sprint", createdAt: AT("12:00"), decidedAt: AT("12:10") })], [], NOW);
    expect(fromItem.waits[0]).toMatchObject({ projectId: "site", sprintId: "S2", kind: "sprint" });
  });
});

describe("buildDayStats", () => {
  const clockFile = (): StateDayFile => {
    const file = emptyStateDayFile(DAY);
    const bucket = emptyClockBucket(MS("12:00"));
    bucket.ms = { ...zeroClockMs(), working: 40 * 60_000, queued: 10 * 60_000 };
    bucket.byAgent.push(["eco", { ...zeroClockMs(), working: 30 * 60_000 }], ["ana", { ...zeroClockMs(), working: 10 * 60_000, queued: 10 * 60_000 }]);
    bucket.byProject.push(["site", { ...zeroClockMs(), working: 40 * 60_000, queued: 10 * 60_000 }]);
    bucket.bySprint.push(["site:S1", { ...zeroClockMs(), working: 40 * 60_000 }]);
    file.buckets.push(bucket);
    file.names.agents.push(["eco", "Eco antigo"], ["ana", "Ana"]);
    return file;
  };
  const input = (over: Partial<Parameters<typeof buildDayStats>[0]> = {}) => ({
    day: DAY,
    now: NOW,
    clock: clockFile(),
    clockFrom: MS("01:00"),
    items: [item({ id: "A-1", taskId: "t1", projectId: "site", sprintId: "S1", createdAt: AT("12:30"), decidedAt: AT("13:30") })],
    tasks: [task({ id: "t1" })],
    projects: [project({ sprints: [{ id: "S1", name: "Sprint 1" }] as never })],
    agents: [{ id: "eco", name: "Eco" }],
    ...over,
  });

  it("monta por hora, agente, estado, projeto e sprint (a espera atravessa a virada de hora)", () => {
    const stats = buildDayStats(input());
    expect(stats.hours).toHaveLength(24);
    const at12 = stats.hours.find((hour) => hour.t === MS("12:00"))!;
    const at13 = stats.hours.find((hour) => hour.t === MS("13:00"))!;
    expect(at12.ms).toMatchObject({ working: 40 * 60_000, queued: 10 * 60_000, waiting_owner: 30 * 60_000 });
    expect(at13.ms.waiting_owner).toBe(30 * 60_000);
    expect(stats.totals.ms).toMatchObject({ waiting_owner: 3_600_000, working: 2_400_000, queued: 600_000 });
    expect(stats.totals).toMatchObject({ waits: 1, longestWaitMs: 3_600_000, waitWallMs: 3_600_000 });
    // Agente: o nome atual vence o gravado; quem só aparece no relógio usa o nome do arquivo.
    expect(stats.agents.map((agent) => [agent.id, agent.name])).toEqual([
      ["eco", "Eco"],
      ["ana", "Ana"],
    ]);
    expect(stats.agents[0]).toMatchObject({ waits: 1, ms: { waiting_owner: 3_600_000, working: 30 * 60_000 } });
    expect(stats.projects[0]).toMatchObject({ id: "site", name: "Site novo", waits: 1, ms: { waiting_owner: 3_600_000, working: 2_400_000 } });
    expect(stats.projects[0]!.sprints).toEqual([expect.objectContaining({ id: "S1", name: "Sprint 1", waits: 1, ms: expect.objectContaining({ waiting_owner: 3_600_000, working: 2_400_000 }) })]);
    expect(stats.waits[0]).toMatchObject({ agentName: "Eco", projectName: "Site novo", sprintName: "Sprint 1", ms: 3_600_000, msInDay: 3_600_000 });
    expect(stats.coverage).toEqual({ clockFrom: new Date(MS("01:00")).toISOString(), states: "full" });
  });

  it("agente sem nenhuma transição e dia sem relógio: só esperas; a cobertura diz que não há registro de estados", () => {
    const stats = buildDayStats(input({ clock: null, clockFrom: MS("12:00", "2026-11-12"), agents: [{ id: "eco", name: "Eco" }, { id: "zeca", name: "Zeca" }] }));
    expect(stats.agents.map((agent) => agent.id)).toEqual(["eco"]);
    expect(stats.totals.ms.working).toBe(0);
    expect(stats.totals.ms.waiting_owner).toBe(3_600_000);
    expect(stats.coverage.states).toBe("none");
    expect(buildDayStats(input({ clockFrom: MS("12:00") })).coverage.states).toBe("partial");
    expect(buildDayStats(input({ clock: null, clockFrom: undefined })).coverage).toEqual({ states: "none" });
  });

  it("dias de 23 h e de 25 h têm essa quantidade de horas e a espera do fim do dia cai na última hora", () => {
    const short = buildDayStats({ day: "2018-11-04", now: Date.parse("2018-11-05T12:00:00Z"), items: [], tasks: [], projects: [], agents: [] });
    const long = buildDayStats({ day: "2019-02-16", now: Date.parse("2019-02-17T12:00:00Z"), items: [], tasks: [], projects: [], agents: [] });
    expect(short.hours).toHaveLength(23);
    expect(long.hours).toHaveLength(25);
    expect(short.hours[0]!.hour).toBe(1);
    expect(long.hours.map((hour) => hour.hour).filter((hour) => hour === 23)).toHaveLength(2);
    // Espera nos últimos 30 min do dia de 25 h.
    const end = dayRange("2019-02-16").end;
    const wait = item({ id: "A-1", createdAt: new Date(end - 1_800_000).toISOString(), decidedAt: new Date(end + 600_000).toISOString() });
    const stats = buildDayStats({ day: "2019-02-16", now: end + HOUR_MS, items: [wait], tasks: [], projects: [], agents: [] });
    expect(stats.totals.ms.waiting_owner).toBe(1_800_000);
    expect(stats.hours.at(-1)!.ms.waiting_owner).toBe(1_800_000);
  });

  it("entregas e tarefas concluídas do dia; o gasto vem pronto do histórico", () => {
    const stats = buildDayStats(
      input({
        tasks: [task({ id: "t1", status: "done", updatedAt: AT("15:00") }), task({ id: "t2", status: "done", updatedAt: AT("15:00", "2026-11-10") }), task({ id: "t3", role: "request", status: "done", updatedAt: AT("15:00") })],
        projects: [project({ tasks: [planTask({ ref: "T1", status: "concluida", finishedAt: AT("15:00") }), planTask({ ref: "T2", status: "concluida", skipped: true, finishedAt: AT("15:00") })] })],
        usage: {
          tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
          costUsd: 1.5,
          costBrl: 8,
          turns: 4,
          unmeasuredTurns: 1,
          providers: [{ provider: "claude", label: "Claude Code", turns: 4, unmeasuredTurns: 1, totalTokens: 100, costUsd: 1.5, costBrl: 8 }],
        },
      }),
    );
    expect(stats.totals).toMatchObject({ tasksDone: 1, deliveries: 1, costUsd: 1.5, turns: 4, unmeasuredTurns: 1, tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 } });
    expect(stats.providers).toHaveLength(1);
    expect(isEmptyDay(stats)).toBe(false);
  });

  it("dia vazio", () => {
    const stats = buildDayStats({ day: DAY, now: NOW, items: [], tasks: [], projects: [], agents: [] });
    expect(isEmptyDay(stats)).toBe(true);
    expect(stats.hours.every((hour) => hour.ms.working === 0)).toBe(true);
    expect(daySentence(stats, { label: "Hoje" })).toBe("Hoje nenhum agente esperou por você.");
  });

  it("espera aberta de antes do dia vale a partir da meia-noite e aparece como aberta", () => {
    const stats = buildDayStats({ day: DAY, now: MS("06:00"), items: [item({ id: "A-1", status: "pendente", createdAt: AT("01:00", "2026-11-10") })], tasks: [], projects: [], agents: [] });
    expect(stats.totals.ms.waiting_owner).toBe(MS("06:00") - dayRange(DAY).start);
    expect(stats.waits[0]).toMatchObject({ open: true, ms: MS("06:00") - MS("01:00", "2026-11-10"), msInDay: MS("06:00") - dayRange(DAY).start });
  });
});

describe("compareDays e a frase", () => {
  const dayWith = (day: string, waitingMin: number, over: { working?: number; done?: number } = {}): DayStats => {
    const start = dayRange(day).start + 15 * HOUR_MS;
    const items = waitingMin > 0 ? [item({ id: `A-${day}`, taskId: `t-${day}`, createdAt: new Date(start).toISOString(), decidedAt: new Date(start + waitingMin * 60_000).toISOString() })] : [];
    const clock = emptyStateDayFile(day);
    if (over.working) {
      const bucket = emptyClockBucket(start);
      bucket.ms.working = over.working;
      clock.buckets.push(bucket);
    }
    const tasks = Array.from({ length: over.done ?? 0 }, (_, index) => task({ id: `d${day}${index}`, status: "done", updatedAt: new Date(start).toISOString() }));
    return buildDayStats({ day, now: dayRange(day).end, clock, items, tasks, projects: [], agents: [{ id: "eco", name: "Eco" }] });
  };

  it("com ontem, com o mesmo dia da semana passada e com a média (menos espera é melhor)", () => {
    const today = dayWith("2026-11-11", 30);
    const compare = compareDays(today, {
      yesterday: dayWith("2026-11-10", 60),
      sameWeekday: dayWith("2026-11-04", 20),
      last7: ["2026-11-10", "2026-11-09", "2026-11-08", "2026-11-07"].map((day, index) => dayWith(day, [60, 30, 0, 90][index]!)),
    });
    expect(compare.yesterday).toMatchObject({ day: "2026-11-10" });
    expect(compare.yesterday!.metrics.waitingOwnerMs).toMatchObject({ delta: -30 * 60_000, pct: -50, sense: "better" });
    expect(compare.sameWeekday!.metrics.waitingOwnerMs).toMatchObject({ delta: 10 * 60_000, pct: 50, sense: "worse" });
    // O dia de 0 min não tem nenhum dado e fica fora da média: (60 + 30 + 90) / 3 = 60.
    expect(compare.avg7).toMatchObject({ days: 3 });
    expect(compare.avg7!.metrics.waitingOwnerMs.base).toBe(60 * 60_000);
    expect(compare.avg7!.metrics.workingMs.sense).toBe("same");
  });

  it("dia de comparação sem dados não entra; base pequena não dá percentual", () => {
    const today = dayWith("2026-11-11", 30);
    expect(compareDays(today, { yesterday: dayWith("2026-11-10", 0), last7: [dayWith("2026-11-10", 0)] })).toEqual({});
    expect(compareDays(today, {})).toEqual({});
    const small = compareDays(today, { yesterday: dayWith("2026-11-10", 4) });
    expect(small.yesterday!.metrics.waitingOwnerMs.pct).toBeUndefined();
    expect(small.yesterday!.metrics.waitingOwnerMs.sense).toBe("worse");
    const equal = compareDays(today, { yesterday: dayWith("2026-11-10", 30) });
    expect(equal.yesterday!.metrics.waitingOwnerMs.sense).toBe("same");
    // Tarefas concluídas: percentual só a partir de 5 itens na base.
    const few = compareDays(dayWith("2026-11-11", 30, { done: 3 }), { yesterday: dayWith("2026-11-10", 30, { done: 2 }) });
    expect(few.yesterday!.metrics.tasksDone.pct).toBeUndefined();
    const many = compareDays(dayWith("2026-11-11", 30, { done: 8 }), { yesterday: dayWith("2026-11-10", 30, { done: 5 }) });
    expect(many.yesterday!.metrics.tasksDone.pct).toBe(60);
  });

  it("a frase pronta traz a comparação e a maior espera", () => {
    const today = dayWith("2026-11-11", 30);
    today.compare = compareDays(today, { yesterday: dayWith("2026-11-10", 100) });
    expect(daySentence(today, { label: "Hoje" })).toBe("Hoje você fez os agentes esperarem 30 min (1 h 10 min a menos que ontem, ▼ 70%). A maior espera foi de Eco, 30 min.");
    expect(formatDayDuration(45_000)).toBe("45 s");
    expect(formatDayDuration(3_600_000)).toBe("1 h");
  });
});

describe("buildPlatformDayStats", () => {
  it("soma os workspaces e une o relógio de espera entre eles", () => {
    const a = buildDayStats({ day: DAY, now: NOW, items: [item({ id: "A-1", createdAt: AT("12:00"), decidedAt: AT("13:00") })], tasks: [], projects: [], agents: [{ id: "eco", name: "Eco" }] });
    const b = buildDayStats({ day: DAY, now: NOW, items: [item({ id: "A-1", createdAt: AT("12:30"), decidedAt: AT("13:30") })], tasks: [], projects: [], agents: [{ id: "ana", name: "Ana" }] });
    const platform = buildPlatformDayStats(DAY, [
      { workspace: "w1", name: "W1", stats: a },
      { workspace: "w2", name: "W2", stats: b },
    ]);
    expect(platform.totals.ms.waiting_owner).toBe(7_200_000);
    expect(platform.totals.waitWallMs).toBe(90 * 60_000);
    expect(platform.totals.waits).toBe(2);
    expect(platform.waits).toHaveLength(2);
    expect(platform.workspaces.map((part) => part.workspace)).toEqual(["w1", "w2"]);
    expect(platform.hours).toHaveLength(24);
    expect(buildPlatformDayStats(DAY, []).totals.waits).toBe(0);
  });
});

describe("parseStateDayFile (leitura defensiva)", () => {
  const valid = (): StateDayFile => ({
    v: 1,
    day: DAY,
    names: { agents: [["eco", "Eco"]], projects: [], sprints: [] },
    buckets: [{ t: MS("12:00"), ms: { ...zeroClockMs(), working: 1000 }, byAgent: [["eco", { ...zeroClockMs(), working: 1000 }]], byProject: [], bySprint: [] }],
    liveAt: MS("12:00"),
  });

  it("aceita um arquivo bom (ida e volta pelo JSON)", () => {
    expect(parseStateDayFile(JSON.parse(JSON.stringify(valid())), DAY)).toEqual(valid());
  });

  it.each([null, 7, "x", [], { v: 2, day: DAY }, { v: 1, day: "2026-11-10" }])("rejeita %j", (raw) => {
    expect(parseStateDayFile(raw, DAY)).toBeNull();
  });

  it("descarta baldes fora do dia, repetidos ou sem hora inteira e corta números absurdos; __proto__ é só um nome", () => {
    const file = valid();
    const messy = {
      ...file,
      buckets: [
        ...file.buckets,
        file.buckets[0],
        { ...file.buckets[0], t: MS("12:30") },
        { ...file.buckets[0], t: MS("12:00", "2026-11-12") },
        { t: MS("13:00"), ms: { working: 9e15, queued: -5, waiting_agent: "x" }, byAgent: [["__proto__", { working: 5 }], [42, {}], "lixo"], byProject: "nada", bySprint: null },
        "texto",
      ],
    };
    const parsed = parseStateDayFile(messy, DAY)!;
    expect(parsed.buckets.map((bucket) => bucket.t)).toEqual([MS("12:00"), MS("13:00")]);
    const odd = parsed.buckets[1]!;
    expect(odd.ms).toEqual({ ...zeroClockMs(), working: HOUR_MS });
    expect(odd.byAgent).toEqual([["__proto__", { ...zeroClockMs(), working: 5 }]]);
    expect(odd.byProject).toEqual([]);
    expect(({} as Record<string, unknown>).working).toBeUndefined();
    expect(CLOCK_STATES.every((state) => typeof odd.ms[state] === "number")).toBe(true);
  });
});

describe("parseDayQuery", () => {
  const now = MS("15:00");
  it("hoje por padrão; formato e data exatos; futuro 400; fora dos 90 dias 404", () => {
    expect(parseDayQuery(undefined, now)).toEqual({ ok: true, day: DAY });
    expect(parseDayQuery("2026-11-01", now)).toEqual({ ok: true, day: "2026-11-01" });
    expect(parseDayQuery("2026-13-01", now)).toMatchObject({ ok: false, status: 400 });
    expect(parseDayQuery("ontem", now)).toMatchObject({ ok: false, status: 400 });
    expect(parseDayQuery("2026-11-12", now)).toMatchObject({ ok: false, status: 400 });
    expect(parseDayQuery("2026-08-13", now)).toEqual({ ok: true, day: "2026-08-13" });
    expect(parseDayQuery("2026-08-12", now)).toMatchObject({ ok: false, status: 404 });
  });
});
