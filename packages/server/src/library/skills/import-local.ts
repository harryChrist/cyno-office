import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSkillMarkdown, skillSizeLabel, SKILL_LIMITS, type SkillCeiling, type SkillImportCandidate } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { looksExecutable, type SkillFile } from "./validate";

/**
 * Importar skills do computador do dono: as de `~/.claude/skills` e as dos plugins instalados são
 * oferecidas como CANDIDATAS (só nome e descrição, lidos do frontmatter) e, quando ele marca, a
 * pasta é COPIADA para a Biblioteca. Nada aqui escreve, renomeia ou apaga no original, e a skill
 * importada nunca aponta de volta para ele.
 */

export type LocalSkillSource = { homeDir?: string; /** Teto técnico (injetável nos testes). */ ceiling?: SkillCeiling };

type Found = { key: string; dir: string; name: string; description: string; source: string; files: number; bytes: number; problem?: string };

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "data", "store"]);
const MAX_SCAN_DEPTH = 9;
const MAX_FOUND = 400;

/** Os pontos de partida (dentro do `~/.claude`): a pasta de skills pessoais e a de plugins. */
function roots(homeDir: string): { dir: string; label: (relative: string) => string }[] {
  const claude = path.join(homeDir, ".claude");
  return [
    { dir: path.join(claude, "skills"), label: () => "~/.claude/skills" },
    {
      dir: path.join(claude, "plugins"),
      label: (relative) => {
        const parts = relative.split(path.sep).filter(Boolean);
        const at = parts.findIndex((part) => part === "skills" || part === "workflow-skills");
        // O nome do plugin é a pasta logo antes de "skills", pulando a versão (1.0.0, hash de commit).
        const before = (at > 0 ? parts.slice(0, at) : parts.slice(0, 1)).filter((part) => !/^v?\d+(\.\d+)*([-+].*)?$/.test(part) && !/^[0-9a-f]{12,}$/.test(part));
        return `plugin ${before.at(-1) ?? "plugins"}`;
      },
    },
  ];
}

/** Lê só o começo do SKILL.md (o frontmatter), sem carregar a skill inteira. */
async function readHead(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** Conta arquivos e bytes pelos metadados (sem ler conteúdo); links simbólicos não contam. */
async function measure(dir: string, ceiling: SkillCeiling): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > ceiling.maxDepth + 2 || files > ceiling.maxFiles * 4) return;
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      const info = await lstat(full).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(full, depth + 1);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
      }
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

const keyOf = (realDir: string) => createHash("sha1").update(realDir).digest("hex").slice(0, 16);

/** Procura pastas com SKILL.md (sem entrar dentro de uma skill achada). */
async function findSkillDirs(root: string, label: (relative: string) => string): Promise<{ dir: string; source: string }[]> {
  const out: { dir: string; source: string }[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FOUND || depth > MAX_SCAN_DEPTH) return;
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const hasSkill = await stat(path.join(dir, "SKILL.md")).then((info) => info.isFile(), () => false);
    if (hasSkill) {
      out.push({ dir, source: label(path.relative(root, dir)) });
      return;
    }
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".")) continue;
      const full = path.join(dir, entry.name);
      // Links na raiz de `~/.claude/skills` são o jeito normal de instalar uma skill: seguem. Dentro dos plugins, não.
      if (entry.isSymbolicLink() && depth > 0) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** Lista as candidatas (só leitura: nome, descrição, tamanho). */
export async function listLocalSkills(source: LocalSkillSource = {}): Promise<Found[]> {
  const homeDir = source.homeDir ?? os.homedir();
  const ceiling = source.ceiling ?? SKILL_LIMITS;
  const found: Found[] = [];
  const dedupe = new Set<string>();
  for (const root of roots(homeDir)) {
    for (const item of await findSkillDirs(root.dir, root.label)) {
      const head = await readHead(path.join(item.dir, "SKILL.md"));
      if (head === undefined) continue;
      const parsed = parseSkillMarkdown(head.endsWith("\n") ? head : `${head}\n`);
      const fm = parsed.frontmatter;
      const name = fm?.name || path.basename(item.dir);
      const description = fm?.description ?? "";
      // O corte em 8 KB pode ter pegado o frontmatter pela metade: sem nome/descrição, mostra o que há.
      const sameAs = `${name}\n${description}`;
      if (dedupe.has(sameAs)) continue;
      dedupe.add(sameAs);
      const real = await realpath(item.dir).catch(() => item.dir);
      const { files, bytes } = await measure(item.dir, ceiling);
      let problem: string | undefined;
      if (!fm || parsed.errors.length > 0) problem = parsed.errors[0] ?? "Sem frontmatter válido.";
      else if (files > ceiling.maxFiles) problem = `${files} arquivos (acima do teto técnico de segurança, ${ceiling.maxFiles}).`;
      else if (bytes > ceiling.maxBytes) problem = `${skillSizeLabel(bytes)} (acima do teto técnico de segurança, ${skillSizeLabel(ceiling.maxBytes)}).`;
      found.push({ key: keyOf(real), dir: item.dir, name, description, source: item.source, files, bytes, ...(problem ? { problem } : {}) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.source.localeCompare(b.source));
}

/** Para a API: as candidatas sem o caminho real, marcando as que já existem na Biblioteca (pelo nome). */
export async function localSkillCandidates(source: LocalSkillSource, libraryNames: ReadonlySet<string>): Promise<SkillImportCandidate[]> {
  return (await listLocalSkills(source)).map(({ dir: _dir, ...rest }) => ({ ...rest, alreadyInLibrary: libraryNames.has(rest.name.toLowerCase()) }));
}

/**
 * Copia os arquivos de UMA candidata (a chave vem da lista acima; nunca um caminho do cliente). Só
 * lê: links simbólicos ficam de fora, executáveis nativos recusam a importação e o que passa do
 * limite aborta antes de carregar tudo na memória.
 */
export async function copyLocalSkill(source: LocalSkillSource, key: string): Promise<{ files: SkillFile[]; from: string }> {
  const found = (await listLocalSkills(source)).find((candidate) => candidate.key === key);
  if (!found) throw new HttpError(404, "Essa skill não está mais na lista de candidatas.");
  if (found.problem) throw new HttpError(400, `Não dá para importar "${found.name}": ${found.problem}`);
  const ceiling = source.ceiling ?? SKILL_LIMITS;
  const real = await realpath(found.dir);
  const files: SkillFile[] = [];
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > ceiling.maxDepth) return;
    for (const entry of await readdir(path.join(real, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(real, rel);
      const info = await lstat(full);
      if (info.isSymbolicLink() || entry.name.startsWith(".")) continue;
      if (info.isDirectory()) {
        await walk(rel, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      total += info.size;
      if (total > ceiling.maxBytes || files.length >= ceiling.maxFiles) throw new HttpError(413, `"${found.name}" passa do teto técnico de segurança (${skillSizeLabel(ceiling.maxBytes)} e ${ceiling.maxFiles} arquivos).`);
      const data = await readFile(full);
      if (looksExecutable(data)) throw new HttpError(400, `"${found.name}" tem um executável (${rel}): não importo.`);
      files.push({ path: rel, data });
    }
  };
  await walk("", 0);
  return { files, from: found.source };
}
