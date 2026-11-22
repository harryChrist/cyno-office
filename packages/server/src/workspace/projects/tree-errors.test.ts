import { PROJECT_SAFETY, validateTree, type ProjectTask } from "@cyno/shared";
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
  it("a rede de segurança de itens e de níveis sai em português, sem o trecho em inglês", () => {
    const flat = Array.from({ length: PROJECT_SAFETY.nodes + 1 }, (_, index) => task(`S${index + 1}`));
    const englishNodes = validateTree({ tasks: flat, sprints: [], labels: [] }).errors[0]!;
    expect(englishNodes).toMatch(/safety net/);
    const ownerNodes = ownerTreeError(englishNodes);
    expect(ownerNodes).not.toMatch(/\b(items|safety net|project would|at most|Task)\b/);
    expect(ownerNodes).toMatch(/itens/);
    expect(() => assertValidTree({ tasks: flat, sprints: [], labels: [] })).toThrow(/^Não dá para fazer isso: /);

    const deep: ProjectTask[] = [];
    for (let level = 1; level <= PROJECT_SAFETY.depth + 1; level += 1) deep.push(task(`G${level}`, { group: true, ownerId: "", steps: [], ...(level > 1 ? { parent: `G${level - 1}` } : {}) }));
    const englishDepth = validateTree({ tasks: deep, sprints: [], labels: [] }).errors[0]!;
    expect(englishDepth).toMatch(/levels deep/);
    const ownerDepth = ownerTreeError(englishDepth);
    expect(ownerDepth).not.toMatch(/\b(levels|safety net|Task)\b/);
    expect(ownerDepth).toMatch(/níveis/);
  });

  it("os outros erros também saem em português e o desconhecido não deixa inglês", () => {
    expect(ownerTreeError('Task T2: parent "T9" does not exist')).toBe('A tarefa T2: a tarefa-mãe "T9" não existe');
    expect(ownerTreeError("Task T2: the parent chain forms a cycle")).toBe("A tarefa T2: a cadeia de mães forma um ciclo");
    expect(ownerTreeError('Task T1: depends on its own descendant "T2"')).toBe('A tarefa T1 não pode depender de uma subtarefa dela mesma ("T2")');
    expect(ownerTreeError('Task T1: depends on its own ancestor "G" (it only finishes after this one)')).toBe('A tarefa T1 não pode depender do módulo ou da tarefa de que faz parte ("G")');
    expect(ownerTreeError("Something nobody planned for")).toBe("a estrutura das tarefas ficaria inválida");
  });
});
