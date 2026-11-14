import { projectDefaults, type Project, type ProjectTask, type Sprint } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  activeCount,
  collectEntries,
  facetOptions,
  filterEntries,
  flatten,
  groupEntries,
  NO_TASK_FILTERS,
  parseTaskFilters,
  serializeTaskFilters,
  sortEntries,
  useful,
  visibleRange,
  type TaskFilters,
} from "./allTasksView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-11T15:00:00.000Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW + n * DAY).toISOString();

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
const sprint = (id: string, order: number, status: Sprint["status"]): Sprint => ({ id, name: `Sprint ${order} · Tema`, startAt: day(-7), endAt: day(7), order, status });
const project = (id: string, title: string, tasks: ProjectTask[], extra: Partial<Project> = {}): Project => ({ ...projectDefaults(), id, title, status: "ativo", version: 1, tasks, labels: [], sprints: [], createdAt: AT, updatedAt: AT, ...extra });

const names: Record<string, string> = { ana: "Ana", beto: "Beto" };
const nameOf = (id: string) => names[id] ?? id;

const sample = () => [
  project(
    "p1",
    "Campanha",
    [
      task("G", { group: true, steps: [], ownerId: "", status: "backlog" }),
      task("T1", { parent: "G", sprintId: "S1", priority: "alta", dueAt: day(-1), status: "em_andamento", updatedAt: day(-1) }),
      task("T2", { parent: "G", sprintId: "S2", ownerId: "beto", steps: [{ agentId: "beto", what: "x", status: "pendente" }], dueAt: day(3), updatedAt: day(-2) }),
      task("T3", { sprintId: "S1", status: "concluida", finishedAt: day(-2) }),
      task("T4", { ownerId: "", steps: [], status: "backlog", priority: "baixa" }),
      task("T5", { status: "esperando_voce", priority: "alta", dueAt: day(1) }),
      task("T6", { status: "cancelada" }),
      task("T7", { archived: true }),
    ],
    { sprints: [sprint("S1", 1, "ativa"), sprint("S2", 2, "planejada")] },
  ),
  project("avulsas", "Avulsas", [task("A1", { ownerId: "beto", steps: [{ agentId: "beto", what: "x", status: "pendente" }], updatedAt: day(0) })], { system: "avulsas" }),
];

describe("collectEntries", () => {
  it("só folhas não arquivadas, com caminho, sprint e atraso", () => {
    const entries = collectEntries(sample(), NOW);
    const refs = entries.map((entry) => entry.key);
    expect(refs).toContain("p1:T1");
    expect(refs).toContain("avulsas:A1");
    expect(refs).not.toContain("p1:G");
    expect(refs).not.toContain("p1:T7");
    const t1 = entries.find((entry) => entry.key === "p1:T1")!;
    expect(t1.path).toBe("Campanha › Tarefa G");
    expect(t1.sprintKind).toBe("ativa");
    expect(t1.late).toBe(true);
    expect(entries.find((entry) => entry.key === "p1:T2")!.sprintKind).toBe("futura");
    expect(entries.find((entry) => entry.key === "p1:T5")!.waiting).toBe(true);
    expect(entries.find((entry) => entry.key === "avulsas:A1")!.sprintKind).toBe("sem");
    expect(entries.find((entry) => entry.key === "p1:T3")!.late).toBe(false);
  });
});

describe("filterEntries", () => {
  const entries = collectEntries(sample(), NOW);
  const keys = (filters: Partial<TaskFilters>) => filterEntries(entries, { ...NO_TASK_FILTERS, ...filters }, nameOf).map((entry) => entry.key);

  it("esconde concluídas e canceladas por padrão; o interruptor mostra", () => {
    expect(keys({})).not.toContain("p1:T3");
    expect(keys({})).not.toContain("p1:T6");
    expect(keys({ showDone: true })).toEqual(expect.arrayContaining(["p1:T3", "p1:T6"]));
  });

  it("escolher o estado concluída mostra elas mesmo sem o interruptor", () => {
    expect(keys({ status: "concluida" })).toEqual(["p1:T3"]);
  });

  it("projeto, agente (inclusive sem responsável), sprint e prioridade", () => {
    expect(keys({ project: "avulsas" })).toEqual(["avulsas:A1"]);
    expect(keys({ agent: "beto" }).sort()).toEqual(["avulsas:A1", "p1:T2"]);
    expect(keys({ agent: "sem" })).toEqual(["p1:T4"]);
    expect(keys({ sprint: "ativa" })).toEqual(["p1:T1"]);
    expect(keys({ sprint: "futura" })).toEqual(["p1:T2"]);
    expect(keys({ sprint: "sem" }).sort()).toEqual(["avulsas:A1", "p1:T4", "p1:T5"]);
    expect(keys({ priority: "alta" }).sort()).toEqual(["p1:T1", "p1:T5"]);
  });

  it("atalhos Esperando você e Atrasadas", () => {
    expect(keys({ waiting: true })).toEqual(["p1:T5"]);
    expect(keys({ late: true })).toEqual(["p1:T1"]);
  });

  it("a busca ignora acento e caixa e olha título, caminho e responsável", () => {
    expect(keys({ q: "TAREFA t2" })).toEqual(["p1:T2"]);
    expect(keys({ q: "campanha" }).length).toBeGreaterThan(3);
    expect(keys({ q: "beto" }).sort()).toEqual(["avulsas:A1", "p1:T2"]);
    expect(keys({ q: "nada disso" })).toEqual([]);
  });
});

describe("facetOptions", () => {
  const entries = collectEntries(sample(), NOW);
  it("conta pelas outras filtragens (não pela própria) e põe Todos primeiro", () => {
    const filters = { ...NO_TASK_FILTERS, agent: "beto" };
    const options = facetOptions(entries, filters, "agent", nameOf);
    expect(options[0]).toMatchObject({ value: "todos", label: "Todos" });
    expect(options.map((option) => option.value)).toEqual(expect.arrayContaining(["ana", "beto", "sem"]));
    expect(options.find((option) => option.value === "sem")!.label).toBe("Sem responsável");
    // Com o agente já escolhido, as outras opções continuam contadas (a contagem ignora o próprio filtro).
    expect(options.find((option) => option.value === "ana")!.count).toBeGreaterThan(0);
    const project = facetOptions(entries, { ...NO_TASK_FILTERS, agent: "beto" }, "project", nameOf);
    expect(project.find((option) => option.value === "p1")!.count).toBe(1);
  });

  it("menu com uma opção só some; ligado, continua", () => {
    const only = collectEntries([sample()[1]!], NOW);
    const options = facetOptions(only, NO_TASK_FILTERS, "project", nameOf);
    expect(options).toHaveLength(2);
    expect(useful(options, "todos")).toBe(false);
    expect(useful(options, "avulsas")).toBe(true);
  });

  it("o valor escolhido sem tarefas continua na lista", () => {
    const options = facetOptions(entries, { ...NO_TASK_FILTERS, status: "falhou" }, "status", nameOf);
    expect(options.find((option) => option.value === "falhou")).toMatchObject({ count: 0, label: "Falhou" });
  });
});

describe("agrupar e ordenar", () => {
  const entries = collectEntries(sample(), NOW);
  const shown = filterEntries(entries, NO_TASK_FILTERS, nameOf);

  it("ordena por prioridade (alta primeiro, depois a data)", () => {
    expect(sortEntries(shown, "prioridade").map((entry) => entry.key).slice(0, 2)).toEqual(["p1:T1", "p1:T5"]);
  });

  it("ordena por data (sem data por último) e por atualização (mais nova primeiro)", () => {
    const byDate = sortEntries(shown, "data").map((entry) => entry.key);
    expect(byDate.slice(0, 3)).toEqual(["p1:T1", "p1:T5", "p1:T2"]);
    expect(byDate.at(-1)).not.toBe("p1:T1");
    expect(sortEntries(shown, "atualizacao")[0]!.key).toBe("avulsas:A1");
  });

  it("sem grupo = um grupo sem rótulo", () => {
    const groups = groupEntries(shown, "nada", "prioridade", nameOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("");
    expect(flatten(groups).every((item) => item.kind === "row")).toBe(true);
  });

  it("por projeto: Avulsas por último", () => {
    expect(groupEntries(shown, "projeto", "prioridade", nameOf).map((group) => group.label)).toEqual(["Campanha", "Avulsas"]);
  });

  it("por agente: pelo primeiro responsável, 'Sem responsável' por último", () => {
    const groups = groupEntries(shown, "agente", "prioridade", nameOf);
    expect(groups.map((group) => group.label)).toEqual(["Ana", "Beto", "Sem responsável"]);
    expect(groups[2]!.entries.map((entry) => entry.key)).toEqual(["p1:T4"]);
  });

  it("por estado, na ordem de atenção", () => {
    expect(groupEntries(shown, "estado", "prioridade", nameOf).map((group) => group.label)).toEqual(["Esperando você", "Em andamento", "A fazer", "Backlog"]);
  });

  it("por sprint: ativa, futura, sem sprint", () => {
    expect(groupEntries(shown, "sprint", "prioridade", nameOf).map((group) => group.label)).toEqual(["Sprint 1 · Campanha", "Sprint 2 · Campanha", "Sem sprint"]);
  });

  it("flatten põe o cabeçalho antes das linhas do grupo", () => {
    const items = flatten(groupEntries(shown, "projeto", "prioridade", nameOf));
    expect(items[0]).toMatchObject({ kind: "head", label: "Campanha" });
    expect(items.filter((item) => item.kind === "head")).toHaveLength(2);
  });
});

describe("os filtros no endereço", () => {
  it("sem nada, a string vazia; ler a vazia dá o padrão", () => {
    expect(serializeTaskFilters(NO_TASK_FILTERS)).toBe("");
    expect(parseTaskFilters("")).toEqual(NO_TASK_FILTERS);
  });

  it("escreve e lê de volta", () => {
    const filters: TaskFilters = { q: "login página", project: "p1", agent: "eco", status: "em_andamento", sprint: "ativa", priority: "alta", waiting: true, late: true, showDone: true, group: "agente", sort: "data" };
    const text = serializeTaskFilters(filters);
    expect(text).toContain("projeto=p1");
    expect(text).toContain("agente=eco");
    expect(text).toContain("sprint=ativa");
    expect(text).toContain("agrupar=agente");
    expect(parseTaskFilters(text)).toEqual(filters);
    expect(parseTaskFilters(`?${text}`)).toEqual(filters);
  });

  it("valor inválido volta ao padrão", () => {
    const parsed = parseTaskFilters("estado=banana&sprint=lua&prio=urgente&agrupar=cor&ordem=nome&agente=");
    expect(parsed).toEqual(NO_TASK_FILTERS);
  });

  it("conta só os filtros ligados", () => {
    expect(activeCount(NO_TASK_FILTERS)).toBe(0);
    expect(activeCount({ ...NO_TASK_FILTERS, agent: "x", waiting: true, q: "a", group: "projeto" })).toBe(3);
  });
});

describe("janela de rolagem", () => {
  const many = Array.from({ length: 300 }, (_, i) => task(`T${i + 1}`));
  const entries = collectEntries([project("big", "Grande", many)], NOW);
  const items = flatten(groupEntries(entries, "nada", "prioridade", nameOf));
  const heights = { head: 30, row: 40 };

  it("com 300 tarefas só calcula as que estão à vista (mais a folga)", () => {
    const top = visibleRange(items, heights, 0, 400, 4);
    expect(top).toMatchObject({ start: 0, total: 300 * 40, offset: 0 });
    expect(top.end).toBe(10 + 4);
    const middle = visibleRange(items, heights, 4000, 400, 4);
    expect(middle.start).toBe(100 - 4);
    expect(middle.offset).toBe((100 - 4) * 40);
    expect(middle.end - middle.start).toBeLessThan(25);
  });

  it("no fim da lista pára no último item", () => {
    const end = visibleRange(items, heights, 300 * 40 - 400, 400, 4);
    expect(end.end).toBe(300);
  });

  it("cabeçalhos têm altura própria", () => {
    const grouped = flatten(groupEntries(entries, "projeto", "prioridade", nameOf));
    expect(visibleRange(grouped, heights, 0, 100, 0)).toMatchObject({ start: 0, total: 30 + 300 * 40 });
  });
});
