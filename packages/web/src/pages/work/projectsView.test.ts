import { emptyAvulsas, projectDefaults, type ForYouItem, type Project, type ProjectTask } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProjectGroups, groupOf, onlyAtRisk, openText, readOpenGroups, waitingText, writeOpenGroups } from "./projectsView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-10T15:00:00.000Z");
const hours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const task = (ref: string, agent: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: agent,
  steps: [{ agentId: agent, what: "fazer", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({ ...projectDefaults(), id, title: id, status: "ativo", version: 1, tasks: [], createdAt: AT, updatedAt: AT, ...extra });
const item = (id: string, projectId: string, extra: Partial<ForYouItem> = {}): ForYouItem => ({ id, status: "pendente", projectId, agentId: "ana", roomId: "r", title: "x", text: "x", why: "", createdAt: AT, ...extra }) as ForYouItem;

describe("groupOf", () => {
  it("ativo e pausado em progresso; proposto e ajustando na fila; terminados em concluídos", () => {
    expect(groupOf(project("a"))).toBe("progresso");
    expect(groupOf(project("b", { status: "pausado" }))).toBe("progresso");
    expect(groupOf(project("c", { status: "proposto" }))).toBe("fila");
    expect(groupOf(project("d", { status: "ajustando" }))).toBe("fila");
    expect(groupOf(project("e", { status: "concluido" }))).toBe("concluidos");
    expect(groupOf(project("f", { status: "cancelado" }))).toBe("concluidos");
    // Casca de pedido do Cyno ainda sem tarefa: espera na fila.
    expect(groupOf(project("g", { kind: "tarefa" }))).toBe("fila");
  });
});

describe("buildProjectGroups: a entrada só com projetos", () => {
  const avulsas = (tasks: ProjectTask[]): Project => ({ ...emptyAvulsas(AT), tasks });

  it("agrupa, ordena por urgência e põe o Avulsas à parte", () => {
    const projects = [
      project("lento", { priority: "baixa", tasks: [task("T1", "ana")] }),
      project("urgente", { priority: "alta", dueAt: hours(10), tasks: [task("T1", "ana"), task("T2", "beto", { status: "concluida" })] }),
      project("espera", { status: "proposto" }),
      project("feito", { status: "concluido", finishedAt: hours(-5) }),
      project("feito-antes", { status: "cancelado", finishedAt: hours(-50) }),
      avulsas([task("A1", "ana"), task("A2", "beto", { status: "concluida" })]),
    ];
    const groups = buildProjectGroups(projects, [], NOW);
    expect(groups.progresso.map((entry) => entry.project.id)).toEqual(["urgente", "lento"]);
    expect(groups.fila.map((entry) => entry.project.id)).toEqual(["espera"]);
    expect(groups.concluidos.map((entry) => entry.project.id)).toEqual(["feito", "feito-antes"]);
    expect(groups.avulsas).toMatchObject({ group: "avulsas", open: 1 });
    expect(groups.progresso.some((entry) => entry.project.system === "avulsas")).toBe(false);
  });

  it("cada linha traz progresso das folhas, agentes (até 3 e +N), prazo, prioridade e o que espera o dono", () => {
    const tasks = [task("T1", "a1"), task("T2", "a2", { status: "concluida" }), task("T3", "a3"), task("T4", "a4")];
    const forYou = [item("A-1", "p"), item("A-2", "p"), item("A-3", "p", { status: "aprovado" })];
    const [entry] = buildProjectGroups([project("p", { priority: "alta", dueAt: hours(-3), tasks })], forYou, NOW).progresso;
    expect(entry).toMatchObject({ progress: { done: 1, total: 4 }, agents: ["a1", "a2", "a3"], moreAgents: 1, priority: "alta", waiting: 2, risk: true, paused: false });
    expect(entry!.deadline).toMatchObject({ state: "late" });
    expect(waitingText(entry!.waiting)).toBe("2 esperando você");
    expect(waitingText(0)).toBe("");
    expect([0, 1, 7].map(openText)).toEqual(["Nenhuma aberta", "1 aberta", "7 abertas"]);
  });

  it("o progresso conta só folhas (o pai e o entregável não entram), sem arquivadas", () => {
    const tasks = [
      task("G", "", { group: true, steps: [], status: "backlog" }),
      task("P", "", { parent: "G", steps: [], status: "backlog" }),
      task("A", "a1", { parent: "P", status: "concluida" }),
      task("B", "a1", { parent: "P" }),
      task("C", "a1", { parent: "G", status: "concluida", archived: true }),
    ];
    const [entry] = buildProjectGroups([project("p", { tasks })], [], NOW).progresso;
    expect(entry!.progress).toEqual({ done: 1, total: 2 });
    expect(entry!.agents).toEqual(["a1"]);
  });

  it("o pausado fica em progresso com o selo; o Avulsas vazio fica oculto", () => {
    const groups = buildProjectGroups([project("p", { status: "pausado", tasks: [task("T1", "a")] }), avulsas([])], [], NOW);
    expect(groups.progresso[0]).toMatchObject({ paused: true, state: { label: "Pausado" } });
    expect(groups.avulsas).toBeNull();
  });

  it("o Avulsas mostra o que espera você e não tem prazo", () => {
    const groups = buildProjectGroups([avulsas([task("A1", "ana")])], [item("A-1", "avulsas")], NOW);
    expect(groups.avulsas).toMatchObject({ waiting: 1, deadline: null });
  });

  it("filtro de prazo em risco", () => {
    const projects = [project("a", { dueAt: hours(-1), tasks: [task("T1", "x")] }), project("b", { dueAt: hours(100), tasks: [task("T1", "x")] })];
    expect(onlyAtRisk(buildProjectGroups(projects, [], NOW)).progresso.map((entry) => entry.project.id)).toEqual(["a"]);
  });
});

describe("grupos abertos lembrados", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("começa com Concluídos recolhido, lembra o que o dono abre e sobrevive sem localStorage", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) });
    expect([...readOpenGroups()].sort()).toEqual(["fila", "progresso"]);
    writeOpenGroups(new Set(["concluidos"]));
    expect([...readOpenGroups()]).toEqual(["concluidos"]);
    const blocked = () => {
      throw new Error("bloqueado");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect([...readOpenGroups()].sort()).toEqual(["fila", "progresso"]);
    expect(() => writeOpenGroups(new Set())).not.toThrow();
  });
});
