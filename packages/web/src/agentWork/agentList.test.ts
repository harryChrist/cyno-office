import type { OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeLogEntry as entry, makeOffice, makeRoom, makeTask } from "../test-fixtures";
import { agentList, listRows } from "./agentList";

function withMaestro(): OfficeState {
  const office = makeOffice();
  office.tasks = [];
  office.rooms.push(makeRoom("sala", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: -1, y: 0 } }));
  office.teams.push({ id: "gerencia", roomId: "sala", name: "Gerência", focus: "coordenar" });
  office.agents.push(makeAgent("maestro", "gerencia", { role: "maestro", name: "Maestro" }));
  return office;
}

describe("agentList", () => {
  it("Maestro à parte; os outros por sala e, dentro dela, por time, na ordem do escritório", () => {
    const office = withMaestro();
    const list = agentList(office, {}, {});
    expect(list.maestro?.agent.id).toBe("maestro");
    expect(list.total).toBe(office.agents.length);
    const teamsWithAgents = office.teams.filter((team) => team.id !== "gerencia" && office.agents.some((agent) => agent.teamId === team.id));
    expect(list.rooms.flatMap((room) => room.teams.map((team) => team.key))).toEqual(teamsWithAgents.map((team) => team.id));
    // Cada sala aparece uma vez só (os times dela ficam dentro, sem repetir o nome da sala).
    expect(new Set(list.rooms.map((room) => room.key)).size).toBe(list.rooms.length);
    for (const room of list.rooms) {
      expect(room.roomName).toBe(office.rooms.find((candidate) => candidate.id === room.key)!.name);
      for (const group of room.teams) {
        const team = office.teams.find((candidate) => candidate.id === group.key)!;
        expect(team.roomId).toBe(room.key);
        expect(group.teamName).toBe(team.name);
        expect(group.rows.every((row) => !row.isMaestro && row.agent.teamId === team.id)).toBe(true);
      }
    }
  });

  it("o time mostra o líder, se tiver", () => {
    const office = withMaestro();
    const team = office.teams.find((candidate) => candidate.id !== "gerencia" && office.agents.some((agent) => agent.teamId === candidate.id))!;
    const lead = office.agents.find((agent) => agent.teamId === team.id)!;
    team.leadAgentId = lead.id;
    const found = agentList(office, {}, {}).rooms.flatMap((room) => room.teams).find((candidate) => candidate.key === team.id)!;
    expect(found.leadName).toBe(lead.name);
  });

  it("atividade: progresso ao vivo > último passo do log > a tarefa; livre diz 'Livre'", () => {
    const office = withMaestro();
    const [first, second, third] = office.agents.filter((agent) => agent.id !== "maestro");
    first!.status = "working";
    second!.status = "working";
    office.tasks.push(
      makeTask("t-a", { agentId: first!.id, status: "in_progress", prompt: "escrever post" }),
      makeTask("t1", { agentId: second!.id, status: "in_progress", prompt: "revisar" }),
    );
    const logs = {
      [second!.id]: [
        entry("e1", { kind: "tool", toolUseId: "x", name: "Busca", summary: "tendências", status: "running" }, { agentId: second!.id, provider: "claude" }),
        entry("e2", { kind: "subagent", phase: "started", subagentId: "sa1", label: "a", goal: "" }, { agentId: second!.id }),
        entry("e3", { kind: "subagent", phase: "started", subagentId: "sa2", label: "b", goal: "" }, { agentId: second!.id }),
      ],
    };
    const list = agentList(office, logs, { "t-a": { agentId: first!.id, progress: 0.3, message: "Rascunhando" } });
    const rows = listRows(list);
    const row = (id: string) => rows.find((candidate) => candidate.agent.id === id)!;
    expect(row(first!.id)).toMatchObject({ activity: "Rascunhando", tone: "busy", activeSubagents: 0 });
    expect(row(second!.id)).toMatchObject({ activity: "Subagente: b", activeSubagents: 2, engine: "Claude Code" });
    expect(row(third!.id)).toMatchObject({ activity: "Livre", tone: "neutral" });
    expect(list.working).toBe(2);
  });

  it("sem log carregado, usa o resumo do server para os subagentes (só de quem está ocupado)", () => {
    const office = withMaestro();
    const [first, second] = office.agents.filter((agent) => agent.id !== "maestro");
    first!.status = "working";
    const list = agentList(office, {}, {}, { [first!.id]: { activeSubagents: 3 }, [second!.id]: { activeSubagents: 5 } });
    const rows = listRows(list);
    expect(rows.find((row) => row.agent.id === first!.id)!.activeSubagents).toBe(3);
    expect(rows.find((row) => row.agent.id === second!.id)!.activeSubagents).toBe(0);
  });

  it("agente indisponível (sem cota) leva o selo na linha; os outros não", () => {
    const office = withMaestro();
    const [first, second] = office.agents.filter((agent) => agent.id !== "maestro");
    const list = agentList(office, {}, {}, {}, { [first!.id]: { label: "sem cota · volta às 14:30" } });
    const rows = listRows(list);
    expect(rows.find((row) => row.agent.id === first!.id)?.unavailable).toBe("sem cota · volta às 14:30");
    expect(rows.find((row) => row.agent.id === second!.id)?.unavailable).toBeUndefined();
  });

  it("agente de um time que sumiu cai num grupo à parte", () => {
    const office = withMaestro();
    office.agents.push(makeAgent("perdido", "nao-existe"));
    const list = agentList(office, {}, {});
    expect(list.rooms.at(-1)).toMatchObject({ key: "__sem-quarto", teams: [{ key: "__sem-time", rows: [{ agent: { id: "perdido" } }] }] });
  });

  it("agente real ganha o estado do terminal (criado, ligado, com erro); o simulado não", () => {
    const office = withMaestro();
    const real = office.agents.find((agent) => agent.id !== "maestro")!;
    real.engine = "claude";
    const list = agentList(office, {}, {}, {}, {}, { [real.id]: { agentId: real.id, engine: "claude", status: "error", error: "spawn claude ENOENT", updatedAt: "2026-11-08T12:00:00.000Z" } });
    const row = listRows(list).find((candidate) => candidate.agent.id === real.id)!;
    expect(row.terminal).toMatchObject({ key: "erro", emoji: "🔴", detail: "comando claude não encontrado" });
    expect(listRows(list).find((candidate) => candidate.agent.id !== real.id)?.terminal).toBeUndefined();
    const fresh = listRows(agentList(office, {}, {})).find((candidate) => candidate.agent.id === real.id)!;
    expect(fresh.terminal).toMatchObject({ key: "novo", label: "Criado, nunca iniciado" });
  });
});
