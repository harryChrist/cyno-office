import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { BRAIN_FIXED_FILES, BRAIN_HISTORY_DIR, slugify, type BrainNote, type BrainNoteLayer } from "@cyno/shared";
import { stripFrontmatter } from "./frontmatter";

/** Nota lida do disco (com a hora da última edição, para a recência). */
export type StoredNote = BrainNote & { layer: BrainNoteLayer; mtimeMs: number };

const FIXED_FILES = new Set<string>(Object.values(BRAIN_FIXED_FILES));

/** `_regras.md`, `_indice.md` ou `_briefing.md`? */
export function isFixedFile(file: string): boolean {
  return FIXED_FILES.has(file);
}

/** Camada pelo caminho relativo à pasta do Cérebro ("historico/…" = histórico). */
export function noteLayer(file: string): BrainNoteLayer {
  if (file.startsWith(`${BRAIN_HISTORY_DIR}/`)) return "history";
  return isFixedFile(file) ? "fixed" : "note";
}

/** Caminho relativo de uma nota do histórico ("historico/<arquivo>.md"). */
export const historyFile = (name: string) => `${BRAIN_HISTORY_DIR}/${name}`;

/** Notas maiores que isso entram cortadas no contexto. */
export const MAX_NOTE_BYTES = 64 * 1024;
const TRUNCATED_MARK = "\n\n[nota cortada: arquivo grande demais]";

/** Só arquivos .md comuns, visíveis e direto na pasta (sem subpastas nem links simbólicos). */
export function isNoteFileName(name: string): boolean {
  return /\.md$/i.test(name) && !name.startsWith(".") && path.basename(name) === name;
}

/** Lê um arquivo de nota; acima de MAX_NOTE_BYTES, corta e marca o corte. */
export async function readCapped(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_NOTE_BYTES + 1);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    const text = buffer.subarray(0, Math.min(bytesRead, MAX_NOTE_BYTES)).toString("utf8");
    return bytesRead > MAX_NOTE_BYTES ? text + TRUNCATED_MARK : text;
  } finally {
    await handle.close();
  }
}

/** Título = primeiro "# cabeçalho" do corpo; senão, o nome do arquivo sem ".md". */
export function noteTitle(file: string, content: string): string {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(stripFrontmatter(content));
  return heading?.[1] ?? file.replace(/\.md$/i, "");
}

/** Nomes das notas .md de uma pasta, em ordem de nome; pasta ausente = nenhuma nota. */
export async function listNoteFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && isNoteFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Notas do histórico de um Cérebro (`<pasta>/historico/*.md`), em ordem de nome. */
export function listHistoryFiles(dir: string): Promise<string[]> {
  return listNoteFiles(path.join(dir, BRAIN_HISTORY_DIR));
}

/** Lê uma lista de notas (caminhos relativos à pasta do Cérebro); as apagadas no meio do caminho somem. */
async function readMany(dir: string, files: string[]): Promise<StoredNote[]> {
  const notes = await Promise.all(
    files.map(async (file): Promise<StoredNote | null> => {
      const full = path.join(dir, file);
      try {
        const [content, info] = await Promise.all([readCapped(full), stat(full)]);
        return { file, title: noteTitle(path.basename(file), content), content, layer: noteLayer(file), mtimeMs: info.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }),
  );
  return notes.filter((note): note is StoredNote => note !== null);
}

/** Lê as notas .md da pasta (fixas e curtas, sem o histórico), em ordem de nome. */
export async function readNotesDir(dir: string): Promise<StoredNote[]> {
  return readMany(dir, await listNoteFiles(dir));
}

/** Lê as notas do histórico ("historico/<arquivo>.md"), em ordem de nome (cronológica). */
export async function readHistoryDir(dir: string): Promise<StoredNote[]> {
  return readMany(dir, (await listHistoryFiles(dir)).map(historyFile));
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "YYYY-MM-DD-HHmmss-<slug>.md" (hora local do server); `suffix` desfaz colisões. */
export function datedNoteFileName(date: Date, title: string, suffix = 1): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const slug = slugify(title, "nota").slice(0, 48).replace(/-+$/g, "");
  return `${day}-${time}-${slug}${suffix > 1 ? `-${suffix}` : ""}.md`;
}
