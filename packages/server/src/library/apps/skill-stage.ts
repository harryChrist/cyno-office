import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { SKILL_LIMITS, skillSizeLabel, type AppSkillSpec, type SkillCeiling } from "@cyno/shared";
import { isInside, resolveInside } from "./paths";

/** Padrão simples: `*` casa qualquer coisa dentro de UM nível de pasta; o resto é literal. */
export function matchesPattern(pattern: string, relative: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(relative);
}

/** Todos os arquivos comuns de uma pasta (caminhos relativos, com `/`). Links simbólicos são ignorados. */
async function walk(root: string, dir = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(root, relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/**
 * Monta a pasta da skill que o app entrega: copia só os arquivos permitidos (`include`) de `spec.from` para
 * `apps/<id>/.skills/<n>/`. As skills têm só um teto técnico alto contra acidente (`SKILL_LIMITS`), mas os repositórios
 * oficiais trazem muito mais (modelos, fontes, scripts), então a cópia leva só o que o agente lê. Tudo dentro
 * da pasta do app. Devolve a pasta montada.
 */
export async function stageSkill(appDir: string, spec: AppSkillSpec, index: number, ceiling: SkillCeiling = SKILL_LIMITS): Promise<string> {
  const source = resolveInside(appDir, spec.from);
  const target = path.join(appDir, ".skills", String(index));
  if (!isInside(target, [appDir])) throw new Error("pasta da skill fora do app");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const info = await lstat(path.join(source, "SKILL.md")).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`a skill ${spec.from} não tem SKILL.md`);
  const files = (await walk(source)).filter((relative) => spec.include.some((pattern) => matchesPattern(pattern, relative))).sort();
  if (files.length > ceiling.maxFiles) throw new Error(`a skill ${spec.from} passa do teto técnico de ${ceiling.maxFiles} arquivos depois do filtro (${files.length}); estreite o \`include\``);
  let bytes = 0;
  for (const relative of files) {
    const from = path.join(source, relative);
    bytes += (await lstat(from)).size;
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await copyFile(from, path.join(target, relative));
  }
  if (bytes > ceiling.maxBytes) throw new Error(`a skill ${spec.from} tem ${skillSizeLabel(bytes)} depois do filtro (teto técnico ${skillSizeLabel(ceiling.maxBytes)}); estreite o \`include\``);
  return target;
}
