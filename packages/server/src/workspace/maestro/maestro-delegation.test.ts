import type { OfficeState, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { delegateTask } from "./maestro-delegation";

const AT = "2026-11-11T12:00:00.000Z";
const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" } as const;

function setup() {
  const request: Task = { id: "req1", roomId: "ger", teamId: "ger-time", agentId: "maestro", role: "request", prompt: "Comentário", status: "in_progress", createdAt: AT, updatedAt: AT };
  const state: OfficeState = {
    rooms: [
      { id: "ger", kind: "maestro", name: "Gerência", theme: "mint", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
      { id: "a", kind: "team", name: "A", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
    ],
    teams: [
      { id: "ger-time", roomId: "ger", name: "Gerência", focus: "gerir" },
      { id: "a-time", roomId: "a", name: "Time", focus: "testar" },
    ],
    agents: [
      { id: "maestro", teamId: "ger-time", name: "Maestro", role: "Gerente", instructions: "", avatar, status: "idle" },
      { id: "ana", teamId: "a-time", name: "Ana", role: "Redatora", instructions: "", avatar, status: "idle" },
    ],
    tasks: [request],
  };
  const adopt = vi.fn();
  const deps = { state: { read: () => state }, orchestrator: { enqueue: vi.fn() }, plans: () => ({ adopt }), log: { info: vi.fn(), error: vi.fn() } };
  const requests = { request: () => request, unwait: vi.fn(), commit: vi.fn(), logEntry: vi.fn(), setProgress: vi.fn() };
  return { state, adopt, call: (input: Parameters<typeof delegateTask>[3]) => delegateTask(deps as never, () => new Date(AT), requests as never, input) };
}

describe("delegate_task: prazo, prioridade e critério de pronto", () => {
  it("o briefing da subtarefa leva o Done when e o prazo; o projeto avulso recebe os mesmos campos", () => {
    const { state, adopt, call } = setup();
    call({ agentId: "ana", task: "Responda o comentário", requestId: "req1", dueAt: "2026-11-12T00:00:00.000Z", priority: "high", doneWhen: ["até 500 caracteres", " cita o ponto principal "] });
    const sub = state.tasks.at(-1)!;
    expect(sub.prompt).toContain("Responda o comentário");
    expect(sub.prompt).toContain("Done when:\n1. até 500 caracteres\n2. cita o ponto principal");
    expect(sub.prompt).toContain("Prazo: 2026-11-12T00:00:00.000Z");
    expect(sub.prompt).toContain("checklist");
    expect(adopt).toHaveBeenCalledWith(expect.anything(), expect.anything(), { dueAt: "2026-11-12T00:00:00.000Z", priority: "high", doneWhen: ["até 500 caracteres", " cita o ponto principal "] });
  });

  it("sem os campos novos o briefing fica como o Maestro mandou", () => {
    const { state, adopt, call } = setup();
    call({ agentId: "ana", task: "Responda o comentário", requestId: "req1" });
    expect(state.tasks.at(-1)!.prompt).toBe("Responda o comentário");
    expect(adopt).toHaveBeenCalledWith(expect.anything(), expect.anything(), {});
  });
});
