import type { Agent, OfficeState, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { routeTask } from "./routing";

const avatar = { skin: "tone1", hair: "short", hairColor: "ink", shirt: "mint", pants: "denim" };

function agent(id: string, name: string, status: Agent["status"] = "idle", teamId = "t1"): Agent {
  return { id, teamId, name, role: "Dev", instructions: "", avatar, status };
}

let taskCount = 0;
function task(agentId: string, status: Task["status"]): Task {
  const at = "2026-01-01T00:00:00.000Z";
  return { id: `task-${++taskCount}`, roomId: "w1", teamId: "t1", agentId, prompt: "x", status, createdAt: at, updatedAt: at };
}

function office(agents: Agent[], tasks: Task[] = []): OfficeState {
  return {
    rooms: [
      { id: "w1", kind: "team", name: "W1", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: false, readsBrainsOf: [] },
      { id: "w2", kind: "team", name: "W2", theme: "sand", gridPosition: { x: 2, y: 0 }, readsGlobalBrain: false, readsBrainsOf: [] },
    ],
    teams: [
      { id: "t1", roomId: "w1", name: "Time 1", focus: "x" },
      { id: "t-vazio", roomId: "w1", name: "Vazio", focus: "x" },
      { id: "t2", roomId: "w2", name: "Time 2", focus: "x" },
    ],
    agents,
    tasks,
  };
}

const route = (state: OfficeState) => routeTask(state, { roomId: "w1", teamId: "t1" });

describe("routeTask", () => {
  it("só considera agentes do time pedido", () => {
    const state = office([agent("fora", "Aaa", "idle", "t2"), agent("bia", "Bia")]);
    expect(route(state)).toBe("bia");
  });

  it("prefere agentes ociosos", () => {
    const state = office([agent("ana", "Ana", "working"), agent("bia", "Bia", "done"), agent("caio", "Caio")]);
    expect(route(state)).toBe("caio");
  });

  it("depois, menos tarefas pendentes (queued, in_progress e waiting_approval)", () => {
    const state = office(
      [agent("ana", "Ana", "working"), agent("bia", "Bia", "working"), agent("caio", "Caio", "waiting_approval")],
      [
        task("ana", "in_progress"),
        task("ana", "queued"),
        task("bia", "in_progress"),
        task("bia", "done"),
        task("bia", "done"),
        task("caio", "waiting_approval"),
        task("caio", "queued"),
      ],
    );
    expect(route(state)).toBe("bia");
  });

  it("depois, menos tarefas no total", () => {
    const state = office(
      [agent("ana", "Ana"), agent("bia", "Bia")],
      [task("ana", "done"), task("ana", "failed"), task("bia", "done")],
    );
    expect(route(state)).toBe("bia");
  });

  it("desempata pelo nome", () => {
    const state = office([agent("z", "Zeca"), agent("y", "Ágata"), agent("x", "Bruno")]);
    expect(route(state)).toBe("y");
  });

  it("time sem agentes -> 422; time de outro quarto -> 400; inexistentes -> 404", () => {
    const state = office([agent("ana", "Ana")]);
    expect(() => routeTask(state, { roomId: "w1", teamId: "t-vazio" })).toThrow(
      expect.objectContaining({ statusCode: 422 }),
    );
    expect(() => routeTask(state, { roomId: "w1", teamId: "t2" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => routeTask(state, { roomId: "w1", teamId: "nada" })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    expect(() => routeTask(state, { roomId: "nada", teamId: "t1" })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});
