import { describe, expect, it } from "vitest";
import { makeOffice, makeTask } from "../test-fixtures";
import { applyTaskProgress, EMPTY_PROGRESS, isActiveTask, type TaskProgressMap } from "./taskProgress";

const progressEvent = (taskId: string, progress: number, message = "lendo notas") =>
  ({ type: "task:progress", taskId, agentId: "ana", progress, message }) as const;

describe("applyTaskProgress", () => {
  it("guarda o último progresso de tarefa ativa, limitado a 0..1", () => {
    const office = makeOffice();
    let progress = applyTaskProgress(EMPTY_PROGRESS, progressEvent("t1", 0.25), office);
    expect(progress).toEqual({ t1: { agentId: "ana", progress: 0.25, message: "lendo notas" } });
    progress = applyTaskProgress(progress, progressEvent("t1", 7, "quase"), office);
    expect(progress.t1).toEqual({ agentId: "ana", progress: 1, message: "quase" });
    expect(applyTaskProgress(EMPTY_PROGRESS, progressEvent("t1", Number.NaN), office).t1?.progress).toBe(0);
    expect(applyTaskProgress(EMPTY_PROGRESS, progressEvent("t1", -1), office).t1?.progress).toBe(0);
  });

  it("ignora progresso atrasado de tarefa já terminada e aceita tarefa ainda desconhecida", () => {
    const office = makeOffice();
    expect(applyTaskProgress(EMPTY_PROGRESS, progressEvent("t3", 0.5), office)).toBe(EMPTY_PROGRESS);
    expect(applyTaskProgress(EMPTY_PROGRESS, progressEvent("nova", 0.1), office)).toHaveProperty("nova");
  });

  it("descarta o progresso quando a tarefa sai de in_progress/waiting_approval", () => {
    const office = makeOffice();
    const start: TaskProgressMap = { t1: { agentId: "ana", progress: 0.5, message: "m" } };
    const waiting = makeTask("t1", { status: "waiting_approval" });
    expect(applyTaskProgress(start, { type: "task:upserted", task: waiting }, office)).toBe(start);
    const done = makeTask("t1", { status: "done" });
    expect(applyTaskProgress(start, { type: "task:upserted", task: done }, office)).toEqual({});
    const requeued = makeTask("t1", { status: "queued" });
    expect(applyTaskProgress(start, { type: "task:upserted", task: requeued }, office)).toEqual({});
  });

  it("snapshot mantém só tarefas ativas; room:deleted limpa as tarefas do quarto", () => {
    const office = makeOffice();
    const start: TaskProgressMap = {
      t1: { agentId: "ana", progress: 0.5, message: "a" },
      t2: { agentId: "caio", progress: 0.2, message: "b" },
      sumiu: { agentId: "ana", progress: 0.9, message: "c" },
    };
    expect(Object.keys(applyTaskProgress(start, { type: "office:snapshot", office }, office))).toEqual(["t1", "t2"]);
    expect(Object.keys(applyTaskProgress(start, { type: "room:deleted", id: "a" }, office))).toEqual(["t2", "sumiu"]);
  });

  it("snapshot com `progress` (recarregar a página) hidrata o mapa e o server manda", () => {
    const office = makeOffice();
    const sent = {
      t1: { agentId: "ana", progress: 0.4, message: "Ana quer sua aprovação para continuar" },
      t3: { agentId: "ana", progress: 1, message: "tarefa já terminou" },
      t2: { agentId: "caio", progress: "x", message: "malformado" },
    };
    const local: TaskProgressMap = { t2: { agentId: "caio", progress: 0.9, message: "antigo" } };
    const event = { type: "office:snapshot", office, progress: sent } as unknown as Parameters<typeof applyTaskProgress>[1];
    expect(applyTaskProgress(local, event, office)).toEqual({ t1: sent.t1 });
    expect(applyTaskProgress(EMPTY_PROGRESS, { type: "office:snapshot", office, progress: {} }, office)).toBe(EMPTY_PROGRESS);
    expect(applyTaskProgress(local, { type: "office:snapshot", office, progress: {} }, office)).toEqual({});
  });

  it("outros eventos não mexem no progresso", () => {
    const start: TaskProgressMap = { t1: { agentId: "ana", progress: 0.5, message: "a" } };
    expect(applyTaskProgress(start, { type: "agent:deleted", id: "ana" }, makeOffice())).toBe(start);
  });

  it("isActiveTask", () => {
    const statuses = ["queued", "in_progress", "waiting_approval", "done", "failed"] as const;
    expect(statuses.map((status) => isActiveTask({ status }))).toEqual([false, true, true, false, false]);
  });
});
