import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  agentSchema,
  calendarFileSchema,
  findOfficeRuleViolations,
  type CalendarEvent,
  forYouItemSchema,
  type ForYouItem,
  forYouTypesFileSchema,
  type ForYouTypeDef,
  projectSchema,
  mediaFileSchema,
  type MediaItem,
  type Project,
  routinesDataSchema,
  emptyRoutinesData,
  type RoutinesData,
  taskSchema,
  teamSchema,
  roomSchema,
  type OfficeState,
} from "@cyno/shared";
import { z } from "zod";
import { migrateOfficeData, migrateTasksData, normalizeTaskCompat } from "./migrations";
import type { DataPaths } from "./paths";

/**
 * v1: quartos em `workspaces` (veja migrations.ts); v2: `rooms`; v3: portas automáticas e o
 * Cérebro compartilhado em `readsGlobalBrain`/`readsBrainsOf` (no lugar de `hasLobbyDoor`/`connections`).
 */
export const OFFICE_FILE_VERSION = 3;

export const officeFileSchema = z.object({
  version: z.literal(OFFICE_FILE_VERSION),
  rooms: z.array(roomSchema),
  teams: z.array(teamSchema),
  agents: z.array(agentSchema),
});

export const tasksFileSchema = z.array(taskSchema);

export const forYouFileSchema = z.array(forYouItemSchema);

/** Parte do estado guardada em office.json (as tarefas vão em tasks/, os projetos em projects/). */
export type OfficeStructure = Pick<OfficeState, "rooms" | "teams" | "agents">;

export class DataFileError extends Error {
  constructor(file: string, problems: string[]) {
    super(`Arquivo de dados inválido (${file}):\n- ${problems.join("\n- ")}`);
    this.name = "DataFileError";
  }
}

async function readJson(file: string): Promise<unknown> {
  const raw = await readFile(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new DataFileError(file, ["JSON malformado"]);
  }
}

function zodProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`);
}

/** Lê office.json, migrando versões antigas. `migrated` = o arquivo no disco está num formato antigo. */
export async function readOfficeFile(file: string): Promise<{ office: OfficeStructure; migrated: boolean }> {
  const { data, changed } = migrateOfficeData(await readJson(file));
  const result = officeFileSchema.safeParse(data);
  if (!result.success) throw new DataFileError(file, zodProblems(result.error));
  const { rooms, teams, agents } = result.data;
  const office = { rooms, teams, agents };
  const violations = findOfficeRuleViolations(office);
  if (violations.length > 0) throw new DataFileError(file, violations);
  return { office, migrated: changed };
}

/** calendar.json ausente = nenhum evento no calendário ainda. */
export async function readCalendarFile(file: string): Promise<CalendarEvent[]> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result = calendarFileSchema.safeParse(raw);
  if (!result.success) throw new DataFileError(file, zodProblems(result.error));
  return result.data;
}

export function toOfficeFile(office: OfficeStructure) {
  return { version: OFFICE_FILE_VERSION, ...office };
}

/** Nome de um arquivo mensal: AAAA-MM.json. */
const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

/** Mês (AAAA-MM) de um instante ISO; datas ruins caem em 0000-00 (nada se perde). */
export function monthOf(iso: string): string {
  return /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "0000-00";
}

/** Arquivos AAAA-MM.json de uma pasta, em ordem; pasta ausente = nenhum. */
async function monthFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => MONTH_FILE.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readMonthly<T>(dir: string, schema: z.ZodType<T[], unknown>, prepare?: (raw: unknown) => unknown): Promise<T[]> {
  const out: T[] = [];
  for (const name of await monthFiles(dir)) {
    const file = path.join(dir, name);
    const raw = await readJson(file);
    const result = schema.safeParse(prepare && Array.isArray(raw) ? raw.map(prepare) : raw);
    if (!result.success) throw new DataFileError(file, zodProblems(result.error));
    out.push(...result.data);
  }
  return out;
}

/** tasks/AAAA-MM.json (pasta ausente = nenhuma tarefa). Aceita `projectId`/`plan` antigos (viram `projectId`/`work`). */
export function readTasksDir(dir: string): Promise<OfficeState["tasks"]> {
  return readMonthly(dir, tasksFileSchema, normalizeTaskCompat);
}

/** for-you/AAAA-MM.json (pasta ausente = nenhum item). */
export function readForYouDir(dir: string): Promise<ForYouItem[]> {
  return readMonthly(dir, forYouFileSchema);
}

/** projects/<id>.json (pasta ausente = nenhum projeto). */
export async function readProjectsDir(dir: string): Promise<Project[]> {
  let names: string[];
  try {
    // `*.legacy.json`: projetos dobrados no Avulsas pela migração para sprints (ficam como cópia, nunca carregados).
    names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".legacy.json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: Project[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const result = projectSchema.safeParse(await readJson(file));
    if (!result.success) throw new DataFileError(file, zodProblems(result.error));
    out.push(result.data);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Lê um JSON qualquer; ausente = undefined (para a migração). */
export async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return await readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** routines.json ausente = nenhuma rotina ainda. */
export async function readRoutinesFile(file: string): Promise<RoutinesData> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRoutinesData();
    throw error;
  }
  const result = routinesDataSchema.safeParse(raw);
  if (!result.success) throw new DataFileError(file, zodProblems(result.error));
  return result.data;
}

/** for-you-types.json ausente = null (o boot registra os tipos; veja migrateForYouTypes). */
export async function readForYouTypesFile(file: string): Promise<ForYouTypeDef[] | null> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const result = forYouTypesFileSchema.safeParse(raw);
  if (!result.success) throw new DataFileError(file, zodProblems(result.error));
  return result.data;
}

/** media/media.json ausente = biblioteca vazia. */
export async function readMediaFile(file: string): Promise<MediaItem[]> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result = mediaFileSchema.safeParse(raw);
  if (!result.success) throw new DataFileError(file, zodProblems(result.error));
  return result.data;
}

// ---------- Leitores de passagem (valem nos dois layouts; para quem só lê, sem migrar) ----------

async function hasDir(dir: string): Promise<boolean> {
  return readdir(dir).then(
    () => true,
    () => false,
  );
}

/** Tarefas no layout novo (tasks/) ou, se o workspace ainda não migrou, em tasks.json. */
export async function readTasksAnyLayout(paths: DataPaths): Promise<OfficeState["tasks"]> {
  if (await hasDir(paths.tasksDir)) return readTasksDir(paths.tasksDir);
  const raw = await readJsonIfExists(paths.legacy.tasks);
  if (raw === undefined) return [];
  const result = tasksFileSchema.safeParse((migrateTasksData(raw).data as unknown[]).map(normalizeTaskCompat));
  if (!result.success) throw new DataFileError(paths.legacy.tasks, zodProblems(result.error));
  return result.data;
}

/** Itens do "Para você" no layout novo (for-you/) ou em for-you.json. */
export async function readForYouAnyLayout(paths: DataPaths): Promise<ForYouItem[]> {
  if (await hasDir(paths.forYouDir)) return readForYouDir(paths.forYouDir);
  const raw = await readJsonIfExists(paths.legacy.forYou);
  if (raw === undefined) return [];
  const result = forYouFileSchema.safeParse(raw);
  if (!result.success) throw new DataFileError(paths.legacy.forYou, zodProblems(result.error));
  return result.data;
}

/** O que a Atividade precisa de cada plano/projeto, nos dois layouts (`requestId` == id do projeto). */
export type PlanSummary = { id: string; requestId: string; title: string; status: string; forYouId?: string; createdAt: string; approvedAt?: string; finishedAt?: string; taskCount: number };

export async function readPlanSummaries(paths: DataPaths): Promise<PlanSummary[]> {
  if (await hasDir(paths.projectsDir)) {
    return (await readProjectsDir(paths.projectsDir))
      .filter((project) => project.kind === "projeto")
      .map((project) => ({ id: project.id, requestId: project.id, title: project.title, status: project.status, ...(project.forYouId ? { forYouId: project.forYouId } : {}), createdAt: project.createdAt, ...(project.approvedAt ? { approvedAt: project.approvedAt } : {}), ...(project.finishedAt ? { finishedAt: project.finishedAt } : {}), taskCount: project.tasks.length }));
  }
  const raw = await readJsonIfExists(paths.legacy.plans);
  if (!Array.isArray(raw)) return [];
  return raw.map((plan: Record<string, any>) => ({ id: plan.id, requestId: plan.requestId, title: String(plan.title ?? ""), status: String(plan.status), ...(plan.forYouId ? { forYouId: plan.forYouId } : {}), createdAt: plan.createdAt, ...(plan.approvedAt ? { approvedAt: plan.approvedAt } : {}), ...(plan.finishedAt ? { finishedAt: plan.finishedAt } : {}), taskCount: Array.isArray(plan.tasks) ? plan.tasks.length : 0 })); // eslint-disable-line @typescript-eslint/no-explicit-any
}
