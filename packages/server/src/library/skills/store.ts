import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SKILL_LIMITS } from "@cyno/shared";
import { z } from "zod";
import { DataFileError } from "../../store/files";
import type { SkillFile } from "./validate";

const isoSchema = z.string();
const grantsSchema = z.record(z.string(), z.object({ agentIds: z.array(z.string()), grantedAt: isoSchema })).default({});

/** Skill como fica em `skills.json` (sem "quem usa": isso se calcula das liberações). */
export const storedSkillSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(1024),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual") }),
    z.object({ kind: z.literal("upload"), at: isoSchema }),
    z.object({ kind: z.literal("folder"), from: z.string(), copiedAt: isoSchema }),
    z.object({ kind: z.literal("app"), appId: z.string(), path: z.string() }),
    z.object({ kind: z.literal("url"), url: z.string(), sha256: z.string(), fetchedAt: isoSchema }),
  ]),
  requires: z.array(z.string()).default([]),
  files: z.number().int().default(1),
  bytes: z.number().int().default(0),
  weightTokens: z.number().int().default(0),
  readonly: z.boolean().default(false),
  usage: z.object({ reads: z.number().int().default(0), lastAt: isoSchema.optional() }).default({ reads: 0 }),
  grants: grantsSchema,
  version: z.number().int().min(1).default(1),
  previousVersion: z.number().int().optional(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
  warnings: z.array(z.string()).default([]),
});
export type StoredSkill = z.output<typeof storedSkillSchema>;

export const SKILLS_FILE_VERSION = 1;
const skillsFileSchema = z.object({ version: z.literal(SKILLS_FILE_VERSION), skills: z.array(storedSkillSchema) });

/** Onde as skills moram: `skills.json`, `skills/<id>/` (a atual) e `skill-versions/<id>/` (a anterior). */
export type SkillPaths = { file: string; dir: (id: string) => string; previousDir: (id: string) => string; root: string; versionsRoot: string };

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function librarySkillPaths(libraryRoot: string): SkillPaths {
  const root = path.join(libraryRoot, "skills");
  const versionsRoot = path.join(libraryRoot, "skill-versions");
  const check = (id: string) => {
    if (!ID.test(id)) throw new Error(`id de skill inválido: "${id}"`);
    return id;
  };
  return { file: path.join(libraryRoot, "skills.json"), root, versionsRoot, dir: (id) => path.join(root, check(id)), previousDir: (id) => path.join(versionsRoot, check(id)) };
}

export async function readSkillsFile(file: string): Promise<StoredSkill[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DataFileError(file, ["JSON malformado"]);
  }
  const parsed = skillsFileSchema.safeParse(json);
  if (!parsed.success) throw new DataFileError(file, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`));
  return parsed.data.skills;
}

export const toSkillsFile = (skills: StoredSkill[]) => ({ version: SKILLS_FILE_VERSION, skills });

/** Grava os arquivos numa pasta nova (sem permissão de execução) e devolve o caminho. */
export async function writeSkillFiles(dir: string, files: readonly SkillFile[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const target = path.join(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, file.data, { mode: 0o644 });
    await chmod(target, 0o644);
  }
}

/** Lê a pasta de uma skill guardada (só arquivos comuns; qualquer link ou item estranho é ignorado). */
export async function readSkillFiles(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > SKILL_LIMITS.maxDepth) return;
    const entries = await readdir(path.join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, rel);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(rel, depth + 1);
      else if (info.isFile()) out.push({ path: rel, data: await readFile(full) });
    }
  };
  await walk("", 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Troca a pasta atual da skill pela nova de forma atômica; a antiga (se houver) vai para `previous`. */
export async function swapSkillDir(paths: SkillPaths, id: string, files: readonly SkillFile[], keepPrevious: boolean): Promise<void> {
  const current = paths.dir(id);
  const staging = path.join(paths.root, `.tmp-${id}-${randomUUID()}`);
  await mkdir(paths.root, { recursive: true });
  try {
    await writeSkillFiles(staging, files);
    let hadCurrent = true;
    try {
      await lstat(current);
    } catch {
      hadCurrent = false;
    }
    if (hadCurrent) {
      if (keepPrevious) {
        await mkdir(paths.versionsRoot, { recursive: true });
        await rm(paths.previousDir(id), { recursive: true, force: true });
        await rename(current, paths.previousDir(id));
      } else await rm(current, { recursive: true, force: true });
    }
    await rename(staging, current);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

