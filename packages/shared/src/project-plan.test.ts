import { describe, expect, it } from "vitest";
import { buildProjectPlan, projectTreeMarkdown } from "./project-plan";

const AT = "2026-11-11T12:00:00.000Z";
const NOW = Date.parse(AT);
const pool = { agents: [{ id: "eco", name: "Eco" }, { id: "sol", name: "Sol" }, { id: "crivo", name: "Crivo" }, { id: "beto", name: "Beto" }], forbidden: new Set(["maestro"]) };
const leaf = (extra: Record<string, unknown> = {}) => ({ title: "Tarefa", briefing: "Faça", owner: "Eco", ...extra });
const group = (ref: string) => ({ ref, title: "Entregável", briefing: "g", kind: "group" as const });

const errorsOf = (input: Parameters<typeof buildProjectPlan>[0]) => {
  const built = buildProjectPlan(input, pool, AT, NOW);
  return built.ok ? [] : built.errors;
};

describe("buildProjectPlan", () => {
  it("lista plana (formato antigo) continua igual: sem pai, sem sprint", () => {
    const built = buildProjectPlan({ tasks: [leaf({ ref: "T1" }), leaf({ ref: "T2", depends_on: ["T1"] })] }, pool, AT, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.sprints).toEqual([]);
    expect(built.tasks.map((task) => [task.ref, task.status, task.parent, task.sprintId])).toEqual([
      ["T1", "a_fazer", undefined, undefined],
      ["T2", "backlog", undefined, undefined],
    ]);
  });

  it("monta entregáveis, tarefas, subtarefas, sprints com datas e etiquetas numa chamada", () => {
    const built = buildProjectPlan(
      {
        sprints: [
          { ref: "s1", name: "Sprint 1", goal: "Base", start_at: "2026-11-12T09:00:00-03:00" },
          { ref: "s2", name: "Sprint 2", duration_days: 14 },
        ],
        labels: [{ name: "front", color: "rose" }],
        tasks: [
          group("D1"),
          { ref: "T1", title: "Tela", briefing: "Tela de login", parent: "D1" },
          { ref: "T2", title: "Arte", briefing: "Arte da tela", owner: "Sol", parent: "T1", sprint: "s1", labels: ["front", "novo"] },
          { ref: "T3", title: "Código", briefing: "Código da tela", owner: "Eco", parent: "T1", sprint: "S2" },
        ],
      },
      pool,
      AT,
      NOW,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.sprints.map((sprint) => [sprint.id, sprint.startAt, sprint.endAt])).toEqual([
      ["S1", "2026-11-12T12:00:00.000Z", "2026-11-19T12:00:00.000Z"],
      ["S2", "2026-11-19T12:00:00.000Z", "2026-12-03T12:00:00.000Z"],
    ]);
    const by = Object.fromEntries(built.tasks.map((task) => [task.ref, task]));
    expect(by.D1).toMatchObject({ group: true, ownerId: "", steps: [] });
    expect(by.T1).toMatchObject({ parent: "D1", ownerId: "", steps: [], status: "backlog" });
    expect(by.T2).toMatchObject({ parent: "T1", sprintId: "S1", ownerId: "sol", status: "a_fazer", labels: ["L1", "L2"] });
    expect(by.T3?.sprintId).toBe("S2");
    expect(built.labels.map((label) => [label.id, label.name, label.color])).toEqual([
      ["L1", "front", "rose"],
      ["L2", "novo", "green"],
    ]);
  });

  it("folha sem sprint cai na primeira quando há sprints", () => {
    const built = buildProjectPlan({ sprints: [{ name: "A" }], tasks: [leaf({ ref: "T1" })] }, pool, AT, NOW);
    expect(built.ok && built.tasks[0]?.sprintId).toBe("S1");
  });

  it("erros claros e acionáveis: qual tarefa e qual regra", () => {
    expect(errorsOf({ tasks: [leaf({ ref: "T1", owner: undefined })] })[0]).toContain("Task T1");
    expect(errorsOf({ tasks: [leaf({ ref: "T1", owner: undefined })] })[0]).toContain("needs an owner");
    expect(errorsOf({ tasks: [leaf({ ref: "T1", sprint: "S9" })] })[0]).toContain('Task T1: sprint "S9" does not exist');
    expect(errorsOf({ tasks: [leaf({ ref: "T1", parent: "X" })] })[0]).toContain('Task T1: parent "X"');
    expect(errorsOf({ tasks: [{ ...group("D1"), owner: "Eco" }] })[0]).toContain("module");
    expect(errorsOf({ tasks: [leaf({ ref: "A", parent: "B" }), leaf({ ref: "B", parent: "A" })] }).join("\n")).toContain("cycle");
    // Sem teto de níveis: 4 níveis passam; só a rede de segurança (50) recusa.
    expect(errorsOf({ tasks: [group("D1"), leaf({ ref: "A", parent: "D1" }), leaf({ ref: "B", parent: "A" }), leaf({ ref: "C", parent: "B" })] })).toEqual([]);
    const deep = Array.from({ length: 51 }, (_, index) => ({ ...group(`G${index + 1}`), ...(index > 0 ? { parent: `G${index}` } : {}) }));
    expect(errorsOf({ tasks: [...deep, leaf({ ref: "F", parent: "G51" })] }).join("\n")).toContain("safety net: at most 50 levels");
    expect(errorsOf({ sprints: [{ name: "X", start_at: "2026-11-20", end_at: "2026-11-10" }], tasks: [leaf()] })[0]).toContain("end_at must be after start_at");
  });

  it("sem limite de subtarefas por tarefa: 5 e 100 subtarefas passam", () => {
    const mother = { ref: "P", title: "Mãe", briefing: "m", parent: "D1" };
    const owners = ["Eco", "Sol", "Crivo", "Beto", "Eco"];
    const kids = owners.map((owner, index) => leaf({ ref: `K${index}`, parent: "P", owner }));
    expect(errorsOf({ tasks: [group("D1"), mother, ...kids] })).toEqual([]);
    const many = Array.from({ length: 100 }, (_, index) => leaf({ ref: `M${index}`, parent: "P", owner: "Eco" }));
    expect(errorsOf({ tasks: [group("D1"), mother, ...many] })).toEqual([]);
  });

  it("dependência de sprint posterior vira aviso, não erro", () => {
    const built = buildProjectPlan({ sprints: [{ ref: "a", name: "A" }, { ref: "b", name: "B" }], tasks: [leaf({ ref: "T1", sprint: "a", depends_on: ["T2"] }), leaf({ ref: "T2", sprint: "b" })] }, pool, AT, NOW);
    expect(built.ok && built.warnings[0]).toContain("T1 is in A and depends on T2");
  });

  it("add: usa as sprints e a árvore que já existem", () => {
    const first = buildProjectPlan({ sprints: [{ ref: "a", name: "A" }], tasks: [group("D1"), leaf({ ref: "T1", parent: "D1" })] }, pool, AT, NOW);
    if (!first.ok) throw new Error("setup");
    const existing = { tasks: first.tasks, sprints: first.sprints, labels: first.labels };
    const more = buildProjectPlan({ tasks: [leaf({ ref: "T2", parent: "D1", sprint: "A" }), leaf({ ref: "T3", parent: "D1" })] }, pool, AT, NOW, undefined, existing);
    expect(more.ok).toBe(true);
    if (!more.ok) return;
    expect(more.tasks.map((task) => [task.ref, task.order, task.sprintId])).toEqual([
      ["T2", 2000, "S1"],
      ["T3", 3000, undefined],
    ]);
  });
});

describe("projectTreeMarkdown", () => {
  it("mostra sprints, módulos e responsáveis (e aceita kind module)", () => {
    const built = buildProjectPlan({ sprints: [{ name: "Sprint 1", goal: "Base" }], tasks: [{ ref: "D1", title: "Front", briefing: "g", kind: "module" }, leaf({ ref: "T1", title: "Tela", parent: "D1" })] }, pool, AT, NOW);
    if (!built.ok) throw new Error("setup");
    expect(built.tasks[0]?.group).toBe(true);
    const text = projectTreeMarkdown({ title: "Curso", tasks: built.tasks, sprints: built.sprints }, (id) => (id === "eco" ? "Eco" : id));
    expect(text).toContain("**Sprint 1**");
    expect(text).toContain("- **Front** (módulo)");
    expect(text).toContain("  - **T1 · Tela** — Eco · Sprint 1");
  });
});
