import { describe, expect, it } from "vitest";
import { approvedWithoutLink, expectedMeta, goalOf, metaFlight, planMeta, type MetaPlanInput } from "./routine-meta";
import { clampTarget, periodBoundsFor, periodBoundsOfKey, periodKeyFor, periodOfKey, previousPeriodKeysFor, routinesDataSchema, closeAtFor, type MetaGoal } from "./routines";

/** Horário de São Paulo (UTC-3, sem horário de verão). */
const at = (local: string) => new Date(`${local}:00-03:00`);
// Semana 2026-W46: segunda 09/11 a domingo 15/11.
const goal = (extra: Partial<MetaGoal> = {}): MetaGoal => ({ target: 3, period: "week", stopOnHit: true, prepareFactor: 1, ...extra });
const input = (now: string, extra: Partial<Omit<MetaPlanInput, "goal">> & { goal?: Partial<MetaGoal> } = {}): MetaPlanInput => {
  const { goal: g, ...rest } = extra;
  return { goal: goal(g), now: at(now), delivered: 0, inFlight: 0, pending: 0, taskOpen: false, dailyLeft: Number.POSITIVE_INFINITY, ...rest };
};

describe("períodos: semana e mês (São Paulo)", () => {
  it("chaves e limites do mês, inclusive na virada de ano", () => {
    expect(periodKeyFor(at("2026-11-30T23:30"), "month")).toBe("2026-M11");
    expect(periodKeyFor(at("2026-12-01T00:30"), "month")).toBe("2026-M12");
    expect(periodBoundsFor(at("2026-12-15T10:00"), "month")).toMatchObject({ key: "2026-M12", start: at("2026-12-01T00:00"), end: at("2027-01-01T00:00") });
    expect(periodBoundsOfKey("2026-M02")).toMatchObject({ start: at("2026-02-01T00:00"), end: at("2026-03-01T00:00") });
    expect(periodBoundsOfKey("2026-M13")).toBeUndefined();
    expect(periodOfKey("2026-M11")).toBe("month");
    expect(periodOfKey("2026-W46")).toBe("week");
    expect(previousPeriodKeysFor(at("2027-01-10T10:00"), "month", 3)).toEqual(["2026-M10", "2026-M11", "2026-M12"]);
    expect(previousPeriodKeysFor(at("2026-11-11T10:00"), "week", 2)).toEqual(["2026-W44", "2026-W45"]);
  });

  it("o fechamento é segunda 08:00 (semana) e dia 1 08:00 (mês)", () => {
    expect(closeAtFor(at("2026-11-11T10:00"), "week")).toEqual(at("2026-11-09T08:00"));
    expect(closeAtFor(at("2026-12-11T10:00"), "month")).toEqual(at("2026-12-01T08:00"));
  });

  it("a meta mensal pode ser maior que a semanal do tipo (até 5 semanas)", () => {
    expect(clampTarget("invite", 500)).toBe(60);
    expect(clampTarget("invite", 500, "month")).toBe(300);
    expect(clampTarget("other", 5, "month")).toBe(5);
  });
});

describe("expectedMeta: a curva do período", () => {
  it("sem dias preferidos é a curva do período inteiro (já no começo pede o primeiro)", () => {
    expect(expectedMeta(goal({ target: 2 }), at("2026-11-09T10:00"))).toBe(1);
    expect(expectedMeta(goal({ target: 2 }), at("2026-11-13T12:00"))).toBe(2);
    expect(expectedMeta(goal({ target: 10, period: "month" }), at("2026-11-16T00:00"))).toBe(5);
  });

  it("dias preferidos (ter e qui) distribuem a meta só por eles e nos 2 últimos dias vale qualquer dia", () => {
    const preferred = goal({ target: 2, preferredDays: [2, 4] });
    expect(expectedMeta(preferred, at("2026-11-09T12:00"))).toBe(0); // segunda
    expect(expectedMeta(preferred, at("2026-11-10T00:30"))).toBe(1); // terça
    expect(expectedMeta(preferred, at("2026-11-11T12:00"))).toBe(1); // quarta
    expect(expectedMeta(preferred, at("2026-11-12T00:30"))).toBe(2); // quinta
    expect(expectedMeta(goal({ target: 2, preferredDays: [4] }), at("2026-11-14T12:00"))).toBe(2); // sábado, ainda sem a quinta? (já passou) e últimos dias
    expect(expectedMeta(goal({ target: 3, preferredDays: [6] }), at("2026-11-10T12:00"))).toBe(0);
    expect(expectedMeta(goal({ target: 3, preferredDays: [6] }), at("2026-11-14T12:00"))).toBe(3);
  });

  it("mês com dias preferidos: cada segunda libera a sua parte", () => {
    const monthly = goal({ target: 4, period: "month", preferredDays: [1] }); // novembro/2026 tem 5 segundas (2, 9, 16, 23, 30)
    expect(expectedMeta(monthly, at("2026-11-01T10:00"))).toBe(0);
    expect(expectedMeta(monthly, at("2026-11-10T10:00"))).toBe(2);
    expect(expectedMeta(monthly, at("2026-11-17T10:00"))).toBe(3);
    expect(expectedMeta(monthly, at("2026-11-29T10:00"))).toBe(4); // últimos 2 dias
  });
});

describe("planMeta: quando e quanto cobrar", () => {
  it("início do período: atrasada pela curva, lote do que falta e opções = lote x fator", () => {
    const plan = planMeta(input("2026-11-09T11:00", { goal: { prepareFactor: 2 } }));
    expect(plan).toMatchObject({ action: "cobrar", batch: 3, candidates: 6, missing: 3, expected: 1, periodKey: "2026-W46" });
  });

  it("alvo 2 com fator 2 pede 4 opções; o teto diário do site encolhe o lote e o motivo diz isso", () => {
    const g = { target: 2, prepareFactor: 2 };
    expect(planMeta(input("2026-11-09T11:00", { goal: g }))).toMatchObject({ action: "cobrar", batch: 2, candidates: 4 });
    // Post: 1 por dia -> lote de 1 e 2 opções (não é falha do fator de preparo).
    const capped = planMeta(input("2026-11-09T11:00", { goal: g, dailyLeft: 1 }));
    expect(capped).toMatchObject({ action: "cobrar", batch: 1, candidates: 2 });
    expect(capped.reason).toContain("teto diário do site");
  });

  it("meio do período no ritmo: não cobra; fim do período atrasada: cobra em qualquer dia", () => {
    expect(planMeta(input("2026-11-11T12:00", { delivered: 2 }))).toMatchObject({ action: "pular", reason: expect.stringContaining("no ritmo") });
    expect(planMeta(input("2026-11-14T12:00", { delivered: 2 }))).toMatchObject({ action: "cobrar", batch: 1 });
  });

  it("dias preferidos: segunda (não preferida) não cobra, terça cobra", () => {
    const g = { target: 2, preferredDays: [2, 4] as MetaGoal["preferredDays"] };
    expect(planMeta(input("2026-11-09T12:00", { goal: g })).action).toBe("pular");
    expect(planMeta(input("2026-11-10T12:00", { goal: g }))).toMatchObject({ action: "cobrar", expected: 1 });
    // Quarta atrasada (nada entregue na terça): continua cobrando, o dia preferido é só sugestão.
    expect(planMeta(input("2026-11-11T12:00", { goal: g })).action).toBe("cobrar");
  });

  it("o que já está em preparo (opções esperando OK, aprovadas) cobre o que falta: não cobra", () => {
    // Meta 3, fator 2: 6 opções esperando OK cobrem as 3.
    const covered = planMeta(input("2026-11-09T11:00", { goal: { prepareFactor: 2 }, pending: 6 }));
    expect(covered).toMatchObject({ action: "pular", pendingCover: 3 });
    expect(covered.reason).toContain("já cobre");
    // 2 opções (fator 2) cobrem 1: pede só o que falta (2 de 3), com 4 opções.
    expect(planMeta(input("2026-11-11T12:00", { goal: { prepareFactor: 2 }, pending: 2 }))).toMatchObject({ action: "cobrar", batch: 2, candidates: 4 });
    // Aprovadas esperando entrega contam como comprometidas.
    expect(planMeta(input("2026-11-14T12:00", { inFlight: 2 }))).toMatchObject({ action: "cobrar", batch: 1, committed: 2 });
  });

  it("bateu (entregue + aprovado >= alvo): para, com ou sem tarefa aberta", () => {
    expect(planMeta(input("2026-11-14T12:00", { delivered: 3 }))).toMatchObject({ action: "pular", hit: true, pace: "concluida" });
    const approved = planMeta(input("2026-11-14T12:00", { delivered: 1, inFlight: 2 }));
    expect(approved).toMatchObject({ action: "pular", hit: true });
    // Aprovadas ainda não entregues: o ritmo não diz "batida" até entregar.
    expect(approved.pace).not.toBe("concluida");
    expect(approved.reason).toContain("meta coberta (1 entregue(s) + 2 aprovada(s) em andamento, alvo 3)");
  });

  it("tarefa aberta: um lote por vez", () => {
    expect(planMeta(input("2026-11-14T12:00", { taskOpen: true }))).toMatchObject({ action: "pular", reason: "já há uma tarefa aberta desta rotina" });
  });

  it("limite diário do site: o lote cabe no que resta e zero para", () => {
    expect(planMeta(input("2026-11-14T12:00", { goal: { target: 8, prepareFactor: 2 }, dailyLeft: 1 }))).toMatchObject({ action: "cobrar", batch: 1, candidates: 2 });
    expect(planMeta(input("2026-11-14T12:00", { dailyLeft: 0 }))).toMatchObject({ action: "pular", reason: "teto diário atingido" });
  });

  it("lote limitado a 5 e opções a 10; o fator vale de 1 a 3", () => {
    expect(planMeta(input("2026-11-14T12:00", { goal: { target: 8, prepareFactor: 3 } }))).toMatchObject({ batch: 5, candidates: 10 });
    expect(planMeta(input("2026-11-14T12:00", { goal: { target: 2, prepareFactor: 3 } }))).toMatchObject({ batch: 2, candidates: 6 });
  });

  it("lembrete de horário (force) ignora o ritmo, mas nunca o alvo", () => {
    expect(planMeta(input("2026-11-11T12:00", { delivered: 2, force: true }))).toMatchObject({ action: "cobrar", batch: 1 });
    expect(planMeta(input("2026-11-11T12:00", { delivered: 3, force: true })).action).toBe("pular");
  });

  it("virar o período não acumula: semana nova começa do zero com o mesmo alvo", () => {
    expect(planMeta(input("2026-11-15T20:00", { delivered: 1 }))).toMatchObject({ periodKey: "2026-W46", missing: 2 });
    expect(planMeta(input("2026-11-16T12:00", { delivered: 0 }))).toMatchObject({ periodKey: "2026-W47", missing: 3, action: "cobrar", batch: 3 });
  });

  it("mês: o alvo é do mês e a chave muda no dia 1", () => {
    const month = { target: 4, period: "month" as const };
    expect(planMeta(input("2026-11-30T12:00", { goal: month, delivered: 1 }))).toMatchObject({ periodKey: "2026-M11", action: "cobrar", batch: 3 });
    expect(planMeta(input("2026-12-01T12:00", { goal: month, delivered: 0 }))).toMatchObject({ periodKey: "2026-M12", missing: 4 });
  });
});

describe("metaFlight: o que está em andamento", () => {
  const tasks = [
    { id: "t1", routineId: "R-0001", status: "waiting_approval" as const },
    { id: "t2", routineId: "R-0001", status: "done" as const },
    { id: "t3", routineId: "R-0002", status: "in_progress" as const },
  ];
  const entry = (taskId: string, url: string, stage: "registrado" | "entregue") => ({ id: url, routineId: "R-0001", periodKey: "2026-W46", url, taskId, agentId: "a", stage, at: "2026-11-11T12:00:00.000Z" });

  it("conta aprovadas e opções pendentes só das tarefas abertas da rotina; aprovado de tarefa terminada não conta", () => {
    const items = [
      { taskId: "t1", status: "aprovado" as const, kind: "aprovacao" as const },
      { taskId: "t1", status: "pendente" as const, kind: "aprovacao" as const },
      { taskId: "t1", status: "pendente" as const },
      { taskId: "t1", status: "cancelado" as const, kind: "aprovacao" as const },
      { taskId: "t2", status: "aprovado" as const, kind: "aprovacao" as const },
      { taskId: "t3", status: "aprovado" as const, kind: "aprovacao" as const },
    ];
    expect(metaFlight({ routineId: "R-0001", tasks, items, entries: [], periodKey: "2026-W46" })).toEqual({ inFlight: 1, pending: 2, taskOpen: true, openTaskIds: ["t1"] });
  });

  it("aprovada que já registrou o link não conta duas vezes (vale o maior)", () => {
    const items = [{ taskId: "t1", status: "aprovado" as const, kind: "aprovacao" as const }, { taskId: "t1", status: "aprovado" as const, kind: "aprovacao" as const }];
    const entries = [entry("t1", "https://x.com/1", "registrado"), entry("t1", "https://x.com/2", "registrado"), entry("t1", "https://x.com/3", "registrado"), entry("t1", "https://x.com/9", "entregue")];
    expect(metaFlight({ routineId: "R-0001", tasks, items, entries, periodKey: "2026-W46" }).inFlight).toBe(3);
  });
});

describe("migração das metas v1", () => {
  const v1 = {
    routines: [
      {
        id: "R-0001",
        title: "Convites",
        unit: "convite",
        kind: "invite",
        site: "linkedin.com",
        target: 10,
        period: "week",
        agentId: "clara",
        instruction: "",
        status: "ativa",
        needsApproval: true,
        skipPeriods: [],
        createdBy: "usuario",
        createdAt: "2026-11-01T12:00:00.000Z",
        updatedAt: "2026-11-01T12:00:00.000Z",
      },
    ],
    entries: [],
    executions: [],
    decisions: {},
    results: [{ routineId: "R-0001", periodKey: "2026-W45", target: 10, delivered: 4, outcome: "nao_bateu" }],
  };

  it("meta v1 sem goal ganha os padrões (stopOnHit, fator 1) e o histórico segue legível", () => {
    const parsed = routinesDataSchema.parse(v1);
    const routine = parsed.routines[0]!;
    expect(routine.goal).toEqual({ target: 10, period: "week", stopOnHit: true, prepareFactor: 1 });
    expect(routine.periodStats).toEqual({});
    expect(goalOf(routine)).toEqual({ target: 10, period: "week", stopOnHit: true, prepareFactor: 1 });
    expect(parsed.results[0]).toMatchObject({ delivered: 4 });
    // Regravar e ler de novo não muda nada.
    expect(routinesDataSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("o plano de uma meta v1 é o mesmo de uma meta v2 com os padrões", () => {
    const routine = routinesDataSchema.parse(v1).routines[0]!;
    const plan = planMeta({ goal: goalOf(routine), now: at("2026-11-11T12:00"), delivered: 0, inFlight: 0, pending: 0, taskOpen: false, dailyLeft: 15 });
    expect(plan).toMatchObject({ action: "cobrar", batch: 5, candidates: 5, missing: 10 });
  });
});

describe("aprovadas sem link registrado", () => {
  const key = "2026-W46";
  const task = { id: "T1", routineId: "R-0001", status: "done" as const };
  const approved = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: "T1", status: "aprovado" as const, kind: undefined, createdAt: at("2026-11-10T10:00").toISOString(), decidedAt: at("2026-11-10T11:00").toISOString(), id: `A-${i}` }));
  const entry = (url: string, stage: "registrado" | "entregue" | "descartado") => ({ id: url, routineId: "R-0001", periodKey: key, url, taskId: "T2", agentId: "a", stage, at: at("2026-11-10T12:00").toISOString() });

  it("conta as aprovadas de tarefa concluída menos os links registrados ou entregues", () => {
    const base = { routineId: "R-0001", period: "week" as const, periodKey: key, tasks: [task] };
    expect(approvedWithoutLink({ ...base, items: approved(3), entries: [] })).toBe(3);
    expect(approvedWithoutLink({ ...base, items: approved(3), entries: [entry("https://x.com/1", "registrado"), entry("https://x.com/2", "entregue"), entry("https://x.com/3", "descartado")] })).toBe(1);
    expect(approvedWithoutLink({ ...base, tasks: [{ ...task, status: "in_progress" as const }], items: approved(3), entries: [] })).toBe(0);
  });

  it("o plano cobra SÓ o registro (sem opções novas) e diz 'meta coberta' em vez de 'batida' enquanto há tarefa aberta", () => {
    const plan = planMeta(input("2026-11-11T12:00", { approvedNoLink: 3 }));
    expect(plan).toMatchObject({ action: "registrar", batch: 3, candidates: 0, approvedNoLink: 3, delivered: 0 });
    expect(planMeta(input("2026-11-11T12:00", { approvedNoLink: 3, delivered: 3 })).action).toBe("pular");
    const open = planMeta(input("2026-11-11T12:00", { inFlight: 3, taskOpen: true }));
    expect(open).toMatchObject({ action: "pular", hit: true });
    expect(open.reason).toContain("meta coberta");
  });
});
