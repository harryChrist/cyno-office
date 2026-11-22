import { PROJECT_SAFETY, projectDefaults, projectUnitProgress, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { addNode, assertValidTree, duplicateNode, idleStatus, moveNode, refreshIdle, setDependsOn } from "./project-edit";

/** Módulos em qualquer profundidade, sem limites de produto e dependência entre módulos (a edição da árvore, em memória). */
const at = "2026-11-21T12:00:00.000Z";
const empty = (): Project => ({ ...projectDefaults(), id: "p1", title: "Livro", status: "ativo", version: 1, labels: [], sprints: [], tasks: [], createdAt: at, updatedAt: at, approvedAt: at });
const find = (project: Project, ref: string): ProjectTask => project.tasks.find((task) => task.ref === ref)!;

function leaf(ref: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return {
    ref,
    title: `Tarefa ${ref}`,
    briefing: "faça",
    ownerId: "eco",
    steps: [{ agentId: "eco", what: "faz", status: "pendente" }],
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
const mod = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => leaf(ref, { group: true, ownerId: "", steps: [], status: "backlog", ...extra });

describe("sem limites de produto na edição da árvore", () => {
  it("150 tarefas na raiz e 100 subtarefas numa tarefa", () => {
    const project = empty();
    for (let index = 0; index < 150; index += 1) addNode(project, { title: `Capítulo ${index + 1}` }, at);
    expect(project.tasks).toHaveLength(150);
    const mother = addNode(project, { title: "Livro grande" }, at);
    for (let index = 0; index < 100; index += 1) addNode(project, { title: `Parte ${index + 1}`, parent: mother.ref }, at);
    expect(project.tasks.filter((task) => task.parent === mother.ref)).toHaveLength(100);
    expect(find(project, mother.ref).steps).toEqual([]);
  });

  it("módulos dentro de módulos e profundidade 8", () => {
    const project = empty();
    let parent: string | undefined;
    for (let level = 1; level <= 7; level += 1) parent = addNode(project, { title: `Módulo ${level}`, group: true, ...(parent ? { parent } : {}) }, at).ref;
    const last = addNode(project, { title: "Tarefa funda", parent: parent! }, at);
    expect(project.tasks.filter((task) => task.group)).toHaveLength(7);
    expect(last.parent).toBe(parent);
    expect(project.tasks).toHaveLength(8);
    expect(() => assertValidTree(project)).not.toThrow();
  });

  it("módulo em qualquer profundidade, também mover módulo para dentro de outro e duplicar com as filhas", () => {
    const project = empty();
    const a = addNode(project, { title: "A", group: true }, at);
    const b = addNode(project, { title: "B", group: true }, at);
    addNode(project, { title: "B1", parent: b.ref }, at);
    moveNode(project, b.ref, { parent: a.ref }, at);
    expect(find(project, b.ref).parent).toBe(a.ref);
    expect(find(project, b.ref).group).toBe(true);
    const copy = duplicateNode(project, a.ref, at);
    expect(project.tasks.filter((task) => task.group)).toHaveLength(4);
    expect(copy.group).toBe(true);
  });

  it("rede de segurança: 5000 itens e 50 níveis recusam com mensagem em português", () => {
    const full = empty();
    full.tasks = Array.from({ length: PROJECT_SAFETY.nodes }, (_, index) => leaf(`T${index + 1}`));
    expect(() => addNode(full, { title: "mais um" }, at)).toThrow(/5000 itens \(rede de segurança\)/);
    const deep = empty();
    let parent: string | undefined;
    for (let level = 1; level <= PROJECT_SAFETY.depth; level += 1) parent = addNode(deep, { title: `M${level}`, group: true, ...(parent ? { parent } : {}) }, at).ref;
    expect(() => addNode(deep, { title: "um nível a mais", parent: parent! }, at)).toThrow(/Passou de 50 níveis/);
  });
});

describe("dependência entre módulos na edição", () => {
  function twoModules(): Project {
    const project = empty();
    project.tasks = [mod("A"), leaf("A1", { parent: "A" }), leaf("A2", { parent: "A", dependsOn: ["A1"], status: "backlog" }), mod("B"), leaf("B1", { parent: "B" }), leaf("B2", { parent: "B", dependsOn: ["B1"], status: "backlog" }), leaf("T")];
    return project;
  }

  it("aceita módulo->módulo, tarefa->módulo e módulo->tarefa", () => {
    const project = twoModules();
    setDependsOn(project, find(project, "B"), ["A"], at);
    setDependsOn(project, find(project, "T"), ["B"], at);
    expect([find(project, "B").dependsOn, find(project, "T").dependsOn]).toEqual([["A"], ["B"]]);
    const other = twoModules();
    setDependsOn(other, find(other, "A"), ["T"], at);
    expect(find(other, "A").dependsOn).toEqual(["T"]);
    // T esperando B e B esperando T seria um ciclo (por módulo).
    setDependsOn(other, find(other, "T"), ["B"], at);
    expect(() => setDependsOn(other, find(other, "B"), ["T"], at)).toThrow(/ciclo/);
  });

  it("recusa ciclo entre módulos, módulo que espera o que faz parte dele e ele mesmo", () => {
    const project = twoModules();
    setDependsOn(project, find(project, "B"), ["A"], at);
    expect(() => setDependsOn(project, find(project, "A"), ["B"], at)).toThrow(/ciclo/);
    expect(find(project, "A").dependsOn).toEqual([]);
    expect(() => setDependsOn(project, find(project, "A"), ["A1"], at)).toThrow(/dentro desta tarefa/);
    expect(() => setDependsOn(project, find(project, "A1"), ["A"], at)).toThrow(/de que esta faz parte/);
    expect(() => setDependsOn(project, find(project, "A"), ["A"], at)).toThrow(/ela mesma/);
    expect(() => setDependsOn(project, find(project, "B"), ["Z9"], at)).toThrow(/não existe/);
  });

  it("a entrada do módulo B espera o módulo A; quando a última tarefa de A termina, destrava (cascata)", () => {
    const project = twoModules();
    setDependsOn(project, find(project, "B"), ["A"], at);
    refreshIdle(project, at);
    expect(find(project, "B1").status).toBe("backlog");
    expect(idleStatus(project, find(project, "B1"))).toBe("backlog");
    // A1 terminou, A2 ainda não: B continua esperando.
    Object.assign(find(project, "A1"), { status: "concluida", steps: [{ agentId: "eco", what: "faz", status: "feita" }] });
    refreshIdle(project, at);
    expect(find(project, "B1").status).toBe("backlog");
    // A2 (a última) termina: B1 vai para a fila; B2 segue esperando B1.
    Object.assign(find(project, "A2"), { status: "concluida", steps: [{ agentId: "eco", what: "faz", status: "feita" }] });
    refreshIdle(project, at);
    expect(find(project, "B1").status).toBe("a_fazer");
    expect(find(project, "B2").status).toBe("backlog");
  });

  it("a última tarefa pulada destrava; cancelada segura quem depende (travada)", () => {
    const skipped = twoModules();
    setDependsOn(skipped, find(skipped, "B"), ["A"], at);
    Object.assign(find(skipped, "A1"), { status: "concluida" });
    Object.assign(find(skipped, "A2"), { status: "concluida", skipped: true });
    refreshIdle(skipped, at);
    expect(find(skipped, "B1").status).toBe("a_fazer");

    const cancelled = twoModules();
    setDependsOn(cancelled, find(cancelled, "B"), ["A"], at);
    Object.assign(find(cancelled, "A1"), { status: "concluida" });
    Object.assign(find(cancelled, "A2"), { status: "cancelada" });
    refreshIdle(cancelled, at);
    expect(find(cancelled, "B1").status).toBe("backlog");
  });

  it("tarefa depende de módulo: espera o módulo inteiro; módulo depende de tarefa: a entrada espera a tarefa", () => {
    const project = twoModules();
    setDependsOn(project, find(project, "T"), ["A"], at);
    setDependsOn(project, find(project, "B"), ["T"], at);
    refreshIdle(project, at);
    expect(find(project, "T").status).toBe("backlog");
    expect(find(project, "B1").status).toBe("backlog");
    Object.assign(find(project, "A1"), { status: "concluida" });
    Object.assign(find(project, "A2"), { status: "concluida" });
    refreshIdle(project, at);
    expect(find(project, "T").status).toBe("a_fazer");
    expect(find(project, "B1").status).toBe("backlog");
    Object.assign(find(project, "T"), { status: "concluida" });
    refreshIdle(project, at);
    expect(find(project, "B1").status).toBe("a_fazer");
  });

  it("o progresso do projeto sobe por módulo quando o último trabalho do módulo termina", () => {
    const project = twoModules();
    project.tasks = project.tasks.filter((task) => task.ref !== "T");
    expect(projectUnitProgress(project)).toMatchObject({ done: 0, total: 2, unit: "modulos" });
    for (const ref of ["A1", "A2"]) Object.assign(find(project, ref), { status: "concluida" });
    expect(projectUnitProgress(project)).toMatchObject({ done: 1, total: 2, unit: "modulos" });
  });
});
