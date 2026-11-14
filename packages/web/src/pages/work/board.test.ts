import type { Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeTask } from "../../test-fixtures";
import type { ActivityEntry } from "../../ui/activity";
import { isRequestRecord, maestroLink, statusHistory, statusLabel, taskError } from "./board";

/** Tarefa com os campos do Maestro (que podem ainda não existir no tipo). */
function subtask(id: string, projectId: string, overrides: Partial<Task> = {}, routeReason?: string): Task {
  return { ...makeTask(id, overrides), projectId, ...(routeReason ? { routeReason } : {}) } as Task;
}

const at = (minute: number) => `2026-11-07T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("statusLabel", () => {
  it("usa o rótulo conhecido ou o próprio id", () => {
    expect(statusLabel("done")).toBe("concluída");
    expect(statusLabel("em_triagem")).toBe("em triagem");
  });
});

describe("maestroLink e taskError", () => {
  it("lê projectId e routeReason só quando são texto", () => {
    expect(maestroLink(makeTask("t"))).toEqual({ projectId: undefined, routeReason: undefined });
    expect(maestroLink(subtask("s", "p", {}, " time de vídeo "))).toEqual({ projectId: "p", routeReason: "time de vídeo" });
    expect(maestroLink({ ...makeTask("x"), projectId: 3, routeReason: "" } as unknown as Task)).toEqual({ projectId: undefined, routeReason: undefined });
  });

  it("o erro vem do campo error ou do result de quem falhou", () => {
    expect(taskError(makeTask("a", { status: "failed", result: "quebrou" }))).toBe("quebrou");
    expect(taskError(makeTask("b", { status: "done", result: "ok" }))).toBeUndefined();
    expect(taskError({ ...makeTask("c", { status: "failed" }), error: "timeout" } as Task)).toBe("timeout");
  });
});

describe("statusHistory", () => {
  const entry = (task: Task, kind: ActivityEntry["kind"], when: string): ActivityEntry => ({
    key: `${task.id}:${kind}`,
    kind,
    taskId: task.id,
    agentId: task.agentId,
    roomId: task.roomId,
    teamId: task.teamId,
    prompt: task.prompt,
    at: when,
  });

  it("só com a tarefa: criação e status atual", () => {
    const task = makeTask("t", { status: "done", createdAt: at(1), updatedAt: at(5) });
    expect(statusHistory(task, []).map((step) => [step.kind, step.at])).toEqual([
      ["created", at(1)],
      ["done", at(5)],
    ]);
  });

  it("na fila, só a criação", () => {
    expect(statusHistory(makeTask("t"), []).map((step) => step.kind)).toEqual(["created"]);
  });

  it("junta as transições vistas ao vivo, sem repetir e em ordem", () => {
    const task = makeTask("t", { status: "done", createdAt: at(1), updatedAt: at(9) });
    const other = makeTask("o");
    const entries = [entry(task, "done", at(9)), entry(task, "waiting_approval", at(6)), entry(other, "started", at(2)), entry(task, "started", at(3))];
    expect(statusHistory(task, entries).map((step) => step.kind)).toEqual(["created", "started", "waiting_approval", "done"]);
  });

  it("status desconhecido não entra no histórico", () => {
    const task = { ...makeTask("t"), status: "triage" } as unknown as Task;
    expect(statusHistory(task, []).map((step) => step.kind)).toEqual(["created"]);
  });
});

describe("isRequestRecord", () => {
  it("só o registro do pedido do Maestro (role request) fica fora do quadro", () => {
    const tasks = [makeTask("r", { role: "request" }), makeTask("t", { projectId: "r" }), makeTask("s")];
    expect(tasks.filter((task) => !isRequestRecord(task)).map((task) => task.id)).toEqual(["t", "s"]);
  });
});
