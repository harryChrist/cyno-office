import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { libraryAppSchema, type InstallJob, type LibraryApp } from "@cyno/shared";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";
import { DataFileError } from "../../store/files";
import type { WriteQueue } from "../../store/write-queue";
import type { AppsPaths } from "./paths";

const APPS_FILE_VERSION = 1;
const appsFileSchema = z.object({ version: z.literal(APPS_FILE_VERSION), apps: z.array(libraryAppSchema) });

/** apps.json ausente = nenhum app instalado. */
export async function readAppsFile(file: string): Promise<LibraryApp[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DataFileError(file, ["JSON malformado"]);
  }
  const result = appsFileSchema.safeParse(data);
  if (!result.success) throw new DataFileError(file, result.error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`));
  return result.data.apps;
}

/** Guarda os apps (apps.json) e os jobs (`jobs/J-0001.json` + `.log`), tudo dentro de `data/platform/library/`. */
export class AppsStore {
  private apps: LibraryApp[];
  private jobSeq = 0;
  private readonly jobs = new Map<string, InstallJob>();

  constructor(
    apps: LibraryApp[],
    private readonly paths: AppsPaths,
    private readonly queue: WriteQueue,
  ) {
    this.apps = structuredClone(apps);
  }

  static async open(paths: AppsPaths, queue: WriteQueue): Promise<AppsStore> {
    const store = new AppsStore(await readAppsFile(paths.appsFile), paths, queue);
    await store.loadJobs();
    return store;
  }

  private async loadJobs(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.jobsDir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^J-(\d+)\.json$/.exec(name);
      if (!match) continue;
      this.jobSeq = Math.max(this.jobSeq, Number(match[1]));
      try {
        this.jobs.set(`J-${match[1]}`, JSON.parse(await readFile(path.join(this.paths.jobsDir, name), "utf8")) as InstallJob);
      } catch {
        // job ilegível: só o log fica
      }
    }
  }

  list(): LibraryApp[] {
    return structuredClone(this.apps);
  }

  get(id: string): LibraryApp | undefined {
    const found = this.apps.find((app) => app.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async put(app: LibraryApp): Promise<LibraryApp> {
    const index = this.apps.findIndex((candidate) => candidate.id === app.id);
    const copy = structuredClone(app);
    if (index === -1) this.apps.push(copy);
    else this.apps[index] = copy;
    await this.save();
    return structuredClone(copy);
  }

  async remove(id: string): Promise<void> {
    this.apps = this.apps.filter((app) => app.id !== id);
    await this.save();
  }

  save(): Promise<void> {
    const snapshot = structuredClone(this.apps);
    return this.queue.enqueue(async () => {
      await mkdir(this.paths.libraryDir, { recursive: true });
      await writeJsonAtomic(this.paths.appsFile, { version: APPS_FILE_VERSION, apps: snapshot });
    });
  }

  // ---------- Jobs ----------

  nextJobId(): string {
    this.jobSeq += 1;
    return `J-${String(this.jobSeq).padStart(4, "0")}`;
  }

  job(id: string): InstallJob | undefined {
    const found = this.jobs.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async putJob(job: InstallJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
    const snapshot = structuredClone(job);
    await this.queue.enqueue(async () => {
      await mkdir(this.paths.jobsDir, { recursive: true });
      await writeJsonAtomic(path.join(this.paths.jobsDir, `${job.id}.json`), snapshot);
    });
  }

  async appendLog(jobId: string, line: string): Promise<void> {
    await mkdir(this.paths.jobsDir, { recursive: true });
    await appendFile(path.join(this.paths.jobsDir, `${jobId}.log`), `${line}\n`);
  }

  /** O log do job (as últimas `maxBytes`). */
  async readLog(jobId: string, maxBytes = 200_000): Promise<string> {
    const file = path.join(this.paths.jobsDir, `${jobId}.log`);
    try {
      const size = (await stat(file)).size;
      const text = await readFile(file, "utf8");
      return size > maxBytes ? text.slice(-maxBytes) : text;
    } catch {
      return "";
    }
  }

  async clearLog(jobId: string): Promise<void> {
    await writeFile(path.join(this.paths.jobsDir, `${jobId}.log`), "").catch(() => undefined);
  }
}
