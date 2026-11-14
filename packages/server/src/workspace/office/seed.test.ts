import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AVATAR_OPTIONS,
  agentSchema,
  findOfficeRuleViolations,
  gridKey,
  isLobbyCell,
  teamSchema,
  roomSchema,
} from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildSeedOffice, seedDataDir } from "./seed";
import { officeFileSchema } from "../../store/files";
import { principalDir } from "../../dev/test-app";
import { useTempDirs } from "../../dev/test-utils";

const tempDir = useTempDirs();

describe("dados do seed", () => {
  const office = buildSeedOffice();

  it("tem 2 quartos de time (4 times, 10 agentes, 2 a 3 por time) e a Sala do Maestro, todos idle", () => {
    expect(office.rooms.map((ws) => ws.id)).toEqual(["projetox", "projetoy", "sala-do-maestro"]);
    expect(office.teams).toHaveLength(5);
    expect(office.agents).toHaveLength(11);
    for (const team of office.teams.filter((candidate) => candidate.roomId !== "sala-do-maestro")) {
      const count = office.agents.filter((agent) => agent.teamId === team.id).length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(3);
    }
    expect(office.agents.every((agent) => agent.status === "idle")).toBe(true);
  });

  it("passa nos schemas zod", () => {
    for (const ws of office.rooms) expect(roomSchema.parse(ws)).toEqual(ws);
    for (const team of office.teams) expect(teamSchema.parse(team)).toEqual(team);
    for (const agent of office.agents) expect(agentSchema.parse(agent)).toEqual(agent);
  });

  it("usa ids únicos em todo o escritório", () => {
    const ids = [...office.rooms, ...office.teams, ...office.agents].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("segue as regras de grid e do Cérebro compartilhado", () => {
    expect(findOfficeRuleViolations(office)).toEqual([]);
    const cells = office.rooms.map((ws) => gridKey(ws.gridPosition));
    expect(new Set(cells).size).toBe(cells.length);
    expect(office.rooms.some((ws) => isLobbyCell(ws.gridPosition))).toBe(false);
    for (const ws of office.rooms) {
      for (const otherId of ws.readsBrainsOf) expect(office.rooms.some((candidate) => candidate.id === otherId)).toBe(true);
    }
  });

  it("configura ProjetoX com porta para o lobby e ProjetoY isolado", () => {
    const [x, y] = office.rooms;
    expect(x).toMatchObject({ theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] });
    expect(y).toMatchObject({ theme: "lavender", gridPosition: { x: 2, y: 0 }, readsGlobalBrain: false, readsBrainsOf: [] });
  });

  it("a Sala do Maestro fica ao lado do lobby, com porta, a Gerência e só o Maestro", () => {
    const room = office.rooms.find((candidate) => candidate.kind === "maestro")!;
    expect(room).toMatchObject({ name: "Sala do Maestro", readsGlobalBrain: true, gridPosition: { x: 0, y: 1 } });
    const teams = office.teams.filter((team) => team.roomId === room.id);
    expect(teams.map((team) => team.name)).toEqual(["Gerência"]);
    const agents = office.agents.filter((agent) => agent.teamId === teams[0]!.id);
    expect(agents).toEqual([expect.objectContaining({ id: "maestro", name: "Maestro", role: "maestro" })]);
  });

  it("tem avatares variados com todos os tons de pele", () => {
    const skins = new Set(office.agents.map((agent) => agent.avatar.skin));
    expect([...skins].sort()).toEqual([...AVATAR_OPTIONS.skin]);
    expect(new Set(office.agents.map((agent) => agent.avatar.hair)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(office.agents.map((agent) => agent.avatar.shirt)).size).toBeGreaterThanOrEqual(8);
    expect(office.agents.some((agent) => agent.avatar.accessory)).toBe(true);
    expect(office.agents.some((agent) => !agent.avatar.accessory)).toBe(true);
  });
});

describe("seedDataDir", () => {
  it("cria workspaces.json com o Principal e, na pasta dele, office.json, schema.json e as notas", async () => {
    const dataDir = await tempDir();
    expect(await seedDataDir(dataDir)).toEqual({ created: true });

    const list = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8"));
    expect(list).toEqual([{ id: "principal", name: "Principal", createdAt: expect.any(String) }]);

    const dir = principalDir(dataDir);
    const officeFile = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    expect(officeFileSchema.parse(officeFile).agents).toHaveLength(11);
    expect(JSON.parse(await readFile(path.join(dir, "schema.json"), "utf8"))).toEqual({ dataVersion: 4 });

    const brains = path.join(dir, "brains");
    expect((await readdir(path.join(brains, "global"))).sort()).toEqual(["aprendizados.md", "preferencias.md"]);
    expect(await readdir(path.join(brains, "projetox"))).toHaveLength(2);
    const notesY = await readdir(path.join(brains, "projetoy"));
    expect(notesY).toHaveLength(2);
    const confidential = await readFile(path.join(brains, "projetoy", "confidencial.md"), "utf8");
    expect(confidential).toMatch(/confidencial/i);
  });

  it("não sobrescreve dados existentes sem --force", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const note = path.join(principalDir(dataDir), "brains", "global", "preferencias.md");
    await writeFile(note, "editado pelo usuário");
    expect(await seedDataDir(dataDir)).toEqual({ created: false });
    expect(await readFile(note, "utf8")).toBe("editado pelo usuário");
  });

  it("pasta do Principal pronta sem workspaces.json: só registra, sem sobrescrever", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const tasksFile = path.join(principalDir(dataDir), "schema.json");
    await writeFile(tasksFile, '{"dataVersion":3}\n ');
    await rm(path.join(dataDir, "workspaces.json"));
    await seedDataDir(dataDir);
    expect(await readFile(tasksFile, "utf8")).toBe('{"dataVersion":3}\n ');
    expect(JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8"))[0].id).toBe("principal");
  });

  it("recria tudo com force (inclusive apagando workspaces extras)", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const dir = principalDir(dataDir);
    const note = path.join(dir, "brains", "global", "preferencias.md");
    await writeFile(note, "editado pelo usuário");
    await writeFile(path.join(dir, "brains", "projetox", "extra.md"), "nota extra");
    await mkdir(path.join(dataDir, "workspaces", "outro"), { recursive: true });
    expect(await seedDataDir(dataDir, { force: true })).toEqual({ created: true });
    expect(await readFile(note, "utf8")).toMatch(/Preferências/);
    expect(await readdir(path.join(dir, "brains", "projetox"))).not.toContain("extra.md");
    expect(await readdir(path.join(dataDir, "workspaces"))).toEqual(["principal"]);
  });
});
