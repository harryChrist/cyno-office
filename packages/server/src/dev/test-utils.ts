import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

/** Cria uma pasta temporária apagada automaticamente após cada teste. */
export function useTempDirs(): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    // Gravações ainda na fila podem recriar arquivos durante a limpeza (ENOTEMPTY): o rm tenta de novo em vez de deixar a pasta para trás.
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })));
  });
  return async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyno-test-"));
    dirs.push(dir);
    return dir;
  };
}

async function readMonthDir<T>(dir: string): Promise<T[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d{4}-\d{2}\.json$/.test(name)).sort();
  const out: T[] = [];
  for (const name of names) out.push(...(JSON.parse(await readFile(path.join(dir, name), "utf8")) as T[]));
  return out;
}

/** Tarefas gravadas em disco (tasks/AAAA-MM.json) de uma pasta de workspace. */
export const readDiskTasks = <T = unknown>(workspaceDir: string) => readMonthDir<T>(path.join(workspaceDir, "tasks"));

/** Itens do "Para você" gravados em disco (for-you/AAAA-MM.json). */
export const readDiskForYou = <T = unknown>(workspaceDir: string) => readMonthDir<T>(path.join(workspaceDir, "for-you"));

/** Troca as tarefas do disco (um arquivo, mês único) para montar cenários de boot. */
export async function writeDiskTasks(workspaceDir: string, tasks: unknown[], month = "2026-01"): Promise<void> {
  await rm(path.join(workspaceDir, "tasks"), { recursive: true, force: true });
  await mkdir(path.join(workspaceDir, "tasks"), { recursive: true });
  await writeFile(path.join(workspaceDir, "tasks", `${month}.json`), JSON.stringify(tasks, null, 2));
}
