import type { OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createAgent, createTask, createTeam, createRoom, getOffice } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

describe("persistência", () => {
  it("o estado sobrevive a um reinício do app", async () => {
    const first = await setupApp();
    const room = await createRoom(first.app, "Estúdio", { theme: "lavender", readsGlobalBrain: true });
    await call(first.app, "PATCH", `/api/w/principal/rooms/${room.id}/brain-sharing`, { readsBrainsOf: ["projetoy"] });
    const team = await createTeam(first.app, room.id, "Arte");
    const agent = await createAgent(first.app, team.id, "Mila");
    await call(first.app, "PATCH", "/api/w/principal/agents/beto", { role: "Revisor sênior" });
    await call(first.app, "DELETE", "/api/w/principal/teams/projetox-backend");
    const task = await createTask(first.app, room.id, team.id, "Desenhar o logo");
    await first.log.waitForTask(task.id, "done");
    // Espera o agente sair de "done" (DONE_LINGER_MS) e voltar a idle.
    while (first.log.agentStatuses(agent.id).at(-1) !== "idle") await new Promise((resolve) => setTimeout(resolve, 5));
    const before: OfficeState = await getOffice(first.app);
    await first.app.close();

    const second = await setupApp({ dataDir: first.dataDir });
    const after = await getOffice(second.app);
    expect(after).toEqual(before);
    expect(after.rooms.find((ws) => ws.id === room.id)!.readsBrainsOf).toEqual(["projetoy"]);
    expect(after.tasks[0]).toMatchObject({ id: task.id, status: "done", agentId: agent.id });
    expect(after.tasks[0]!.result).toContain("Desenhar o logo");
    expect(second.log.events).toEqual([]); // nada a retomar: boot silencioso
  });
});
