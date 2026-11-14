import { projectDefaults, projectTaskDefaults, type Project, type ProjectTask, type Sprint } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { addNode, moveToSprint } from "./project-edit";
import { addSprint, advanceSprints, closeSprintNow, editSprint, inheritSprint, removeSprint, reorderSprints, shiftSprints, startSprintNow } from "./sprint-service";

const DAY = 86_400_000;
/** 2026-11-09 12:00 em São Paulo (segunda). */
const T0 = Date.parse("2026-11-09T15:00:00.000Z");
const at = new Date(T0).toISOString();

function leaf(ref: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { ref, title: `Tarefa ${ref}`, briefing: "faça", ownerId: "eco", steps: [{ agentId: "eco", what: "faz", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", ...projectTaskDefaults(), status: "a_fazer", updatedAt: at, ...extra };
}

function project(extra: Partial<Project> = {}): Project {
  return { ...projectDefaults(), id: "p1", kind: "projeto", title: "Projeto", status: "ativo", version: 1, labels: [], sprints: [], tasks: [], createdAt: at, updatedAt: at, approvedAt: at, ...extra };
}

/** Três sprints de uma semana, começando em `T0` (a primeira já deve abrir). */
function threeSprints(extra: Partial<Project> = {}): Project {
  const p = project(extra);
  addSprint(p, { name: "Sprint 1" }, T0);
  addSprint(p, { name: "Sprint 2" }, T0);
  addSprint(p, { name: "Sprint 3" }, T0);
  return p;
}
const byId = (p: Project, id: string): Sprint => p.sprints!.find((sprint) => sprint.id === id)!;
const statuses = (p: Project) => p.sprints!.map((sprint) => sprint.status);

describe("criar e editar sprint", () => {
  it("sugere uma semana a partir do fim da anterior, com ids e nomes automáticos", () => {
    const p = project();
    const first = addSprint(p, {}, T0);
    expect(first).toMatchObject({ id: "S1", name: "Sprint 1", status: "planejada", order: 1, startAt: new Date(T0).toISOString(), endAt: new Date(T0 + 7 * DAY).toISOString() });
    const second = addSprint(p, { goal: "  Entrar no app  " }, T0 + 99 * DAY);
    expect(second).toMatchObject({ id: "S2", name: "Sprint 2", goal: "Entrar no app", order: 2, startAt: first.endAt, endAt: new Date(T0 + 14 * DAY).toISOString() });
    const manual = addSprint(p, { name: "Login", startAt: "2026-12-01T12:00:00.000Z", endAt: "2026-12-03T12:00:00.000Z" }, T0);
    expect(manual).toMatchObject({ name: "Login", startAt: "2026-12-01T12:00:00.000Z" });
  });

  it("recusa fim antes do começo e passa de 20", () => {
    const p = project();
    expect(() => addSprint(p, { startAt: "2026-11-10T12:00:00.000Z", endAt: "2026-11-09T12:00:00.000Z" }, T0)).toThrow(/depois do começo/);
    for (let n = 0; n < 20; n += 1) addSprint(p, {}, T0);
    expect(() => addSprint(p, {}, T0)).toThrow(/até 20 sprints/);
  });

  it("edita nome, objetivo e datas; sprint fechada não muda", () => {
    const p = threeSprints();
    editSprint(p, "S1", { name: "Login", goal: "Entrar", endAt: new Date(T0 + 10 * DAY).toISOString() });
    expect(byId(p, "S1")).toMatchObject({ name: "Login", goal: "Entrar", endAt: new Date(T0 + 10 * DAY).toISOString() });
    editSprint(p, "S1", { goal: null });
    expect(byId(p, "S1").goal).toBeUndefined();
    expect(() => editSprint(p, "S1", { endAt: new Date(T0 - DAY).toISOString() })).toThrow(/depois do começo/);
    advanceSprints(p, T0);
    closeSprintNow(p, "S1", T0 + DAY);
    expect(() => editSprint(p, "S1", { name: "X" })).toThrow(/já fechou/);
    expect(() => editSprint(p, "S9", { name: "X" })).toThrow(/não existe/);
  });

  it("reordena (lista completa, uma vez cada)", () => {
    const p = threeSprints();
    reorderSprints(p, ["S3", "S1", "S2"]);
    expect(p.sprints!.map((sprint) => [sprint.id, sprint.order])).toEqual([["S1", 2], ["S2", 3], ["S3", 1]]);
    expect(() => reorderSprints(p, ["S1", "S2"])).toThrow(/todas as sprints/);
    expect(() => reorderSprints(p, ["S1", "S1", "S2"])).toThrow();
  });
});

describe("abrir por data e uma ativa por projeto", () => {
  it("abre a planejada cuja hora chegou, só uma, e só quando o projeto está ativo", () => {
    const p = threeSprints();
    expect(advanceSprints(p, T0 - DAY)).toEqual([]);
    expect(statuses(p)).toEqual(["planejada", "planejada", "planejada"]);
    const events = advanceSprints(p, T0 + 1000);
    expect(events.map((event) => event.action)).toEqual(["sprint-aberta"]);
    expect(statuses(p)).toEqual(["ativa", "planejada", "planejada"]);
    expect(byId(p, "S1").openedAt).toBeDefined();
    // Dia seguinte: a S2 só começa na data dela.
    expect(advanceSprints(p, T0 + 3 * DAY)).toEqual([]);
  });

  it("projeto pausado não abre nem fecha", () => {
    const p = threeSprints({ status: "pausado" });
    expect(advanceSprints(p, T0 + 20 * DAY)).toEqual([]);
    expect(statuses(p)).toEqual(["planejada", "planejada", "planejada"]);
    p.status = "ativo";
    advanceSprints(p, T0 + 1000);
    p.status = "pausado";
    expect(advanceSprints(p, T0 + 20 * DAY)).toEqual([]);
    expect(byId(p, "S1").status).toBe("ativa");
  });

  it("retomar empurra as datas das sprints que não fecharam", () => {
    const p = threeSprints();
    advanceSprints(p, T0 + 1000);
    shiftSprints(p, 2 * DAY);
    expect(byId(p, "S1").endAt).toBe(new Date(T0 + 9 * DAY).toISOString());
    expect(byId(p, "S3").startAt).toBe(new Date(T0 + 16 * DAY).toISOString());
  });
});

describe("fechar por data: a sobra vai para a seguinte, por código", () => {
  it("passa backlog, a fazer e falhou; o que está em andamento, esperando ou pronto fica", () => {
    const p = threeSprints({
      tasks: [
        leaf("T1", { sprintId: "S1", status: "concluida" }),
        leaf("T2", { sprintId: "S1", status: "a_fazer" }),
        leaf("T3", { sprintId: "S1", status: "backlog" }),
        leaf("T4", { sprintId: "S1", status: "falhou" }),
        leaf("T5", { sprintId: "S1", status: "em_andamento" }),
        leaf("T6", { sprintId: "S1", status: "esperando_voce" }),
        leaf("T7", { sprintId: "S2", status: "a_fazer" }),
      ],
    });
    advanceSprints(p, T0 + 1000);
    const events = advanceSprints(p, T0 + 7 * DAY + 60_000);
    expect(events.map((event) => event.action)).toEqual(["sprint-fechada", "sprint-aberta"]);
    expect(events[0]!.summary).toContain("3 sobraram e foram para Sprint 2");
    expect(statuses(p)).toEqual(["fechando", "ativa", "planejada"]);
    expect(byId(p, "S1").closedAt).toBeDefined();
    const sprintOf = (ref: string) => p.tasks.find((task) => task.ref === ref)!.sprintId;
    expect(["T1", "T2", "T3", "T4", "T5", "T6", "T7"].map(sprintOf)).toEqual(["S1", "S2", "S2", "S2", "S1", "S1", "S2"]);
    expect(p.tasks.find((task) => task.ref === "T2")).toMatchObject({ carriedFrom: "S1", carryCount: 1 });
    expect(p.tasks.find((task) => task.ref === "T7")!.carriedFrom).toBeUndefined();
    expect(p.tasks.find((task) => task.ref === "T1")!.carriedFrom).toBeUndefined();
  });

  it("duas sobras seguidas somam carryCount", () => {
    const p = threeSprints({ tasks: [leaf("T1", { sprintId: "S1" })] });
    advanceSprints(p, T0 + 1000);
    advanceSprints(p, T0 + 7 * DAY + 1000);
    advanceSprints(p, T0 + 14 * DAY + 1000);
    expect(statuses(p)).toEqual(["fechando", "fechando", "ativa"]);
    expect(p.tasks[0]).toMatchObject({ sprintId: "S3", carriedFrom: "S2", carryCount: 2 });
  });

  it("sem sprint seguinte, a sobra fica sem sprint com a marca de que veio da anterior", () => {
    const p = project();
    addSprint(p, {}, T0);
    p.tasks.push(leaf("T1", { sprintId: "S1" }), leaf("T2", { sprintId: "S1", status: "concluida" }));
    advanceSprints(p, T0 + 1000);
    const events = advanceSprints(p, T0 + 8 * DAY);
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain("1 sobrou e ficou sem sprint");
    expect(p.tasks[0]).toMatchObject({ carriedFrom: "S1", carryCount: 1 });
    expect(p.tasks[0]!.sprintId).toBeUndefined();
    expect(p.tasks[1]!.sprintId).toBe("S1");
  });

  it("uma sprint vencida que nunca abriu abre e fecha na hora, passando a sobra adiante", () => {
    const p = threeSprints({ tasks: [leaf("T1", { sprintId: "S1" })] });
    advanceSprints(p, T0 + 15 * DAY);
    expect(statuses(p)).toEqual(["fechando", "fechando", "ativa"]);
    expect(p.tasks[0]).toMatchObject({ sprintId: "S3", carryCount: 2 });
  });
});

describe("começar e fechar agora", () => {
  it("fechar agora manda a sobra para a próxima e a próxima abre na data dela", () => {
    const p = threeSprints({ tasks: [leaf("T1", { sprintId: "S1" })] });
    advanceSprints(p, T0 + 1000);
    const events = closeSprintNow(p, "S1", T0 + DAY);
    expect(events[0]!.action).toBe("sprint-fechada");
    expect(statuses(p)).toEqual(["fechando", "planejada", "planejada"]);
    expect(p.tasks[0]).toMatchObject({ sprintId: "S2", carryCount: 1 });
    // Fechada antes da hora: o fim planejado fica; o dia em que fechou está em closedAt.
    expect(byId(p, "S1").endAt).not.toBe(new Date(T0 + DAY).toISOString());
    expect(byId(p, "S1").closedAt).toBe(new Date(T0 + DAY).toISOString());
    expect(() => closeSprintNow(p, "S2", T0 + DAY)).toThrow(/sprint ativa/);
  });

  it("começar agora fecha a ativa (sobra para a que começa) e abre a escolhida com começo = agora", () => {
    const p = threeSprints({ tasks: [leaf("T1", { sprintId: "S1" }), leaf("T2", { sprintId: "S3" })] });
    advanceSprints(p, T0 + 1000);
    const now = T0 + 2 * DAY;
    const events = startSprintNow(p, "S3", now);
    expect(events.map((event) => event.action)).toEqual(["sprint-fechada", "sprint-aberta"]);
    expect(statuses(p)).toEqual(["fechando", "planejada", "ativa"]);
    expect(byId(p, "S3").startAt).toBe(new Date(now).toISOString());
    expect(p.tasks[0]).toMatchObject({ sprintId: "S3", carriedFrom: "S1" });
    expect(() => startSprintNow(p, "S1", now)).toThrow(/planejada/);
  });

  it("começar agora estende o fim se já tinha passado", () => {
    const p = project();
    addSprint(p, { startAt: new Date(T0 - 9 * DAY).toISOString(), endAt: new Date(T0 - 2 * DAY).toISOString() }, T0);
    startSprintNow(p, "S1", T0);
    expect(byId(p, "S1")).toMatchObject({ status: "ativa", endAt: new Date(T0 + 7 * DAY).toISOString() });
  });
});

describe("apagar sprint", () => {
  it("planejada com tarefas: as tarefas voltam para sem sprint; ativa com tarefas e fechada com histórico: 409", () => {
    const p = threeSprints({ tasks: [leaf("T1", { sprintId: "S3" }), leaf("T2", { sprintId: "S1" })] });
    expect(removeSprint(p, "S3")).toEqual({ freed: 1 });
    expect(p.sprints!.map((sprint) => sprint.id)).toEqual(["S1", "S2"]);
    expect(p.tasks[0]!.sprintId).toBeUndefined();
    advanceSprints(p, T0 + 1000);
    expect(() => removeSprint(p, "S1")).toThrow(/feche-a antes/);
    // Ativa e vazia apaga.
    p.tasks[1]!.sprintId = "S2";
    expect(removeSprint(p, "S1")).toEqual({ freed: 0 });
  });
});

describe("tarefa nova herda a sprint ativa (risco 4)", () => {
  it("inheritSprint: a preferida aberta, senão a ativa, senão nenhuma; sem sprints, nada", () => {
    const p = threeSprints();
    expect(inheritSprint(p)).toBeUndefined();
    advanceSprints(p, T0 + 1000);
    expect(inheritSprint(p)).toBe("S1");
    expect(inheritSprint(p, "S3")).toBe("S3");
    closeSprintNow(p, "S1", T0 + DAY);
    expect(inheritSprint(p, "S1")).toBeUndefined();
    expect(inheritSprint(project())).toBeUndefined();
  });

  it("addNode: a folha nova entra na ativa; a mãe perde a sprint e a filha herda a dela; entregável não tem", () => {
    const p = threeSprints();
    advanceSprints(p, T0 + 1000);
    const group = addNode(p, { title: "Front", group: true }, at);
    expect(group.sprintId).toBeUndefined();
    const task = addNode(p, { title: "Login", parent: group.ref, assignee: "eco" }, at);
    expect(task.sprintId).toBe("S1");
    moveToSprint(p, task.ref, "S2", at);
    const sub = addNode(p, { title: "Layout", parent: task.ref, assignee: "eco" }, at);
    expect(sub.sprintId).toBe("S2");
    expect(task.sprintId).toBeUndefined();
  });

  it("sem sprint ativa a tarefa nova fica sem sprint; projeto sem sprints nunca ganha", () => {
    const p = threeSprints();
    expect(addNode(p, { title: "A" }, at).sprintId).toBeUndefined();
    expect(addNode(project(), { title: "B" }, at).sprintId).toBeUndefined();
  });
});

describe("mover tarefa de sprint", () => {
  it("só folha que não terminou, para sprint existente e que não fechou; null tira", () => {
    const p = threeSprints({ tasks: [leaf("T1", { sprintId: "S1" }), leaf("T2", { status: "concluida" }), leaf("T3", { group: true, steps: [] }), leaf("T4", { parent: "T3" })] });
    moveToSprint(p, "T1", "S2", at);
    expect(p.tasks[0]!.sprintId).toBe("S2");
    moveToSprint(p, "T1", null, at);
    expect(p.tasks[0]!.sprintId).toBeUndefined();
    expect(() => moveToSprint(p, "T1", "S9", at)).toThrow(/não existe/);
    expect(() => moveToSprint(p, "T2", "S1", at)).toThrow(/já terminou/);
    expect(() => moveToSprint(p, "T3", "S1", at)).toThrow(/Só as tarefas que executam/);
    advanceSprints(p, T0 + 1000);
    closeSprintNow(p, "S1", T0 + DAY);
    expect(() => moveToSprint(p, "T4", "S1", at)).toThrow(/já fechou/);
    moveToSprint(p, "T4", "S2", at);
    expect(p.tasks[3]!.sprintId).toBe("S2");
  });
});
