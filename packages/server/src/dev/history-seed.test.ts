import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUsageLine, usageDir } from "../engines/usage/usage-history";
import { readRoutinesFile } from "../store/files";
import { OfficeStore } from "../store/office-store";
import { dataPaths, rootPaths } from "../store/paths";
import { computeMetrics } from "../workspace/metrics/compute";
import { seedDataDir } from "../workspace/office/seed";
import { labDataDirError, seedHistory, SEED_AGENTS } from "./history-seed";
import { LAB, offlineLabApi, setupLab } from "./lab";

const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function readUsage(workspaceDir: string) {
  const dir = usageDir(workspaceDir);
  const records = [];
  for (const name of await readdir(dir)) for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n")) if (line.trim()) records.push(parseUsageLine(line)!);
  return records;
}

describe("semente de histórico: a trava", () => {
  const dir = path.join(tmpdir(), "cyno-lab-abc");
  it("só aceita o DATA_DIR que o lab:up declarou, temporário e chamado cyno-…", () => {
    expect(labDataDirError(dir, { CYNO_LAB_DATA_DIR: dir })).toBeUndefined();
    expect(labDataDirError(undefined, {})).toMatch(/não definido/);
    expect(labDataDirError(dir, {})).toMatch(/não foi declarado/);
    expect(labDataDirError("/home/usuario/cyno/data", { CYNO_LAB_DATA_DIR: "/home/usuario/cyno/data" })).toMatch(/temporária/);
    expect(labDataDirError(path.join(tmpdir(), "meus-dados"), { CYNO_LAB_DATA_DIR: path.join(tmpdir(), "meus-dados") })).toMatch(/cyno-/);
    expect(labDataDirError(dir, { CYNO_LAB_DATA_DIR: path.join(tmpdir(), "cyno-outro") })).toMatch(/não foi declarado/);
  });

  it("recusa um DATA_DIR com senha (auth.json)", async () => {
    const real = await mkdtemp(path.join(tmpdir(), "cyno-lab-"));
    dirs.push(real);
    await writeFile(path.join(real, "auth.json"), "{}");
    expect(labDataDirError(real, { CYNO_LAB_DATA_DIR: real })).toMatch(/senha/);
  });
});

describe("semente de histórico: grava no layout real", () => {
  it("cria os agentes, grava tudo marcado como semente, as métricas saem do disco e rodar de novo troca a semente (sem duplicar)", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "cyno-lab-"));
    dirs.push(dataDir);
    await seedDataDir(dataDir);
    const lab = await offlineLabApi(dataDir);
    await setupLab(lab);
    await lab.close();

    const first = await seedHistory({ dataDir, days: 21, seed: 7, now: NOW });
    expect(first.tasks).toBeGreaterThan(50);

    const workspaceDir = rootPaths(dataDir).workspaceDir(LAB.id);
    const store = await OfficeStore.open(workspaceDir); // valida tarefas, Para você e projetos pelos schemas de verdade
    const office = store.snapshot();
    const names = office.agents.map((agent) => agent.name);
    for (const spec of SEED_AGENTS) expect(names.filter((name) => name === spec.name)).toHaveLength(1);
    expect(office.tasks.filter((task) => task.id.startsWith("seed-")).length).toBe(first.tasks);
    const projects = store.projectsSnapshot();
    expect(projects.filter((project) => project.id.startsWith("seed-"))).toHaveLength(5);
    expect(projects.find((project) => project.system === "avulsas")!.tasks.length).toBeGreaterThan(30);
    const routines = await readRoutinesFile(dataPaths(workspaceDir).routinesFile);
    expect(routines.routines.map((routine) => routine.id)).toContain("R-0900");
    expect(routines.routines.map((routine) => routine.id)).toEqual(expect.arrayContaining(["R-0901", "R-0902"]));
    expect(routines.entries.length).toBeGreaterThan(3);

    const usage = await readUsage(workspaceDir);
    expect(usage).toHaveLength(first.usage);
    expect(usage.every((record) => record.source === "seed")).toBe(true);
    const activityText = await readFile(path.join(workspaceDir, "activity", "2026-11-12.jsonl"), "utf8");
    expect(activityText.trim().split("\n").every((line) => JSON.parse(line).data.seed === true)).toBe(true);

    const agents = office.agents.map((agent) => ({ id: agent.id, name: agent.name }));
    const metrics = computeMetrics({ agents, tasks: office.tasks, projects, forYou: store.forYouSnapshot(), usage, routines: routines.routines, entries: routines.entries, quota: [], dispatch: { maxRunning: 3, perAgent: 1 } }, { now: NOW, from: NOW - 28 * 86_400_000, to: NOW });
    expect(metrics.throughput.value).toBeGreaterThan(20);
    const worst = [...metrics.rejectionRate.byAgent].filter((group) => group.n >= 8).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
    expect(worst?.label).toBe("Beto");

    // De novo: a semente anterior sai e a nova entra; nada duplica e os agentes não se repetem.
    const second = await seedHistory({ dataDir, days: 21, seed: 7, now: NOW });
    expect(second).toEqual(first);
    const again = await OfficeStore.open(workspaceDir);
    expect(again.snapshot().tasks.filter((task) => task.id.startsWith("seed-")).length).toBe(first.tasks);
    expect(again.forYouSnapshot().filter((item) => item.meta.seed === "1").length).toBe(first.forYou);
    expect(again.snapshot().agents.filter((agent) => agent.name === "Beto")).toHaveLength(1);
    expect((await readUsage(workspaceDir)).length).toBe(first.usage);
  }, 60_000);
});
