import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTreeRows, defaultClosed, dueOf, hasSprintColumn, moveTargets, readClosedRefs, treeClosedKey, writeClosedRefs, type TreeNodeRow } from "./taskTreeView";

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
  it("com o entregável fechado mostra só o primeiro nível, na ordem de `order`, e as linhas de adicionar", () => {
    const rows = buildTreeRows(sample(), new Set(["G1"]), { now: NOW, addRows: true });
    // O G2 está vazio: fica aberto e mostra o "Adicionar tarefa" dele.
    expect(keys(rows)).toEqual(["G1", "G2", "add:G2", "T5", "add:root"]);
    expect(nodes(rows).map((row) => row.open)).toEqual([false, true, false]);
  });

  it("abrir o entregável mostra as filhas e a linha de adicionar tarefa dele; abrir a mãe mostra as netas", () => {
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

  it("prioridade da folha é a dela; a do entregável é a mais urgente das folhas", () => {
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

  it("não deixa criar filha dentro de quem está no 3º nível, nem de tarefa que já começou", () => {
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
  it("tudo nasce aberto; projeto grande fecha só as tarefas-mãe (os entregáveis ficam abertos)", () => {
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
    // T4 (filha de G1): direto no projeto, dentro da mãe T1, no outro entregável G2 ou dentro da tarefa solta T5 (o G1 já é o pai dela).
    expect(targets).toEqual([null, "T1", "G2", "T5"]);
  });

  it("o nó não pode ir para dentro dele mesmo, de um descendente, nem passar de 3 níveis", () => {
    const base = sample();
    const targets = moveTargets(base, "T1").map((target) => target.ref);
    expect(targets).not.toContain("T1");
    expect(targets).not.toContain("T2");
    expect(targets).not.toContain("T3");
    // T1 tem altura 2 (ela e as filhas): só cabe direto no projeto ou num nível 1 (1 + 2 = 3); a T4 (nível 2) não serve.
    expect(targets).toEqual([null, "G2", "T5"]);
  });

  it("entregável só fica direto no projeto: sem destinos", () => {
    expect(moveTargets(sample(), "G1")).toEqual([]);
  });

  it("tarefa que já começou não vira mãe de ninguém", () => {
    const base = sample();
    Object.assign(base.tasks.find((candidate) => candidate.ref === "T5")!, { status: "em_andamento", steps: [{ agentId: "ana", what: "x", status: "em_andamento", taskId: "w" }] });
    expect(moveTargets(base, "T4").map((target) => target.ref)).toEqual([null, "T1", "G2"]);
  });
});
