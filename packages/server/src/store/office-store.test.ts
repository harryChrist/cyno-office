import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { projectSchema } from "@cyno/shared";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedDataDir } from "../workspace/office/seed";
import { principalDir } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { DataFileError } from "./files";
import { OfficeStore } from "./office-store";

const tempDir = useTempDirs();

async function openSeeded() {
  const dataDir = await tempDir();
  await seedDataDir(dataDir);
  const dir = principalDir(dataDir);
  return { dir, store: await OfficeStore.open(dir) };
}

describe("OfficeStore", () => {
  it("carrega o estado do disco", async () => {
    const { store } = await openSeeded();
    const state = store.snapshot();
    expect(state.rooms).toHaveLength(3);
    expect(state.tasks).toEqual([]);
  });

  it("devolve cópias: alterar o snapshot não altera o store", async () => {
    const { store } = await openSeeded();
    store.snapshot().rooms[0]!.name = "Hackeado";
    expect(store.snapshot().rooms[0]!.name).toBe("ProjetoX");
  });

  it("grava em ordem e sem deixar arquivos temporários", async () => {
    const { dir, store } = await openSeeded();
    const base = store.snapshot();
    const renamed = (name: string) => ({
      ...base,
      rooms: base.rooms.map((ws) => (ws.id === "projetox" ? { ...ws, name } : ws)),
    });
    await Promise.all(["A", "B", "C"].map((name) => store.commitOffice(renamed(name))));
    await store.flush();

    const saved = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.rooms[0].name).toBe("C");
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);

    const reopened = await OfficeStore.open(dir);
    expect(reopened.snapshot().rooms[0]!.name).toBe("C");
  });

  it("persiste tarefas em tasks/AAAA-MM.json", async () => {
    const { dir, store } = await openSeeded();
    const now = new Date().toISOString();
    const task = {
      id: "t1",
      roomId: "projetox",
      teamId: "projetox-backend",
      prompt: "Criar endpoint",
      status: "queued" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.commitTasks([task]);
    expect(JSON.parse(await readFile(path.join(dir, "tasks", `${now.slice(0, 7)}.json`), "utf8"))).toEqual([task]);
  });

  it("regrava só o mês que mudou (tarefas e Para você) e grava projetos um a um", async () => {
    const { dir, store } = await openSeeded();
    const mk = (id: string, createdAt: string) => ({ id, roomId: "projetox", teamId: "projetox-backend", prompt: id, status: "queued" as const, createdAt, updatedAt: createdAt });
    const tasks = [mk("a", "2026-10-05T10:00:00.000Z"), mk("b", "2026-11-05T10:00:00.000Z")];
    await store.commitTasks(tasks);
    const october = path.join(dir, "tasks", "2026-10.json");
    const november = path.join(dir, "tasks", "2026-11.json");
    const before = { october: await stat(october), november: await stat(november) };
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.commitTasks([tasks[0]!, { ...tasks[1]!, status: "done" as const }]);
    expect((await stat(october)).mtimeMs).toBe(before.october.mtimeMs);
    expect((await stat(november)).mtimeMs).toBeGreaterThan(before.november.mtimeMs);
    // sem mudança nenhuma: nada é regravado
    const mid = (await stat(november)).mtimeMs;
    await store.commitTasks(store.snapshot().tasks);
    expect((await stat(november)).mtimeMs).toBe(mid);
    // remover a última tarefa de um mês apaga o arquivo dele
    await store.commitTasks([{ ...tasks[1]!, status: "done" as const }]);
    expect(await readdir(path.join(dir, "tasks"))).toEqual(["2026-11.json"]);
    const reopened = await OfficeStore.open(dir);
    expect(reopened.snapshot().tasks.map((task) => task.id)).toEqual(["b"]);

    const at = "2026-11-05T10:00:00.000Z";
    const project = projectSchema.parse({ id: "p1", title: "P", status: "ativo", version: 1, tasks: [], createdAt: at, updatedAt: at });
    await store.commitProjects([project]);
    await store.commitProjects([{ ...project, title: "P2" }]);
    expect((await OfficeStore.open(dir)).projectsSnapshot().map((candidate) => candidate.title)).toEqual(["P2", "Avulsas"]);
    await store.commitProjects([], ["p1"]);
    // o projeto fixo "Avulsas" sempre existe
    expect((await OfficeStore.open(dir)).projectsSnapshot().map((candidate) => candidate.id)).toEqual(["avulsas"]);
  });

  it("rejeita estados que quebram as regras sem alterar nada", async () => {
    const { store } = await openSeeded();
    const state = store.snapshot();
    const broken = {
      ...state,
      rooms: state.rooms.map((ws) => ({ ...ws, gridPosition: { x: 0, y: 0 } })),
    };
    await expect(store.commitOffice(broken)).rejects.toThrow(/lobby/);
    expect(store.snapshot().rooms[0]!.gridPosition).toEqual({ x: 1, y: 0 });
  });

  it("falha com erro claro se office.json estiver inválido", async () => {
    const { dir } = await openSeeded();
    await writeFile(path.join(dir, "office.json"), "{ quebrado");
    await expect(OfficeStore.open(dir)).rejects.toBeInstanceOf(DataFileError);
    await writeFile(path.join(dir, "office.json"), JSON.stringify({ version: 3, rooms: [{}], teams: [], agents: [] }));
    await expect(OfficeStore.open(dir)).rejects.toThrow(/office\.json/);
  });

  it("migra o office.json v1 (quartos em `workspaces`) e o tasks.json antigo sem perder nada", async () => {
    const { dir } = await openSeeded();
    const current = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    const legacyOffice = {
      version: 1,
      workspaces: current.rooms,
      teams: current.teams.map(({ roomId, ...team }: { roomId: string }) => ({ ...team, workspaceId: roomId })),
      agents: current.agents,
    };
    const now = new Date().toISOString();
    const legacyTask = {
      id: "t1",
      workspaceId: "projetox",
      teamId: "projetox-backend",
      prompt: "Criar endpoint",
      status: "done",
      result: "ok",
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(path.join(dir, "office.json"), JSON.stringify(legacyOffice));
    await rm(path.join(dir, "schema.json"));
    await writeFile(path.join(dir, "tasks.json"), JSON.stringify([legacyTask]));

    const store = await OfficeStore.open(dir);
    const state = store.snapshot();
    expect(state.rooms).toEqual(current.rooms);
    expect(state.teams).toEqual(current.teams);
    expect(state.agents).toEqual(current.agents);
    const { workspaceId, ...rest } = legacyTask;
    expect(state.tasks).toEqual([{ ...rest, roomId: workspaceId }]);

    // Já gravou no formato novo; abrir de novo não muda nada.
    const saved = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.workspaces).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(dir, "tasks", `${now.slice(0, 7)}.json`), "utf8"))[0].roomId).toBe("projetox");
    expect((await OfficeStore.open(dir)).snapshot()).toEqual(state);
  });

  it("migra o office.json v2 (portas configuráveis) para v3 sem mudar o que cada quarto lê do Cérebro", async () => {
    const { dir } = await openSeeded();
    const current = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    // v2: porta para o lobby aberta/fechada e conexões (simétricas) entre quartos.
    const legacyRooms = current.rooms.map(({ readsGlobalBrain, readsBrainsOf, ...room }: { id: string; readsGlobalBrain: boolean; readsBrainsOf: string[] }) => {
      void readsGlobalBrain;
      void readsBrainsOf;
      const connections = room.id === "projetox" ? ["projetoy"] : room.id === "projetoy" ? ["projetox"] : [];
      return { ...room, hasLobbyDoor: room.id === "projetox", connections };
    });
    await writeFile(path.join(dir, "office.json"), JSON.stringify({ ...current, version: 2, rooms: legacyRooms }));

    const state = (await OfficeStore.open(dir)).snapshot();
    const byId = Object.fromEntries(state.rooms.map((room) => [room.id, room]));
    expect(byId.projetox).toMatchObject({ readsGlobalBrain: true, readsBrainsOf: ["projetoy"] });
    expect(byId.projetoy).toMatchObject({ readsGlobalBrain: false, readsBrainsOf: ["projetox"] });
    expect(state.rooms.every((room) => !("hasLobbyDoor" in room) && !("connections" in room))).toBe(true);

    const saved = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.rooms.some((room: object) => "hasLobbyDoor" in room || "connections" in room)).toBe(false);
  });
});
