import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  AVULSAS_ID,
  AVULSAS_TITLE,
  effectivePriority,
  emptyAvulsas,
  isArchivable,
  projectSchema,
  pruneWorked,
  type Project,
  type ProjectTask,
  type ProjectTaskStatus,
} from "@cyno/shared";
import { writeJsonAtomic } from "./atomic-write";
import { monthOf, readJsonIfExists } from "./files";
import type { DataPaths } from "./paths";

/**
 * Migração para a árvore de tarefas e o projeto "Avulsas" (`schema.json` dataVersion 4). Roda no boot
 * do workspace, depois de `migrateToProjects`, e é idempotente:
 * 1. com `dataVersion >= 4`, sai;
 * 2. monta tudo em memória e valida; se algo falhar, NADA é gravado e o boot do workspace falha com a
 *    mensagem (os arquivos antigos ficam intactos);
 * 3. backup em `backup/pre-sprints-<ts>/` (projects/, tasks/, for-you/, routines.json e routines/; não
 *    sobrescreve um que já exista);
 * 4. grava o arquivo mensal do Avulsas, o Avulsas vivo, as tarefas, os itens do "Para você" e as
 *    rotinas já remapeados, o relatório, renomeia os projetos dobrados para `*.legacy.json` e grava
 *    `schema.json` POR ÚLTIMO. Se cair no meio, o marcador falta e o passo 2 roda de novo: lê os
 *    projetos de `<id>.json` ou de `<id>.legacy.json` e ignora o que a tentativa anterior deixou do
 *    Avulsas, então o resultado é sempre o mesmo.
 *
 * O que muda: cada projeto `kind: "tarefa"` (um pedido simples, inclusive o de rotina e o do Cyno) vira
 * uma FOLHA do Avulsas (`ref` novo `A<n>`, `meta` guarda o que era do projeto) e `Task.work`, os itens
 * do "Para você" e as execuções das rotinas passam a apontar para ela. NÃO são dobrados: pedido simples
 * em modo automático, com ritmo próprio, parte de projeto conjunto, pausado, ou sem nenhuma tarefa.
 * Os projetos `kind: "projeto"` ficam exatamente como estão (os campos novos são todos opcionais).
 */

export const SPRINTS_DATA_VERSION = 4;

export class SprintsMigrationError extends Error {
  constructor(problems: string[]) {
    super(`Migração para sprints abortada, nada foi gravado e os arquivos antigos estão intactos:\n- ${problems.join("\n- ")}`);
    this.name = "SprintsMigrationError";
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type SprintsMigrationOptions = {
  now?: () => Date;
  /** Gancho de teste: chamado depois de cada etapa de gravação (pode lançar para simular uma queda). */
  afterStep?: (step: string) => void;
};

export type SprintsMigrationReport = {
  migratedAt: string;
  dataVersion: number;
  counts: {
    projectsBefore: number;
    tasksBefore: number;
    projectsKept: number;
    projectsFolded: number;
    leaves: number;
    leavesLive: number;
    leavesArchived: number;
    runnerTasks: number;
    forYouItems: number;
    taskWorkRemapped: number;
    forYouRemapped: number;
    routineRunsRemapped: number;
  };
  /** Projetos `kind: "tarefa"` que ficaram como projeto (e por quê). */
  notFolded: { projectId: string; title: string; reason: string }[];
  /** Mapa antigo -> Avulsas (um por tarefa dobrada). */
  map: { from: { projectId: string; ref: string }; to: { projectId: string; ref: string; archived: boolean } }[];
  warnings: string[];
};

/** Por que um projeto `kind: "tarefa"` NÃO é dobrado (undefined = é dobrado). */
export function whyNotFolded(project: Project): string | undefined {
  if (project.system) return "projeto do sistema";
  if (project.kind !== "tarefa") return undefined;
  if (project.tasks.length === 0) return "sem tarefas (só o registro do pedido)";
  if (project.mode.kind === "automatico") return "modo automático próprio";
  if (project.pace) return "ritmo próprio";
  if (project.joint) return "parte de projeto conjunto";
  if (project.status === "pausado") return "pausado";
  return undefined;
}

export type FoldPlan = {
  avulsas: Project;
  /** Folhas finalizadas há mais de 14 dias, por mês (AAAA-MM). */
  archive: Map<string, ProjectTask[]>;
  /** Projeto antigo -> refs novos (por ref antigo) e a primeira folha. */
  folded: Map<string, { refs: Map<string, string>; first: string }>;
  /** Projetos que não mudam (todos os que não foram dobrados). */
  kept: Project[];
  notFolded: SprintsMigrationReport["notFolded"];
  map: SprintsMigrationReport["map"];
};

function leafStatus(project: Project, task: ProjectTask): ProjectTaskStatus {
  const finished = task.status === "concluida" || task.status === "cancelada";
  if (finished || task.status === "falhou") return task.status;
  if (project.status === "cancelado") return "cancelada";
  if (project.status === "concluido") return "concluida";
  return task.status;
}

/** Parte pura: os projetos antigos -> o Avulsas vivo, o arquivo mensal e o mapa antigo -> novo. */
export function planFold(projects: readonly Project[], now: Date): FoldPlan {
  const at = now.toISOString();
  const foldable = projects.filter((project) => project.kind === "tarefa" && whyNotFolded(project) === undefined);
  const ordered = [...foldable].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const notFolded = projects.filter((project) => project.kind === "tarefa" && whyNotFolded(project) !== undefined).map((project) => ({ projectId: project.id, title: project.title, reason: whyNotFolded(project)! }));
  const folded: FoldPlan["folded"] = new Map();
  const map: FoldPlan["map"] = [];
  const archive = new Map<string, ProjectTask[]>();
  const live: ProjectTask[] = [];
  const worked: Record<string, number> = {};
  let sequence = 0;
  for (const project of ordered) {
    const refs = new Map<string, string>();
    let first = "";
    for (const task of project.tasks) {
      sequence += 1;
      const ref = `A${sequence}`;
      refs.set(task.ref, ref);
      first ||= ref;
      const status = leafStatus(project, task);
      const terminal = status === "concluida" || status === "cancelada" || status === "falhou";
      const finishedAt = task.finishedAt ?? (terminal ? (project.finishedAt ?? project.updatedAt) : undefined);
      const doneWhen = task.doneWhen.length > 0 ? task.doneWhen : (project.doneWhen ?? []);
      const startAt = task.startAt ?? project.startAt;
      const dueAt = task.dueAt ?? project.dueAt;
      const { parent: _parent, group: _group, sprintId: _sprint, ...rest } = task;
      const leaf: ProjectTask = {
        ...rest,
        ref,
        title: project.title,
        priority: effectivePriority(project, task),
        doneWhen,
        status,
        ...(startAt ? { startAt } : {}),
        ...(dueAt ? { dueAt } : {}),
        ...(finishedAt ? { finishedAt } : {}),
        order: sequence * 1000,
        meta: {
          requestId: project.id,
          origin: project.origin,
          ...(project.routineRef ? { routineRef: project.routineRef } : {}),
          ...(project.brief ? { brief: project.brief } : {}),
          ...(project.joint ? { joint: project.joint } : {}),
          createdAt: project.createdAt,
        },
      };
      if ((status === "cancelada" || status === "concluida") && task.status !== status) {
        delete leaf.note;
        delete leaf.blocked;
        delete leaf.waitingSince;
      }
      if (status === "cancelada" && !leaf.failure && project.summary) leaf.failure = project.summary;
      const archived = isArchivable(leaf, now.getTime());
      if (archived) {
        const month = monthOf(leaf.finishedAt ?? leaf.updatedAt);
        archive.set(month, [...(archive.get(month) ?? []), leaf]);
      } else live.push(leaf);
      map.push({ from: { projectId: project.id, ref: task.ref }, to: { projectId: AVULSAS_ID, ref, archived } });
    }
    folded.set(project.id, { refs, first });
    for (const [day, ms] of Object.entries(project.worked)) worked[day] = (worked[day] ?? 0) + ms;
  }
  pruneWorked(worked, now.getTime());
  const avulsas: Project = {
    ...emptyAvulsas(ordered[0]?.createdAt ?? at),
    title: AVULSAS_TITLE,
    worked,
    nextRef: sequence + 1,
    tasks: live,
    updatedAt: at,
  };
  const kept = projects.filter((project) => !folded.has(project.id));
  return { avulsas, archive, folded, kept, notFolded, map };
}

/** `Task.work` de uma tarefa do runner (objeto cru) -> o Avulsas. true se mudou. */
export function remapWork(task: Json, fold: Pick<FoldPlan, "folded">): boolean {
  const work = task.work as { projectId?: string; ref?: string; step?: number } | undefined;
  if (!work || typeof work.projectId !== "string") return false;
  const ref = fold.folded.get(work.projectId)?.refs.get(String(work.ref));
  if (!ref) return false;
  task.work = { ...work, projectId: AVULSAS_ID, ref };
  return true;
}

/** Item do "Para você" (objeto cru) -> o Avulsas. `workOf`: o `work` (já remapeado) de cada tarefa do runner. true se mudou. */
export function remapForYouItem(item: Json, fold: Pick<FoldPlan, "folded">, workOf: ReadonlyMap<string, { projectId: string; ref: string }>): boolean {
  const work = typeof item.taskId === "string" ? workOf.get(item.taskId) : undefined;
  if (work?.projectId === AVULSAS_ID) {
    if (item.projectId === AVULSAS_ID && item.taskRef === work.ref) return false;
    item.projectId = AVULSAS_ID;
    item.taskRef = work.ref;
    return true;
  }
  const hit = typeof item.projectId === "string" ? fold.folded.get(item.projectId) : undefined;
  if (!hit) return false;
  item.projectId = AVULSAS_ID;
  item.taskRef = (typeof item.taskRef === "string" ? hit.refs.get(item.taskRef) : undefined) ?? hit.first;
  return true;
}

/** Troca, em qualquer lugar do JSON das rotinas, `projectId` de projeto dobrado por "avulsas". Devolve quantas trocas. */
export function remapRoutines(node: unknown, fold: Pick<FoldPlan, "folded">): number {
  let count = 0;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== "object" || value === null) return;
    const object = value as Json;
    if (typeof object.projectId === "string" && fold.folded.has(object.projectId)) {
      object.projectId = AVULSAS_ID;
      count += 1;
    }
    for (const child of Object.values(object)) walk(child);
  };
  walk(node);
  return count;
}

export type SprintsOutcome = { status: "already" | "migrated"; report?: SprintsMigrationReport };

const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

type MonthFile = { file: string; items: Json[]; changed: boolean };

async function readMonths(dir: string): Promise<MonthFile[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => MONTH_FILE.test(name)).sort();
  const out: MonthFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const raw = await readJsonIfExists(file);
    if (!Array.isArray(raw)) throw new SprintsMigrationError([`${name} não é uma lista`]);
    out.push({ file, items: raw as Json[], changed: false });
  }
  return out;
}

/** Projetos de origem: `<id>.json` e, onde só sobrou o `<id>.legacy.json` (queda no meio), esse. O Avulsas deixado por uma tentativa anterior é ignorado. */
async function readSourceProjects(dir: string): Promise<Project[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
  const live = new Set(names.filter((name) => !name.endsWith(".legacy.json")).map((name) => name.slice(0, -".json".length)));
  const out: Project[] = [];
  for (const name of names) {
    const legacy = name.endsWith(".legacy.json");
    const id = name.slice(0, -(legacy ? ".legacy.json" : ".json").length);
    if (id === AVULSAS_ID || (legacy && live.has(id))) continue;
    const raw = await readJsonIfExists(path.join(dir, name));
    const parsed = projectSchema.safeParse(raw);
    if (!parsed.success) throw new SprintsMigrationError([`Projeto ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`]);
    out.push(parsed.data);
  }
  return out;
}

/** Leva o workspace ao layout com o Avulsas (veja o comentário do arquivo). */
export async function migrateToSprints(paths: DataPaths, options: SprintsMigrationOptions = {}): Promise<SprintsOutcome> {
  const marker = (await readJsonIfExists(paths.schemaFile).catch(() => undefined)) as { dataVersion?: number } | undefined;
  if (marker && typeof marker.dataVersion === "number" && marker.dataVersion >= SPRINTS_DATA_VERSION) return { status: "already" };

  const now = (options.now ?? (() => new Date()))();
  const step = (name: string) => options.afterStep?.(name);
  const problems: string[] = [];
  const warnings: string[] = [];

  const projects = await readSourceProjects(paths.projectsDir);
  const fold = planFold(projects, now);
  const taskMonths = await readMonths(paths.tasksDir);
  const forYouMonths = await readMonths(paths.forYouDir);
  const routinesRaw = (await readJsonIfExists(paths.routinesFile)) as Json | undefined;

  // ---- tarefas do runner: Task.work -> Avulsas
  const tasksBefore = taskMonths.reduce((total, month) => total + month.items.length, 0);
  const taskIds = new Set<string>();
  let taskWorkRemapped = 0;
  const workOf = new Map<string, { projectId: string; ref: string }>();
  for (const month of taskMonths) {
    for (const task of month.items) {
      taskIds.add(String(task.id));
      if (remapWork(task, fold)) {
        month.changed = true;
        taskWorkRemapped += 1;
      }
      if (task.work && typeof task.work.projectId === "string") workOf.set(String(task.id), { projectId: task.work.projectId, ref: String(task.work.ref) });
    }
  }

  // ---- itens do Para você
  const forYouBefore = forYouMonths.reduce((total, month) => total + month.items.length, 0);
  const originalProjectOf = new Map<string, string | undefined>();
  let forYouRemapped = 0;
  for (const month of forYouMonths) {
    for (const item of month.items) {
      originalProjectOf.set(String(item.id), typeof item.projectId === "string" ? item.projectId : undefined);
      if (remapForYouItem(item, fold, workOf)) {
        month.changed = true;
        forYouRemapped += 1;
      }
    }
  }

  // ---- rotinas
  const routineRunsRemapped = routinesRaw ? remapRoutines(routinesRaw, fold) : 0;

  // ---- valida antes de gravar
  const liveRefs = new Set(fold.avulsas.tasks.map((task) => task.ref));
  const archivedRefs = new Set([...fold.archive.values()].flat().map((task) => task.ref));
  const resolves = (ref: string) => liveRefs.has(ref) || archivedRefs.has(ref);
  const oldTaskCount = projects.filter((project) => fold.folded.has(project.id)).reduce((total, project) => total + project.tasks.length, 0);
  if (liveRefs.size + archivedRefs.size !== oldTaskCount) problems.push(`Número de folhas (${liveRefs.size + archivedRefs.size}) difere do de tarefas antigas (${oldTaskCount})`);
  const allLeaves = [...fold.avulsas.tasks, ...[...fold.archive.values()].flat()];
  if (new Set(allLeaves.map((task) => task.ref)).size !== allLeaves.length) problems.push("Há refs repetidos no Avulsas");
  const keptById = new Map(fold.kept.map((project) => [project.id, project]));
  const afterIds = new Set(taskMonths.flatMap((month) => month.items.map((task) => String(task.id))));
  for (const id of taskIds) if (!afterIds.has(id)) problems.push(`A tarefa ${id} sumiria`);
  for (const month of taskMonths) {
    for (const task of month.items) {
      const work = task.work as { projectId?: string; ref?: string } | undefined;
      if (!work || typeof work.projectId !== "string") continue;
      if (work.projectId === AVULSAS_ID) {
        if (!resolves(String(work.ref))) problems.push(`A tarefa ${task.id} aponta para ${AVULSAS_ID}/${work.ref}, que não existe`);
      } else if (fold.folded.has(work.projectId)) problems.push(`A tarefa ${task.id} continuou apontando para o projeto dobrado ${work.projectId}/${work.ref}`);
      else {
        const project = keptById.get(work.projectId);
        if (!project) warnings.push(`Tarefa ${task.id}: o projeto ${work.projectId} já não existia antes da migração`);
        else if (!project.tasks.some((candidate) => candidate.ref === work.ref)) warnings.push(`Tarefa ${task.id}: a tarefa ${work.projectId}/${work.ref} já não existia antes da migração`);
      }
    }
  }
  const existedBefore = new Set(projects.map((project) => project.id));
  for (const month of forYouMonths) {
    for (const item of month.items) {
      const was = originalProjectOf.get(String(item.id));
      if (item.projectId === AVULSAS_ID) {
        if (typeof item.taskRef !== "string" || !resolves(item.taskRef)) problems.push(`O item ${item.id} aponta para ${AVULSAS_ID}/${item.taskRef ?? "?"}, que não existe`);
      } else if (typeof item.projectId === "string" && was !== undefined && existedBefore.has(was) && !keptById.has(item.projectId)) {
        problems.push(`O item ${item.id} perdeu o projeto ${was}`);
      } else if (typeof item.projectId === "string" && !existedBefore.has(item.projectId)) warnings.push(`Item ${item.id}: o projeto ${item.projectId} já não existia antes da migração`);
    }
  }
  if (forYouMonths.reduce((total, month) => total + month.items.length, 0) !== forYouBefore) problems.push("O número de itens do Para você mudou");
  if (routinesRaw) {
    const stale: string[] = [];
    const scan = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(scan);
      if (typeof value !== "object" || value === null) return;
      const object = value as Json;
      if (typeof object.projectId === "string" && object.projectId !== AVULSAS_ID && fold.folded.has(object.projectId)) stale.push(object.projectId);
      Object.values(object).forEach(scan);
    };
    scan(routinesRaw);
    if (stale.length > 0) problems.push(`Rotinas ainda apontam para projetos dobrados: ${stale.join(", ")}`);
  }
  const parsedAvulsas = projectSchema.safeParse(fold.avulsas);
  if (!parsedAvulsas.success) problems.push(`Avulsas inválido: ${parsedAvulsas.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (problems.length > 0) throw new SprintsMigrationError(problems);

  const report: SprintsMigrationReport = {
    migratedAt: now.toISOString(),
    dataVersion: SPRINTS_DATA_VERSION,
    counts: {
      projectsBefore: projects.length,
      tasksBefore,
      projectsKept: fold.kept.length,
      projectsFolded: fold.folded.size,
      leaves: allLeaves.length,
      leavesLive: fold.avulsas.tasks.length,
      leavesArchived: archivedRefs.size,
      runnerTasks: tasksBefore,
      forYouItems: forYouBefore,
      taskWorkRemapped,
      forYouRemapped,
      routineRunsRemapped,
    },
    notFolded: fold.notFolded,
    map: fold.map,
    warnings,
  };

  // ---- backup (não sobrescreve um que já exista)
  const existing = await readdir(paths.backupRoot).catch(() => [] as string[]);
  if (!existing.some((name) => name.startsWith("pre-sprints-"))) {
    const dir = path.join(paths.backupRoot, `pre-sprints-${now.toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(dir, { recursive: true });
    for (const [source, name] of [
      [paths.projectsDir, "projects"],
      [paths.tasksDir, "tasks"],
      [paths.forYouDir, "for-you"],
      [paths.routinesFile, "routines.json"],
      [path.join(paths.root, "routines"), "routines"],
      [paths.schemaFile, "schema.json"],
    ] as const) {
      if (await exists(source)) await cp(source, path.join(dir, name), { recursive: true });
    }
  }
  step("backup");

  // ---- grava (idempotente: refazer depois de uma queda dá o mesmo resultado)
  await mkdir(paths.projectsDir, { recursive: true });
  await rm(paths.projectsArchiveDir, { recursive: true, force: true });
  if (fold.archive.size > 0) await mkdir(paths.projectsArchiveDir, { recursive: true });
  for (const [month, leaves] of fold.archive) await writeJsonAtomic(path.join(paths.projectsArchiveDir, `${month}.json`), leaves);
  step("archive");
  await writeJsonAtomic(path.join(paths.projectsDir, `${AVULSAS_ID}.json`), fold.avulsas);
  step("avulsas");
  for (const month of taskMonths) if (month.changed) await writeJsonAtomic(month.file, month.items);
  step("tasks");
  for (const month of forYouMonths) if (month.changed) await writeJsonAtomic(month.file, month.items);
  step("for-you");
  if (routinesRaw && routineRunsRemapped > 0) await writeJsonAtomic(paths.routinesFile, routinesRaw);
  step("routines");
  await writeJsonAtomic(paths.sprintsReportFile, report);
  step("report");
  for (const id of fold.folded.keys()) {
    const file = path.join(paths.projectsDir, `${id}.json`);
    if (await exists(file)) await rename(file, path.join(paths.projectsDir, `${id}.legacy.json`));
  }
  step("legacy");
  await writeJsonAtomic(paths.schemaFile, { dataVersion: SPRINTS_DATA_VERSION, migratedAt: now.toISOString() });
  return { status: "migrated", report };
}
