import { MAESTRO_TEXTS, type OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeOffice, makeRoom, makeTask } from "../test-fixtures";
import { coordinatedTasks, maestroFeedback } from "./maestro";

/** O escritório de teste com a Sala do Maestro, a Gerência e o Maestro. */
function withMaestro(): OfficeState {
  const office = makeOffice();
  office.rooms.push(makeRoom("sala", { kind: "maestro", gridPosition: { x: -1, y: 0 } }));
  office.teams.push({ id: "gerencia", roomId: "sala", name: "Gerência", focus: "coordenar" });
  office.agents.push(makeAgent("maestro", "gerencia", { role: "maestro" }));
  return office;
}

const asked = (id: string, overrides = {}) => makeTask(id, { roomId: "sala", teamId: "gerencia", agentId: "maestro", ...overrides });

describe("maestroFeedback", () => {
  it("enviado -> delegado (time, motivo e agente)", () => {
    const office = withMaestro();
    office.tasks.push(asked("p", { status: "in_progress" }));
    expect(maestroFeedback(office, "p")).toEqual({ kind: "sent" });
    expect(maestroFeedback(null, "p")).toEqual({ kind: "sent" });

    office.tasks[office.tasks.length - 1]!.routeReason = "pedido fala de 'testar' → time Time A do quarto A";
    office.tasks.push(makeTask("s", { projectId: "p", agentId: "bia" }));
    expect(maestroFeedback(office, "p")).toMatchObject({
      kind: "delegated",
      teamName: "Time A",
      reason: "pedido fala de 'testar' → time Time A do quarto A",
      agent: { id: "bia" },
      status: "in_progress",
    });
  });

  it("sem time: mostra a pergunta do Maestro", () => {
    const office = withMaestro();
    office.tasks.push(asked("p", { status: "waiting_approval", routeReason: MAESTRO_TEXTS.noTeam }));
    expect(maestroFeedback(office, "p")).toEqual({ kind: "waiting", question: MAESTRO_TEXTS.noTeam });
  });
});

describe("coordinatedTasks", () => {
  it("só as tarefas ativas do Maestro (não as subtarefas), mais antigas primeiro, com quem está nelas", () => {
    const office = withMaestro();
    office.tasks.push(
      asked("nova", { status: "in_progress", createdAt: "2026-11-07T10:05:00.000Z" }),
      asked("velha", { status: "waiting_approval", createdAt: "2026-11-07T10:01:00.000Z" }),
      asked("feita", { status: "done" }),
      makeTask("sub", { projectId: "nova", roomId: "b", teamId: "b-time", agentId: "caio" }),
    );
    const items = coordinatedTasks(office, "maestro");
    expect(items.map((item) => item.task.id)).toEqual(["velha", "nova"]);
    expect(items[1]).toMatchObject({ subtask: { id: "sub" }, team: { id: "b-time" }, room: { id: "b" }, agent: { id: "caio" } });
    expect(items[0]!.subtask).toBeUndefined();
  });
});
