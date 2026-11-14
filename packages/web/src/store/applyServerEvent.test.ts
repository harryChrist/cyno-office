import { describe, expect, it } from "vitest";
import { makeAgent, makeOffice, makeTask, makeRoom } from "../test-fixtures";
import { applyServerEvent } from "./applyServerEvent";

describe("applyServerEvent", () => {
  it("substitui tudo no snapshot", () => {
    const office = makeOffice();
    const next = { ...office, agents: [] };
    expect(applyServerEvent(office, { type: "office:snapshot", office: next })).toBe(next);
  });

  it("atualiza ou insere no upsert sem mutar o estado anterior", () => {
    const office = makeOffice();
    const ana = office.agents[0]!;
    const working = applyServerEvent(office, { type: "agent:upserted", agent: { ...ana, status: "working" } });
    expect(working.agents.map((agent) => agent.status)).toEqual(["working", "idle", "idle"]);
    expect(office.agents[0]!.status).toBe("idle");

    const added = applyServerEvent(office, {
      type: "team:upserted",
      team: { id: "c-time", roomId: "c", name: "Time C", focus: "f" },
    });
    expect(added.teams.map((team) => team.id)).toEqual(["a-time", "b-time", "c-time"]);
  });

  it("aplica upsert de quarto e de tarefa", () => {
    const office = makeOffice();
    const moved = applyServerEvent(office, {
      type: "room:upserted",
      room: makeRoom("c", { gridPosition: { x: 3, y: 3 } }),
    });
    expect(moved.rooms.find((room) => room.id === "c")?.gridPosition).toEqual({ x: 3, y: 3 });

    const done = applyServerEvent(office, { type: "task:upserted", task: makeTask("t1", { status: "done", result: "# ok" }) });
    expect(done.tasks.find((task) => task.id === "t1")).toMatchObject({ status: "done", result: "# ok" });
    const created = applyServerEvent(office, { type: "task:upserted", task: makeTask("t9") });
    expect(created.tasks.at(-1)?.id).toBe("t9");
  });

  it("room:deleted remove em cascata times, agentes, tarefas e os Cérebros lidos", () => {
    const next = applyServerEvent(makeOffice(), { type: "room:deleted", id: "a" });
    expect(next.rooms.map((room) => room.id)).toEqual(["b", "c"]);
    expect(next.rooms.find((room) => room.id === "b")?.readsBrainsOf).toEqual([]);
    expect(next.teams.map((team) => team.id)).toEqual(["b-time"]);
    expect(next.agents.map((agent) => agent.id)).toEqual(["caio"]);
    expect(next.tasks.map((task) => task.id)).toEqual(["t2"]);
  });

  it("team:deleted remove os agentes do time e mantém as tarefas como histórico", () => {
    const next = applyServerEvent(makeOffice(), { type: "team:deleted", id: "a-time" });
    expect(next.teams.map((team) => team.id)).toEqual(["b-time"]);
    expect(next.agents.map((agent) => agent.id)).toEqual(["caio"]);
    expect(next.tasks).toHaveLength(3);
  });

  it("agent:deleted remove só o agente", () => {
    const next = applyServerEvent(makeOffice(), { type: "agent:deleted", id: "bia" });
    expect(next.agents.map((agent) => agent.id)).toEqual(["ana", "caio"]);
  });

  it("remoção de id desconhecido e task:progress devolvem o mesmo objeto", () => {
    const office = makeOffice();
    expect(applyServerEvent(office, { type: "room:deleted", id: "zzz" })).toBe(office);
    expect(applyServerEvent(office, { type: "team:deleted", id: "zzz" })).toBe(office);
    expect(applyServerEvent(office, { type: "agent:deleted", id: "zzz" })).toBe(office);
    const progress = { type: "task:progress", taskId: "t1", agentId: "ana", progress: 0.5, message: "..." } as const;
    expect(applyServerEvent(office, progress)).toBe(office);
  });

  it("aceita agente novo de um time que ainda não chegou", () => {
    const next = applyServerEvent(makeOffice(), { type: "agent:upserted", agent: makeAgent("novo", "x-time") });
    expect(next.agents.at(-1)?.id).toBe("novo");
  });
});
