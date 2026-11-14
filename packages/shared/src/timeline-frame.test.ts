import type { AgentLogEntry } from "./agent-log";
import type { ForYouItem } from "./for-you";
import type { OfficeState, Task } from "./types";
import { describe, expect, it } from "vitest";
import { buildSceneFrame, emptyLogMemory, rememberLogEntry, TOOL_RECENT_MS } from "./timeline-frame";

const NOW = Date.parse("2026-11-11T15:00:00.000Z");
const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" };
const office = (tasks: Partial<Task>[] = []): OfficeState => ({
  rooms: [
    { id: "m", kind: "maestro", name: "Maestro", theme: "x", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
    { id: "r", kind: "team", name: "Sala", theme: "x", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
  ],
  teams: [
    { id: "tm", roomId: "m", name: "Gerência", focus: "" },
    { id: "t", roomId: "r", name: "Time", focus: "", leadAgentId: "ana" },
  ],
  agents: [
    { id: "mae", teamId: "tm", name: "Mae", role: "Maestro", instructions: "", avatar, status: "idle" },
    { id: "ana", teamId: "t", name: "Ana", role: "Dev", instructions: "", avatar, status: "working", engine: "claude" },
  ],
  tasks: tasks.map((t, i) => ({ id: `k${i}`, roomId: "r", teamId: "t", prompt: "x", status: "queued", createdAt: "2026-11-11T14:00:00.000Z", updatedAt: "2026-11-11T14:30:00.000Z", ...t }) as Task),
});
const base = { terminals: {}, forYou: [] as ForYouItem[], projects: [], progress: {}, block: () => undefined, log: emptyLogMemory(), now: NOW };

describe("buildSceneFrame", () => {
  it("copia salas, times e agentes; tarefa ativa com título e andamento; espera do dono; motor sem cota; terminal com erro", () => {
    const o = office([{ agentId: "ana", status: "in_progress", prompt: "Escrever o post\nmais detalhes" }, { agentId: "ana", status: "queued", prompt: "Revisar" }]);
    const frame = buildSceneFrame({
      ...base,
      office: o,
      progress: { k0: { agentId: "ana", progress: 0.4, message: "Pesquisando" } },
      forYou: [{ id: "A-1", agentId: "ana", status: "pendente", type: "post", title: "Aprovar o post" } as ForYouItem],
      terminals: { ana: { agentId: "ana", engine: "claude", status: "error", error: "caiu", updatedAt: "2026-11-11T14:58:00.000Z" } },
      block: () => ({ reason: "quota", resetsAt: new Date(NOW + 3_600_000).toISOString() }),
    });
    expect([...frame.rooms.keys()]).toEqual(["m", "r"]);
    expect(frame.teams.get("t")?.lead).toBe("ana");
    const ana = frame.agents.get("ana")!;
    expect(ana.tasks?.map((t) => [t.s, t.title])).toEqual([["a", "Escrever o post"], ["q", "Revisar"]]);
    expect(ana.progress).toEqual({ message: "Pesquisando", pct: 40 });
    expect(ana.asking).toBe("Aprovar o post");
    expect(ana.unavailable).toMatch(/sem cota/);
    expect(ana.terminal).toMatchObject({ status: "error", error: "caiu", at: Date.parse("2026-11-11T14:58:00.000Z") });
    expect(JSON.stringify(frame.agents.get("mae"))).not.toContain("tasks");
  });

  it("não grava texto de tarefa além do título curto nem custo", () => {
    const frame = buildSceneFrame({ ...base, office: office([{ agentId: "ana", status: "in_progress", prompt: `${"a".repeat(500)}\nsegredo`, result: "resultado longo" }]) });
    const json = JSON.stringify([...frame.agents.values()]);
    expect(json).not.toContain("segredo");
    expect(json).not.toContain("resultado longo");
    expect(frame.agents.get("ana")!.tasks![0]!.title.length).toBeLessThanOrEqual(80);
  });

  it("o Maestro com pedido nas mãos de um time mostra que delega; o pedido não vai para a parede", () => {
    const o = office([
      { id: "req", agentId: "mae", teamId: "tm", roomId: "m", role: "request", status: "in_progress" },
      { id: "sub", agentId: "ana", projectId: "req", status: "in_progress" },
    ]);
    const mae = buildSceneFrame({ ...base, office: o }).agents.get("mae")!;
    expect(mae.delegating).toEqual(["t"]);
    expect(mae.tasks).toEqual([expect.objectContaining({ id: "req", rq: true })]);
  });

  it("ferramenta em uso vale enquanto roda e por 8 s depois; subagente só enquanto a tarefa está aberta", () => {
    const memory = emptyLogMemory();
    const tool = { id: "e1", taskId: "k0", agentId: "ana", at: new Date(NOW - 20_000).toISOString(), kind: "tool", toolUseId: "tu1", name: "Read", summary: "", status: "running", input: { file_path: "/a/App.tsx" } } as AgentLogEntry;
    rememberLogEntry(memory, tool, NOW);
    const sub = { id: "e2", taskId: "k0", agentId: "ana", at: new Date(NOW).toISOString(), kind: "subagent", phase: "started", subagentId: "s1", label: "Pesquisa", goal: "achar" } as AgentLogEntry;
    rememberLogEntry(memory, sub, NOW);
    const o = office([{ agentId: "ana", status: "in_progress" }]);
    const running = buildSceneFrame({ ...base, office: o, log: memory }).agents.get("ana")!;
    expect(running.tool).toMatchObject({ id: "tu1", name: "Read", icon: expect.any(String) });
    expect(running.subs).toEqual([expect.objectContaining({ id: "s1", label: "Pesquisa" })]);
    rememberLogEntry(memory, { ...tool, status: "ok" } as AgentLogEntry, NOW);
    expect(buildSceneFrame({ ...base, office: o, log: memory }).agents.get("ana")!.tool).toBeUndefined();
    expect(buildSceneFrame({ ...base, office: o, log: memory, now: NOW - 20_000 + TOOL_RECENT_MS }).agents.get("ana")!.tool).toBeDefined();
    const done = office([{ agentId: "ana", status: "done" }]);
    expect(buildSceneFrame({ ...base, office: done, log: memory }).agents.get("ana")!.subs).toBeUndefined();
  });
});
