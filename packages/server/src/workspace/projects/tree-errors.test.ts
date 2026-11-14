import { PROJECT_LIMITS, validateTree, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { assertValidTree, ownerTreeError } from "./project-edit";

/** Revisão 2, L12: o erro de árvore chega ao dono em português puro; as mensagens do Maestro (MCP) seguem em inglês. */
const at = "2026-11-11T12:00:00.000Z";
const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "",
  ownerId: "a",
  steps: [{ agentId: "a", what: "faz", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  status: "backlog",
  rework: { count: 0 },
  updatedAt: at,
  ...extra,
});

describe("erro de árvore para o dono", () => {
  it("o teto de subtarefas sai em português, sem o trecho em inglês", () => {
    const tasks = [task("G", { group: true, ownerId: "", steps: [] }), task("M", { parent: "G", ownerId: "", steps: [] }), ...Array.from({ length: PROJECT_LIMITS.subtasksPerTask + 1 }, (_, index) => task(`S${index + 1}`, { parent: "M" }))];
    const english = validateTree({ tasks, sprints: [], labels: [] }).errors[0]!;
    expect(english).toMatch(/subtasks/);
    const owner = ownerTreeError(english);
    expect(owner).not.toMatch(/\b(subtasks|children|at most|Task)\b/);
    expect(owner).toMatch(/subtarefas|itens/);
    expect(() => assertValidTree({ tasks, sprints: [], labels: [] })).toThrow(/^Não dá para fazer isso: /);
    try {
      assertValidTree({ tasks, sprints: [], labels: [] });
    } catch (error) {
      expect((error as Error).message).not.toMatch(/\b(subtasks|at most)\b/);
    }
  });

  it("os outros erros também saem em português e o desconhecido não deixa inglês", () => {
    expect(ownerTreeError('Task T2: parent "T9" does not exist')).toBe('A tarefa T2: a tarefa-mãe "T9" não existe');
    expect(ownerTreeError("Task T2: the parent chain forms a cycle")).toBe("A tarefa T2: a cadeia de mães forma um ciclo");
    expect(ownerTreeError('Task T1: depends on its own descendant "T2"')).toBe('A tarefa T1 não pode depender de uma subtarefa dela mesma ("T2")');
    expect(ownerTreeError("Something nobody planned for")).toBe("a estrutura das tarefas ficaria inválida");
  });
});
