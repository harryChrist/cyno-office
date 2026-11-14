import type { ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeOffice, makeTask } from "../test-fixtures";
import { INITIAL_SYNC, officeReducer, type OfficeSync } from "./officeReducer";

describe("officeReducer", () => {
  it("ignora eventos antes do primeiro snapshot", () => {
    const event: ServerEvent = { type: "task:upserted", task: makeTask("t1") };
    expect(officeReducer(INITIAL_SYNC, event)).toBe(INITIAL_SYNC);
  });

  it("snapshot define o escritório e poda o progresso", () => {
    const stale: OfficeSync = { office: null, progress: { velha: { agentId: "x", progress: 1, message: "" } }, forYou: null, forYouTypes: null };
    const office = makeOffice();
    const next = officeReducer(stale, { type: "office:snapshot", office });
    expect(next.office).toBe(office);
    expect(next.progress).toEqual({});
  });

  it("fluxo de uma tarefa: criada, em andamento com progresso, concluída", () => {
    let state = officeReducer(INITIAL_SYNC, { type: "office:snapshot", office: makeOffice() });
    const events: ServerEvent[] = [
      { type: "task:upserted", task: makeTask("t9") },
      { type: "task:upserted", task: makeTask("t9", { status: "in_progress" }) },
      { type: "task:progress", taskId: "t9", agentId: "ana", progress: 0.4, message: "escrevendo" },
    ];
    state = events.reduce(officeReducer, state);
    expect(state.office?.tasks.find((task) => task.id === "t9")?.status).toBe("in_progress");
    expect(state.progress.t9).toEqual({ agentId: "ana", progress: 0.4, message: "escrevendo" });

    state = officeReducer(state, { type: "task:upserted", task: makeTask("t9", { status: "done", result: "pronto" }) });
    expect(state.office?.tasks.find((task) => task.id === "t9")).toMatchObject({ status: "done", result: "pronto" });
    expect(state.progress).not.toHaveProperty("t9");
  });

  it("devolve o mesmo estado quando nada muda", () => {
    const state = officeReducer(INITIAL_SYNC, { type: "office:snapshot", office: makeOffice() });
    expect(officeReducer(state, { type: "agent:deleted", id: "ninguem" })).toBe(state);
    expect(officeReducer(state, { type: "task:progress", taskId: "t3", agentId: "ana", progress: 1, message: "" })).toBe(state);
  });

  it("room:deleted limpa escritório e progresso juntos", () => {
    let state = officeReducer(INITIAL_SYNC, { type: "office:snapshot", office: makeOffice() });
    state = officeReducer(state, { type: "task:progress", taskId: "t1", agentId: "ana", progress: 0.3, message: "" });
    state = officeReducer(state, { type: "room:deleted", id: "a" });
    expect(state.office?.tasks.map((task) => task.id)).toEqual(["t2"]);
    expect(state.progress).toEqual({});
  });
});
