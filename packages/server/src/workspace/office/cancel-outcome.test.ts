import type { ManagementSummary, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, soloTeam, wsApi } from "../../dev/test-api";
import { gatedSleep, testRunner, useTestApp } from "../../dev/test-app";
import { failActiveTasks } from "./cancel";

const setupApp = useTestApp();

describe("cancelar não é falhar", () => {
  it("cancelTask (tarefa em andamento e tarefa na fila) grava outcome 'cancelled' e a Gestão não conta como falha", async () => {
    const gate = gatedSleep();
    const { app, log, workspaces } = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const { room, team } = await soloTeam(app);
    const running = await createTask(app, room.id, team.id, "Rodando");
    const queued = await createTask(app, room.id, team.id, "Na fila");
    await log.waitForTask(running.id, "in_progress");
    const { orchestrator } = workspaces.get("principal");
    orchestrator.cancelTask(running.id, "Cancelada: o usuário parou");
    orchestrator.cancelTask(queued.id, "Cancelada: o usuário parou");
    const office = await call<{ tasks: Task[] }>(app, "GET", `${wsApi()}/office`);
    for (const id of [running.id, queued.id]) expect(office.tasks.find((task) => task.id === id)).toMatchObject({ status: "failed", outcome: "cancelled", failureKind: "cancelada" });
    const summary = await call<ManagementSummary>(app, "GET", `${wsApi()}/management/summary`);
    expect(summary.tasks.failedToday).toEqual([]);
    gate.open();
  });

  it("uma falha de verdade (sem outcome) continua contando na Gestão", async () => {
    const { app, log, workspaces } = await setupApp({ runner: testRunner() });
    const { room, team } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Vai falhar [falhar]");
    await log.waitForTask(task.id, "failed");
    const stored = workspaces.get("principal").store.snapshot().tasks.find((candidate) => candidate.id === task.id);
    expect(stored?.outcome).toBeUndefined();
    // O runner de teste não diz de onde veio a falha: o orquestrador grava "outro" (nunca deixa sem origem).
    expect(stored?.failureKind).toBe("outro");
    const summary = await call<ManagementSummary>(app, "GET", `${wsApi()}/management/summary`);
    expect(summary.tasks.failedToday.map((entry) => entry.id)).toContain(task.id);
  });

  it("failActiveTasks (agente/time/quarto removido) marca como cancelada", () => {
    const tasks = [{ id: "a", status: "queued" }, { id: "b", status: "done" }] as Task[];
    const events = failActiveTasks(tasks, () => true, "Cancelada: o agente foi removido", "2026-11-11T12:00:00.000Z");
    expect(events).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "failed", outcome: "cancelled", failureKind: "cancelada" });
    expect(tasks[1]).toMatchObject({ status: "done" });
  });
});
