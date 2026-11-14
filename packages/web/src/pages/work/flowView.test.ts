import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { dependsChoices, dependsSummary, flowItems, flowOrder } from "./flowView";

const AT = "2026-11-10T12:00:00.000Z";
const NAMES: Record<string, string> = { sonia: "Sônia", davi: "Davi", hugo: "Hugo", ana: "Ana" };
const agentName = (id: string) => NAMES[id] ?? id;

const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => {
  const owner = extra.ownerId ?? "sonia";
  return { ref, title: `Tarefa ${ref}`, briefing: "b", ownerId: owner, steps: [{ agentId: owner, what: "fazer", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", doneWhen: [], rework: { count: 0 }, status: "a_fazer", updatedAt: AT, ...extra };
};
const mother = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { steps: [], ownerId: "", status: "backlog", ...extra });
const project = (tasks: ProjectTask[]): Project => ({ ...projectDefaults(), id: "p", title: "P", status: "ativo", version: 1, tasks, labels: [], sprints: [], createdAt: AT, updatedAt: AT });

/** Fora de ordem de propósito: o texto vem antes da pesquisa na lista, mas depende dela. */
const flow = () =>
  project([
    mother("P"),
    task("b", { parent: "P", title: "Texto", ownerId: "davi", dependsOn: ["a"], status: "a_fazer" }),
    task("a", { parent: "P", title: "Pesquisa", ownerId: "sonia", status: "concluida", result: "Fontes" }),
    task("c", { parent: "P", title: "Imagem", ownerId: "hugo", dependsOn: ["b"], status: "backlog" }),
    task("d", { parent: "P", title: "Conferência", ownerId: "ana", dependsOn: ["b", "c"], status: "backlog" }),
  ]);

describe("bloco Fluxo", () => {
  it("põe as subtarefas em ordem: cada uma depois das que ela espera", () => {
    expect(flowOrder(flow(), "P").map((leaf) => leaf.ref)).toEqual(["a", "b", "c", "d"]);
  });

  it("cada item: responsável, estado, de quem espera (com o já pronto marcado) e a entrega", () => {
    const items = flowItems(flow(), "P", agentName);
    expect(items.map((item) => [item.ref, item.ownerName, item.text])).toEqual([
      ["a", "Sônia", "entregou"],
      ["b", "Davi", "pronta para começar"],
      ["c", "Hugo", "espera o Davi terminar “Texto”"],
      ["d", "Ana", "espera Davi e Hugo"],
    ]);
    expect(items[0]).toMatchObject({ result: "Fontes", after: [] });
    expect(items[1]!.after).toEqual([{ ref: "a", label: "Sônia · Pesquisa", done: true }]);
    expect(items[3]!.after.map((dep) => dep.ref)).toEqual(["b", "c"]);
    expect(items.map((item) => item.final)).toEqual([false, false, false, true]);
  });

  it("ciclo (dado ruim) não trava: o resto entra na ordem da árvore", () => {
    const cyclic = project([mother("P"), task("x", { parent: "P", dependsOn: ["y"] }), task("y", { parent: "P", dependsOn: ["x"] })]);
    expect(flowOrder(cyclic, "P").map((leaf) => leaf.ref)).toEqual(["x", "y"]);
  });
});

describe("lista \"Depois de\"", () => {
  it("as opções são as irmãs, sem ela mesma, sem a mãe nem as de dentro; as marcadas vêm marcadas", () => {
    const p = flow();
    const choices = dependsChoices(p, p.tasks.find((t) => t.ref === "c")!);
    expect(choices.map((choice) => [choice.ref, choice.checked])).toEqual([["b", true], ["a", false], ["d", false]]);
    // A mãe não oferece as próprias filhas.
    const forMother = dependsChoices(p, p.tasks[0]!);
    expect(forMother).toEqual([]);
  });

  it("uma dependência que não é irmã continua na lista para dar para tirar", () => {
    const p = project([task("x"), mother("P"), task("a", { parent: "P", dependsOn: ["x"] })]);
    const choices = dependsChoices(p, p.tasks.find((t) => t.ref === "a")!);
    expect(choices.map((choice) => [choice.ref, choice.checked])).toEqual([["x", true]]);
  });

  it("o resumo: Depois de Sônia e Davi", () => {
    const p = flow();
    expect(dependsSummary(p, p.tasks.find((t) => t.ref === "d")!, agentName)).toBe("Depois de Davi e Hugo");
    expect(dependsSummary(p, p.tasks.find((t) => t.ref === "a")!, agentName)).toBe("");
  });
});
