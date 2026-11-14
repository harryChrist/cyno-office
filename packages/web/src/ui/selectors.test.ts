import { LOBBY_ID, type BrainContext } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeOffice, makeTask, makeRoom } from "../test-fixtures";
import { agentTasks, currentWork, findAgentDetails, isFocusedOn, roomShortcuts, summarizeBrain, toggledReads, roomFootprint, roomTeams } from "./selectors";

describe("findAgentDetails", () => {
  it("junta agente, time e quarto", () => {
    const office = makeOffice();
    const details = findAgentDetails(office, "caio");
    expect(details?.team?.id).toBe("b-time");
    expect(details?.room?.id).toBe("b");
    expect(findAgentDetails(office, "ninguem")).toBeNull();
  });
});

describe("tarefas do agente", () => {
  const tasks = [
    makeTask("velha", { createdAt: "2026-11-07T10:00:00.000Z", status: "done" }),
    makeTask("fila-2", { createdAt: "2026-11-07T10:03:00.000Z", status: "queued" }),
    makeTask("fila-1", { createdAt: "2026-11-07T10:02:00.000Z", status: "queued" }),
    makeTask("outra", { agentId: "bia", createdAt: "2026-11-07T10:04:00.000Z", status: "in_progress" }),
  ];

  it("histórico do mais novo para o mais velho, só do agente", () => {
    expect(agentTasks(tasks, "ana").map((t) => t.id)).toEqual(["fila-2", "fila-1", "velha"]);
  });

  it("atual: aprovação > em andamento > mais antiga da fila", () => {
    expect(currentWork(tasks, "ana")).toMatchObject({ task: { id: "fila-1" }, queued: 1 });
    const running = [...tasks, makeTask("rodando", { createdAt: "2026-11-07T10:05:00.000Z", status: "in_progress" })];
    expect(currentWork(running, "ana")).toMatchObject({ task: { id: "rodando" }, queued: 2 });
    const asking = [...running, makeTask("pede", { createdAt: "2026-11-07T10:06:00.000Z", status: "waiting_approval" })];
    expect(currentWork(asking, "ana").task?.id).toBe("pede");
    expect(currentWork(tasks, "ninguem")).toEqual({ task: null, queued: 0 });
  });
});

describe("quartos", () => {
  it("times com seus agentes", () => {
    const teams = roomTeams(makeOffice(), "a");
    expect(teams.map((t) => [t.team.id, t.agents.map((a) => a.id)])).toEqual([["a-time", ["ana", "bia"]]]);
  });

  it("atalhos: lobby primeiro e depois o grid (linha, coluna)", () => {
    const shortcuts = roomShortcuts(makeOffice().rooms);
    expect(shortcuts.map((s) => s.id)).toEqual([LOBBY_ID, "a", "b", "c"]);
  });

  it("foco", () => {
    expect(isFocusedOn({ kind: "room", id: "a" }, "a")).toBe(true);
    expect(isFocusedOn({ kind: "map" }, "a")).toBe(false);
  });

  it("toggledReads liga e desliga sem duplicar", () => {
    const room = makeRoom("x", { readsBrainsOf: ["y", "z"] });
    expect(toggledReads(room, "w", true)).toEqual(["y", "z", "w"]);
    expect(toggledReads(room, "y", true)).toEqual(["z", "y"]);
    expect(toggledReads(room, "y", false)).toEqual(["z"]);
  });

  it("o que some ao excluir um quarto", () => {
    expect(roomFootprint(makeOffice(), "a")).toEqual({ teams: 1, agents: 2, activeTasks: 1 });
    expect(roomFootprint(makeOffice(), "c")).toEqual({ teams: 0, agents: 0, activeTasks: 0 });
  });
});

describe("summarizeBrain", () => {
  const office = makeOffice();
  const note = (title: string) => ({ file: `${title}.md`, title, content: "" });

  it("lista as fontes com notas e deixa claro o que fica de fora", () => {
    const context: BrainContext = {
      roomId: "a",
      text: "",
      sources: [
        { kind: "self", id: "a", name: "A", notes: [note("n1"), note("n2")] },
        { kind: "lobby", id: "global", name: "Cérebro global", notes: [note("g")] },
        { kind: "connected", id: "b", name: "B", notes: [] },
      ],
    };
    const summary = summarizeBrain(context, office.rooms[0]!, office.rooms);
    expect(summary.sources.map((s) => [s.label, s.notes.length])).toEqual([
      ["Esta sala", 2],
      ["Lobby (Cérebro global)", 1],
      ["Sala conectada", 0],
    ]);
    expect(summary.totalNotes).toBe(3);
    expect(summary.sources.map((s) => s.omitted)).toEqual([0, 0, 0]);
    expect(summary.hidden).toEqual([{ id: "c", name: "C", reason: "fora da lista de Cérebros lidos" }]);
  });

  it("sem ler o global, o lobby aparece entre os que não enxerga", () => {
    const context: BrainContext = { roomId: "c", text: "", sources: [{ kind: "self", id: "c", name: "C", notes: [] }] };
    const summary = summarizeBrain(context, office.rooms[2]!, office.rooms);
    expect(summary.hidden.map((h) => h.id)).toEqual([LOBBY_ID, "a", "b"]);
    expect(summary.hidden[0]?.reason).toBe("não lê o Cérebro global");
  });
});
