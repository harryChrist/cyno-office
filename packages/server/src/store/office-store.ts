import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { findOfficeRuleViolations, type ForYouItem, type OfficeState, type Project, type Task } from "@cyno/shared";
import { writeJsonAtomic } from "./atomic-write";
import { monthOf, readForYouDir, readOfficeFile, readProjectsDir, readTasksDir, toOfficeFile, type OfficeStructure } from "./files";
import { migrateToProjects } from "./migrate-projects";
import { migrateToSprints } from "./migrate-sprints";
import { dataPaths, type DataPaths } from "./paths";
import { WriteQueue } from "./write-queue";

/** Grava um JSON criando a pasta se faltar (tasks/, for-you/ e projects/ nascem no primeiro uso). */
async function writeInDir(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, data);
}

/**
 * Registros em arquivos mensais (tarefas e itens do "Para você"): guarda o que foi gravado de cada
 * id (JSON e mês) e, a cada troca de lista, regrava só os arquivos dos meses que mudaram.
 */
class MonthlyFiles<T extends { id: string; createdAt: string }> {
  private written = new Map<string, { json: string; month: string }>();

  constructor(
    private readonly dir: string,
    initial: readonly T[],
  ) {
    for (const item of initial) this.written.set(item.id, { json: JSON.stringify(item), month: monthOf(item.createdAt) });
  }

  /** Plano de gravação para a lista nova: meses que mudaram, com o conteúdo inteiro de cada um. */
  plan(next: readonly T[]): { months: Map<string, T[]>; commit: () => void; rollback: () => void } {
    const nextMap = new Map<string, { json: string; month: string }>();
    const touched = new Set<string>();
    for (const item of next) {
      const entry = { json: JSON.stringify(item), month: monthOf(item.createdAt) };
      nextMap.set(item.id, entry);
      const before = this.written.get(item.id);
      if (!before) touched.add(entry.month);
      else if (before.json !== entry.json || before.month !== entry.month) {
        touched.add(entry.month);
        touched.add(before.month);
      }
    }
    for (const [id, before] of this.written) if (!nextMap.has(id)) touched.add(before.month);
    const months = new Map<string, T[]>();
    for (const month of touched) months.set(month, []);
    for (const item of next) {
      const month = nextMap.get(item.id)!.month;
      months.get(month)?.push(item);
    }
    const previous = this.written;
    return {
      months,
      commit: () => {
        this.written = nextMap;
      },
      // Gravação falhou: volta a achar que o disco tem o que tinha antes (a próxima troca regrava o que faltar;
      // regravar a mais é inofensivo).
      rollback: () => {
        this.written = previous;
      },
    };
  }

  file(month: string): string {
    return path.join(this.dir, `${month}.json`);
  }
}

/**
 * Estado do escritório em memória, persistido em office.json, tasks/AAAA-MM.json,
 * for-you/AAAA-MM.json e projects/<id>.json (layout `schema.json` dataVersion 4). Toda escrita é
 * atômica e passa por uma fila serializada; só se regrava o que mudou.
 */
export class OfficeStore {
  /** Fila de escrita do workspace (o calendário grava por ela também; veja CalendarService). */
  readonly queue = new WriteQueue();
  private readonly taskFiles: MonthlyFiles<Task>;
  private readonly forYouFiles: MonthlyFiles<ForYouItem>;
  /** JSON de cada projeto já gravado. */
  private readonly projectJson = new Map<string, string>();

  private constructor(
    readonly paths: DataPaths,
    private office: OfficeStructure,
    private tasks: Task[],
    private forYou: ForYouItem[],
    private projects: Project[],
  ) {
    this.taskFiles = new MonthlyFiles(paths.tasksDir, tasks);
    this.forYouFiles = new MonthlyFiles(paths.forYouDir, forYou);
    for (const project of projects) this.projectJson.set(project.id, JSON.stringify(project));
  }

  /**
   * Abre a pasta de dados (precisa já ter office.json; veja seedDataDir). Antes de ler, leva o
   * workspace ao layout de projetos (idempotente; se não puder, falha com mensagem clara e os
   * arquivos antigos ficam intactos).
   */
  static async open(dataDir: string, options: { groupRequests?: boolean } = {}): Promise<OfficeStore> {
    const paths = dataPaths(dataDir);
    const { office, migrated: officeMigrated } = await readOfficeFile(paths.officeFile);
    await migrateToProjects(paths, { group: options.groupRequests ?? process.env.CYNO_MIGRATE_NO_GROUP !== "1", workspaceId: path.basename(dataDir) });
    await migrateToSprints(paths);
    const tasks = await readTasksDir(paths.tasksDir);
    const forYou = await readForYouDir(paths.forYouDir);
    const projects = await readProjectsDir(paths.projectsDir);
    const store = new OfficeStore(paths, office, tasks, forYou, projects);
    // Arquivo num formato antigo: grava já no formato atual (o conteúdo é o mesmo).
    if (officeMigrated) await store.commitOffice(office);
    return store;
  }

  /** Cópia do estado atual (alterar o retorno não afeta o store). */
  snapshot(): OfficeState {
    return structuredClone({ ...this.office, tasks: this.tasks });
  }

  /** Troca rooms/times/agentes e grava office.json. Rejeita estados que quebram as regras. */
  commitOffice(next: OfficeStructure): Promise<void> {
    const violations = findOfficeRuleViolations(next);
    if (violations.length > 0) {
      return Promise.reject(new Error(`Estado inválido: ${violations.join("; ")}`));
    }
    this.office = structuredClone(next);
    const data = toOfficeFile(this.office);
    return this.queue.enqueue(() => writeJsonAtomic(this.paths.officeFile, data));
  }

  /** Troca a lista de tarefas e regrava só os meses de tasks/ que mudaram. */
  commitTasks(next: Task[]): Promise<void> {
    this.tasks = structuredClone(next);
    return this.writeMonthly(this.taskFiles, this.tasks);
  }

  /** Cópia dos itens do "Para você" (fora do OfficeState: não vão no office:snapshot). */
  forYouSnapshot(): ForYouItem[] {
    return structuredClone(this.forYou);
  }

  /** Troca os itens do "Para você" e regrava só os meses de for-you/ que mudaram. */
  commitForYou(next: ForYouItem[]): Promise<void> {
    this.forYou = structuredClone(next);
    return this.writeMonthly(this.forYouFiles, this.forYou);
  }

  private writeMonthly<T extends { id: string; createdAt: string }>(files: MonthlyFiles<T>, list: T[]): Promise<void> {
    const plan = files.plan(list);
    plan.commit();
    if (plan.months.size === 0) return Promise.resolve();
    const writes = [...plan.months].map(([month, items]) => this.queue.enqueue(() => (items.length === 0 ? rm(files.file(month), { force: true }) : writeInDir(files.file(month), items))));
    return Promise.all(writes).then(
      () => undefined,
      (error: unknown) => {
        plan.rollback();
        throw error;
      },
    );
  }

  /** Cópia dos projetos. */
  projectsSnapshot(): Project[] {
    return structuredClone(this.projects);
  }

  /** Grava (cria ou troca) os projetos que mudaram: um arquivo por projeto, só dos que mudaram de fato. */
  commitProjects(changed: Project[], deletedIds: string[] = []): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const project of changed) {
      const copy = structuredClone(project);
      const json = JSON.stringify(copy);
      const index = this.projects.findIndex((candidate) => candidate.id === copy.id);
      if (index >= 0) this.projects[index] = copy;
      else this.projects.push(copy);
      if (this.projectJson.get(copy.id) === json) continue;
      this.projectJson.set(copy.id, json);
      const file = path.join(this.paths.projectsDir, `${copy.id}.json`);
      writes.push(
        this.queue.enqueue(() => writeInDir(file, copy)).catch((error: unknown) => {
          this.projectJson.delete(copy.id);
          throw error;
        }),
      );
    }
    for (const id of deletedIds) {
      this.projects = this.projects.filter((candidate) => candidate.id !== id);
      this.projectJson.delete(id);
      writes.push(this.queue.enqueue(() => rm(path.join(this.paths.projectsDir, `${id}.json`), { force: true })));
    }
    return Promise.all(writes).then(() => undefined);
  }

  /** Espera todas as escritas pendentes. */
  flush(): Promise<void> {
    return this.queue.idle();
  }
}
