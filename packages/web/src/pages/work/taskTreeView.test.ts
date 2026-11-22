import { assigneesOf, flowStatusOf, leavesOf, moduleProgress, projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTreeRows, defaultClosed, dueOf, hasSprintColumn, hasStateColumn, indentLevel, moveTargets, normalizeText, pathText, readClosedRefs, searchTree, TREE_PAGE, treeClosedKey, waitsText, writeClosedRefs, type TreeMoreRow, type TreeNodeRow } from "./taskTreeView";
import { releaseFilterRefs } from "./releaseView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-10T15:00:00.000Z");
const hours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

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
const group = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { group: true, steps: [], ownerId: "", status: "backlog", ...extra });
const parent = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { steps: [], ownerId: "", status: "backlog", ...extra });

const project = (tasks: ProjectTask[], extra: Partial<Project> = {}): Project => ({ ...projectDefaults(), id: "p", title: "Projeto", status: "ativo", version: 1, tasks, labels: [], sprints: [], createdAt: AT, updatedAt: AT, ...extra });
const nodes = (rows: ReturnType<typeof buildTreeRows>) => rows.filter((row): row is TreeNodeRow => row.kind === "node");
const keys = (rows: ReturnType<typeof buildTreeRows>) => rows.map((row) => row.key);

/** Front (grupo) > Login (pai) > Layout, Integração; Front > Busca (folha); Back (grupo) vazio; Solta (folha no projeto). */
const sample = () =>
  project([
    group("G1", { title: "Front-End", order: 1000 }),
    parent("T1", { parent: "G1", title: "Tela de login", order: 1000, labels: ["L1"] }),
    task("T2", { parent: "T1", title: "Layout", ownerId: "eco", steps: [{ agentId: "eco", what: "x", status: "pendente" }], order: 1000, status: "concluida", dueAt: hours(5), finishedAt: hours(-1) }),
    task("T3", { parent: "T1", title: "Integração", ownerId: "crivo", steps: [{ agentId: "crivo", what: "x", status: "em_andamento" }], order: 2000, status: "em_andamento", dueAt: hours(-30) }),
    task("T4", { parent: "G1", title: "Busca", order: 2000, priority: "baixa" }),
    group("G2", { title: "Backend", order: 2000 }),
    task("T5", { title: "Solta", order: 3000, priority: "alta" }),
  ], { labels: [{ id: "L1", name: "front", color: "blue" }] });

describe("buildTreeRows: linhas visíveis", () => {
  it("com o módulo fechado mostra só o primeiro nível, na ordem de `order`, e as linhas de adicionar", () => {
    const rows = buildTreeRows(sample(), new Set(["G1"]), { now: NOW, addRows: true });
    // O G2 está vazio: fica aberto e mostra o "Adicionar tarefa" dele.
    expect(keys(rows)).toEqual(["G1", "G2", "add:G2", "T5", "add:root"]);
    expect(nodes(rows).map((row) => row.open)).toEqual([false, true, false]);
  });

  it("abrir o módulo mostra as filhas e a linha de adicionar tarefa dele; abrir a mãe mostra as netas", () => {
    const rows = buildTreeRows(sample(), new Set(), { now: NOW, addRows: true });
    expect(keys(rows)).toEqual(["G1", "T1", "T2", "T3", "add:T1", "T4", "add:G1", "G2", "add:G2", "T5", "add:root"]);
    const login = nodes(rows).find((row) => row.ref === "T1")!;
    expect(login).toMatchObject({ depth: 2, isGroup: false, hasChildren: true, childCount: 2, open: true });
    expect(nodes(rows).find((row) => row.ref === "T2")!.depth).toBe(3);
    const addTask = rows.find((row) => row.key === "add:G1");
    expect(addTask).toMatchObject({ kind: "add", label: "Adicionar tarefa", parentRef: "G1" });
    expect(rows.find((row) => row.key === "add:T1")).toMatchObject({ label: "Adicionar subtarefa" });
  });

  it("sem addRows (projeto que não aceita criar) não há linhas de adicionar", () => {
    expect(buildTreeRows(sample(), new Set(), { now: NOW }).some((row) => row.kind === "add")).toBe(false);
  });

  it("o estado do pai é o calculado das filhas; o contador conta as folhas concluídas", () => {
    const rows = nodes(buildTreeRows(sample(), new Set(), { now: NOW }));
    const by = (ref: string) => rows.find((row) => row.ref === ref)!;
    expect(by("T1")).toMatchObject({ status: "em_andamento", progress: { done: 1, total: 2 }, childCount: 2 });
    expect(by("G1")).toMatchObject({ status: "em_andamento", progress: { done: 1, total: 3 }, childCount: 2 });
    expect(by("G2")).toMatchObject({ status: "backlog", hasChildren: false, childCount: 0 });
    expect(by("T4").progress).toBeUndefined();
    expect(by("T4").status).toBe("a_fazer");
  });

  it("responsáveis derivados (até 3, depois +N), com os do pai vindo das filhas", () => {
    const tasks = [
      parent("P"),
      task("A", { parent: "P", ownerId: "a1", steps: [{ agentId: "a1", what: "x", status: "pendente" }, { agentId: "a2", what: "y", status: "pendente" }] }),
      task("B", { parent: "P", ownerId: "a3", steps: [{ agentId: "a3", what: "x", status: "pendente" }, { agentId: "a4", what: "y", status: "pendente" }] }),
    ];
    const rows = nodes(buildTreeRows(project(tasks), new Set(), { now: NOW }));
    const p = rows.find((row) => row.ref === "P")!;
    expect(p.assignees).toEqual(["a1", "a2", "a3"]);
    expect(p.moreAssignees).toBe(1);
    expect(rows.find((row) => row.ref === "A")).toMatchObject({ assignees: ["a1", "a2"], moreAssignees: 0 });
    // Tarefa sem responsável: lista vazia.
    const none = nodes(buildTreeRows(project([task("X", { ownerId: "", steps: [{ agentId: "", what: "x", status: "pendente" }], status: "backlog" })]), new Set(), { now: NOW }))[0]!;
    expect(none.assignees).toEqual([]);
  });

  it("prioridade da folha é a dela; a do módulo é a mais urgente das folhas", () => {
    const rows = nodes(buildTreeRows(sample(), new Set(), { now: NOW }));
    expect(rows.find((row) => row.ref === "T5")!.priority).toBe("alta");
    expect(rows.find((row) => row.ref === "T4")!.priority).toBe("baixa");
    expect(rows.find((row) => row.ref === "G1")!.priority).toBe("normal");
    expect(rows.find((row) => row.ref === "G2")!.priority).toBeNull();
  });

  it("etiquetas do projeto viram objetos; ids que não existem somem", () => {
    const base = sample();
    base.tasks.find((candidate) => candidate.ref === "T1")!.labels = ["L1", "L9"];
    const login = nodes(buildTreeRows(base, new Set(), { now: NOW })).find((row) => row.ref === "T1")!;
    expect(login.labels.map((label) => label.name)).toEqual(["front"]);
  });

  it("selos: bloqueio por agente/cota e quantas folhas esperam você", () => {
    const base = project([
      group("G"),
      task("A", { parent: "G", status: "esperando_voce", blocked: { type: "voce", note: "x", since: AT } }),
      task("B", { parent: "G", status: "a_fazer", blocked: { type: "cota", note: "sem cota", since: AT } }),
    ]);
    const g = nodes(buildTreeRows(base, new Set(), { now: NOW })).find((row) => row.ref === "G")!;
    expect(g).toMatchObject({ waiting: 1, blocked: true });
  });

  it("tarefas arquivadas não aparecem nem contam", () => {
    const base = sample();
    base.tasks.find((candidate) => candidate.ref === "T5")!.archived = true;
    expect(keys(buildTreeRows(base, new Set(["G1"]), { now: NOW }))).toEqual(["G1", "G2"]);
    base.tasks.find((candidate) => candidate.ref === "T2")!.archived = true;
    const login = nodes(buildTreeRows(base, new Set(), { now: NOW })).find((row) => row.ref === "T1")!;
    expect(login.childCount).toBe(1);
  });

  it("não deixa criar filha dentro de tarefa que já começou (sem limite de nível)", () => {
    const rows = nodes(buildTreeRows(sample(), new Set(), { now: NOW, addRows: true }));
    const by = (ref: string) => rows.find((row) => row.ref === ref)!;
    expect(by("G1").canAddChild).toBe(true);
    expect(by("T1").canAddChild).toBe(true);
    expect(by("T2").canAddChild).toBe(false);
    expect(by("T3").canAddChild).toBe(false);
    expect(by("T4").canAddChild).toBe(true);
  });

  it("a coluna Sprint só existe com sprints", () => {
    expect(hasSprintColumn(project([]))).toBe(false);
    expect(hasSprintColumn(project([], { sprints: [{ id: "S1", name: "S1", startAt: AT, endAt: AT, order: 0, status: "ativa" }] }))).toBe(true);
    const base = sample();
    base.tasks.find((candidate) => candidate.ref === "T4")!.sprintId = "S1";
    const g1 = nodes(buildTreeRows(base, new Set(), { now: NOW })).find((row) => row.ref === "G1")!;
    expect(g1.sprints).toEqual(["S1"]);
  });
});

describe("dueOf: a coluna Data", () => {
  const t = (extra: Partial<ProjectTask>) => task("X", extra);
  it("verde concluída no prazo, vermelha atrasada, âmbar em menos de 24 h, normal no resto", () => {
    const p = project([]);
    expect(dueOf(p, t({ dueAt: hours(5), finishedAt: hours(-1), status: "concluida" }), "concluida", NOW)).toMatchObject({ tone: "done" });
    expect(dueOf(p, t({ dueAt: hours(-5), finishedAt: hours(-2), status: "concluida" }), "concluida", NOW)).toMatchObject({ tone: "late", title: "Concluída depois do prazo" });
    expect(dueOf(p, t({ dueAt: hours(-30) }), "a_fazer", NOW)).toMatchObject({ tone: "late" });
    expect(dueOf(p, t({ dueAt: hours(10) }), "a_fazer", NOW)).toMatchObject({ tone: "soon" });
    expect(dueOf(p, t({ dueAt: hours(72) }), "a_fazer", NOW)).toMatchObject({ tone: "normal" });
    expect(dueOf(p, t({}), "a_fazer", NOW)).toBeNull();
  });

  it("o pai sem prazo próprio mostra o maior das folhas", () => {
    const base = project([parent("P"), task("A", { parent: "P", dueAt: hours(48) }), task("B", { parent: "P", dueAt: hours(96) })]);
    expect(dueOf(base, base.tasks[0]!, "a_fazer", NOW)?.at).toBe(hours(96));
  });

  it("a data atrasada de uma linha aparece vermelha na árvore", () => {
    const rows = nodes(buildTreeRows(sample(), new Set(), { now: NOW }));
    expect(rows.find((row) => row.ref === "T3")!.due?.tone).toBe("late");
    expect(rows.find((row) => row.ref === "T2")!.due?.tone).toBe("done");
  });
});

describe("fechados lembrados", () => {
  it("tudo nasce aberto; projeto grande fecha só as tarefas-mãe (os módulos ficam abertos)", () => {
    expect([...defaultClosed(sample())]).toEqual([]);
    const many = project([group("G"), parent("P", { parent: "G" }), ...Array.from({ length: 45 }, (_, i) => task(`X${i}`, { parent: "P" }))]);
    expect([...defaultClosed(many)]).toEqual(["P"]);
  });

  it("tarefa-mãe que aparece depois nasce aberta (não está na lista dos fechados)", () => {
    const base = project([group("G"), task("A", { parent: "G" })]);
    const closed = defaultClosed(base);
    base.tasks.push(task("B", { parent: "A" }));
    expect(nodes(buildTreeRows(base, closed, { now: NOW })).find((row) => row.ref === "A")!.open).toBe(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lê e grava no localStorage (e sobrevive sem ele)", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) });
    const key = treeClosedKey("ws", "p");
    expect(readClosedRefs(key)).toBeNull();
    writeClosedRefs(key, new Set(["G1", "T1"]));
    expect([...readClosedRefs(key)!].sort()).toEqual(["G1", "T1"]);
    data.set(key, "{lixo");
    expect(readClosedRefs(key)).toBeNull();
    const blocked = () => {
      throw new Error("bloqueado");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(readClosedRefs(key)).toBeNull();
    expect(() => writeClosedRefs(key, new Set())).not.toThrow();
  });
});

describe("moveTargets: Mover para…", () => {
  it("lista o projeto e os pais que cabem, sem o próprio nó nem o que está dentro dele", () => {
    const base = sample();
    const targets = moveTargets(base, "T4").map((target) => target.ref);
    // T4 (filha de G1): direto no projeto, dentro da mãe T1, no outro módulo G2 ou dentro da tarefa solta T5 (o G1 já é o pai dela).
    expect(targets).toEqual([null, "T1", "G2", "T5"]);
  });

  it("o nó não pode ir para dentro dele mesmo nem de um descendente; sem limite de níveis", () => {
    const base = sample();
    const targets = moveTargets(base, "T1").map((target) => target.ref);
    expect(targets).not.toContain("T1");
    expect(targets).not.toContain("T2");
    expect(targets).not.toContain("T3");
    // Sem limite de profundidade: a T4 (irmã de T1 no G1) também serve; o G1 já é o pai dela.
    expect(targets).toEqual([null, "T4", "G2", "T5"]);
  });

  it("módulo pode ir para dentro de outro módulo ou de uma tarefa", () => {
    const targets = moveTargets(sample(), "G1");
    expect(targets.map((target) => target.ref)).toEqual(["G2", "T5"]);
    expect(targets[0]).toMatchObject({ label: "Backend", path: "", container: true });
    expect(targets[1]).toMatchObject({ container: false });
  });

  it("destino mostra o caminho e não oferece o que criaria dependência impossível", () => {
    const base = sample();
    base.tasks.find((candidate) => candidate.ref === "G2")!.parent = "G1";
    expect(moveTargets(base, "T5").find((target) => target.ref === "G2")).toMatchObject({ path: "Front-End", depth: 2 });
    // G1 espera T5: T5 dentro de G1 (ou de quem está dentro) nunca começaria.
    base.tasks.find((candidate) => candidate.ref === "G1")!.dependsOn = ["T5"];
    expect(moveTargets(base, "T5").map((target) => target.ref)).toEqual([]);
  });

  it("tarefa que já começou não vira mãe de ninguém", () => {
    const base = sample();
    Object.assign(base.tasks.find((candidate) => candidate.ref === "T5")!, { status: "em_andamento", steps: [{ agentId: "ana", what: "x", status: "em_andamento", taskId: "w" }] });
    expect(moveTargets(base, "T4").map((target) => target.ref)).toEqual([null, "T1", "G2"]);
  });
});

/** Cria N tarefas folha numa lista, filhas de `parentRef`. */
const leaves = (parentRef: string, count: number, prefix = "L", extra: Partial<ProjectTask> = {}) => Array.from({ length: count }, (_, i) => task(`${prefix}${i + 1}`, { parent: parentRef, order: (i + 1) * 10, title: `Capítulo ${i + 1}`, ...extra }));

describe("módulo dentro de módulo e sem limite de profundidade", () => {
  /** M1 > M2 > M3 > M4 > T (profundidade 5, tudo módulo menos a folha). */
  const deep = () =>
    project([group("M1", { title: "Leitura" }), group("M2", { parent: "M1", title: "Capítulos" }), group("M3", { parent: "M2", title: "Lote 1" }), group("M4", { parent: "M3", title: "Revisão" }), task("T", { parent: "M4", title: "Ler" })]);

  it("mostra todos os níveis, com contêiner, caminho e botões de criar em cada módulo", () => {
    const rows = buildTreeRows(deep(), new Set(), { now: NOW, addRows: true });
    expect(keys(rows)).toEqual(["M1", "M2", "M3", "M4", "T", "add:M4", "add:M3", "add:M2", "add:M1", "add:root"]);
    const t = nodes(rows).find((row) => row.ref === "T")!;
    expect(t).toMatchObject({ depth: 5, isContainer: false, trail: ["Leitura", "Capítulos", "Lote 1", "Revisão"] });
    const m3 = nodes(rows).find((row) => row.ref === "M3")!;
    expect(m3).toMatchObject({ depth: 3, isContainer: true, isGroup: true, canAddChild: true, progress: { done: 0, total: 1 } });
    // Cada módulo aberto oferece "+ Módulo" e "+ Tarefa"; o fim do projeto também.
    for (const key of ["add:M1", "add:M2", "add:M3", "add:M4", "add:root"]) expect(rows.find((row) => row.key === key)).toMatchObject({ kind: "add", both: true });
  });

  it("tarefa com subtarefas oferece só subtarefa; módulo oferece módulo e tarefa", () => {
    const rows = buildTreeRows(sample(), new Set(), { now: NOW, addRows: true });
    expect(rows.find((row) => row.key === "add:T1")).toMatchObject({ both: false, label: "Adicionar subtarefa" });
    expect(rows.find((row) => row.key === "add:G1")).toMatchObject({ both: true });
  });

  it("indentação: no desktop um nível por ancestral, no celular pára no 4º", () => {
    expect([1, 2, 3, 4, 5, 9, 40].map((depth) => indentLevel(depth, false))).toEqual([0, 1, 2, 3, 4, 8, 39]);
    expect([1, 2, 3, 4, 5, 9, 40].map((depth) => indentLevel(depth, true))).toEqual([0, 1, 2, 3, 3, 3, 3]);
    expect(pathText(["Leitura", "Capítulos", "Lote 1"])).toBe("Leitura > Capítulos > Lote 1");
  });

  it("o contêiner mostra feitas/total das atividades (folhas), igual ao moduleProgress do shared", () => {
    const base = project([
      group("M1"),
      group("M2", { parent: "M1" }),
      ...leaves("M2", 4, "A", { status: "concluida" }).slice(0, 1),
      ...leaves("M2", 4, "B").slice(1),
      task("X", { parent: "M1", status: "cancelada" }),
      task("Y", { parent: "M1", status: "concluida", skipped: true }),
    ]);
    const rows = nodes(buildTreeRows(base, new Set(), { now: NOW }));
    for (const ref of ["M1", "M2"]) {
      const { done, total } = moduleProgress(base, ref);
      expect(rows.find((row) => row.ref === ref)!.progress).toEqual({ done, total });
    }
    expect(rows.find((row) => row.ref === "M2")!.progress).toEqual({ done: 1, total: 4 });
  });

  it("as contas por linha batem com as funções do shared (estado, responsáveis, folhas)", () => {
    const base = project([
      group("G"),
      parent("P", { parent: "G" }),
      task("a", { parent: "P", ownerId: "ana", status: "concluida", dueAt: hours(10), finishedAt: hours(1) }),
      task("b", { parent: "P", ownerId: "bia", status: "em_andamento", dueAt: hours(40) }),
      task("c", { parent: "P", ownerId: "cris", dependsOn: ["x"], status: "backlog" }),
      task("x", { parent: "G", status: "cancelada" }),
      group("G2", { parent: "G" }),
      task("d", { parent: "G2", status: "esperando_voce" }),
    ]);
    const rows = nodes(buildTreeRows(base, new Set(), { now: NOW }));
    for (const row of rows) {
      expect(row.status, row.ref).toBe(flowStatusOf(base, row.node));
      expect(row.assignees, row.ref).toEqual(assigneesOf(base, row.node, 3));
      if (row.isContainer) expect(row.progress?.total, row.ref).toBe(moduleProgress(base, row.ref).total);
      expect(row.waiting, row.ref).toBe(leavesOf(base, row.ref).filter((leaf) => leaf.status === "esperando_voce").length);
    }
  });
});

describe("dependência entre módulos", () => {
  const modules = (done: boolean) =>
    project([
      group("A", { title: "Autenticação", order: 1000 }),
      task("a1", { parent: "A", status: done ? "concluida" : "a_fazer" }),
      group("B", { title: "Pagamentos", dependsOn: ["A"], order: 2000 }),
      task("b1", { parent: "B" }),
      group("C", { title: "Relatórios", dependsOn: ["A", "B"], order: 3000 }),
      task("c1", { parent: "C" }),
    ]);

  it("o módulo que espera outro mostra 'espera Autenticação' até o outro terminar", () => {
    const pending = nodes(buildTreeRows(modules(false), new Set(), { now: NOW }));
    expect(pending.find((row) => row.ref === "B")!.waits).toBe("espera Autenticação");
    expect(pending.find((row) => row.ref === "C")!.waits).toBe("espera Autenticação e Pagamentos");
    expect(pending.find((row) => row.ref === "A")!.waits).toBeUndefined();
    const finished = nodes(buildTreeRows(modules(true), new Set(), { now: NOW }));
    expect(finished.find((row) => row.ref === "B")!.waits).toBeUndefined();
    expect(finished.find((row) => row.ref === "C")!.waits).toBe("espera Pagamentos");
  });

  it("frases de espera: uma, duas ou mais", () => {
    expect(waitsText([])).toBe("");
    expect(waitsText(["A"])).toBe("espera A");
    expect(waitsText(["A", "B"])).toBe("espera A e B");
    expect(waitsText(["A", "B", "C", "D"])).toBe("espera A e mais 3");
  });

  it("tarefa que espera um módulo também mostra a espera (módulo vazio ainda não terminou)", () => {
    const base = project([group("A", { title: "Vazio" }), task("t", { dependsOn: ["A"], title: "Depois" })]);
    const row = nodes(buildTreeRows(base, new Set(), { now: NOW })).find((candidate) => candidate.ref === "t")!;
    expect(row.waits).toBe("espera Vazio");
    expect(row.flow).toBeDefined();
  });
});

describe("árvore grande: ver mais, recolher e busca", () => {
  const chapters = () => project([group("Lote", { title: "Lote 1" }), ...leaves("Lote", 100)]);

  it("grupo com mais de 30 filhos começa recolhido (e quem tem até 30 fica aberto)", () => {
    expect([...defaultClosed(chapters())]).toEqual(["Lote"]);
    expect([...defaultClosed(project([group("G"), ...leaves("G", 30)]))]).toEqual([]);
  });

  it("projeto grande abre só o que cabe em umas 300 linhas, e o de dentro de um fechado também começa fechado", () => {
    const tasks: ProjectTask[] = [];
    for (let m = 0; m < 20; m += 1) {
      tasks.push(group(`M${m}`, { order: m }));
      for (let s = 0; s < 10; s += 1) {
        tasks.push(group(`M${m}S${s}`, { parent: `M${m}`, order: s }));
        for (let t = 0; t < 9; t += 1) tasks.push(task(`M${m}S${s}T${t}`, { parent: `M${m}S${s}`, order: t }));
      }
    }
    const closed = defaultClosed(project(tasks));
    // Os módulos de primeiro nível abrem; os submódulos só enquanto couber no orçamento.
    expect(closed.has("M0")).toBe(false);
    expect(closed.has("M19")).toBe(false);
    expect(closed.has("M19S9")).toBe(true);
    expect(closed.size).toBeGreaterThan(150);
  });

  it("aberto, mostra 30 filhos e a linha 'ver mais 70'; cada pedido soma 30 até acabar", () => {
    const base = chapters();
    const first = buildTreeRows(base, new Set(), { now: NOW, addRows: true });
    expect(nodes(first).filter((row) => row.parentRef === "Lote")).toHaveLength(TREE_PAGE);
    expect(first.find((row) => row.kind === "more")).toMatchObject({ key: "more:Lote", parentRef: "Lote", remaining: 70 });
    const second = buildTreeRows(base, new Set(), { now: NOW, shown: new Map([["Lote", 60]]) });
    expect(nodes(second).filter((row) => row.parentRef === "Lote")).toHaveLength(60);
    expect((second.find((row) => row.kind === "more") as TreeMoreRow).remaining).toBe(40);
    const all = buildTreeRows(base, new Set(), { now: NOW, shown: new Map([["Lote", 120]]) });
    expect(all.some((row) => row.kind === "more")).toBe(false);
    expect(nodes(all).filter((row) => row.parentRef === "Lote")).toHaveLength(100);
    // A linha de adicionar segue depois do "ver mais".
    expect(keys(first).slice(-3)).toEqual(["more:Lote", "add:Lote", "add:root"]);
  });

  it("recolhido não gera linha dos filhos (desempenho), mas o progresso do grupo conta todos", () => {
    const rows = buildTreeRows(chapters(), new Set(["Lote"]), { now: NOW });
    expect(keys(rows)).toEqual(["Lote"]);
    expect(nodes(rows)[0]).toMatchObject({ open: false, childCount: 100, progress: { done: 0, total: 100 } });
  });

  it("a raiz também pagina: 45 módulos de primeiro nível mostram 30 e 'ver mais 15'", () => {
    const base = project(Array.from({ length: 45 }, (_, i) => group(`M${i}`, { order: i })));
    const rows = buildTreeRows(base, new Set(), { now: NOW });
    expect(nodes(rows)).toHaveLength(30);
    expect(rows.find((row) => row.kind === "more")).toMatchObject({ key: "more:root", remaining: 15, depth: 1 });
  });

  it("projeto com 2.000 itens monta rápido e só desenha o que está aberto", () => {
    const tasks: ProjectTask[] = [];
    for (let m = 0; m < 20; m += 1) {
      tasks.push(group(`M${m}`, { order: m }));
      for (let s = 0; s < 10; s += 1) {
        tasks.push(group(`M${m}S${s}`, { parent: `M${m}`, order: s }));
        for (let t = 0; t < 9; t += 1) tasks.push(task(`M${m}S${s}T${t}`, { parent: `M${m}S${s}`, order: t }));
      }
    }
    const base = project(tasks);
    expect(tasks.length).toBe(2020);
    const started = Date.now();
    const rows = buildTreeRows(base, defaultClosed(base), { now: NOW });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(rows.length).toBeLessThan(600);
  });

  it("busca: acha por título (sem acento nem caixa) ou código, mantém os ancestrais abertos e não mostra o resto", () => {
    const base = project([
      group("G1", { title: "Leitura" }),
      group("G2", { parent: "G1", title: "Capítulos" }),
      task("T10", { parent: "G2", title: "Ação inicial" }),
      task("T11", { parent: "G2", title: "Outro" }),
      group("G3", { title: "Escrita" }),
      task("T12", { parent: "G3", title: "Rascunho" }),
    ]);
    const rows = buildTreeRows(base, new Set(["G1", "G2"]), { now: NOW, addRows: true, query: "ACAO" });
    expect(keys(rows)).toEqual(["G1", "G2", "T10"]);
    expect(nodes(rows).map((row) => row.open)).toEqual([true, true, false]);
    // Pelo código.
    expect(keys(buildTreeRows(base, new Set(), { now: NOW, query: "t12" }))).toEqual(["G3", "T12"]);
    // Sem resultado: nada na lista.
    expect(buildTreeRows(base, new Set(), { now: NOW, addRows: true, query: "zzz" })).toEqual([]);
    // Busca só com espaços volta à árvore normal.
    expect(keys(buildTreeRows(base, new Set(), { now: NOW, query: "   " })).length).toBe(6);
    expect(searchTree(base, "outro")?.matches).toEqual(new Set(["T11"]));
    expect(normalizeText("Ação Âncora")).toBe("acao ancora");
  });

  it("a busca também respeita o 'ver mais' por nível", () => {
    const rows = buildTreeRows(chapters(), new Set(), { now: NOW, query: "capítulo" });
    expect(nodes(rows).filter((row) => row.parentRef === "Lote")).toHaveLength(TREE_PAGE);
    expect(rows.find((row) => row.kind === "more")).toMatchObject({ remaining: 70 });
  });
});

describe("liberação na árvore: coluna Estado, filtro e aviso de dependência Planejada", () => {
  it("sem sprints entra a coluna Estado; com sprints fica a coluna Sprint", () => {
    expect(hasStateColumn(project([]))).toBe(true);
    expect(hasStateColumn(project([], { sprints: [{ id: "S1", name: "S1", startAt: AT, endAt: AT, order: 0, status: "ativa" }] }))).toBe(false);
  });

  it("cada linha traz o estado de liberação e o aviso quando espera item Planejado", () => {
    const base = project([
      group("M1", { title: "Pesquisa" }),
      task("T1", { parent: "M1", title: "Planejada", released: false, status: "a_fazer" }),
      task("T2", { parent: "M1", title: "Rodando", released: true, status: "em_andamento" }),
      group("M2", { title: "Escrita", released: false }),
      task("T3", { title: "Depende da T1", released: true, dependsOn: ["T1"], status: "backlog" }),
      task("T4", { title: "Depende da T3", released: true, dependsOn: ["T3"], status: "backlog" }),
    ]);
    const rows = nodes(buildTreeRows(base, new Set(), { now: NOW }));
    const by = (ref: string) => rows.find((row) => row.ref === ref)!;
    expect(by("T1").state).toEqual({ label: "Planejada", tone: "planned", planned: true });
    expect(by("T2").state).toEqual({ label: "Em andamento", tone: "running", planned: false });
    expect(by("M1").state).toEqual({ label: "Misto", tone: "neutral", planned: false });
    expect(by("M2").state).toEqual({ label: "Planejado", tone: "planned", planned: true });
    expect(by("T3").plannedWaits.map((item) => item.ref)).toEqual(["T1"]);
    expect(by("T4").plannedWaits.map((item) => item.ref)).toEqual(["T1"]);
    expect(by("T1").plannedWaits).toEqual([]);
  });

  it("filtro Mostrar filtra folhas mantendo ancestrais e combina com a busca sem deixar módulo fantasma", () => {
    const base = project([
      group("M1", { title: "Módulo 1" }),
      task("T1", { parent: "M1", title: "Login", released: true }),
      task("T2", { parent: "M1", title: "Logout", released: false }),
      group("M2", { title: "Módulo 2" }),
      task("T3", { parent: "M2", title: "Pagamento", released: true }),
    ]);
    const planned = buildTreeRows(base, new Set(["M1", "M2"]), { now: NOW, filter: releaseFilterRefs(base, "planejadas") });
    expect(keys(planned)).toEqual(["M1", "T2"]);
    const released = buildTreeRows(base, new Set(["M1", "M2"]), { now: NOW, filter: releaseFilterRefs(base, "liberadas") });
    expect(keys(released)).toEqual(["M1", "T1", "M2", "T3"]);
    // Busca "Login" (liberada) com filtro "Planejadas": nada aparece (nem M1 vazio).
    expect(keys(buildTreeRows(base, new Set(), { now: NOW, query: "Login", filter: releaseFilterRefs(base, "planejadas") }))).toEqual([]);
    // Busca "Logout" (planejada) com filtro "Planejadas": mostra M1 e T2.
    expect(keys(buildTreeRows(base, new Set(), { now: NOW, query: "Logout", filter: releaseFilterRefs(base, "planejadas") }))).toEqual(["M1", "T2"]);
  });
});
