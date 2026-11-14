import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BRAIN_HISTORY_DIR } from "@cyno/shared";
import { noteExcerpt } from "./browse";
import { parseFrontmatter } from "./frontmatter";
import { isFixedFile, listNoteFiles, noteTitle, readCapped } from "./notes";
import { fixedTemplates, type BrainScope, type ExistingNote } from "./templates";

/** Resultado de tarefa gravado pelo server: "YYYY-MM-DD-HHmmss-<slug>.md" com `task:` no frontmatter. */
const RESULT_FILE = /^\d{4}-\d{2}-\d{2}-\d{6}-.+\.md$/i;

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Nome livre em `dir` para `file` ("x.md", "x-2.md", …). */
async function freeName(dir: string, file: string): Promise<string> {
  const base = file.replace(/\.md$/i, "");
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? file : `${base}-${n}.md`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error(`Sem nome livre para ${file} em ${dir}`);
}

/**
 * Move os resultados de tarefa datados da raiz do Cérebro para `historico/` (só os que têm `task`
 * no frontmatter: notas escritas à mão com nome datado ficam). Nunca apaga nem sobrescreve; rodar
 * de novo não faz nada. Devolve os arquivos movidos (caminhos relativos novos).
 */
export async function moveResultsToHistory(dir: string): Promise<string[]> {
  const moved: string[] = [];
  const historyDir = path.join(dir, BRAIN_HISTORY_DIR);
  for (const file of await listNoteFiles(dir)) {
    if (!RESULT_FILE.test(file) || isFixedFile(file)) continue;
    const source = path.join(dir, file);
    let content: string;
    try {
      content = await readCapped(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!("task" in parseFrontmatter(content).frontmatter)) continue;
    await mkdir(historyDir, { recursive: true });
    const target = await freeName(historyDir, file);
    await rename(source, path.join(historyDir, target));
    moved.push(`${BRAIN_HISTORY_DIR}/${target}`);
  }
  return moved;
}

/** Notas curtas da raiz (para o índice e o briefing iniciais). */
async function shortNotes(dir: string): Promise<ExistingNote[]> {
  const notes: ExistingNote[] = [];
  for (const file of await listNoteFiles(dir)) {
    if (isFixedFile(file)) continue;
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      notes.push({ file, title: noteTitle(file, content), excerpt: noteExcerpt(parseFrontmatter(content).body, 100) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return notes;
}

/**
 * Cria `_regras.md`, `_indice.md` e `_briefing.md` que faltarem (o índice já lista as notas
 * curtas que existem). Nunca sobrescreve um fixo existente. Devolve os criados.
 */
export async function ensureFixedFiles(dir: string, scope: BrainScope): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const templates = fixedTemplates(scope, await shortNotes(dir));
  for (const [file, content] of Object.entries(templates)) {
    try {
      await writeFile(path.join(dir, file), content, { flag: "wx" });
      created.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return created;
}
