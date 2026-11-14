import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OfficeState, Workspace } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { seedDataDir } from "../workspace/office/seed";
import { call } from "../dev/test-api";
import { principalDir, useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";
import { migrateLegacyLayout } from "./legacy-layout";

const tempDir = useTempDirs();
const setupApp = useTestApp();

const AT = "2026-01-01T00:00:00.000Z";

/**
 * DATA_DIR no layout antigo: office.json v1 (quartos em `workspaces`, times com `workspaceId`),
 * tasks.json com `workspaceId` e brains/ na raiz. Usa o conteúdo do seed como base.
 */
async function legacyDataDir(): Promise<{ dataDir: string; office: Omit<OfficeState, "tasks"> }> {
  const seeded = await tempDir();
  await seedDataDir(seeded);
  const source = principalDir(seeded);
  const office = JSON.parse(await readFile(path.join(source, "office.json"), "utf8")) as Omit<OfficeState, "tasks">;

  const dataDir = await tempDir();
  const legacyOffice = {
    version: 1,
    workspaces: office.rooms,
    teams: office.teams.map(({ roomId, ...team }) => ({ ...team, workspaceId: roomId })),
    agents: office.agents,
  };
  await writeFile(path.join(dataDir, "office.json"), JSON.stringify(legacyOffice, null, 2));
  const task = {
    id: "t-antiga",
    workspaceId: "projetox",
    teamId: "projetox-frontend",
    agentId: "lia",
    prompt: "Tarefa de antes da migração",
    status: "done",
    result: "Feito",
    createdAt: AT,
    updatedAt: AT,
  };
  await writeFile(path.join(dataDir, "tasks.json"), JSON.stringify([task], null, 2));
  await cp(path.join(source, "brains"), path.join(dataDir, "brains"), { recursive: true });
  await mkdir(path.join(dataDir, "brains", "quarto-removido"));
  await writeFile(path.join(dataDir, "brains", "quarto-removido", "velha.md"), "# Nota de um quarto removido");
  return { dataDir, office };
}

async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

describe("migrateLegacyLayout", () => {
  it("move tudo para workspaces/principal/, cria o registro e não perde nada", async () => {
    const { dataDir, office } = await legacyDataDir();
    const brainsBefore = await listTree(path.join(dataDir, "brains"));

    expect(await migrateLegacyLayout(dataDir, { now: () => new Date(AT) })).toEqual({ migrated: true });

    expect((await readdir(dataDir)).sort()).toEqual(["workspaces", "workspaces.json"]);
    const list = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")) as Workspace[];
    expect(list).toEqual([{ id: "principal", name: "Principal", createdAt: AT }]);
    const dir = principalDir(dataDir);
    expect((await readdir(dir)).sort()).toEqual(["brains", "office.json", "tasks.json"]);
    expect(await listTree(path.join(dir, "brains"))).toEqual(brainsBefore);

    // O app abre o workspace migrado; office.json e tasks.json passam para o formato novo.
    const { app } = await setupApp({ dataDir });
    const migrated = await call<OfficeState>(app, "GET", "/api/w/principal/office");
    expect(migrated.rooms).toEqual(office.rooms);
    expect(migrated.teams).toEqual(office.teams);
    expect(migrated.agents).toEqual(office.agents);
    expect(migrated.tasks).toEqual([expect.objectContaining({ id: "t-antiga", roomId: "projetox", status: "done" })]);
    const saved = JSON.parse(await readFile(path.join(dir, "office.json"), "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.rooms).toBeDefined();
    expect(saved.workspaces).toBeUndefined();
  });

  it("é idempotente: rodar de novo (ou o seed) não muda nada", async () => {
    const { dataDir } = await legacyDataDir();
    await migrateLegacyLayout(dataDir);
    const before = await listTree(dataDir);
    const registry = await readFile(path.join(dataDir, "workspaces.json"), "utf8");

    expect(await migrateLegacyLayout(dataDir)).toEqual({ migrated: false });
    expect(await seedDataDir(dataDir)).toEqual({ created: false });
    expect(await listTree(dataDir)).toEqual(before);
    expect(await readFile(path.join(dataDir, "workspaces.json"), "utf8")).toBe(registry);
  });

  it("o seed sem --force migra o layout antigo em vez de semear por cima", async () => {
    const { dataDir } = await legacyDataDir();
    expect(await seedDataDir(dataDir)).toEqual({ created: false });
    const tasks = JSON.parse(await readFile(path.join(principalDir(dataDir), "tasks.json"), "utf8"));
    expect(tasks[0].id).toBe("t-antiga");
  });

  it("retoma uma migração interrompida no meio", async () => {
    const { dataDir } = await legacyDataDir();
    const dir = principalDir(dataDir);
    // Caiu depois de mover tasks.json e brains/, antes de office.json.
    await mkdir(dir, { recursive: true });
    await rename(path.join(dataDir, "tasks.json"), path.join(dir, "tasks.json"));
    await rename(path.join(dataDir, "brains"), path.join(dir, "brains"));
    expect(await migrateLegacyLayout(dataDir)).toEqual({ migrated: true });
    expect((await readdir(dir)).sort()).toEqual(["brains", "office.json", "tasks.json"]);

    // Caiu depois de mover tudo, antes de gravar workspaces.json.
    const second = await legacyDataDir();
    const secondDir = principalDir(second.dataDir);
    await mkdir(secondDir, { recursive: true });
    for (const entry of ["tasks.json", "brains", "office.json"]) {
      await rename(path.join(second.dataDir, entry), path.join(secondDir, entry));
    }
    expect(await migrateLegacyLayout(second.dataDir)).toEqual({ migrated: true });
    expect(JSON.parse(await readFile(path.join(second.dataDir, "workspaces.json"), "utf8"))[0].id).toBe("principal");
  });

  it("não sobrescreve: item nos dois lugares para com erro e não move nada", async () => {
    const { dataDir } = await legacyDataDir();
    const dir = principalDir(dataDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "tasks.json"), "[]");
    await expect(migrateLegacyLayout(dataDir)).rejects.toThrow(/tasks\.json existe/);
    expect((await readdir(dataDir)).sort()).toEqual(["brains", "office.json", "tasks.json", "workspaces"]);
    expect(await readFile(path.join(dir, "tasks.json"), "utf8")).toBe("[]");
  });

  it("pasta vazia ou já no layout novo: nada a fazer", async () => {
    const empty = await tempDir();
    expect(await migrateLegacyLayout(empty)).toEqual({ migrated: false });
    expect(await readdir(empty)).toEqual([]);
  });
});
