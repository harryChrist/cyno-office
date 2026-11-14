import { describe, expect, it } from "vitest";
import { makeTask } from "../test-fixtures";
import { ACTIVITY_LIMIT, diffTaskActivity, mergeActivity, rebuildActivity } from "./activity";

const at = (minute: number) => `2026-11-07T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("diffTaskActivity", () => {
  it("primeiro estado (recarregar a página): reconstrói o feed das tarefas", () => {
    const tasks = [
      makeTask("feita", { status: "done", createdAt: at(1), updatedAt: at(5) }),
      makeTask("fila", { status: "queued", createdAt: at(2), updatedAt: at(2) }),
      makeTask("espera", { status: "waiting_approval", createdAt: at(3), updatedAt: at(4) }),
      makeTask("rapida", { status: "failed", createdAt: at(6), updatedAt: at(6) }),
    ];
    const entries = diffTaskActivity(null, tasks);
    expect(entries.map((e) => e.key)).toEqual([
      "rapida:failed",
      "rapida:created",
      "feita:done",
      "espera:waiting_approval",
      "espera:created",
      "fila:created",
      "feita:created",
    ]);
    expect(entries.find((e) => e.key === "feita:created")!.at).toBe(at(1));
    expect(entries.find((e) => e.key === "feita:done")!.at).toBe(at(5));
  });

  it("reconstrução respeita o limite e fica com as mais novas", () => {
    const tasks = Array.from({ length: ACTIVITY_LIMIT }, (_, i) => makeTask(`t${i}`, { status: "done", createdAt: at(i), updatedAt: at(i) }));
    const entries = rebuildActivity(tasks);
    expect(entries).toHaveLength(ACTIVITY_LIMIT);
    expect(entries[0]).toMatchObject({ taskId: `t${ACTIVITY_LIMIT - 1}`, kind: "done" });
    expect(entries.at(-1)).toMatchObject({ taskId: `t${ACTIVITY_LIMIT / 2}`, kind: "created" });
  });

  it("tarefa nova = criada (já atribuída); mudança de status = nova entrada; igual = nada", () => {
    const queued = makeTask("t1", { status: "queued", updatedAt: at(1) });
    expect(diffTaskActivity([], [queued]).map((e) => e.key)).toEqual(["t1:created"]);
    const running = { ...queued, status: "in_progress" as const, updatedAt: at(2) };
    expect(diffTaskActivity([queued], [running]).map((e) => e.kind)).toEqual(["started"]);
    expect(diffTaskActivity([running], [running])).toEqual([]);
    const waiting = { ...running, status: "waiting_approval" as const };
    expect(diffTaskActivity([running], [waiting])[0]).toMatchObject({ kind: "waiting_approval", agentId: "ana" });
  });

  it("tarefa que já chega adiantada (snapshot depois de reconectar) gera criada + status atual", () => {
    const done = makeTask("t9", { status: "done", updatedAt: at(9) });
    expect(diffTaskActivity([], [done]).map((e) => e.kind)).toEqual(["created", "done"]);
  });
});

describe("delegação do Maestro", () => {
  const parent = makeTask("p", { agentId: "maestro", status: "in_progress", createdAt: at(1), updatedAt: at(3), routeReason: "pedido fala de 'x' → time B" });
  const sub = makeTask("s", { projectId: "p", roomId: "b", teamId: "b-time", agentId: "caio", createdAt: at(3), updatedAt: at(3), routeReason: parent.routeReason });

  it("subtarefa nova = o Maestro delegou (com o motivo) + o agente recebeu, nessa ordem no feed", () => {
    const entries = mergeActivity([], diffTaskActivity([parent], [parent, sub]));
    expect(entries.map((e) => e.key)).toEqual(["s:created", "p:delegated:s"]);
    expect(entries[1]).toMatchObject({ kind: "delegated", taskId: "p", agentId: "maestro", teamId: "b-time", detail: parent.routeReason, at: at(3) });
  });

  it("recarregar a página reconstrói a delegação a partir da subtarefa", () => {
    const keys = rebuildActivity([parent, sub]).map((e) => e.key);
    expect(keys).toEqual(["s:created", "p:delegated:s", "p:created"]);
  });
});

describe("mergeActivity", () => {
  it("mais novas no topo, sem repetir chave e até o limite", () => {
    const a = diffTaskActivity([], [makeTask("a", { updatedAt: at(1) })]);
    const b = diffTaskActivity([], [makeTask("b", { updatedAt: at(2) })]);
    const merged = mergeActivity(a, b);
    expect(merged.map((e) => e.taskId)).toEqual(["b", "a"]);
    expect(mergeActivity(merged, a)).toBe(merged);
    expect(mergeActivity(merged, [])).toBe(merged);
    const many = Array.from({ length: 10 }, (_, i) => diffTaskActivity([], [makeTask(`m${i}`, { updatedAt: at(10 + i) })])[0]!);
    expect(mergeActivity(merged, many, 5)).toHaveLength(5);
  });
});
