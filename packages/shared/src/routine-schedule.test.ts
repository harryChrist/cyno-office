import { describe, expect, it } from "vitest";
import { describeDays, describeSlotWhen, describeTimes, dueSlots, nextSlots, slotKeyNow, slotsBetween, type DueSlot } from "./routine-schedule";
import type { RoutineSchedule, ScheduleDays } from "./routines";
import { createRoutineBodySchema, routinesDataSchema, scheduleInputSchema, upgradeRoutine } from "./routines";

const schedule = (days: ScheduleDays, times: string[], extra: Partial<RoutineSchedule> = {}): RoutineSchedule => ({ id: "S1", label: "Teste", days, times, action: "faça", enabled: true, ...extra });
const due = (schedules: RoutineSchedule[], nowIso: string, tz?: string) => dueSlots({ schedules }, new Date(nowIso), tz ? { timeZone: tz } : {});
const keys = (slots: DueSlot[]) => slots.map((slot) => `${slot.action}:${slot.slotKey}`);

// São Paulo é UTC-3 o ano todo (sem horário de verão). 2026-11-11 é quarta-feira.
const SP = (local: string) => `${local}:00-03:00`;

describe("dueSlots: dias", () => {
  it("todo dia: roda o horário de hoje depois da hora", () => {
    const s = schedule({ kind: "todo_dia" }, ["09:00"], { lastSlotKey: "2026-11-10T09:00" });
    expect(due([s], SP("2026-11-11T08:59"))).toEqual([]);
    expect(keys(due([s], SP("2026-11-11T09:00")))).toEqual(["run:2026-11-11T09:00"]);
    expect(keys(due([s], SP("2026-11-11T09:00")))).toHaveLength(1);
  });

  it.each([
    ["segunda", "2026-11-09", true],
    ["sexta", "2026-11-13", true],
    ["sábado", "2026-11-14", false],
    ["domingo", "2026-11-15", false],
  ])("dias úteis: %s", (_name, day, runs) => {
    const s = schedule({ kind: "uteis" }, ["10:00"], { lastSlotKey: "2026-11-01T10:00" });
    const slots = due([s], SP(`${day}T10:05`));
    // Em dia útil vencem também os dias úteis anteriores desde a última marca; só o de hoje é "run".
    expect(slots.some((slot) => slot.slotKey === `${day}T10:00`)).toBe(runs);
  });

  it("dias da semana escolhidos (ter, qui, sex)", () => {
    const s = schedule({ kind: "semana", weekdays: [2, 4, 5] }, ["10:00"], { lastSlotKey: "2026-11-09T23:59" });
    // quarta 11 ao meio-dia: a terça 10h venceu há 26 h (fora da janela): pulada, não roda.
    expect(keys(due([s], SP("2026-11-11T12:00")))).toEqual(["skip:2026-11-10T10:00"]);
    expect(keys(due([s], SP("2026-11-10T11:00")))).toEqual(["run:2026-11-10T10:00"]);
    expect(due([{ ...s, lastSlotKey: "2026-11-10T10:00" }], SP("2026-11-11T12:00"))).toEqual([]);
    expect(keys(due([{ ...s, lastSlotKey: "2026-11-10T10:00" }], SP("2026-11-12T10:01")))).toEqual(["run:2026-11-12T10:00"]);
  });

  it("dia do mês: roda no dia, e mês curto roda no último dia", () => {
    const s = schedule({ kind: "mes", monthDay: 31 }, ["09:00"], { lastSlotKey: "2026-02-01T00:00" });
    expect(keys(due([s], SP("2026-02-28T09:30")))).toEqual(["run:2026-02-28T09:00"]);
    expect(due([s], SP("2026-02-27T09:30"))).toEqual([]);
    const dia15 = schedule({ kind: "mes", monthDay: 15 }, ["09:00"], { lastSlotKey: "2026-11-01T00:00" });
    expect(keys(due([dia15], SP("2026-11-15T09:10")))).toEqual(["run:2026-11-15T09:00"]);
    expect(due([dia15], SP("2026-11-16T09:10")).map((slot) => slot.action)).toEqual(["skip"]);
    expect(due([dia15], SP("2026-11-14T23:00"))).toEqual([]);
  });
});

describe("dueSlots: horas, virada de dia e marca", () => {
  it("várias horas no dia: só o mais recente roda, o anterior da mesma passada vira pulada", () => {
    const s = schedule({ kind: "todo_dia" }, ["09:00", "13:00", "18:00"], { lastSlotKey: "2026-11-10T18:00" });
    expect(keys(due([s], SP("2026-11-11T09:01")))).toEqual(["run:2026-11-11T09:00"]);
    expect(keys(due([{ ...s, lastSlotKey: "2026-11-11T09:00" }], SP("2026-11-11T13:00")))).toEqual(["run:2026-11-11T13:00"]);
    // Servidor voltou às 18:30: 09 e 13 foram perdidos (pulados); 18 roda.
    expect(keys(due([{ ...s, lastSlotKey: "2026-11-10T18:00" }], SP("2026-11-11T18:30")))).toEqual(["skip:2026-11-11T09:00", "skip:2026-11-11T13:00", "run:2026-11-11T18:00"]);
  });

  it("virada de dia: o horário de 23:50 de ontem recuperado às 00:30 de hoje", () => {
    const s = schedule({ kind: "todo_dia" }, ["23:50"], { lastSlotKey: "2026-11-10T23:50" });
    expect(keys(due([s], SP("2026-11-11T23:55")))).toEqual(["run:2026-11-11T23:50"]);
    const ontem = { ...s, lastSlotKey: "2026-11-09T23:50" };
    expect(keys(due([ontem], SP("2026-11-11T00:30")))).toEqual(["run:2026-11-10T23:50"]);
  });

  it("o fuso é o de São Paulo, não o do servidor", () => {
    const s = schedule({ kind: "todo_dia" }, ["09:00"], { lastSlotKey: "2026-11-10T09:00" });
    // 11:59Z = 08:59 em SP; 12:00Z = 09:00 em SP
    expect(due([s], "2026-11-11T11:59:00Z")).toEqual([]);
    expect(keys(due([s], "2026-11-11T12:00:00Z"))).toEqual(["run:2026-11-11T09:00"]);
  });

  it("horário já tratado, desligado ou com gatilho reservado nunca vence", () => {
    const base = schedule({ kind: "todo_dia" }, ["09:00"], { lastSlotKey: "2026-11-11T09:00" });
    expect(due([base], SP("2026-11-11T10:00"))).toEqual([]);
    expect(due([{ ...base, lastSlotKey: undefined, enabled: false }], SP("2026-11-11T09:10"))).toEqual([]);
    expect(due([{ ...base, lastSlotKey: undefined, trigger: { kind: "email_novo", connector: "gmail" } }], SP("2026-11-11T09:10"))).toEqual([]);
  });

  it("horário novo (sem marca) só olha a janela de recuperação e não gera pulados", () => {
    const s = schedule({ kind: "todo_dia" }, ["09:00"]);
    expect(keys(due([s], SP("2026-11-11T09:30")))).toEqual(["run:2026-11-11T09:00"]);
    expect(due([s], SP("2026-11-11T12:00"))).toEqual([]);
  });

  it("dois schedules independentes, cada um com a sua marca", () => {
    const a = schedule({ kind: "todo_dia" }, ["09:00"], { id: "S1", lastSlotKey: "2026-11-10T09:00" });
    const b = schedule({ kind: "uteis" }, ["09:00"], { id: "S2", lastSlotKey: "2026-11-11T09:00" });
    expect(due([a, b], SP("2026-11-11T09:01")).map((slot) => slot.scheduleId)).toEqual(["S1"]);
  });
});

describe("dueSlots: recuperação de até 2 h", () => {
  const s = schedule({ kind: "todo_dia" }, ["08:00"], { lastSlotKey: "2026-11-10T08:00" });
  it("passou há 1h59: roda uma vez agora", () => {
    expect(keys(due([s], SP("2026-11-11T09:59")))).toEqual(["run:2026-11-11T08:00"]);
  });
  it("passou há exatas 2h: ainda roda", () => {
    expect(keys(due([s], SP("2026-11-11T10:00")))).toEqual(["run:2026-11-11T08:00"]);
  });
  it("passou há mais de 2h: vira pulada (servidor desligado), sem rodar", () => {
    const slots = due([s], SP("2026-11-11T10:01"));
    expect(keys(slots)).toEqual(["skip:2026-11-11T08:00"]);
    expect(slots[0]!.skipReason).toBe("servidor desligado");
  });
  it("vários dias parado: roda no máximo o último e pula os antigos", () => {
    const parado = { ...s, lastSlotKey: "2026-11-07T08:00" };
    expect(keys(due([parado], SP("2026-11-11T08:20")))).toEqual(["skip:2026-11-08T08:00", "skip:2026-11-09T08:00", "skip:2026-11-10T08:00", "run:2026-11-11T08:00"]);
  });
  it("o dia seguinte nunca recupera o anterior: só o de hoje roda", () => {
    const parado = { ...s, lastSlotKey: "2026-11-09T08:00" };
    const slots = due([parado], SP("2026-11-11T08:05"));
    expect(slots.filter((slot) => slot.action === "run").map((slot) => slot.slotKey)).toEqual(["2026-11-11T08:00"]);
  });
  it("o horário depois da marca de hoje não vence antes da hora", () => {
    expect(due([{ ...s, lastSlotKey: "2026-11-11T08:00" }], SP("2026-11-11T20:00"))).toEqual([]);
  });
});

describe("dueSlots: horário de verão (fuso de teste America/New_York)", () => {
  const NY = "America/New_York";
  it("02:30 não existe em 08/03/2026: roda uma vez, na primeira passada depois do pulo", () => {
    const s = schedule({ kind: "todo_dia" }, ["02:30"], { lastSlotKey: "2026-03-07T02:30" });
    // O horário que não existe vale 03:30 EDT (= 07:30Z), logo depois da lacuna.
    expect(due([s], "2026-03-08T07:29:00Z", NY)).toEqual([]);
    const first = due([s], "2026-03-08T07:30:00Z", NY);
    expect(keys(first)).toEqual(["run:2026-03-08T02:30"]);
    // Depois de tratado, nunca repete.
    const treated = { ...s, lastSlotKey: first[0]!.slotKey };
    expect(due([treated], "2026-03-08T09:00:00Z", NY)).toEqual([]);
    expect(due([treated], "2026-03-08T20:00:00Z", NY)).toEqual([]);
  });

  it("01:30 repete em 01/11/2026: roda uma vez só", () => {
    const s = schedule({ kind: "todo_dia" }, ["01:30"], { lastSlotKey: "2026-10-31T01:30" });
    // 05:30Z = 01:30 EDT (primeira vez); 06:30Z = 01:30 EST (segunda).
    const first = due([s], "2026-11-01T05:30:00Z", NY);
    expect(keys(first)).toEqual(["run:2026-11-01T01:30"]);
    const treated = { ...s, lastSlotKey: first[0]!.slotKey };
    expect(due([treated], "2026-11-01T06:30:00Z", NY)).toEqual([]);
    expect(due([treated], "2026-11-01T07:30:00Z", NY)).toEqual([]);
  });
});

describe("nextSlots e descrição", () => {
  it("lista os próximos horários em ordem, de todos os schedules", () => {
    const a = schedule({ kind: "uteis" }, ["09:00", "13:00", "18:00"], { id: "S1", label: "Posts" });
    const b = schedule({ kind: "semana", weekdays: [2, 4] }, ["10:00"], { id: "S2", label: "Pessoas" });
    const next = nextSlots({ schedules: [a, b] }, new Date(SP("2026-11-11T12:00")), 4);
    expect(next.map((slot) => `${slot.scheduleId}@${slot.slotKey}`)).toEqual(["S1@2026-11-11T13:00", "S1@2026-11-11T18:00", "S1@2026-11-12T09:00", "S2@2026-11-12T10:00"]);
    expect(next[0]!.at).toBe("2026-11-11T16:00:00.000Z");
  });
  it("sexta à noite pula o fim de semana nos dias úteis", () => {
    const a = schedule({ kind: "uteis" }, ["09:00"]);
    expect(nextSlots({ schedules: [a] }, new Date(SP("2026-11-13T20:00")), 2).map((slot) => slot.slotKey)).toEqual(["2026-11-16T09:00", "2026-11-17T09:00"]);
  });
  it("sem horário ligado devolve vazio", () => {
    expect(nextSlots({ schedules: [schedule({ kind: "todo_dia" }, ["09:00"], { enabled: false })] }, new Date(), 3)).toEqual([]);
  });
  it("chave do instante e textos da lista", () => {
    expect(slotKeyNow(new Date(SP("2026-11-11T08:07")))).toBe("2026-11-11T08:07");
    expect(describeDays({ kind: "uteis" })).toBe("Dias úteis");
    expect(describeDays({ kind: "semana", weekdays: [2, 4, 5] })).toBe("Ter, qui e sex");
    expect(describeDays({ kind: "mes", monthDay: 1 })).toBe("Dia 1 de cada mês");
    expect(describeTimes(["18:00", "09:00", "13:30"])).toBe("9h, 13h30, 18h");
  });
});

describe("esquemas", () => {
  it("o horário exige hora (menos com gatilho) e ordena sem repetir", () => {
    expect(scheduleInputSchema.safeParse({ label: "x", days: { kind: "uteis" }, times: [], action: "a" }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ label: "x", days: { kind: "uteis" }, times: ["25:00"], action: "a" }).success).toBe(false);
    const ok = scheduleInputSchema.parse({ label: "x", days: { kind: "uteis" }, times: ["18:00", "09:00", "18:00"], action: "a" });
    expect(ok.times).toEqual(["09:00", "18:00"]);
    expect(ok.enabled).toBe(true);
    expect(scheduleInputSchema.safeParse({ label: "x", days: { kind: "todo_dia" }, action: "a", trigger: { kind: "email_novo", connector: "gmail" } }).success).toBe(true);
  });
  it("criar acompanhamento pede horário; meta pede site e alvo", () => {
    const base = { title: "T", agentId: "eco" };
    expect(createRoutineBodySchema.safeParse({ ...base, type: "acompanhamento" }).success).toBe(false);
    expect(createRoutineBodySchema.safeParse({ ...base, type: "acompanhamento", schedules: [{ label: "x", days: { kind: "todo_dia" }, times: ["08:00"], action: "a" }] }).success).toBe(true);
    expect(createRoutineBodySchema.safeParse({ ...base }).success).toBe(false);
    expect(createRoutineBodySchema.safeParse({ ...base, site: "linkedin.com", target: 2, kind: "post", unit: "post" }).success).toBe(true);
    expect(createRoutineBodySchema.safeParse({ ...base, teamId: "t", site: "linkedin.com", target: 2 }).success).toBe(false);
  });
});

describe("migração da rotina v1", () => {
  const v1 = {
    id: "R-0001",
    title: "Convites",
    unit: "convite",
    kind: "invite",
    site: "linkedin.com",
    target: 10,
    period: "week",
    teamId: "t1",
    instruction: "convide",
    status: "arquivada",
    needsApproval: false,
    dailyCap: 5,
    skipPeriods: [],
    createdBy: "usuario",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
  };
  const file = (routine: unknown) => ({ routines: [routine], entries: [], executions: [], decisions: {}, results: [] });

  it("needsApproval:false vira automático com o grant do tipo; arquivada vira encerrada; meta vira goal", () => {
    const data = routinesDataSchema.parse(file(v1));
    const r = data.routines[0]!;
    expect(data.version).toBe(2);
    expect(r.type).toBe("meta");
    expect(r.status).toBe("encerrada");
    expect(r.schedules).toEqual([]);
    expect(r.lastRuns).toEqual([]);
    expect(r.goal).toEqual({ target: 10, period: "week", stopOnHit: true, prepareFactor: 1 });
    expect(r.mode).toEqual({ kind: "automatico", grant: { actions: ["enviar convite", "enviar sem nota", "send invitation", "send invite", "send without a note"], sites: ["linkedin.com"], dailyCap: 5, approvedAt: "2026-11-02T10:00:00.000Z" } });
    expect(r.needsApproval).toBe(false);
  });

  it("needsApproval:true vira pede-ok", () => {
    const r = routinesDataSchema.parse(file({ ...v1, needsApproval: true, status: "ativa" })).routines[0]!;
    expect(r.mode).toEqual({ kind: "pede-ok" });
    expect(r.status).toBe("ativa");
  });

  it("regravar e ler de novo não muda nada (idempotente)", () => {
    const first = routinesDataSchema.parse(file(v1));
    const second = routinesDataSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
  });

  it("com mode presente, needsApproval só espelha", () => {
    const upgraded = upgradeRoutine({ ...v1, needsApproval: true, mode: { kind: "automatico", grant: { actions: [], approvedAt: "2026-11-02T10:00:00.000Z" } } }) as { needsApproval: boolean };
    expect(upgraded.needsApproval).toBe(false);
  });
});

describe("slotsBetween e describeSlotWhen", () => {
  it("só devolve os horários do período pedido, em ordem, respeitando o limite", () => {
    const a = schedule({ kind: "uteis" }, ["09:00", "18:00"], { id: "S1" });
    const out = slotsBetween({ schedules: [a] }, new Date(SP("2026-11-11T12:00")), new Date(SP("2026-11-14T00:00")), 100);
    expect(out.map((slot) => slot.slotKey)).toEqual(["2026-11-11T18:00", "2026-11-12T09:00", "2026-11-12T18:00", "2026-11-13T09:00", "2026-11-13T18:00"]);
    expect(slotsBetween({ schedules: [a] }, new Date(SP("2026-11-11T12:00")), new Date(SP("2026-11-14T00:00")), 2)).toHaveLength(2);
    expect(slotsBetween({ schedules: [a] }, new Date(SP("2026-11-14T00:00")), new Date(SP("2026-11-16T00:00")), 10)).toEqual([]);
    expect(slotsBetween({ schedules: [a] }, new Date(SP("2026-11-12T00:00")), new Date(SP("2026-11-12T00:00")), 10)).toEqual([]);
  });
  it("descreve quando: hoje, amanhã ou dia da semana", () => {
    const now = new Date(SP("2026-11-11T10:00"));
    expect(describeSlotWhen(new Date(SP("2026-11-11T18:00")), now)).toBe("hoje às 18h");
    expect(describeSlotWhen(new Date(SP("2026-11-12T09:00")), now)).toBe("amanhã às 9h");
    expect(describeSlotWhen(new Date(SP("2026-11-14T09:30")), now)).toBe("sáb 14/11 às 9h30");
  });
});
