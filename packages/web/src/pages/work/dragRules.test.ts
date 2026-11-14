import { projectDefaults, type Project, type ProjectTask, type Sprint } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { canDragToSprint, sprintDrop, treeDrop, zoneAt } from "./dragRules";

const AT = "2026-11-10T12:00:00.000Z";
const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "fazer", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  ...extra,
});
const group = (ref: string, order: number): ProjectTask => task(ref, { group: true, steps: [], ownerId: "", status: "backlog", order });
const sprint = (id: string, order: number, status: Sprint["status"]): Sprint => ({ id, name: `Sprint ${order}`, startAt: AT, endAt: AT, order, status });

/**
 * G1 (entregável)
 *   A  (tarefa-mãe)
 *     A1
 *       A1x  (profundidade 4? não: A1 é neta, A1x não existe)
 *     A2
 *   B
 * G2 (entregável, vazio)
 * C  (tarefa direto no projeto)
 */
const sample = (): Project => ({
  ...projectDefaults(),
  id: "p",
  title: "Projeto",
  status: "ativo",
  version: 1,
  labels: [],
  sprints: [sprint("S1", 1, "ativa"), sprint("S2", 2, "planejada"), sprint("S0", 0, "fechada")],
  createdAt: AT,
  updatedAt: AT,
  tasks: [
    group("G1", 1000),
    task("A", { parent: "G1", order: 1000, steps: [], ownerId: "", status: "backlog" }),
    task("A1", { parent: "A", order: 1000, sprintId: "S1" }),
    task("A2", { parent: "A", order: 2000, sprintId: "S0" }),
    task("B", { parent: "G1", order: 2000 }),
    group("G2", 2000),
    task("C", { order: 3000, status: "em_andamento" }),
    task("D", { order: 4000, status: "concluida" }),
  ],
});

describe("treeDrop", () => {
  const project = sample();

  it("reordenar entre irmãs: antes e depois", () => {
    expect(treeDrop(project, "B", "A", "before")).toMatchObject({ ok: true, move: { parent: "G1", before: "A" } });
    expect(treeDrop(project, "A", "B", "after")).toMatchObject({ ok: true, move: { parent: "G1", before: null } });
    expect(treeDrop(project, "A2", "A1", "before")).toMatchObject({ ok: true, move: { parent: "A", before: "A1" } });
  });

  it("soltar onde já está não faz nada e não avisa", () => {
    expect(treeDrop(project, "A", "B", "before")).toMatchObject({ ok: false, reason: "" });
    expect(treeDrop(project, "B", "A", "after")).toMatchObject({ ok: false, reason: "" });
    expect(treeDrop(project, "A", "A", "inside")).toMatchObject({ ok: false, reason: "" });
  });

  it("mudar de pai: sobre um entregável ou uma tarefa", () => {
    expect(treeDrop(project, "C", "G2", "inside")).toMatchObject({ ok: true, move: { parent: "G2", before: null } });
    expect(treeDrop(project, "B", "G2", "inside")).toMatchObject({ ok: true, move: { parent: "G2", before: null } });
    expect(treeDrop(project, "B", "A", "inside")).toMatchObject({ ok: true, move: { parent: "A", before: null } });
  });

  it("antes de uma linha de outro pai muda de pai para o dela", () => {
    expect(treeDrop(project, "C", "A1", "before")).toMatchObject({ ok: true, move: { parent: "A", before: "A1" } });
    expect(treeDrop(project, "A1", "C", "after")).toMatchObject({ ok: true, move: { parent: null, before: "D" } });
  });

  it("não solta dentro de si mesma nem num filho dela", () => {
    expect(treeDrop(project, "A", "A1", "inside")).toMatchObject({ ok: false, reason: "Não dá para soltar dentro dela mesma." });
    expect(treeDrop(project, "A", "A2", "after")).toMatchObject({ ok: false, reason: "Não dá para soltar dentro dela mesma." });
    expect(treeDrop(project, "G1", "A", "inside")).toMatchObject({ ok: false });
  });

  it("entregável só na raiz", () => {
    expect(treeDrop(project, "G2", "B", "before")).toMatchObject({ ok: false, reason: "Entregável só fica direto no projeto." });
    expect(treeDrop(project, "G2", "C", "inside")).toMatchObject({ ok: false, reason: "Entregável só fica direto no projeto." });
    expect(treeDrop(project, "G2", "G1", "before")).toMatchObject({ ok: true, move: { parent: null, before: "G1" } });
    expect(treeDrop(project, "G1", "C", "after")).toMatchObject({ ok: true, move: { parent: null, before: "D" } });
  });

  it("respeita a profundidade máxima (3 níveis)", () => {
    // A1 está no nível 3 (G1 › A › A1): nada cabe dentro dele; A (altura 2) não cabe dentro de B (nível 2).
    expect(treeDrop(project, "B", "A1", "inside")).toMatchObject({ ok: false, reason: "Passa do limite de 3 níveis." });
    expect(treeDrop(project, "A", "B", "inside")).toMatchObject({ ok: false, reason: "Passa do limite de 3 níveis." });
    // Mas A pode ir para a raiz (altura 2 + 0).
    expect(treeDrop(project, "A", "C", "before")).toMatchObject({ ok: true, move: { parent: null, before: "C" } });
    // E uma folha cabe no nível 3, ao lado de A1.
    expect(treeDrop(project, "B", "A2", "after")).toMatchObject({ ok: true, move: { parent: "A", before: null } });
  });

  it("tarefa que já começou não vira mãe", () => {
    expect(treeDrop(project, "B", "C", "inside")).toMatchObject({ ok: false, reason: "Essa tarefa já começou: não dá para dividir em subtarefas." });
    // Ao lado dela pode.
    expect(treeDrop(project, "B", "C", "after")).toMatchObject({ ok: true, move: { parent: null, before: "D" } });
  });

  it("linha que não existe (arquivada) não aceita", () => {
    const archived = { ...project, tasks: project.tasks.map((item) => (item.ref === "B" ? { ...item, archived: true as const } : item)) };
    expect(treeDrop(archived, "A", "B", "before")).toMatchObject({ ok: false, reason: "" });
  });
});

describe("zoneAt", () => {
  it("quarto de cima, meio e quarto de baixo", () => {
    expect(zoneAt(101, 100, 40, true)).toBe("before");
    expect(zoneAt(120, 100, 40, true)).toBe("inside");
    expect(zoneAt(139, 100, 40, true)).toBe("after");
    expect(zoneAt(120, 100, 40, false)).toBe("after");
    expect(zoneAt(110, 100, 40, false)).toBe("before");
  });
});

describe("sprintDrop", () => {
  const project = sample();

  it("muda a sprint, inclusive para Sem sprint", () => {
    expect(sprintDrop(project, "A1", "S2")).toEqual({ ok: true, sprintId: "S2" });
    expect(sprintDrop(project, "A1", null)).toEqual({ ok: true, sprintId: null });
    expect(sprintDrop(project, "B", "S1")).toEqual({ ok: true, sprintId: "S1" });
  });

  it("sprint fechada não aceita; a mesma sprint não faz nada", () => {
    expect(sprintDrop(project, "A1", "S0")).toMatchObject({ ok: false, reason: expect.stringContaining("já fechou") });
    expect(sprintDrop(project, "A1", "S1")).toMatchObject({ ok: false, reason: "" });
    expect(sprintDrop(project, "B", null)).toMatchObject({ ok: false, reason: "" });
  });

  it("tarefa que terminou fica onde terminou; pai e entregável não entram", () => {
    expect(sprintDrop(project, "D", "S1")).toMatchObject({ ok: false, reason: expect.stringContaining("já terminou") });
    expect(sprintDrop(project, "A", "S1")).toMatchObject({ ok: false });
    expect(sprintDrop(project, "G1", "S1")).toMatchObject({ ok: false });
  });

  it("quem pode ser pego para arrastar", () => {
    expect(canDragToSprint(project, "A1")).toBe(true);
    expect(canDragToSprint(project, "D")).toBe(false);
    expect(canDragToSprint(project, "A")).toBe(false);
  });
});
