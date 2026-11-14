import { describe, expect, it } from "vitest";
import { compareWork, taskRankInput, type Project, type ProjectTask } from "./projects";
import { activeSprint, buildSprintSummary, linksIn, nextSprintAfter, nextSprintBoundary, sprintDayOf, sprintHold, sprintsInOrder, type Sprint } from "./sprints";
import { completedRefs } from "./task-tree";

const at = "2026-11-11T15:00:00.000Z";
const NOW = Date.parse(at);
const DAY = 86_400_000;

function task(ref: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { ref, title: `Tarefa ${ref}`, briefing: "faça", ownerId: "eco", steps: [{ agentId: "eco", what: "faz", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", doneWhen: [], status: "a_fazer", rework: { count: 0 }, updatedAt: at, ...extra };
}
const sprint = (id: string, order: number, status: Sprint["status"], startDays: number, endDays: number): Sprint => ({ id, name: `Sprint ${order}`, startAt: new Date(NOW + startDays * DAY).toISOString(), endAt: new Date(NOW + endDays * DAY).toISOString(), order, status });

describe("sprintHold (a nota da folha que espera pela sprint)", () => {
  const sprints = [sprint("S1", 1, "fechada", -8, -1), sprint("S2", 2, "ativa", -1, 6), sprint("S3", 3, "planejada", 6, 13)];
  it("projeto sem sprints: tudo liberado", () => {
    expect(sprintHold({ sprints: [] }, { status: "a_fazer" })).toBeUndefined();
    expect(sprintHold({}, { status: "a_fazer" })).toBeUndefined();
  });
  it("só a sprint ativa libera; sem sprint, planejada e fechada esperam com a nota; em andamento termina onde está", () => {
    const project = { sprints };
    expect(sprintHold(project, { status: "a_fazer", sprintId: "S2" })).toBeUndefined();
    expect(sprintHold(project, { status: "a_fazer" })?.note).toMatch(/^Sem sprint/);
    const future = sprintHold(project, { status: "a_fazer", sprintId: "S3" })!;
    expect(future.note).toMatch(/^Sprint 3 começa em 17\/11 às /);
    expect(future.wakeAt).toBe(NOW + 6 * DAY);
    expect(sprintHold(project, { status: "a_fazer", sprintId: "S1" })?.note).toMatch(/já fechou/);
    expect(sprintHold(project, { status: "em_andamento", sprintId: "S1" })).toBeUndefined();
    expect(sprintHold(project, { status: "a_fazer", sprintId: "S9" })?.note).toMatch(/^Sem sprint/);
  });
});

describe("sprint: ordem, seguinte, ativa e relógio", () => {
  const sprints = [sprint("S3", 3, "planejada", 6, 13), sprint("S1", 1, "fechada", -8, -1), sprint("S2", 2, "ativa", -1, 6)];
  it("ordena por order, acha a ativa e a seguinte (a próxima planejada)", () => {
    expect(sprintsInOrder({ sprints }).map((item) => item.id)).toEqual(["S1", "S2", "S3"]);
    expect(activeSprint({ sprints })?.id).toBe("S2");
    expect(nextSprintAfter({ sprints }, sprints[0]!)).toBeUndefined();
    expect(nextSprintAfter({ sprints }, sprints[1]!)?.id).toBe("S3");
    expect(nextSprintAfter({ sprints }, sprints[2]!)?.id).toBe("S3");
  });
  it("próxima fronteira: o fim da ativa ou o começo da planejada", () => {
    expect(nextSprintBoundary({ sprints })).toBe(NOW + 6 * DAY);
    expect(nextSprintBoundary({ sprints: [] })).toBeUndefined();
  });
  it("dia N de M, preso nas pontas", () => {
    const s = sprint("S", 1, "ativa", -2, 5);
    expect(sprintDayOf(s, NOW)).toEqual({ day: 3, days: 7 });
    expect(sprintDayOf(s, NOW - 10 * DAY)).toEqual({ day: 1, days: 7 });
    expect(sprintDayOf(s, NOW + 30 * DAY)).toEqual({ day: 7, days: 7 });
  });
});

describe("a ordem do agendador: o que veio da sprint anterior passa na frente do que é novo", () => {
  const project = { priority: "normal" as const, approvedAt: at, createdAt: at };
  const input = (extra: Partial<ProjectTask>, position: number) => taskRankInput(project, { priority: "normal", ...extra }, position);
  it("depois da prioridade e antes do prazo", () => {
    const soon = new Date(NOW + 3 * DAY).toISOString();
    const later = new Date(NOW + 9 * DAY).toISOString();
    const fresh = input({ dueAt: soon }, 0);
    const carried = input({ dueAt: later, carriedFrom: "S1" }, 1);
    expect(compareWork(carried, fresh, NOW, { tieBreak: "approved" })).toBeLessThan(0);
    // A prioridade ainda vence.
    const high = taskRankInput(project, { priority: "alta" }, 2);
    expect(compareWork(high, carried, NOW, { tieBreak: "approved" })).toBeLessThan(0);
    // Sem carried, o prazo decide como antes.
    expect(compareWork(fresh, input({ dueAt: later }, 1), NOW, { tieBreak: "approved" })).toBeLessThan(0);
  });
});

describe("completedRefs: dependência em pai", () => {
  it("o pai só conta quando todas as folhas terminaram (ao menos uma concluída)", () => {
    const tasks = [task("G", { group: true, steps: [] }), task("A", { parent: "G", status: "concluida" }), task("B", { parent: "G", status: "a_fazer" }), task("C")];
    expect([...completedRefs({ tasks })].sort()).toEqual(["A"]);
    // Revisão 2, M5: uma folha cancelada deixa a mãe "com pendência": ela não conta como pronta e quem depende dela fica travado.
    tasks[2]!.status = "cancelada";
    expect([...completedRefs({ tasks })].sort()).toEqual(["A"]);
    // Pulada (concluída com selo) destrava.
    Object.assign(tasks[2]!, { status: "concluida", skipped: true });
    expect([...completedRefs({ tasks })].sort()).toEqual(["A", "B", "G"]);
  });
});

describe("buildSprintSummary (calculável, sem cartão)", () => {
  it("conta o entregue, o que sobrou, o que falhou, o pulado e por agente", () => {
    const sprints = [sprint("S1", 1, "fechada", -8, -1), sprint("S2", 2, "ativa", -1, 6)];
    const project: Pick<Project, "tasks" | "sprints"> & { worked: Record<string, number> } = {
      sprints,
      worked: { "2026-11-04": 60_000, "2026-11-10": 5000, "2026-10-01": 999_999 },
      tasks: [
        task("T1", { sprintId: "S1", status: "concluida", finishedAt: at }),
        task("T2", { sprintId: "S1", status: "concluida", skipped: true }),
        task("T3", { sprintId: "S1", status: "falhou", failure: "quebrou", ownerId: "crivo", steps: [{ agentId: "crivo", what: "faz", status: "falhou" }] }),
        task("T4", { sprintId: "S2", carriedFrom: "S1", carryCount: 1 }),
        task("T5", { carriedFrom: "S1", carryCount: 1 }),
        task("T6", { sprintId: "S1", status: "cancelada" }),
      ],
    };
    const summary = buildSprintSummary(project, "S1", NOW);
    expect(summary.done.map((item) => item.ref)).toEqual(["T1"]);
    expect(summary.skipped).toEqual(["T2"]);
    expect(summary.failed).toEqual([{ ref: "T3", title: "Tarefa T3", reason: "quebrou" }]);
    expect(summary.carried).toEqual([{ ref: "T4", title: "Tarefa T4", to: "S2" }, { ref: "T5", title: "Tarefa T5", to: null }]);
    expect(summary.byAgent).toEqual({ eco: { done: 1, total: 1 }, crivo: { done: 0, total: 1 } });
    expect(summary.workedMs).toBe(65_000);
  });

  it("traz links, tarefas do runner, canceladas, retrabalho e conta como falha a que passou adiante", () => {
    const project: Pick<Project, "tasks" | "sprints"> = {
      sprints: [sprint("S1", 1, "fechando", -8, -1), sprint("S2", 2, "ativa", -1, 6)],
      tasks: [
        task("T1", { sprintId: "S1", status: "concluida", finishedAt: at, result: "Veja https://a.com/x, e (https://b.com/y).", steps: [{ agentId: "eco", what: "faz", status: "feita", taskId: "run-1" }] }),
        task("T2", { sprintId: "S1", status: "concluida", finishedAt: at, rework: { count: 2, last: { reason: "tom", at } } }),
        task("T3", { sprintId: "S2", carriedFrom: "S1", carryCount: 1, status: "falhou", failure: "sem cota" }),
        task("T4", { sprintId: "S1", status: "cancelada" }),
      ],
    };
    const summary = buildSprintSummary(project, "S1", NOW);
    expect(summary.done[0]).toMatchObject({ ref: "T1", links: ["https://a.com/x", "https://b.com/y"], taskIds: ["run-1"] });
    expect(summary.done[1]).not.toHaveProperty("links");
    expect(summary.cancelled).toEqual([{ ref: "T4", title: "Tarefa T4" }]);
    expect(summary.reworked).toEqual([{ ref: "T2", title: "Tarefa T2", count: 2, reason: "tom" }]);
    expect(summary.failed).toEqual([{ ref: "T3", title: "Tarefa T3", reason: "sem cota" }]);
    expect(summary.carried).toEqual([{ ref: "T3", title: "Tarefa T3", to: "S2" }]);
  });

  it("sprint sem nenhuma tarefa: resumo vazio sem campos opcionais", () => {
    const summary = buildSprintSummary({ sprints: [sprint("S1", 1, "fechando", -8, -1)], tasks: [] }, "S1", NOW);
    expect(summary).toMatchObject({ done: [], carried: [], failed: [], skipped: [], byAgent: {}, workedMs: 0 });
    expect(summary).not.toHaveProperty("cancelled");
    expect(summary).not.toHaveProperty("reworked");
  });
});

describe("linksIn", () => {
  it("acha http/https sem repetir, tira pontuação do fim e limita a 5", () => {
    expect(linksIn("a https://x.com/a. b https://x.com/a; c http://y.org/b?q=1!")).toEqual(["https://x.com/a", "http://y.org/b?q=1"]);
    expect(linksIn(undefined)).toEqual([]);
    expect(linksIn(Array.from({ length: 8 }, (_, n) => `https://s.com/${n}`).join(" "))).toHaveLength(5);
  });
});
