import { createRoutineBodySchema, updateRoutineBodySchema, type Routine } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { ROUTINE_TEMPLATES, emptyRoutineForm, fieldKeyFor, hasFormErrors, metaPreview, routineToForm, templateToForm, toCreateBody, toUpdateBody, validateRoutineForm } from "./routineForm";
import { emptySchedule } from "./scheduleForm";

const template = (id: string) => ROUTINE_TEMPLATES.find((candidate) => candidate.id === id)!;

const metaRoutine: Routine = {
  id: "R-0001",
  title: "Convites",
  unit: "convite",
  kind: "invite",
  site: "linkedin.com",
  target: 10,
  period: "week",
  agentId: "a1",
  instruction: "Convide.",
  status: "ativa",
  needsApproval: true,
  type: "meta",
  mode: { kind: "pede-ok" },
  goal: { target: 10, period: "week", stopOnHit: true, prepareFactor: 1 },
  schedules: [],
  lastRuns: [],
  periodStats: {},
  skipPeriods: [],
  createdBy: "usuario",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const trackingRoutine: Routine = {
  ...metaRoutine,
  id: "R-0002",
  type: "acompanhamento",
  title: "Inscrições",
  kind: "other",
  site: "",
  unit: "item",
  goal: undefined as never,
  tracking: {
    fields: [
      { key: "empresa", label: "Empresa", type: "texto", required: true },
      { key: "link", label: "Link", type: "link" },
    ],
    statuses: [{ name: "Inscrito" }, { name: "Entrevista", alert: true }, { name: "Recusado", terminal: true }],
    lifespan: { days: 15, untilTerminal: true },
    expireStatus: "Recusado",
    checkEveryHours: 24,
  },
  schedules: [{ id: "S1", label: "Manhã", days: { kind: "todo_dia" }, times: ["08:00"], action: "Procurar novidades", enabled: true, scope: "geral" }],
};

describe("modelos", () => {
  it("há um modelo de Meta semanal e um de Acompanhar inscrições, prontos para criar", () => {
    expect(ROUTINE_TEMPLATES.map((t) => [t.id, t.type])).toEqual([
      ["meta-semanal", "meta"],
      ["inscricoes", "acompanhamento"],
      ["post-semanal", "meta"],
      ["comentarios", "meta"],
      ["convites", "meta"],
    ]);
    for (const id of ["meta-semanal", "inscricoes"]) {
      const form = { ...templateToForm(template(id)), owner: "agent:eco" };
      expect(hasFormErrors(validateRoutineForm(form, false))).toBe(false);
      expect(createRoutineBodySchema.safeParse(toCreateBody(form)).success).toBe(true);
    }
    expect(templateToForm(template("meta-semanal"))).toMatchObject({ target: "3", prepareFactor: "2", stopOnHit: true });
    const inscricoes = templateToForm(template("inscricoes"));
    expect(inscricoes.schedules).toHaveLength(2);
    expect(inscricoes.statuses.map((s) => s.name)).toEqual(["Inscrito", "Em análise", "Entrevista", "Oferta", "Recusado", "Sem resposta"]);
  });
});

describe("validação do formulário", () => {
  it("meta: campos obrigatórios", () => {
    const form = emptyRoutineForm("meta");
    const found = validateRoutineForm(form, false).fields;
    expect(found).toMatchObject({ title: expect.any(String), owner: "Escolha quem executa.", unit: expect.any(String), site: expect.any(String) });
    expect(found.target).toBeUndefined();
    const ok = { ...form, title: "Posts", unit: "post", site: "linkedin.com", owner: "team:t1" };
    expect(hasFormErrors(validateRoutineForm(ok, false))).toBe(false);
    expect(validateRoutineForm({ ...ok, target: "0", dailyCap: "-3", site: "x" }, false).fields).toMatchObject({ target: expect.any(String), dailyCap: expect.any(String), site: expect.any(String) });
  });

  it("acompanhamento: horário, colunas e status", () => {
    const base = { ...templateToForm(template("inscricoes")), owner: "agent:eco" };
    expect(validateRoutineForm({ ...base, schedules: [] }, false).fields.schedules).toBe("O acompanhamento precisa de pelo menos um horário.");
    const bad = validateRoutineForm({ ...base, schedules: [emptySchedule({ action: "" })], fields: [{ key: "", label: "", type: "texto", options: "", required: false, locked: false }, { key: "", label: "Empresa", type: "opcao", options: "", required: false, locked: false }], statuses: [{ name: "A", terminal: false, alert: false, locked: false }, { name: "a", terminal: false, alert: false, locked: false }], lifespanDays: "0", checkEveryHours: "x" }, false);
    expect(bad.schedules[0]).toMatchObject({ action: expect.any(String) });
    expect(bad.trackingFields).toEqual(["Dê um nome à coluna.", "Liste as opções, separadas por vírgula."]);
    expect(bad.trackingStatuses).toEqual(["", "Já existe um status com esse nome."]);
    expect(bad.fields).toMatchObject({ lifespanDays: expect.any(String), checkEveryHours: expect.any(String) });
    expect(validateRoutineForm({ ...base, expireStatus: "Inexistente" }, false).fields.expireStatus).toBeTruthy();
    expect(validateRoutineForm({ ...base, lifespanDays: "", expireStatus: "Sem resposta" }, false).fields.expireStatus).toBeTruthy();
  });

  it("chave do campo sai do rótulo, sem acento e sem repetir", () => {
    expect(fieldKeyFor("Inscrito em")).toBe("inscritoEm");
    expect(fieldKeyFor("Vaga disponível?")).toBe("vagaDisponivel");
    expect(fieldKeyFor("Empresa", ["empresa"])).toBe("empresa2");
    expect(fieldKeyFor("1º contato")).toBe("campo1Contato");
  });
});

describe("corpo de criação", () => {
  it("meta: dono, teto do tipo, período, dias preferidos e preparo", () => {
    const form = { ...templateToForm(template("convites")), owner: "team:t1", target: "200", dailyCap: "5", period: "week" as const, preferredDays: [5, 2] as (1 | 2 | 3 | 4 | 5 | 6 | 7)[], prepareFactor: "2" };
    const body = toCreateBody(form);
    expect(body).toMatchObject({ type: "meta", teamId: "t1", target: 60, dailyCap: 5, kind: "invite", needsApproval: true, goal: { target: 60, period: "week", preferredDays: [2, 5], stopOnHit: true, prepareFactor: 2 } });
    expect(toCreateBody({ ...form, owner: "agent:a1", dailyCap: "" })).not.toHaveProperty("dailyCap");
    expect(toCreateBody({ ...form, owner: "agent:a1" })).toMatchObject({ agentId: "a1" });
  });

  it("acompanhamento: esquema, vida do item e horários", () => {
    const body = toCreateBody({ ...templateToForm(template("inscricoes")), owner: "agent:eco" });
    expect(body).toMatchObject({ type: "acompanhamento", agentId: "eco", unit: "item" });
    expect(body.tracking).toMatchObject({
      fields: [{ key: "empresa", label: "Empresa", type: "texto", required: true }, { key: "vaga" }, { key: "link", type: "link" }, { key: "inscritoEm", type: "data" }],
      lifespan: { days: 15, untilTerminal: true },
      expireStatus: "Sem resposta",
      checkEveryHours: 24,
    });
    expect(body.tracking?.statuses?.[2]).toEqual({ name: "Entrevista", alert: true });
    expect(body.tracking?.statuses?.[3]).toEqual({ name: "Oferta", terminal: true, alert: true });
    expect(body.schedules).toHaveLength(2);
    expect(body.schedules?.[1]).toMatchObject({ times: ["10:00"], scope: "itens_vencidos" });
  });
});

describe("corpo de edição", () => {
  it("meta: só o que mudou", () => {
    const base = routineToForm(metaRoutine);
    expect(toUpdateBody(base, metaRoutine)).toEqual({});
    expect(toUpdateBody({ ...base, target: "12", needsApproval: false }, metaRoutine)).toEqual({ target: 12, needsApproval: false });
    expect(toUpdateBody({ ...base, owner: "team:t9" }, metaRoutine)).toEqual({ teamId: "t9", agentId: null });
    expect(toUpdateBody({ ...base, dailyCap: "4" }, metaRoutine)).toEqual({ dailyCap: 4 });
    // O site e o tipo de atividade agora também se editam (o site vai normalizado).
    expect(toUpdateBody({ ...base, site: " WWW.Instagram.com " }, metaRoutine)).toEqual({ site: "instagram.com" });
    expect(toUpdateBody({ ...base, kind: base.kind === "post" ? "comment" : "post" }, metaRoutine)).toMatchObject({ kind: base.kind === "post" ? "comment" : "post" });
    expect(validateRoutineForm({ ...base, site: "https://x" }, true).fields.site).toBeTruthy();
    expect(toUpdateBody({ ...base, period: "month", preferredDays: [1, 3], stopOnHit: false, prepareFactor: "3" }, metaRoutine)).toMatchObject({ goal: { period: "month", preferredDays: [1, 3], stopOnHit: false, prepareFactor: 3 } });
    expect(toUpdateBody({ ...base, preferredDays: [] }, { ...metaRoutine, goal: { ...metaRoutine.goal!, preferredDays: [2] } })).toEqual({ goal: { preferredDays: null } });
  });

  it("horário acrescentado leva a lista inteira, com os ids dos que existem", () => {
    const base = routineToForm(trackingRoutine);
    expect(toUpdateBody(base, trackingRoutine)).toEqual({});
    const body = toUpdateBody({ ...base, schedules: [...base.schedules, emptySchedule({ label: "Tarde", action: "Conferir", times: ["16:00"] })] }, trackingRoutine);
    expect(body.schedules).toHaveLength(2);
    expect(body.schedules?.[0]).toMatchObject({ id: "S1" });
    expect(body.schedules?.[1]).not.toHaveProperty("id");
    expect(updateRoutineBodySchema.safeParse(body).success).toBe(true);
  });

  it("acompanhamento: status e coluna só se acrescentam (os existentes ficam travados e na frente)", () => {
    const base = routineToForm(trackingRoutine);
    expect(base.fields.every((f) => f.locked) && base.statuses.every((s) => s.locked)).toBe(true);
    const body = toUpdateBody(
      {
        ...base,
        statuses: [...base.statuses, { name: "Oferta", terminal: true, alert: true, locked: false }],
        fields: [...base.fields, { key: "", label: "Salário", type: "numero", options: "", required: false, locked: false }],
        lifespanDays: "30",
        expireStatus: "",
        checkEveryHours: "",
      },
      trackingRoutine,
    );
    expect(body.tracking?.statuses?.map((s) => s.name)).toEqual(["Inscrito", "Entrevista", "Recusado", "Oferta"]);
    expect(body.tracking?.fields?.map((f) => f.key)).toEqual(["empresa", "link", "salario"]);
    expect(body.tracking).toMatchObject({ lifespan: { days: 30, untilTerminal: true }, expireStatus: null, checkEveryHours: null });
    expect(updateRoutineBodySchema.safeParse(body).success).toBe(true);
  });
});

describe("prévia da meta", () => {
  it("frase com plural, dias preferidos, preparo e parada", () => {
    const form = { ...emptyRoutineForm("meta"), unit: "frase", target: "3", prepareFactor: "2", preferredDays: [2, 4] as (1 | 2 | 3 | 4 | 5 | 6 | 7)[] };
    expect(metaPreview(form)).toBe("3 frases por semana, preferindo ter, qui; prepara 2x mais opções para você escolher; para quando bater o alvo.");
    expect(metaPreview({ ...emptyRoutineForm("meta"), unit: "post", target: "1", stopOnHit: false, period: "month" })).toBe("1 post por mês, continua depois de bater o alvo.");
    expect(metaPreview({ ...emptyRoutineForm("meta"), unit: "convite", kind: "invite", target: "200" })).toContain("limitado de 200");
    expect(metaPreview({ ...emptyRoutineForm("meta"), unit: "post", target: "x" })).toBe("Defina o alvo para ver a prévia.");
  });
});
