import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { collectEntries } from "./allTasksView";
import { buildSprintLanes } from "./sprintsView";
import { awaitingUser, buildRows, buildWorkBoard, currentOwner } from "./workView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = new Date("2026-11-10T15:00:00.000Z");

const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => {
  const owner = extra.ownerId ?? "sonia";
  return { ref, title: `Tarefa ${ref}`, briefing: "b", ownerId: owner, steps: [{ agentId: owner, what: "fazer", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", doneWhen: [], rework: { count: 0 }, status: "a_fazer", updatedAt: AT, ...extra };
};
const mother = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { steps: [], ownerId: "", status: "backlog", ...extra });

/** Entregável G > mãe P > três subtarefas de agentes diferentes (a do meio espera você), com a sprint S1. */
const project = (): Project => ({
  ...projectDefaults(),
  id: "p",
  title: "Campanha",
  status: "ativo",
  version: 1,
  labels: [],
  sprints: [{ id: "S1", name: "Sprint 1", startAt: "2026-11-09T00:00:00.000Z", endAt: "2026-11-16T00:00:00.000Z", order: 1, status: "ativa" }],
  tasks: [
    task("G", { group: true, steps: [], ownerId: "", status: "backlog" }),
    mother("P", { parent: "G" }),
    task("a", { parent: "P", ownerId: "sonia", status: "concluida", sprintId: "S1", result: "ok", finishedAt: AT }),
    task("b", { parent: "P", ownerId: "davi", status: "esperando_voce", sprintId: "S1", dependsOn: ["a"], waitingSince: AT }),
    task("c", { parent: "P", ownerId: "hugo", status: "backlog", sprintId: "S1", dependsOn: ["b"] }),
  ],
  createdAt: AT,
  updatedAt: AT,
});

describe("subtarefas nas outras telas: todos aparecem e nada conta em dobro", () => {
  it("Todas as tarefas: uma linha por subtarefa (a mãe e o entregável não entram), cada uma com o seu responsável e o caminho", () => {
    const entries = collectEntries([project()], NOW.getTime());
    expect(entries.map((entry) => [entry.task.ref, entry.assignees, entry.path])).toEqual([
      ["a", ["sonia"], "Campanha › Tarefa G › Tarefa P"],
      ["b", ["davi"], "Campanha › Tarefa G › Tarefa P"],
      ["c", ["hugo"], "Campanha › Tarefa G › Tarefa P"],
    ]);
  });

  it("o quadro do Trabalho: um cartão por subtarefa (sem cartão da mãe nem do entregável)", () => {
    const rows = buildRows([project()], [], NOW);
    const columns = buildWorkBoard(rows);
    const cards = columns.flatMap((column) => column.cards.map((card) => [column.id, card.task.ref]));
    expect(cards.map(([, ref]) => ref).sort()).toEqual(["a", "b", "c"]);
    expect(columns.reduce((sum, column) => sum + column.count, 0)).toBe(3);
  });

  it("Esperando você: a subtarefa parada conta uma vez, a mãe e o entregável não", () => {
    const awaiting = awaitingUser([project()], []);
    expect(awaiting.count).toBe(1);
    expect(awaiting.byProject.get("p")).toBe(1);
  });

  it("quem está com a vez no projeto é o responsável da subtarefa, não a mãe sem dono", () => {
    expect(currentOwner(project())).toBe("davi");
    const idle = project();
    for (const item of idle.tasks) if (item.ref === "b") item.status = "a_fazer";
    expect(currentOwner(idle)).toBe("davi");
  });

  it("a aba de sprints: as três subtarefas contam na sprint (3 de 3 folhas), a mãe não soma", () => {
    const lanes = buildSprintLanes(project(), NOW.getTime());
    const lane = lanes.lanes.find((candidate) => candidate.sprint.id === "S1")!;
    expect(lane.tasks.map((entry) => entry.task.ref)).toEqual(["a", "b", "c"]);
    expect(lane.progress).toMatchObject({ done: 1, total: 3 });
    expect(lane.load.map((entry) => entry.agentId).sort()).toEqual(["davi", "hugo"]);
  });
});
