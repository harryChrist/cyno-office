import { describe, expect, it } from "vitest";
import { projectSchema } from "./api";
import { projectProgress, type Project, type ProjectTask, type ProjectTaskStatus } from "./projects";
import type { Sprint } from "./sprints";
import { assigneeCount, assigneesOf, childrenOf, depthOf, isLeaf, leafTasks, leavesOf, pathOf, rollupStatus, sprintProgress, statusOf, treeProgress, validateTree } from "./task-tree";

const at = "2026-11-11T12:00:00.000Z";

function task(ref: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  const owner = extra.ownerId ?? "eco";
  return {
    ref,
    title: `Tarefa ${ref}`,
    briefing: "faça",
    ownerId: owner,
    steps: extra.group ? [] : [{ agentId: owner, what: "faz", status: "pendente" }],
    current: 0,
    dependsOn: [],
    priority: "normal",
    doneWhen: [],
    status: "a_fazer",
    rework: { count: 0 },
    updatedAt: at,
    ...extra,
  };
}

const sprint = (id: string, order: number): Sprint => ({ id, name: `Sprint ${order}`, startAt: at, endAt: at, order, status: "planejada" });
const proj = (tasks: ProjectTask[], extra: Partial<Project> = {}): Pick<Project, "tasks" | "sprints" | "labels"> => ({ tasks, ...extra });

describe("rollupStatus (estado calculado do pai e do entregável)", () => {
  const cases: [string, ProjectTaskStatus[], ProjectTaskStatus][] = [
    ["sem filhas", [], "backlog"],
    ["todas concluídas", ["concluida", "concluida"], "concluida"],
    ["concluídas e canceladas: a mãe fica com pendência", ["concluida", "cancelada"], "esperando_voce"],
    ["só canceladas", ["cancelada", "cancelada"], "cancelada"],
    ["alguma em andamento vence tudo", ["concluida", "em_andamento", "falhou", "esperando_voce"], "em_andamento"],
    ["esperando você vence falhou", ["a_fazer", "esperando_voce", "falhou"], "esperando_voce"],
    ["falhou vence a fazer", ["a_fazer", "falhou", "concluida"], "falhou"],
    ["uma concluída e o resto pendente", ["concluida", "a_fazer", "backlog"], "em_andamento"],
    ["uma concluída e o resto em backlog", ["concluida", "backlog"], "em_andamento"],
    ["alguma a fazer", ["a_fazer", "backlog"], "a_fazer"],
    ["só backlog", ["backlog", "backlog"], "backlog"],
    ["cancelada e a fazer", ["cancelada", "a_fazer"], "a_fazer"],
  ];
  it.each(cases)("%s", (_name, statuses, expected) => {
    expect(rollupStatus(statuses.map((status) => ({ status })))).toBe(expected);
  });
});

describe("estado na árvore", () => {
  it("o pai e o entregável vêm das filhas, de baixo para cima", () => {
    const project = proj([
      task("G1", { group: true }),
      task("T1", { parent: "G1" }),
      task("T2", { parent: "T1", status: "concluida" }),
      task("T3", { parent: "T1", status: "concluida" }),
      task("T4", { parent: "G1", status: "em_andamento" }),
    ]);
    expect(statusOf(project, project.tasks[2]!)).toBe("concluida");
    expect(statusOf(project, project.tasks[1]!)).toBe("concluida");
    expect(statusOf(project, project.tasks[0]!)).toBe("em_andamento");
  });
  it("entregável sem filhas fica em backlog; folha devolve o estado gravado", () => {
    const project = proj([task("G1", { group: true }), task("T1", { status: "falhou" })]);
    expect(statusOf(project, project.tasks[0]!)).toBe("backlog");
    expect(statusOf(project, project.tasks[1]!)).toBe("falhou");
  });
});

describe("folhas, filhas, profundidade e caminho", () => {
  const project = proj([
    task("G1", { group: true, order: 2000 }),
    task("T1", { parent: "G1", order: 2000 }),
    task("T2", { parent: "G1", order: 1000 }),
    task("T3", { parent: "T1" }),
    task("T9"),
  ]);
  it("lista plana (sem pai) é toda folha, na ordem da lista", () => {
    const flat = proj([task("T1"), task("T2")]);
    expect(leavesOf(flat).map((leaf) => leaf.ref)).toEqual(["T1", "T2"]);
    expect(leafTasks(flat.tasks).map((leaf) => leaf.ref)).toEqual(["T1", "T2"]);
  });
  it("childrenOf ordena por order", () => {
    expect(childrenOf(project, "G1").map((child) => child.ref)).toEqual(["T2", "T1"]);
    expect(childrenOf(project).map((child) => child.ref)).toEqual(["G1", "T9"]);
  });
  it("leavesOf do projeto e da subárvore; folha devolve ela mesma", () => {
    expect(leavesOf(project).map((leaf) => leaf.ref).sort()).toEqual(["T2", "T3", "T9"]);
    expect(leavesOf(project, "G1").map((leaf) => leaf.ref)).toEqual(["T2", "T3"]);
    expect(leavesOf(project, "T9").map((leaf) => leaf.ref)).toEqual(["T9"]);
    expect(leavesOf(project, "nada")).toEqual([]);
  });
  it("isLeaf: entregável e pai não são folha", () => {
    expect(isLeaf(project, project.tasks[0]!)).toBe(false);
    expect(isLeaf(project, project.tasks[1]!)).toBe(false);
    expect(isLeaf(project, project.tasks[3]!)).toBe(true);
  });
  it("depthOf e pathOf", () => {
    expect(depthOf(project, "T9")).toBe(1);
    expect(depthOf(project, "G1")).toBe(1);
    expect(depthOf(project, "T3")).toBe(3);
    expect(depthOf(project, "x")).toBe(0);
    expect(pathOf(project, "T3").map((node) => node.ref)).toEqual(["G1", "T1", "T3"]);
  });
  it("profundidade de um ciclo é infinita (e não trava)", () => {
    const cycle = proj([task("A", { parent: "B" }), task("B", { parent: "A" })]);
    expect(depthOf(cycle, "A")).toBe(Number.POSITIVE_INFINITY);
    expect(pathOf(cycle, "A").length).toBe(2);
    expect(leavesOf(cycle)).toEqual([]);
  });
});

describe("responsáveis derivados", () => {
  const project = proj([
    task("T1", { ownerId: "eco", steps: [{ agentId: "eco", what: "a", status: "pendente" }, { agentId: "crivo", what: "b", status: "pendente" }] }),
    task("P", { ownerId: "" , steps: [] }),
    task("F1", { parent: "P", ownerId: "sol" }),
    task("F2", { parent: "P", ownerId: "eco" }),
    task("F3", { parent: "P", ownerId: "radar" }),
    task("F4", { parent: "P", ownerId: "beto" }),
  ]);
  it("dono e etapas, sem repetir", () => {
    expect(assigneesOf(project, project.tasks[0]!)).toEqual(["eco", "crivo"]);
  });
  it("pai: os das filhas na ordem, com teto de 3 e a contagem total para o +N", () => {
    const parent = project.tasks[1]!;
    expect(assigneesOf(project, parent)).toEqual(["sol", "eco", "radar"]);
    expect(assigneeCount(project, parent)).toBe(4);
    expect(assigneesOf(project, parent, 10)).toEqual(["sol", "eco", "radar", "beto"]);
  });
  it("ignora dono vazio", () => {
    const empty = proj([task("G", { group: true, ownerId: "" })]);
    expect(assigneesOf(empty, empty.tasks[0]!)).toEqual([]);
  });
});

describe("validateTree", () => {
  const ok = (p: ReturnType<typeof proj>) => validateTree(p).errors;
  it("projeto plano de hoje é válido", () => {
    expect(ok(proj([task("T1"), task("T2", { dependsOn: ["T1"] })]))).toEqual([]);
  });
  it("árvore de 3 níveis é válida", () => {
    expect(ok(proj([task("G", { group: true }), task("T", { parent: "G" }), task("S", { parent: "T" })]))).toEqual([]);
  });
  it("profundidade 4 é recusada", () => {
    const errors = ok(proj([task("G", { group: true }), task("T", { parent: "G" }), task("S", { parent: "T" }), task("X", { parent: "S" })]));
    expect(errors.join("\n")).toMatch(/Task X: nested 4 levels/);
  });
  it("entregável só em profundidade 1 e sem steps", () => {
    expect(ok(proj([task("T"), task("G", { group: true, parent: "T" })])).join("\n")).toMatch(/Task G: a deliverable \(group\) can only sit directly under the project/);
    expect(ok(proj([task("G", { group: true, steps: [{ agentId: "eco", what: "x", status: "pendente" }] })])).join("\n")).toMatch(/has no steps/);
  });
  it("folha sem steps é inválida; o pai pode não ter", () => {
    expect(ok(proj([task("T", { steps: [] })])).join("\n")).toMatch(/leaf task needs at least one step/);
    expect(ok(proj([task("P", { steps: [] }), task("F", { parent: "P" })]))).toEqual([]);
  });
  it("pai inexistente, ele mesmo e ciclo", () => {
    expect(ok(proj([task("T", { parent: "Z" })])).join("\n")).toMatch(/parent "Z" does not exist/);
    expect(ok(proj([task("T", { parent: "T" })])).join("\n")).toMatch(/own parent/);
    const cycle = ok(proj([task("A", { parent: "B" }), task("B", { parent: "A" })]));
    expect(cycle.filter((error) => /cycle/.test(error)).length).toBe(2);
  });
  it("sprintId inexistente ou em quem não é folha", () => {
    const sprints = [sprint("S1", 1)];
    expect(ok(proj([task("T", { sprintId: "S9" })], { sprints })).join("\n")).toMatch(/sprint "S9" does not exist/);
    expect(ok(proj([task("P", { sprintId: "S1", steps: [] }), task("F", { parent: "P", sprintId: "S1" })], { sprints })).join("\n")).toMatch(/only leaf tasks go in a sprint/);
    expect(ok(proj([task("T", { sprintId: "S1" })], { sprints }))).toEqual([]);
  });
  it("sem limite de agentes por tarefa: 5 subtarefas de agentes diferentes passam; mais de 12 subtarefas é o teto técnico", () => {
    const kids = (count: number) => Array.from({ length: count }, (_, index) => task(`F${index}`, { parent: "P", ownerId: `ag${index}` }));
    const base = [task("G", { group: true }), task("P", { parent: "G", steps: [], ownerId: "" })];
    expect(ok(proj([...base, ...kids(5)]))).toEqual([]);
    expect(ok(proj([...base, ...kids(12)]))).toEqual([]);
    expect(ok(proj([...base, ...kids(13)])).join("\n")).toMatch(/Task P: 13 subtasks \(at most 12 per task/);
  });
  it("entregável não tem limite de agentes", () => {
    const kids = ["a", "b", "c", "d", "e"].map((agent, index) => task(`F${index}`, { parent: "G", ownerId: agent }));
    expect(ok(proj([task("G", { group: true }), ...kids]))).toEqual([]);
  });
  it("dependência de um descendante é recusada", () => {
    const errors = ok(proj([task("P", { steps: [], dependsOn: ["F"] }), task("F", { parent: "P" })]));
    expect(errors.join("\n")).toMatch(/depends on its own descendant "F"/);
  });
  it("dependência de sprint posterior só avisa", () => {
    const sprints = [sprint("S1", 1), sprint("S2", 2)];
    const result = validateTree(proj([task("A", { sprintId: "S1", dependsOn: ["B"] }), task("B", { sprintId: "S2" })], { sprints }));
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/A is in Sprint 1 and depends on B, which is in Sprint 2/);
  });
  it("etiquetas: teto por tarefa e existência", () => {
    const labels = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, name: id, color: "azul" }));
    expect(ok(proj([task("T", { labels: ["a", "b", "c", "d", "e", "f"] })], { labels })).join("\n")).toMatch(/at most 5 labels/);
    expect(ok(proj([task("T", { labels: ["zz"] })], { labels })).join("\n")).toMatch(/label "zz" does not exist/);
  });
  it("tetos: 200 nós e 40 filhas", () => {
    const many = Array.from({ length: 201 }, (_, index) => task(`T${index}`));
    expect(ok(proj(many)).join("\n")).toMatch(/At most 200 nodes/);
    const kids = Array.from({ length: 41 }, (_, index) => task(`K${index}`, { parent: "G" }));
    expect(ok(proj([task("G", { group: true }), ...kids])).join("\n")).toMatch(/Task G has 41 children/);
  });
});

describe("progresso", () => {
  const project = proj([
    task("G", { group: true }),
    task("A", { parent: "G", status: "concluida" }),
    task("B", { parent: "G", status: "concluida", skipped: true }),
    task("C", { parent: "G", status: "cancelada" }),
    task("D", { parent: "G", status: "em_andamento", sprintId: "S1" }),
    task("E", { sprintId: "S1", status: "concluida" }),
  ]);
  it("conta só folhas, sem canceladas nem puladas", () => {
    expect(treeProgress(project)).toEqual({ done: 2, total: 3, skipped: 1 });
    expect(treeProgress(project, "G")).toEqual({ done: 1, total: 2, skipped: 1 });
  });
  it("projectProgress passa a contar folhas (o entregável não conta nem duas vezes)", () => {
    expect(projectProgress(project)).toEqual({ done: 2, total: 3, skipped: 1 });
    expect(projectProgress({ tasks: [task("T1"), task("T2", { status: "concluida" })] })).toEqual({ done: 1, total: 2, skipped: 0 });
  });
  it("sprintProgress", () => {
    expect(sprintProgress(project, "S1")).toEqual({ done: 1, total: 2, skipped: 0 });
    expect(sprintProgress(project, "S7")).toEqual({ done: 0, total: 0, skipped: 0 });
  });
});

describe("os campos novos aceitam o que já estava gravado", () => {
  const base = { id: "p1", title: "x", status: "ativo", version: 1, tasks: [], createdAt: at, updatedAt: at };
  it("projeto antigo continua válido, sem campos novos", () => {
    const parsed = projectSchema.parse(base);
    expect(parsed.sprints).toBeUndefined();
    expect(parsed.system).toBeUndefined();
  });
  it("lê os campos novos de projeto e de tarefa", () => {
    const parsed = projectSchema.parse({
      ...base,
      system: "avulsas",
      labels: [{ id: "l1", name: "front", color: "azul" }],
      sprints: [{ id: "S1", name: "Sprint 1", startAt: at, endAt: at, order: 1, status: "ativa" }],
      nextRef: 3,
      tasks: [{ ...task("A1"), parent: undefined, order: 1000, labels: ["l1"], carryCount: 1, meta: { requestId: "r1", origin: "cyno", brief: "b", createdAt: at } }],
      brief: "briefing",
    });
    expect(parsed.system).toBe("avulsas");
    expect(parsed.tasks[0]!.meta?.requestId).toBe("r1");
    expect(parsed.brief).toBe("briefing");
    expect(parsed.nextRef).toBe(3);
  });
});
