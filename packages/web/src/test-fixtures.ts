import type { Agent, AgentLogBody, AgentLogEntry, OfficeState, Task, Room } from "@cyno/shared";

/** Peças para testes de unidade do web (não entra no bundle: só arquivos .test.ts importam). */
export function makeRoom(id: string, overrides: Partial<Room> = {}): Room {
  return { id, kind: "team", name: id.toUpperCase(), theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: false, readsBrainsOf: [], ...overrides };
}

export function makeAgent(id: string, teamId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    teamId,
    name: id,
    role: "Testador",
    instructions: "",
    avatar: { skin: "tone2", hair: "long", hairColor: "wood", shirt: "mint", pants: "denim" },
    status: "idle",
    ...overrides,
  };
}

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    roomId: "a",
    teamId: "a-time",
    agentId: "ana",
    prompt: `pedido ${id}`,
    status: "queued",
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

/** A (porta para o lobby) <-> B; C isolado. Times e agentes em A e B. */
export function makeOffice(): OfficeState {
  return {
    rooms: [
      makeRoom("a", { readsGlobalBrain: true, readsBrainsOf: ["b"] }),
      makeRoom("b", { gridPosition: { x: 2, y: 0 }, readsBrainsOf: ["a"] }),
      makeRoom("c", { gridPosition: { x: 0, y: 1 } }),
    ],
    teams: [
      { id: "a-time", roomId: "a", name: "Time A", focus: "testar" },
      { id: "b-time", roomId: "b", name: "Time B", focus: "revisar" },
    ],
    agents: [makeAgent("ana", "a-time"), makeAgent("bia", "a-time"), makeAgent("caio", "b-time")],
    tasks: [
      makeTask("t1", { status: "in_progress" }),
      makeTask("t2", { roomId: "b", teamId: "b-time", agentId: "caio", status: "waiting_approval" }),
      makeTask("t3", { status: "done", result: "ok" }),
    ],
  };
}

let logClock = 0;
/** Entrada de log de teste: id ordenável dado ("e001"…), tarefa t1 e agente ana por padrão. */
export function makeLogEntry(id: string, body: AgentLogBody, extra: Partial<Pick<AgentLogEntry, "taskId" | "agentId" | "thread" | "provider" | "at">> = {}): AgentLogEntry {
  logClock += 1;
  return { id, taskId: "t1", agentId: "ana", at: `2026-11-08T10:00:${String(logClock % 60).padStart(2, "0")}.000Z`, ...extra, ...body } as AgentLogEntry;
}
