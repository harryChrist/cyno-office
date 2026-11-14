import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findOfficeRuleViolations, MAESTRO_AVATAR, avatarSchema, type ApiErrorBody, type OfficeState, type Room } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildSeedOffice } from "./seed";
import { call, createRoom, getOffice, TEST_AVATAR } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";
import { ensureMaestro, MAESTRO_RULES } from "./maestro";

const setupApp = useTestApp();
const API = "/api/w/principal";

describe("ensureMaestro", () => {
  it("cria sala (ao lado do lobby, com porta), Gerência e Maestro só quando faltam", () => {
    const empty = ensureMaestro({ office: { rooms: [], teams: [], agents: [] } });
    expect(empty.changed).toBe(true);
    expect(empty.office.rooms).toEqual([
      { id: "sala-do-maestro", kind: "maestro", name: "Sala do Maestro", theme: "terracotta", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
    ]);
    expect(empty.office.teams).toEqual([expect.objectContaining({ name: "Gerência", roomId: "sala-do-maestro" })]);
    expect(empty.office.agents).toEqual([expect.objectContaining({ id: "maestro", name: "Maestro", role: "maestro", status: "idle" })]);
    expect(avatarSchema.parse(MAESTRO_AVATAR)).toEqual(MAESTRO_AVATAR);
    expect(findOfficeRuleViolations(empty.office)).toEqual([]);

    const again = ensureMaestro({ office: empty.office });
    expect(again).toEqual({ office: empty.office, changed: false });
  });

  it("não reaproveita ids do histórico nem pastas de Cérebro antigas", () => {
    const result = ensureMaestro({
      office: { rooms: [], teams: [], agents: [] },
      takenRoomIds: ["sala-do-maestro"],
      tasks: [
        {
          id: "t",
          roomId: "x",
          teamId: "sala-do-maestro-2-gerencia",
          agentId: "maestro",
          prompt: "p",
          status: "done",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(result.office.rooms[0]!.id).toBe("sala-do-maestro-2");
    expect(result.office.teams[0]!.id).toBe("sala-do-maestro-2-gerencia-2");
    expect(result.office.agents[0]!.id).toBe("maestro-2");
  });
});

describe("Sala do Maestro na API", () => {
  it("não pode ser excluída nem ter times normais; Gerência e Maestro ficam onde estão", async () => {
    const { app } = await setupApp();
    const office = await getOffice(app);
    const room = office.rooms.find((candidate) => candidate.kind === "maestro")!;
    const team = office.teams.find((candidate) => candidate.roomId === room.id)!;
    const maestro = office.agents.find((agent) => agent.teamId === team.id)!;

    const expectRule = async (method: "POST" | "PATCH" | "DELETE", url: string, body: object | undefined, message: string) => {
      const response = await call<ApiErrorBody>(app, method, `${API}${url}`, body, 409);
      expect(response.error).toBe(message);
    };
    await expectRule("DELETE", `/rooms/${room.id}`, undefined, MAESTRO_RULES.deleteRoom);
    await expectRule("POST", "/teams", { roomId: room.id, name: "Intruso", focus: "x" }, MAESTRO_RULES.teamInRoom);
    await expectRule("PATCH", "/teams/projetox-frontend", { roomId: room.id }, MAESTRO_RULES.teamInRoom);
    await expectRule("PATCH", `/teams/${team.id}`, { roomId: "projetox" }, MAESTRO_RULES.moveTeam);
    await expectRule("DELETE", `/teams/${team.id}`, undefined, MAESTRO_RULES.deleteTeam);
    const newAgent = { teamId: team.id, name: "Ajudante", role: "Dev", instructions: "", avatar: TEST_AVATAR };
    await expectRule("POST", "/agents", newAgent, MAESTRO_RULES.agentInRoom);
    await expectRule("PATCH", "/agents/lia", { teamId: team.id }, MAESTRO_RULES.agentInRoom);
    await expectRule("PATCH", `/agents/${maestro.id}`, { teamId: "projetox-frontend" }, MAESTRO_RULES.moveAgent);
    await expectRule("PATCH", `/agents/${maestro.id}`, { role: "Dev" }, MAESTRO_RULES.changeRole);
    await expectRule("DELETE", `/agents/${maestro.id}`, undefined, MAESTRO_RULES.deleteAgent);

    // Renomear a sala e trocar o visual do Maestro continua livre.
    await call(app, "PATCH", `${API}/rooms/${room.id}`, { name: "Gabinete" }, 200);
    await call(app, "PATCH", `${API}/agents/${maestro.id}`, { name: "Regente" }, 200);
    const after = await getOffice(app);
    expect(after.rooms.filter((candidate) => candidate.kind === "maestro")).toHaveLength(1);
    expect(after.agents.filter((agent) => agent.teamId === team.id).map((agent) => agent.name)).toEqual(["Regente"]);
  });

  it("um workspace antigo sem a sala (ex.: o migrado) ganha a sala ao abrir", async () => {
    const first = await setupApp();
    await first.app.close();
    const officeFile = path.join(first.dir, "office.json");
    const data = JSON.parse(await readFile(officeFile, "utf8")) as Omit<OfficeState, "tasks"> & { version: number };
    const seedWithout = buildSeedOffice();
    const maestroRoom = seedWithout.rooms.find((room) => room.kind === "maestro")!.id;
    const gerencia = seedWithout.teams.filter((team) => team.roomId === maestroRoom).map((team) => team.id);
    const legacy = {
      ...data,
      // Sem `kind`, como nos arquivos de antes da Sala do Maestro.
      rooms: data.rooms
        .filter((room) => room.kind !== "maestro")
        .map((room) => {
          const old: Partial<Room> = { ...room };
          delete old.kind;
          return old;
        }),
      teams: data.teams.filter((team) => team.roomId !== maestroRoom),
      agents: data.agents.filter((agent) => !gerencia.includes(agent.teamId)),
    };
    await writeFile(officeFile, JSON.stringify(legacy));
    // Antes da sala existir não havia a pasta do Cérebro dela (o primeiro boot já criou os fixos).
    await rm(path.join(first.dir, "brains", maestroRoom), { recursive: true, force: true });

    const { app } = await setupApp({ dataDir: first.dataDir });
    const office = await getOffice(app);
    expect(office.rooms.map((room) => [room.id, room.kind])).toEqual([
      ["projetox", "team"],
      ["projetoy", "team"],
      ["sala-do-maestro", "maestro"],
    ]);
    expect(office.agents.filter((agent) => agent.role === "maestro")).toHaveLength(1);
    const saved = JSON.parse(await readFile(officeFile, "utf8")) as Omit<OfficeState, "tasks">;
    expect(saved.rooms.find((room) => room.kind === "maestro")).toBeDefined();
  });

  it("quartos novos continuam sendo de time", async () => {
    const { app } = await setupApp();
    expect((await createRoom(app, "Estúdio")).kind).toBe("team");
  });
});
