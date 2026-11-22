import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { dependsChoices, dependsOverview, dependsSummary, filterDependsChoices, flowItems, flowOrder, pendingWaitsText } from "./flowView";

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
    // A "d" espera a "c": oferecê-la criaria um ciclo, então não aparece.
    expect(choices.map((choice) => [choice.ref, choice.checked])).toEqual([["b", true], ["a", false]]);
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

describe("\"Depois de\" resumido", () => {
  const dep = (ref: string, status: ProjectTask["status"]) => task(ref, { parent: "P", status });
  it("o que falta vem primeiro e o resumo conta quantas travam", () => {
    const p = project([mother("P"), dep("a", "concluida"), dep("b", "em_andamento"), task("c", { parent: "P", dependsOn: ["a", "b"] })]);
    const o = dependsOverview(p, p.tasks.find((t) => t.ref === "c")!);
    expect(o.rows.map((r) => [r.ref, r.done, r.stateLabel])).toEqual([["b", false, "fazendo"], ["a", true, "feita"]]);
    expect(o.summary).toBe("Esperando 1 de 2");
  });
  it("tudo feito: nada travando", () => {
    const p = project([mother("P"), dep("a", "concluida"), task("c", { parent: "P", dependsOn: ["a"], status: "a_fazer" })]);
    expect(dependsOverview(p, p.tasks.find((t) => t.ref === "c")!).summary).toBe("Nada travando: pode começar");
  });
  it("sem dependência: sem resumo", () => {
    const p = project([mother("P"), task("c", { parent: "P" })]);
    expect(dependsOverview(p, p.tasks.find((t) => t.ref === "c")!)).toMatchObject({ rows: [], summary: "" });
  });
  it("busca sem acento nem caixa", () => {
    const list = [{ ref: "a", title: "Pesquisar ação", ownerId: "", checked: false }, { ref: "b", title: "Outra", ownerId: "", checked: false }];
    expect(filterDependsChoices(list, "ACAO", (id) => id).map((c) => c.ref)).toEqual(["a"]);
  });
});

describe("\"Depois de\" entre módulos", () => {
  const group = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { group: true, steps: [], ownerId: "", status: "backlog", title: `Módulo ${ref}`, ...extra });
  /** A (módulo) > a1, a2; B (módulo) > b1; C (módulo) > D (módulo) > d1; x (tarefa solta). */
  const tree = (extra: Record<string, Partial<ProjectTask>> = {}) =>
    project([
      group("A", extra.A),
      task("a1", { parent: "A", ...extra.a1 }),
      task("a2", { parent: "A", ...extra.a2 }),
      group("B", extra.B),
      task("b1", { parent: "B", ...extra.b1 }),
      group("C", extra.C),
      group("D", { parent: "C", ...extra.D }),
      task("d1", { parent: "D", ...extra.d1 }),
      task("x", extra.x),
    ]);

  it("um módulo oferece os módulos irmãos (e as tarefas irmãs), e os outros módulos de outros lugares", () => {
    const p = tree();
    const choices = dependsChoices(p, p.tasks.find((t) => t.ref === "B")!);
    expect(choices.map((c) => [c.ref, c.sibling])).toEqual([["A", true], ["C", true], ["x", true], ["D", false]]);
    expect(choices.find((c) => c.ref === "D")).toMatchObject({ path: "Módulo C", container: true });
  });

  it("uma tarefa também pode esperar um módulo (de outro lugar), mas não o módulo em que está nem os de dentro", () => {
    const p = tree();
    const refs = dependsChoices(p, p.tasks.find((t) => t.ref === "b1")!).map((c) => c.ref);
    expect(refs).toEqual(expect.arrayContaining(["A", "C", "D"]));
    expect(refs).not.toContain("B");
    const forModule = dependsChoices(p, p.tasks.find((t) => t.ref === "C")!).map((c) => c.ref);
    expect(forModule).not.toContain("D");
    expect(forModule).not.toContain("d1");
  });

  it("não oferece quem criaria ciclo (direto, por outro módulo ou por quem está dentro)", () => {
    // B espera A: A não pode esperar B. C espera B: então A também não pode esperar C (A espera C, C espera B, B espera A).
    const p = tree({ B: { dependsOn: ["A"] }, C: { dependsOn: ["B"] } });
    const forA = dependsChoices(p, p.tasks.find((t) => t.ref === "A")!).map((c) => c.ref);
    expect(forA).not.toContain("B");
    expect(forA).not.toContain("C");
    expect(forA).toContain("x");
    // Uma tarefa dentro de B que o módulo C espera (C espera B): b1 não pode esperar C.
    const forB1 = dependsChoices(p, p.tasks.find((t) => t.ref === "b1")!).map((c) => c.ref);
    expect(forB1).not.toContain("C");
  });

  it("o que já está marcado continua na lista para dar para tirar", () => {
    const p = tree({ x: { dependsOn: ["D"] } });
    expect(dependsChoices(p, p.tasks.find((t) => t.ref === "x")!).find((c) => c.ref === "D")).toMatchObject({ checked: true });
  });

  it("nova subtarefa só oferece as irmãs", () => {
    const p = tree();
    const refs = dependsChoices(p, { ref: "", parent: "A", dependsOn: [] }, { siblingsOnly: true }).map((c) => c.ref);
    expect(refs).toEqual(["a1", "a2"]);
  });

  it("o resumo conta o módulo como feito só quando tudo dentro terminou", () => {
    const pending = tree({ x: { dependsOn: ["A"] }, a1: { status: "concluida" } });
    const o = dependsOverview(pending, pending.tasks.find((t) => t.ref === "x")!);
    expect(o.rows).toEqual([expect.objectContaining({ ref: "A", done: false, stateLabel: "fazendo" })]);
    expect(o.summary).toBe("Esperando 1 de 1");
    expect(pendingWaitsText(pending, pending.tasks.find((t) => t.ref === "x")!)).toBe("espera Módulo A");
    const finished = tree({ x: { dependsOn: ["A"] }, a1: { status: "concluida" }, a2: { status: "concluida" } });
    const f = dependsOverview(finished, finished.tasks.find((t) => t.ref === "x")!);
    expect(f.rows).toEqual([expect.objectContaining({ ref: "A", done: true, stateLabel: "feita" })]);
    expect(pendingWaitsText(finished, finished.tasks.find((t) => t.ref === "x")!)).toBe("");
  });

  it("a busca da lista acha pelo caminho também", () => {
    const p = tree();
    const choices = dependsChoices(p, p.tasks.find((t) => t.ref === "B")!);
    expect(filterDependsChoices(choices, "modulo c", (id) => id).map((c) => c.ref)).toEqual(["C", "D"]);
  });
});
