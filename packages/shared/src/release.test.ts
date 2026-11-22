import { describe, expect, it } from "vitest";
import type { ProjectTask } from "./projects";
import { isParked, isReleased, nextReleaseBatch, PLANNED_NOTE, plannedLeafCount, prerequisiteClosure, releaseHold, releaseOrder, releasePriority, releaseState } from "./release";
import { waitingText } from "./task-flow";

/** Liberação: o freio da folha Planejada, o estado de módulos, o fecho de pré-requisitos, a ordem e o lote da liberação diária. */
const at = "2026-11-21T12:00:00.000Z";

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
    updatedAt: at,
    ...extra,
  };
}
const mod = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { group: true, status: "backlog", ...extra });
const planned = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { released: false, ...extra });
const proj = (tasks: ProjectTask[]) => ({ tasks });

describe("isReleased e releaseHold", () => {
  it("ausente conta como liberada; só false segura", () => {
    expect(isReleased({})).toBe(true);
    expect(isReleased({ released: true })).toBe(true);
    expect(isReleased({ released: false })).toBe(false);
  });
  it("segura a folha Planejada que não começou, com a nota fixa", () => {
    expect(releaseHold({ released: false, status: "a_fazer" })).toEqual({ note: PLANNED_NOTE });
    expect(releaseHold({ released: false, status: "backlog" })).toEqual({ note: "Planejada: libere para entrar na fila" });
    expect(releaseHold({ released: false, status: "falhou" })).toBeDefined();
  });
  it("não segura liberada, em andamento, concluída nem cancelada", () => {
    expect(releaseHold({ status: "a_fazer" })).toBeUndefined();
    expect(releaseHold({ released: true, status: "a_fazer" })).toBeUndefined();
    for (const status of ["em_andamento", "concluida", "cancelada"] as const) expect(releaseHold({ released: false, status })).toBeUndefined();
  });
});

describe("releaseState e plannedLeafCount", () => {
  const project = proj([
    mod("M1"),
    planned("A", { parent: "M1" }),
    planned("B", { parent: "M1" }),
    mod("M2"),
    task("C", { parent: "M2" }),
    planned("D", { parent: "M2" }),
    mod("M3"),
    task("E", { parent: "M3", status: "concluida" }),
    mod("M4"),
    task("F", { released: false, status: "em_andamento" }),
    planned("G", { status: "concluida" }),
  ]);
  it("folha: pelo campo; concluída ou em andamento conta como liberada", () => {
    expect(releaseState(project, "A")).toBe("planejada");
    expect(releaseState(project, "C")).toBe("liberada");
    expect(releaseState(project, "F")).toBe("liberada");
    expect(releaseState(project, "G")).toBe("liberada");
  });
  it("contêiner: planejada, liberada ou mista; sem folhas ou tudo terminado = undefined", () => {
    expect(releaseState(project, "M1")).toBe("planejada");
    expect(releaseState(project, "M2")).toBe("mista");
    expect(releaseState(project, "M3")).toBeUndefined();
    expect(releaseState(project, "M4")).toBeUndefined();
    expect(releaseState(project, "nada")).toBeUndefined();
  });
  it("módulo com tudo liberado e uma Planejada já terminada é liberado", () => {
    const done = proj([mod("M"), task("X", { parent: "M" }), planned("Y", { parent: "M", status: "cancelada" })]);
    expect(releaseState(done, "M")).toBe("liberada");
  });
  it("conta as folhas Planejadas que não terminaram, no projeto e na subárvore", () => {
    expect(plannedLeafCount(project)).toBe(3);
    expect(plannedLeafCount(project, "M1")).toBe(2);
    expect(plannedLeafCount(project, "A")).toBe(1);
    expect(plannedLeafCount(project, "M3")).toBe(0);
    expect(plannedLeafCount(project, "nada")).toBe(0);
  });
});

describe("prerequisiteClosure", () => {
  it("devolve só as Planejadas de que a folha depende, transitivo, na ordem da árvore e sem as de `refs`", () => {
    const project = proj([planned("A"), planned("B", { dependsOn: ["A"] }), planned("C", { dependsOn: ["B"] }), planned("D")]);
    expect(prerequisiteClosure(project, ["C"])).toEqual(["A", "B"]);
    expect(prerequisiteClosure(project, ["A"])).toEqual([]);
    expect(prerequisiteClosure(project, ["D"])).toEqual([]);
  });
  it("dependência em módulo vale todas as folhas dele; contêiner em refs vale as folhas", () => {
    const project = proj([mod("M1"), planned("A", { parent: "M1" }), planned("B", { parent: "M1" }), mod("M2", { dependsOn: ["M1"] }), planned("C", { parent: "M2" })]);
    expect(prerequisiteClosure(project, ["C"])).toEqual(["A", "B"]);
    expect(prerequisiteClosure(project, ["M2"])).toEqual(["A", "B"]);
  });
  it("não inclui o que já está liberado ou terminado, mas atravessa a liberada aberta", () => {
    const project = proj([planned("A"), task("B", { dependsOn: ["A"] }), planned("C", { dependsOn: ["B"] }), task("D", { status: "concluida" }), planned("E", { dependsOn: ["D"] })]);
    // B está liberada mas espera A (Planejada): para C andar, A também precisa sair.
    expect(prerequisiteClosure(project, ["C"])).toEqual(["A"]);
    expect(prerequisiteClosure(project, ["E"])).toEqual([]);
  });
  it("não repete e tolera ciclo", () => {
    const project = proj([planned("A", { dependsOn: ["C"] }), planned("B", { dependsOn: ["A"] }), planned("C", { dependsOn: ["A", "B"] })]);
    expect(prerequisiteClosure(project, ["C"])).toEqual(["A", "B"]);
  });
});

describe("releaseOrder e releasePriority", () => {
  it("prioridade primeiro, depois a ordem da árvore; só as Planejadas", () => {
    const project = proj([planned("A"), planned("B", { priority: "alta" }), task("C"), planned("D", { priority: "baixa" }), planned("E")]);
    expect(releaseOrder(project, 0)).toEqual(["B", "A", "E", "D"]);
  });
  it("a folha herda a prioridade MAIS ALTA do contêiner acima", () => {
    const project = proj([mod("M1"), planned("A", { parent: "M1" }), mod("M2", { priority: "alta" }), planned("B", { parent: "M2" }), planned("C", { parent: "M2", priority: "baixa" })]);
    expect(releaseOrder(project, 0)).toEqual(["B", "C", "A"]);
    expect(releasePriority(project, "C")).toBe("alta");
    expect(releasePriority(project, "A")).toBe("normal");
    expect(releasePriority(project, "nada")).toBeUndefined();
  });
  it("a prioridade da folha vale mesmo com o módulo comum", () => {
    const project = proj([mod("M1"), planned("A", { parent: "M1" }), planned("B", { parent: "M1", priority: "alta" })]);
    expect(releaseOrder(project, 0)).toEqual(["B", "A"]);
  });
});

describe("nextReleaseBatch", () => {
  it("tarefas: até completar o dia, com os pré-requisitos contando", () => {
    const project = proj([planned("A"), planned("B", { dependsOn: ["A"] }), planned("C"), planned("D")]);
    expect(nextReleaseBatch(project, "tarefas", 2, { guaranteeFirst: true }, 0)).toEqual({ refs: ["A", "B"], units: 2 });
    expect(nextReleaseBatch(project, "tarefas", 3, { guaranteeFirst: true }, 0)).toEqual({ refs: ["A", "B", "C"], units: 3 });
  });
  it("tarefas: o primeiro sai inteiro mesmo passando do dia, e o lote para", () => {
    const project = proj([planned("A"), planned("B", { dependsOn: ["A"] }), planned("C", { dependsOn: ["B"] }), planned("D")]);
    expect(nextReleaseBatch(project, "tarefas", 1, { guaranteeFirst: true }, 0)).toEqual({ refs: ["A"], units: 1 });
    const chain = proj([planned("X", { priority: "alta", dependsOn: ["Y"] }), planned("Y"), planned("Z")]);
    expect(nextReleaseBatch(chain, "tarefas", 1, { guaranteeFirst: true }, 0)).toEqual({ refs: ["X", "Y"], units: 2 });
    // Sem a garantia (já saiu algo hoje), o item que não cabe não sai.
    expect(nextReleaseBatch(chain, "tarefas", 1, { guaranteeFirst: false }, 0)).toEqual({ refs: [], units: 0 });
  });
  it("tarefas: sem nada Planejado, lote vazio", () => {
    expect(nextReleaseBatch(proj([task("A")]), "tarefas", 3, { guaranteeFirst: true }, 0)).toEqual({ refs: [], units: 0 });
  });
  it("módulos: um módulo inteiro por vez, a prioridade vence a ordem da árvore", () => {
    const project = proj([mod("M1"), planned("A", { parent: "M1" }), planned("B", { parent: "M1" }), mod("M2", { priority: "alta" }), planned("C", { parent: "M2" }), mod("M3"), planned("D", { parent: "M3" })]);
    expect(nextReleaseBatch(project, "modulos", 1, { guaranteeFirst: true }, 0)).toEqual({ refs: ["C"], units: 1 });
    expect(nextReleaseBatch(project, "modulos", 2, { guaranteeFirst: true }, 0)).toEqual({ refs: ["A", "B", "C"], units: 2 });
  });
  it("módulos: o módulo de que depende entra junto e conta; só saem as folhas de que ele depende", () => {
    const project = proj([mod("M1"), planned("A", { parent: "M1" }), planned("B", { parent: "M1" }), mod("M2", { priority: "alta", dependsOn: ["A"] }), planned("C", { parent: "M2" })]);
    expect(nextReleaseBatch(project, "modulos", 1, { guaranteeFirst: true }, 0)).toEqual({ refs: ["A", "C"], units: 2 });
    expect(nextReleaseBatch(project, "modulos", 1, { guaranteeFirst: false }, 0)).toEqual({ refs: [], units: 0 });
  });
  it("módulos: tarefa solta na raiz é uma unidade e módulo sem Planejada é pulado", () => {
    const project = proj([mod("M0"), task("X", { parent: "M0" }), planned("S1"), planned("S2"), mod("M1"), planned("A", { parent: "M1" })]);
    expect(nextReleaseBatch(project, "modulos", 2, { guaranteeFirst: true }, 0)).toEqual({ refs: ["S1", "S2"], units: 2 });
    expect(nextReleaseBatch(project, "modulos", 3, { guaranteeFirst: true }, 0)).toEqual({ refs: ["S1", "S2", "A"], units: 3 });
  });
});

describe("waitingText com a folha Planejada", () => {
  it("diz que está planejada em vez de pronta ou na fila", () => {
    const project = proj([planned("A")]);
    expect(waitingText({ task: project.tasks[0]!, project, agentName: () => "Eco", queuePosition: 1 })).toBe("planejada, ainda não liberada");
    const free = proj([task("B")]);
    expect(waitingText({ task: free.tasks[0]!, project: free, agentName: () => "Eco" })).toBe("pronta para começar");
  });
});

describe("isParked", () => {
  it("verdadeiro para ativo ou pausado com folhas abertas todas Planejadas (inclusive em módulos e com terminadas junto)", () => {
    expect(isParked({ status: "ativo", tasks: [planned("A"), planned("B", { status: "backlog" })] })).toBe(true);
    expect(isParked({ status: "pausado", tasks: [planned("A")] })).toBe(true);
    expect(isParked({ status: "ativo", tasks: [mod("M1"), planned("A", { parent: "M1" }), task("B", { status: "concluida" }), task("C", { status: "cancelada" })] })).toBe(true);
  });

  it("falso quando há folha liberada, em andamento, esperando você, sem folhas abertas ou fora de ativo/pausado", () => {
    expect(isParked({ status: "ativo", tasks: [planned("A"), task("B", { released: true })] })).toBe(false);
    expect(isParked({ status: "ativo", tasks: [planned("A"), task("B")] })).toBe(false);
    expect(isParked({ status: "ativo", tasks: [planned("A", { status: "em_andamento" })] })).toBe(false);
    expect(isParked({ status: "ativo", tasks: [planned("A", { status: "esperando_voce" })] })).toBe(false);
    expect(isParked({ status: "proposto", tasks: [planned("A")] })).toBe(false);
    expect(isParked({ status: "ajustando", tasks: [planned("A")] })).toBe(false);
    expect(isParked({ status: "concluido", tasks: [planned("A")] })).toBe(false);
    expect(isParked({ status: "cancelado", tasks: [planned("A")] })).toBe(false);
    expect(isParked({ status: "ativo", tasks: [] })).toBe(false);
    expect(isParked({ status: "ativo", tasks: [mod("M1")] })).toBe(false);
    expect(isParked({ status: "ativo", tasks: [planned("A", { status: "concluida" })] })).toBe(false);
  });
});
