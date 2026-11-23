import { assigneesOf, blockedLeaves, childrenOf, flowStatusOf, leavesOf, plannedLeafCount, projectDefaults, projectUnitProgress, releaseHold, releaseState, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { detectHandoffs } from "./planView";
import { buildProjectIndex, containerReleaseFromAgg, releaseStateIn } from "./projectIndex";
import { releaseCounts, releaseFilterRefs } from "./releaseView";
import { buildTreeRows, TREE_PAGE, treeVisibleRange, type TreeNodeRow } from "./taskTreeView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-23T03:30:00.000Z");
const AGENTS = ["lia", "davi", "nina", "caio", "bruna", "iara"] as const;
const PRIORITIES = ["alta", "normal", "baixa"] as const;
const STATUSES: readonly ProjectTask["status"][] = ["concluida", "concluida", "em_andamento", "a_fazer", "a_fazer", "a_fazer", "backlog", "backlog", "esperando_voce", "cancelada"];

const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: "lia",
  steps: [{ agentId: "lia", what: "fazer", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  ...extra,
});

const group = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => task(ref, { group: true, steps: [], ownerId: "", status: "backlog", ...extra });

/** Monta um projeto sintético grande (módulos > tarefas > subtarefas, com dependências e itens Planejados). */
function syntheticProject(modules: number, tasksPerMod: number, subsPerTask: number): Project {
  const tasks: ProjectTask[] = [];
  let seq = 1;
  for (let m = 1; m <= modules; m += 1) {
    const modRef = `G${m}`;
    const modDeps = m === 3 || m === 6 ? [`G${m - 1}`] : [];
    tasks.push(group(modRef, { title: `Módulo ${m}`, order: m * 1000, dependsOn: modDeps, priority: PRIORITIES[m % PRIORITIES.length]! }));
    for (let t = 1; t <= tasksPerMod; t += 1) {
      const taskRef = `T${seq++}`;
      const isContainer = subsPerTask > 0;
      const agent = AGENTS[(m + t) % AGENTS.length]!;
      tasks.push(
        task(taskRef, {
          parent: modRef,
          title: `Tarefa ${m}.${t}`,
          order: t * 1000,
          ownerId: isContainer ? "" : agent,
          steps: isContainer ? [] : [{ agentId: agent, what: "executar", status: "pendente" }],
          status: isContainer ? "backlog" : STATUSES[(m + t) % STATUSES.length]!,
          priority: PRIORITIES[(m + t) % PRIORITIES.length]!,
        }),
      );
      let prev: string | undefined;
      for (let s = 1; s <= subsPerTask; s += 1) {
        const subRef = `T${seq++}`;
        const subAgent = AGENTS[(m + t + s) % AGENTS.length]!;
        const status = STATUSES[(m * 7 + t * 3 + s) % STATUSES.length]!;
        const released = (m + t + s) % 3 === 0 ? false : true;
        tasks.push(
          task(subRef, {
            parent: taskRef,
            title: `Subtarefa ${m}.${t}.${s}`,
            order: s * 1000,
            ownerId: subAgent,
            steps: [{ agentId: subAgent, what: "passo", status: status === "concluida" ? "feita" : status === "em_andamento" ? "em_andamento" : "pendente" }],
            status,
            priority: PRIORITIES[(m + t + s) % PRIORITIES.length]!,
            dependsOn: s === 2 && prev ? [prev] : [],
            ...(released === false ? { released: false } : {}),
            ...(status === "a_fazer" ? { waitingSince: AT } : {}),
          }),
        );
        prev = subRef;
      }
    }
  }
  return { ...projectDefaults(), id: "big", title: "Projeto Grande", status: "pausado", version: 1, tasks, labels: [], sprints: [], createdAt: AT, updatedAt: AT };
}

describe("projectIndex: paridade com as funções de referência do shared", () => {
  it("unitProgress, agentIds, releaseCounts, agg e estado de liberação batem com o shared", () => {
    const base = syntheticProject(4, 5, 3);
    // Acrescenta um item arquivado e uma folha pulada para cobrir os cantos.
    base.tasks.push(task("ARCH", { parent: "G1", archived: true, ownerId: "zeca", steps: [{ agentId: "zeca", what: "x", status: "feita", taskId: "step-arch-1" }], status: "concluida" }));
    base.tasks.push(task("SKIP", { parent: "G2", status: "concluida", skipped: true }));

    const live = { tasks: base.tasks.filter((item) => !item.archived) };
    const index = buildProjectIndex(base.tasks);

    expect(index.unitProgress).toEqual(projectUnitProgress(live));
    expect(index.leaves.map((leaf) => leaf.ref)).toEqual(leavesOf(live).map((leaf) => leaf.ref));
    expect(index.stepTaskIds.has("step-arch-1")).toBe(true);

    const expectedAgents: string[] = [];
    for (const root of childrenOf(live)) for (const id of assigneesOf(live, root, Number.POSITIVE_INFINITY)) if (!expectedAgents.includes(id)) expectedAgents.push(id);
    expect(index.agentIds).toEqual(expectedAgents);

    expect(releaseCounts(base, index)).toEqual({
      released: leavesOf(live).filter((leaf) => leaf.status !== "concluida" && leaf.status !== "cancelada" && releaseHold(leaf) === undefined).length,
      planned: plannedLeafCount(live),
    });

    for (const node of live.tasks) {
      expect(index.agg.get(node.ref)?.status, node.ref).toBe(flowStatusOf(live, node));
      expect(releaseStateIn(index, node.ref), node.ref).toBe(releaseState(live, node.ref));
      if (!index.leafSet.has(node.ref)) {
        expect(containerReleaseFromAgg(index.agg.get(node.ref)), node.ref).toBe(releaseState(live, node.ref));
      }
    }
  });
});

describe("escala com 10 mil itens (trava de desempenho)", () => {
  const big = syntheticProject(50, 40, 4);

  it("tem 10.050 itens, indexa e gera apenas as linhas visíveis rápido (< 100 ms por chamada de buildTreeRows)", () => {
    expect(big.tasks.length).toBe(10_050);

    const tIndex0 = performance.now();
    const index = buildProjectIndex(big.tasks);
    const indexMs = performance.now() - tIndex0;
    expect(indexMs).toBeLessThan(500);

    // Árvore fechada: gera só as 30 raízes da 1ª página + "ver mais 20" + "+ Módulo / + Tarefa" = 32 linhas.
    const tClosed0 = performance.now();
    const closedRows = buildTreeRows(big, new Set(), { index, openRefs: new Set(), addRows: true, now: NOW });
    const closedMs = performance.now() - tClosed0;
    expect(closedRows).toHaveLength(TREE_PAGE + 2);
    expect(closedRows.filter((row): row is TreeNodeRow => row.kind === "node").every((row) => !row.open)).toBe(true);
    expect(closedMs).toBeLessThan(100);

    // Abrir 1 módulo (40 tarefas -> 30 na 1ª página + ver mais + add): continua gerando só o aberto, rápido.
    const tOpen0 = performance.now();
    const openRows = buildTreeRows(big, new Set(), { index, openRefs: new Set(["G1"]), addRows: true, now: NOW });
    const openMs = performance.now() - tOpen0;
    expect(openRows).toHaveLength(TREE_PAGE + 2 + TREE_PAGE + 2);
    expect(openMs).toBeLessThan(100);

    // Filtro "Planejadas" reaproveitando o índice também é linear e rápido.
    const tFilter0 = performance.now();
    const plannedRefs = releaseFilterRefs(big, "planejadas", index);
    const filterMs = performance.now() - tFilter0;
    expect(plannedRefs?.size ?? 0).toBeGreaterThan(0);
    expect(filterMs).toBeLessThan(100);
  });

  it("detectHandoffs e blockedLeaves escalam em O(n) com 10.050 itens", () => {
    const mutated: Project = { ...big, version: 2, tasks: big.tasks.map((item, idx) => (idx === 2 ? { ...item, title: "Alterada" } : item)) };
    const tHandoff0 = performance.now();
    expect(detectHandoffs(big, mutated)).toEqual([]);
    expect(performance.now() - tHandoff0).toBeLessThan(100);

    const tBlocked0 = performance.now();
    const blocked = blockedLeaves(big);
    expect(Array.isArray(blocked)).toBe(true);
    expect(performance.now() - tBlocked0).toBeLessThan(250);
  });

  it("treeVisibleRange virtualiza listas com > 200 linhas abertas mantendo poucas linhas no DOM", () => {
    const openAll = new Set(Array.from({ length: 10 }, (_, i) => `G${i + 1}`));
    const index = buildProjectIndex(big.tasks);
    const rows = buildTreeRows(big, new Set(), { index, openRefs: openAll, addRows: true });
    expect(rows.length).toBeGreaterThan(200);

    const top = treeVisibleRange(rows, false, 0, 700, 10);
    expect(top.start).toBe(0);
    expect(top.end - top.start).toBeLessThan(45);
    expect(top.offset).toBe(0);
    expect(top.bottom).toBeGreaterThan(0);

    const mid = treeVisibleRange(rows, false, 4000, 700, 10);
    expect(mid.start).toBeGreaterThan(50);
    expect(mid.end - mid.start).toBeLessThan(55);
    expect(mid.offset).toBeGreaterThan(0);
  });
});
