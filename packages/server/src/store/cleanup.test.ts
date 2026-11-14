import { access, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { DataCleanup } from "./cleanup";
import { dataPaths } from "./paths";
import { WriteQueue } from "./write-queue";

const tempDir = useTempDirs();

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

async function touch(file: string, content = "x\n"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Workspace temporário (`<tmp>/ws`) com uma pasta "de fora" ao lado (`<tmp>/fora`). */
async function setup() {
  const base = await tempDir();
  const root = path.join(base, "ws");
  const outside = path.join(base, "fora");
  await touch(path.join(outside, "importante.md"));
  const paths = dataPaths(root);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const stopTerminal = vi.fn(async () => undefined);
  const forgetLogs = vi.fn();
  const cleanup = new DataCleanup({ paths, queue: new WriteQueue(), log, stopTerminal, forgetLogs });
  return { root, outside, paths, log, stopTerminal, forgetLogs, cleanup };
}

describe("DataCleanup.removeOrphans", () => {
  it("apaga só Cérebros, pastas de agentes e logs sem dono; registra cada um no log", async () => {
    const { root, paths, log, cleanup } = await setup();
    for (const brain of ["global", "vivo", "b", "c"]) await touch(path.join(paths.brainDir(brain), "nota.md"));
    await mkdir(path.join(paths.brainsDir, "Nome Estranho"), { recursive: true });
    await touch(path.join(paths.agentDir("lia"), "session.json"));
    await touch(path.join(paths.agentDir("fantasma"), "session.json"));
    await touch(paths.taskLogFile("t-viva"));
    await touch(paths.taskLogFile("t-morta"));
    await touch(path.join(paths.logsDir, "leia-me.txt"));
    await touch(path.join(root, "office.json"), "{}");

    const removed = await cleanup.removeOrphans({ roomIds: ["vivo"], agentIds: ["lia"], taskIds: ["t-viva"] });

    expect(removed.sort()).toEqual([paths.agentDir("fantasma"), paths.brainDir("b"), paths.brainDir("c"), paths.taskLogFile("t-morta")].sort());
    expect((await readdir(paths.brainsDir)).sort()).toEqual(["Nome Estranho", "global", "vivo"]);
    expect(await readdir(paths.agentsDir)).toEqual(["lia"]);
    expect((await readdir(paths.logsDir)).sort()).toEqual(["leia-me.txt", "t-viva.jsonl"]);
    expect(await exists(path.join(root, "office.json"))).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(4);
  });

  it("nunca segue links simbólicos: nem um Cérebro que é link, nem uma pasta-mãe que aponta para fora", async () => {
    const { root, outside, paths, log, cleanup } = await setup();
    await mkdir(paths.brainsDir, { recursive: true });
    await symlink(outside, path.join(paths.brainsDir, "link"));
    // agents/ inteira é um link para fora do workspace (onde há uma pasta "fantasma").
    await touch(path.join(outside, "fantasma", "session.json"));
    await symlink(outside, paths.agentsDir);

    const removed = await cleanup.removeOrphans({ roomIds: [], agentIds: [], taskIds: [] });

    expect(removed).toEqual([]);
    expect(await exists(path.join(outside, "importante.md"))).toBe(true);
    expect(await exists(path.join(paths.brainsDir, "link"))).toBe(true);
    expect(await exists(path.join(outside, "fantasma", "session.json"))).toBe(true);
    expect(log.warn).toHaveBeenCalled();
    expect(await readdir(root)).toEqual(expect.arrayContaining(["agents", "brains"]));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("workspace sem as pastas: nada a fazer, sem erro", async () => {
    const { cleanup, log } = await setup();
    expect(await cleanup.removeOrphans({ roomIds: [], agentIds: [], taskIds: [] })).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("DataCleanup.removeLeftovers", () => {
  it("para os terminais antes, esquece os logs em memória e apaga logs, pastas e Cérebro (o que já não existe não é erro)", async () => {
    const { paths, stopTerminal, forgetLogs, cleanup, log } = await setup();
    await touch(paths.taskLogFile("t1"));
    await touch(path.join(paths.agentDir("ana"), "mcp.json"));
    await touch(path.join(paths.brainDir("sala"), "nota.md"));
    await touch(path.join(paths.brainDir("global"), "nota.md"));

    await cleanup.removeLeftovers({ taskIds: ["t1", "t-sem-log"], agentIds: ["ana", "sem-pasta"], brainId: "sala" });

    expect(stopTerminal.mock.calls).toEqual([["ana"], ["sem-pasta"]]);
    expect(forgetLogs).toHaveBeenCalledWith(["t1", "t-sem-log"], ["ana", "sem-pasta"]);
    expect(await exists(paths.taskLogFile("t1"))).toBe(false);
    expect(await exists(paths.agentDir("ana"))).toBe(false);
    expect(await exists(paths.brainDir("sala"))).toBe(false);
    expect(await exists(paths.brainDir("global"))).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("nunca apaga o Cérebro global nem ids fora do padrão (../)", async () => {
    const { outside, paths, cleanup } = await setup();
    await touch(path.join(paths.brainDir("global"), "nota.md"));
    await cleanup.removeLeftovers({ brainId: "global", agentIds: ["../fora"], taskIds: ["../../fora/importante"] });
    expect(await exists(path.join(paths.brainDir("global"), "nota.md"))).toBe(true);
    expect(await exists(path.join(outside, "importante.md"))).toBe(true);
  });

  it("Cérebro que é link simbólico: sai só o link, o destino fica", async () => {
    const { outside, paths, cleanup } = await setup();
    await mkdir(paths.brainsDir, { recursive: true });
    await symlink(outside, paths.brainDir("sala"));
    await cleanup.removeLeftovers({ brainId: "sala" });
    expect(await exists(paths.brainDir("sala"))).toBe(false);
    expect(await exists(path.join(outside, "importante.md"))).toBe(true);
  });

  it("pasta brains/ que aponta para fora do workspace: recusa", async () => {
    const { root, outside, paths, cleanup, log } = await setup();
    await mkdir(root, { recursive: true });
    await symlink(outside, paths.brainsDir);
    await touch(path.join(outside, "sala", "nota.md"));
    await cleanup.removeLeftovers({ brainId: "sala" });
    expect(await exists(path.join(outside, "sala", "nota.md"))).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("DataCleanup: contagens da prévia", () => {
  it("conta notas .md do Cérebro e logs existentes das tarefas", async () => {
    const { paths, cleanup } = await setup();
    await touch(path.join(paths.brainDir("sala"), "a.md"));
    await touch(path.join(paths.brainDir("sala"), "b.md"));
    await touch(path.join(paths.brainDir("sala"), "imagem.png"));
    await touch(paths.taskLogFile("t1"));
    expect(await cleanup.countBrainNotes("sala")).toBe(2);
    expect(await cleanup.countBrainNotes("vazio")).toBe(0);
    expect(await cleanup.countTaskLogs(["t1", "t2"])).toBe(1);
    expect(await cleanup.countTaskLogs([])).toBe(0);
  });
});
