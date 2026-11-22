import { describe, expect, it } from "vitest";
import { buildProjectPlan } from "./project-plan";
import { buildProjectTasks, PROJECT_SAFETY, progressLabel, type ProjectAgentPool, type ProjectTask, type ProjectTaskInput } from "./projects";
import { effectiveDeps, finalLeaves, receiversOf, waitingText } from "./task-flow";
import { completedRefs, dependencyCycle, isContainer, moduleProgress, nodeDone, projectUnitProgress, validateTree } from "./task-tree";

/** Módulos em qualquer profundidade, dependência entre módulos, progresso por unidade e a rede de segurança (sem limites de produto). */
const at = "2026-11-21T12:00:00.000Z";
const pool: ProjectAgentPool = { agents: [{ id: "eco", name: "Eco" }] };

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
    status: "backlog",
    rework: { count: 0 },
    updatedAt: at,
    ...extra,
  };
}
const mod = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { group: true, ...extra });
const proj = (tasks: ProjectTask[]) => ({ tasks });
const input = (ref: string, extra: Partial<ProjectTaskInput> = {}): ProjectTaskInput => ({ ref, title: `Item ${ref}`, briefing: "faça", ...(extra.kind === "group" ? {} : { owner: "eco" }), ...extra });

describe("sem limites de produto (buildProjectTasks e buildProjectPlan)", () => {
  it("150 tarefas na raiz são aceitas", () => {
    const built = buildProjectTasks(Array.from({ length: 150 }, (_, index) => input(`T${index + 1}`)), pool, at);
    expect(built.ok).toBe(true);
  });
  it("100 subtarefas numa tarefa-mãe (um lote de capítulos) são aceitas e a árvore valida", () => {
    const items = [input("MAE", { owner: undefined }), ...Array.from({ length: 100 }, (_, index) => input(`C${index + 1}`, { parent: "MAE" }))];
    const result = buildProjectPlan({ tasks: items }, pool, at, Date.parse(at));
    expect(result.ok).toBe(true);
  });
  it("módulos aninhados e profundidade 8 são aceitos", () => {
    const items: ProjectTaskInput[] = [];
    for (let level = 1; level <= 7; level += 1) items.push(input(`M${level}`, { kind: "group", ...(level > 1 ? { parent: `M${level - 1}` } : {}) }));
    items.push(input("F", { parent: "M7" }));
    const result = buildProjectPlan({ tasks: items }, pool, at, Date.parse(at));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tasks.find((candidate) => candidate.ref === "M4")?.group).toBe(true);
  });
  it("módulo aceita depends_on (de módulo, de tarefa) e a primeira tarefa do módulo B espera o módulo A", () => {
    const result = buildProjectPlan(
      { tasks: [input("A", { kind: "group" }), input("A1", { parent: "A" }), input("B", { kind: "group", depends_on: ["A"] }), input("B1", { parent: "B" }), input("B2", { parent: "B", depends_on: ["B1"] })] },
      pool,
      at,
      Date.parse(at),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = (ref: string) => result.tasks.find((candidate) => candidate.ref === ref)!.status;
    expect(status("A1")).toBe("a_fazer");
    expect(status("B1")).toBe("backlog");
    expect(status("B2")).toBe("backlog");
  });
  it("dependência de um módulo que já terminou (existing) deixa a entrada pronta", () => {
    const existing = [mod("A"), task("A1", { parent: "A", status: "concluida" }), task("A2", { parent: "A", status: "concluida", skipped: true })];
    const built = buildProjectTasks([input("B", { kind: "group", depends_on: ["A"] }), input("B1", { parent: "B" })], pool, at, existing);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.tasks.find((candidate) => candidate.ref === "B1")!.status).toBe("a_fazer");
  });
  it("rede de segurança: mais de 500 itens por chamada ou 5000 no projeto é recusado com mensagem clara", () => {
    const tooMany = Array.from({ length: PROJECT_SAFETY.perCall + 1 }, (_, index) => input(`T${index + 1}`));
    const perCall = buildProjectTasks(tooMany, pool, at);
    expect(perCall.ok).toBe(false);
    if (!perCall.ok) expect(perCall.errors.join("\n")).toMatch(/At most 500 items per call \(safety net\)/);
    const existing = Array.from({ length: PROJECT_SAFETY.nodes }, (_, index) => task(`E${index + 1}`));
    const total = buildProjectTasks([input("N1")], pool, at, existing);
    expect(total.ok).toBe(false);
    if (!total.ok) expect(total.errors.join("\n")).toMatch(/safety net: at most 5000 items per project/);
  });
  it("ciclo entre módulos (e por módulo e tarefa) é recusado", () => {
    const direct = buildProjectTasks([input("A", { kind: "group", depends_on: ["B"] }), input("A1", { parent: "A" }), input("B", { kind: "group", depends_on: ["A"] }), input("B1", { parent: "B" })], pool, at);
    expect(direct.ok).toBe(false);
    const viaTask = buildProjectTasks([input("A", { kind: "group" }), input("A1", { parent: "A", depends_on: ["B1"] }), input("B", { kind: "group", depends_on: ["A"] }), input("B1", { parent: "B" })], pool, at);
    expect(viaTask.ok).toBe(false);
    if (!viaTask.ok) expect(viaTask.errors.join("\n")).toMatch(/form a cycle/);
  });
});

describe("dependência entre módulos: quando destrava", () => {
  const project = proj([
    mod("A"),
    task("A1", { parent: "A" }),
    task("A2", { parent: "A", dependsOn: ["A1"] }),
    mod("B", { dependsOn: ["A"] }),
    task("B1", { parent: "B" }),
    task("B2", { parent: "B" }),
    task("T", { dependsOn: ["A"] }),
    mod("C", { dependsOn: ["T"] }),
    task("C1", { parent: "C" }),
  ]);
  const withStatus = (statuses: Record<string, ProjectTask["status"]>, skipped: string[] = []) => proj(project.tasks.map((item) => ({ ...item, ...(statuses[item.ref] ? { status: statuses[item.ref]! } : {}), ...(skipped.includes(item.ref) ? { skipped: true } : {}) })));
  const waits = (current: ReturnType<typeof proj>, ref: string) => {
    const done = completedRefs(current);
    const found = current.tasks.find((candidate) => candidate.ref === ref)!;
    return effectiveDeps(current, found).filter((dep) => !done.has(dep));
  };

  it("módulo B depende de módulo A: as folhas de B esperam A até a última folha de A terminar", () => {
    expect(waits(project, "B1")).toEqual(["A"]);
    expect(waits(project, "B2")).toEqual(["A"]);
    expect(waits(withStatus({ A1: "concluida" }), "B1")).toEqual(["A"]);
    expect(waits(withStatus({ A1: "concluida", A2: "concluida" }), "B1")).toEqual([]);
    expect(waits(withStatus({ A1: "concluida", A2: "concluida" }), "B2")).toEqual([]);
  });
  it("tarefa depende de módulo e módulo depende de tarefa", () => {
    expect(waits(project, "T")).toEqual(["A"]);
    expect(waits(withStatus({ A1: "concluida", A2: "concluida" }), "T")).toEqual([]);
    expect(waits(project, "C1")).toEqual(["T"]);
    expect(waits(withStatus({ T: "concluida" }), "C1")).toEqual([]);
  });
  it("a última folha pulada (concluída com skipped) destrava; a cancelada segura quem depende (travada)", () => {
    expect(waits(withStatus({ A1: "concluida", A2: "concluida" }, ["A2"]), "B1")).toEqual([]);
    expect(waits(withStatus({ A1: "concluida", A2: "cancelada" }), "B1")).toEqual(["A"]);
    expect(nodeDone(withStatus({ A1: "concluida", A2: "cancelada" }), "A")).toBe(true);
  });
  it("módulo vazio não conta como terminado, então quem depende dele espera", () => {
    const empty = proj([mod("E"), task("X", { dependsOn: ["E"] })]);
    expect(nodeDone(empty, "E")).toBe(false);
    expect(waits(empty, "X")).toEqual(["E"]);
  });
  it("waitingText diz que a folha espera o módulo (as folhas que faltam) e some quando termina", () => {
    const agentName = (id: string) => id;
    const text = waitingText({ task: project.tasks.find((candidate) => candidate.ref === "B1")!, project, agentName });
    expect(text).toMatch(/^espera /);
    const done = withStatus({ A1: "concluida", A2: "concluida" });
    expect(waitingText({ task: done.tasks.find((candidate) => candidate.ref === "B1")!, project: done, agentName })).toBeNull();
  });
  it("a entrega de um módulo vai para quem depende dele (receiversOf) e as folhas finais saem pelas dependências internas", () => {
    expect(finalLeaves(project, "A").map((leaf) => leaf.ref)).toEqual(["A2"]);
    expect(receiversOf(project, "A2").map((leaf) => leaf.ref).sort()).toEqual(["B1", "B2", "T"]);
  });
  it("módulo dentro de módulo: a dependência do interno vale para as entradas dele", () => {
    const nested = proj([mod("X"), task("X1", { parent: "X" }), mod("Y"), mod("Y1", { parent: "Y", dependsOn: ["X"] }), task("Y11", { parent: "Y1" }), task("Y2", { parent: "Y", dependsOn: ["Y1"] })]);
    expect(effectiveDeps(nested, nested.tasks.find((candidate) => candidate.ref === "Y11")!)).toEqual(["X"]);
    expect(effectiveDeps(nested, nested.tasks.find((candidate) => candidate.ref === "Y2")!)).toEqual(["Y1"]);
  });
});

describe("validateTree com módulos e dependências", () => {
  it("módulo em qualquer profundidade (sem steps) e módulo dentro de tarefa-mãe são válidos", () => {
    expect(validateTree({ tasks: [task("M", { steps: [] }), mod("G", { parent: "M" }), task("F", { parent: "G" })], sprints: [], labels: [] }).errors).toEqual([]);
  });
  it("módulo que depende de descendante dele e folha que depende do módulo dela são recusados", () => {
    const down = validateTree({ tasks: [mod("G", { dependsOn: ["F"] }), task("F", { parent: "G" })], sprints: [], labels: [] }).errors.join("\n");
    expect(down).toMatch(/depends on its own descendant "F"/);
    const up = validateTree({ tasks: [mod("G"), task("F", { parent: "G", dependsOn: ["G"] })], sprints: [], labels: [] }).errors.join("\n");
    expect(up).toMatch(/depends on its own ancestor "G"/);
  });
  it("ciclo entre módulos e ciclo misto (módulo e tarefa) são recusados; cadeia sem ciclo passa", () => {
    const direct = [mod("A", { dependsOn: ["B"] }), task("A1", { parent: "A" }), mod("B", { dependsOn: ["A"] }), task("B1", { parent: "B" })];
    expect(validateTree({ tasks: direct, sprints: [], labels: [] }).errors.join("\n")).toMatch(/form a cycle/);
    const mixed = [mod("A"), task("A1", { parent: "A", dependsOn: ["B1"] }), mod("B", { dependsOn: ["A"] }), task("B1", { parent: "B" })];
    expect(validateTree({ tasks: mixed, sprints: [], labels: [] }).errors.join("\n")).toMatch(/form a cycle/);
    expect(dependencyCycle(proj(mixed))).not.toBeNull();
    const chain = [mod("A"), task("A1", { parent: "A" }), mod("B", { dependsOn: ["A"] }), task("B1", { parent: "B" }), mod("C", { dependsOn: ["B"] }), task("C1", { parent: "C" })];
    expect(validateTree({ tasks: chain, sprints: [], labels: [] }).errors).toEqual([]);
    expect(dependencyCycle(proj(chain))).toBeNull();
  });
  it("dependência de ref inexistente continua recusada na criação", () => {
    const built = buildProjectTasks([input("B", { kind: "group", depends_on: ["ZZ"] }), input("B1", { parent: "B" })], pool, at);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.join("\n")).toMatch(/depends on "ZZ", which is not in the plan/);
  });
});

describe("nodeDone, isContainer e moduleProgress", () => {
  const project = proj([mod("G"), task("A", { parent: "G", status: "concluida" }), task("B", { parent: "G", status: "cancelada" }), task("C", { parent: "G", status: "concluida", skipped: true }), mod("V"), task("L"), task("X", { status: "backlog", archived: true })]);
  it("concluída, cancelada, pulada e arquivada contam como terminadas; o contêiner precisa de todas as folhas", () => {
    for (const ref of ["A", "B", "C", "X", "G"]) expect(nodeDone(project, ref)).toBe(true);
    for (const ref of ["L", "V", "ZZ"]) expect(nodeDone(project, ref)).toBe(false);
    expect(nodeDone(proj([mod("G"), task("A", { parent: "G", status: "concluida" }), task("B", { parent: "G", status: "em_andamento" })]), "G")).toBe(false);
  });
  it("isContainer: módulo (mesmo vazio) e mãe sim; folha não", () => {
    const find = (ref: string) => project.tasks.find((candidate) => candidate.ref === ref)!;
    expect(isContainer(project, find("G"))).toBe(true);
    expect(isContainer(project, find("V"))).toBe(true);
    expect(isContainer(project, find("L"))).toBe(false);
    const mother = proj([task("M", { steps: [] }), task("M1", { parent: "M" })]);
    expect(isContainer(mother, mother.tasks[0]!)).toBe(true);
  });
  it("moduleProgress = folhas do módulo (submódulos incluídos), sem canceladas nem puladas", () => {
    expect(moduleProgress(project, "G")).toEqual({ done: 1, total: 1, skipped: 1 });
    const nested = proj([mod("A"), mod("A1", { parent: "A" }), task("A11", { parent: "A1", status: "concluida" }), task("A12", { parent: "A1" }), task("A2", { parent: "A", status: "concluida" })]);
    expect(moduleProgress(nested, "A")).toEqual({ done: 2, total: 3, skipped: 0 });
    expect(moduleProgress(nested, "A1")).toEqual({ done: 1, total: 2, skipped: 0 });
  });
});

describe("progresso do projeto por unidade", () => {
  it("só tarefas: as folhas, unidade tarefas", () => {
    const project = proj([task("T1", { status: "concluida" }), task("T2"), task("T3", { status: "cancelada" }), task("T4", { status: "concluida", skipped: true })]);
    expect(projectUnitProgress(project)).toEqual({ done: 1, total: 2, skipped: 1, unit: "tarefas" });
  });
  it("só módulos: cada módulo de primeiro nível é uma unidade; o que só tem cancelada sai da conta", () => {
    const project = proj([
      mod("A"),
      task("A1", { parent: "A", status: "concluida" }),
      task("A2", { parent: "A", status: "concluida" }),
      mod("B"),
      task("B1", { parent: "B", status: "concluida" }),
      task("B2", { parent: "B" }),
      mod("C"),
      task("C1", { parent: "C", status: "cancelada" }),
    ]);
    expect(projectUnitProgress(project)).toEqual({ done: 1, total: 2, skipped: 0, unit: "modulos" });
  });
  it("submódulo não vira unidade do projeto", () => {
    const project = proj([mod("A"), mod("A1", { parent: "A" }), task("A11", { parent: "A1", status: "concluida" }), task("A12", { parent: "A1" }), task("A2", { parent: "A", status: "concluida" })]);
    expect(projectUnitProgress(project)).toEqual({ done: 0, total: 1, skipped: 0, unit: "modulos" });
  });
  it("misto: cada módulo e cada tarefa solta na raiz contam como uma unidade; módulo vazio é pendente", () => {
    const project = proj([mod("A"), task("A1", { parent: "A", status: "concluida" }), task("T1", { status: "concluida" }), task("T2"), task("T3", { status: "cancelada" }), task("T4", { status: "concluida", skipped: true }), mod("E")]);
    expect(projectUnitProgress(project)).toEqual({ done: 2, total: 4, skipped: 1, unit: "modulos" });
  });
  it("sem itens, e arquivados ficam de fora", () => {
    expect(projectUnitProgress(proj([]))).toEqual({ done: 0, total: 0, skipped: 0, unit: "tarefas" });
    expect(projectUnitProgress(proj([mod("A", { archived: true }), task("A1", { parent: "A", archived: true, status: "concluida" }), task("T", { status: "concluida" })]))).toEqual({ done: 1, total: 1, skipped: 0, unit: "tarefas" });
  });
  it("progressLabel diz a unidade", () => {
    expect(progressLabel({ done: 3, total: 8, skipped: 0, unit: "modulos" })).toBe("3 de 8 módulos concluídos");
    expect(progressLabel({ done: 12, total: 40, skipped: 1, unit: "tarefas" })).toBe("12 de 40 tarefas concluídas, 1 pulada");
    expect(progressLabel({ done: 1, total: 3 })).toBe("1 de 3 concluídas");
  });
});
