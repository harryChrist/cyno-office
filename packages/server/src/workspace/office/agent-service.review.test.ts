import type { Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createAgent, createTask, soloTeam } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";

const setupApp = useTestApp();

describe("review: ids de agentes removidos", () => {
  // Quartos evitam reaproveitar ids de quartos removidos (brainIds), mas agentes não:
  // as tarefas antigas (done/failed) continuam com agentId do agente removido, e um agente novo
  // com o mesmo nome, em OUTRO quarto, herda esse histórico (GET /api/tasks?agentId=, routeTask).
  it("agente novo não herda o histórico de tarefas de um agente removido de outro quarto", async () => {
    const { app, log } = await setupApp();
    const a = await soloTeam(app, "Quarto A");
    const task = await createTask(app, a.room.id, a.team.id, "Tarefa secreta do quarto A");
    await log.waitForTask(task.id, "done");
    await call(app, "DELETE", `/api/w/principal/agents/${a.agent.id}`);

    const b = await soloTeam(app, "Quarto B");
    const newcomer = await createAgent(app, b.team.id, `Agente Quarto A`);
    const history = await call<Task[]>(app, "GET", `/api/w/principal/tasks?agentId=${newcomer.id}`);
    expect(history.map((candidate) => candidate.prompt)).not.toContain("Tarefa secreta do quarto A");
  });
});
