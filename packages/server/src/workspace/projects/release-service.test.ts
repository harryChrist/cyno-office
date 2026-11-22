import { PLANNED_NOTE, projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { applyReleasePace, holdNodes, normalizeReleasePace, releaseNodes } from "./release-service";

/** Testes unitários de `release-service.ts`: mutações em memória de liberar, segurar, validar e rodar o ritmo diário. */
const AT = "2026-11-11T15:00:00.000Z";
const NOON = Date.parse(AT);
const DAY = 86_400_000;

function task(ref: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return {
    ref,
    title: `Tarefa ${ref}`,
    briefing: "faça",
    ownerId: extra.group ? "" : "eco",
    steps: extra.group ? [] : [{ agentId: "eco", what: "faz", status: "pendente" }],
    current: 0,
    dependsOn: [],
    priority: "normal",
    doneWhen: [],
    status: "a_fazer",
    rework: { count: 0 },
    updatedAt: AT,
    ...extra,
  };
}

const mod = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { group: true, status: "backlog", released: false, ...extra });
const planned = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { released: false, note: PLANNED_NOTE, ...extra });

function project(tasks: ProjectTask[], extra: Partial<Project> = {}): Project {
  return {
    ...projectDefaults(),
    id: "p1",
    kind: "projeto",
    origin: "usuario",
    title: "Marrow",
    status: "ativo",
    version: 1,
    tasks,
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

const byRef = (p: Project, ref: string) => p.tasks.find((item) => item.ref === ref)!;

describe("releaseNodes", () => {
  it("libera folha, contêiner com subcontêineres (herança) e ignora já liberada/em andamento/terminada", () => {
    const p = project([
      mod("M1"),
      mod("M1a", { parent: "M1" }),
      planned("A", { parent: "M1a" }),
      task("B", { parent: "M1a", status: "em_andamento", released: false }),
      planned("C", { parent: "M1a", status: "concluida" }),
      task("D", { parent: "M1a", released: true }),
      planned("E"),
    ]);
    const changed = releaseNodes(p, ["M1"], { withPrerequisites: false }, AT);
    expect(changed).toEqual(["A"]);
    expect(byRef(p, "A")).toMatchObject({ released: true, queuedAt: AT, waitingSince: AT });
    expect(byRef(p, "A").note).toBeUndefined();
    expect(byRef(p, "M1").released).toBe(true);
    expect(byRef(p, "M1a").released).toBe(true);
    expect(byRef(p, "E").released).toBe(false);
  });

  it("withPrerequisites leva o fecho transitivo (inclusive módulo de que depende) e atualiza o módulo ancestral", () => {
    const p = project([
      mod("M1"),
      planned("A", { parent: "M1" }),
      planned("B", { parent: "M1" }),
      mod("M2", { dependsOn: ["M1"] }),
      planned("C", { parent: "M2" }),
    ]);
    const changed = releaseNodes(p, ["C"], { withPrerequisites: true }, AT);
    expect(changed.sort()).toEqual(["A", "B", "C"]);
    expect(byRef(p, "M1").released).toBe(true);
    expect(byRef(p, "M2").released).toBe(true);
  });

  it('"all" libera todas as folhas Planejadas e todos os contêineres', () => {
    const p = project([mod("M1"), planned("A", { parent: "M1" }), planned("B")]);
    expect(releaseNodes(p, "all", { withPrerequisites: false }, AT)).toEqual(["A", "B"]);
    expect(p.tasks.every((item) => item.released === true)).toBe(true);
  });
});

describe("holdNodes", () => {
  it("segura folhas que não começaram, tira queuedAt, grava a nota e devolve ignoradas com o motivo", () => {
    const p = project([
      mod("M1", { released: true }),
      task("A", { parent: "M1", released: true, queuedAt: AT }),
      task("B", { parent: "M1", released: true, status: "em_andamento" }),
      task("C", { parent: "M1", released: true, status: "concluida" }),
      task("D", { released: true, status: "concluida" }),
    ]);
    const res = holdNodes(p, ["M1", "D"], AT);
    expect(res.held).toEqual(["A"]);
    expect(res.ignored).toEqual([
      { ref: "B", title: "Tarefa B", reason: "já está em andamento" },
      { ref: "D", title: "Tarefa D", reason: "já terminou" },
    ]);
    expect(byRef(p, "A")).toMatchObject({ released: false, note: PLANNED_NOTE });
    expect(byRef(p, "A").queuedAt).toBeUndefined();
    expect(byRef(p, "B")).toMatchObject({ released: true, status: "em_andamento" });
    expect(byRef(p, "M1").released).toBe(false);
  });
});

describe("normalizeReleasePace", () => {
  it("valida 1..500, unidade e dia real; preserva `given` existente", () => {
    expect(() => normalizeReleasePace({ perDay: 0, unit: "tarefas" })).toThrow(/1 a 500/);
    expect(() => normalizeReleasePace({ perDay: 501, unit: "tarefas" })).toThrow(/1 a 500/);
    expect(() => normalizeReleasePace({ perDay: 2.5, unit: "tarefas" })).toThrow(/1 a 500/);
    expect(() => normalizeReleasePace({ perDay: 2, unit: "horas" })).toThrow(/tarefas ou módulos/);
    expect(() => normalizeReleasePace({ perDay: 2, unit: "tarefas", startsOn: "2026-02-31" })).toThrow(/AAAA-MM-DD/);
    const existing = { perDay: 1, unit: "tarefas" as const, given: { day: "2026-11-11", count: 1 } };
    expect(normalizeReleasePace({ perDay: 5, unit: "modulos", startsOn: "2026-11-12" }, existing)).toEqual({
      perDay: 5,
      unit: "modulos",
      startsOn: "2026-11-12",
      given: { day: "2026-11-11", count: 1 },
    });
  });
});

describe("applyReleasePace", () => {
  it("libera até perDay, respeita idempotência no mesmo dia, vira o dia e para de acordar ao acabar as Planejadas", () => {
    const p = project([planned("A"), planned("B"), planned("C")], { releasePace: { perDay: 2, unit: "tarefas" } });
    const first = applyReleasePace(p, NOON, AT);
    expect(first).toEqual({ released: ["A", "B"], units: 2, wakeAt: Date.parse("2026-11-12T03:00:00.000Z") });
    expect(p.releasePace?.given).toEqual({ day: "2026-11-11", count: 2 });
    // Repetir no mesmo dia: nada sai, mas ainda acorda na virada.
    const sameDay = applyReleasePace(p, NOON + 60_000, AT);
    expect(sameDay).toEqual({ released: [], units: 0, wakeAt: Date.parse("2026-11-12T03:00:00.000Z") });
    // Dia seguinte: sai a última (C) e não sobra despertar.
    const nextDay = applyReleasePace(p, NOON + DAY, new Date(NOON + DAY).toISOString());
    expect(nextDay).toEqual({ released: ["C"], units: 1 });
    expect(p.releasePace?.given).toEqual({ day: "2026-11-12", count: 1 });
  });

  it("projeto pausado, startsOn futuro e janela fechada não liberam", () => {
    const paused = project([planned("A")], { status: "pausado", releasePace: { perDay: 1, unit: "tarefas" } });
    expect(applyReleasePace(paused, NOON, AT)).toEqual({ released: [], units: 0 });
    const future = project([planned("A")], { releasePace: { perDay: 1, unit: "tarefas", startsOn: "2026-11-15" } });
    expect(applyReleasePace(future, NOON, AT)).toEqual({ released: [], units: 0, wakeAt: Date.parse("2026-11-12T03:00:00.000Z") });
    const closed = project([planned("A")], { pace: { window: { from: "14:00", to: "18:00" } }, releasePace: { perDay: 1, unit: "tarefas" } });
    expect(applyReleasePace(closed, NOON, AT)).toEqual({ released: [], units: 0, wakeAt: Date.parse("2026-11-11T17:00:00.000Z") });
  });
});
