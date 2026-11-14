import { BRAIN_EXCERPT_LENGTH, type BrainFrontmatter, type BrainNoteSummary } from "@cyno/shared";
import { shorten } from "../../util/text";
import { parseFrontmatter } from "./frontmatter";
import { noteLayer, noteTitle } from "./notes";

/** Primeiro valor de texto entre as chaves dadas (a primeira que existir ganha). */
function firstText(frontmatter: BrainFrontmatter, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    const text = Array.isArray(value) ? value[0] : value;
    if (text?.trim()) return text.trim();
  }
  return undefined;
}

const DATED_FILE = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?(?:\D|$)/;

/** Data da nota: frontmatter (`data`/`date`), senão o nome datado do arquivo, senão `mtime`. */
export function noteDate(file: string, frontmatter: BrainFrontmatter, mtime?: Date): string | null {
  const declared = firstText(frontmatter, ["data", "date", "created"]);
  if (declared) {
    const date = new Date(declared);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const dated = DATED_FILE.exec(file);
  if (dated) {
    const [year, month, day, hours = "0", minutes = "0", seconds = "0"] = dated.slice(1).map((part) => part ?? "0");
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return mtime && !Number.isNaN(mtime.getTime()) ? mtime.toISOString() : null;
}

/** Tags do frontmatter (`tags`/`tag`), em lista ou texto separado por vírgulas/espaços, sem "#". */
export function noteTags(frontmatter: BrainFrontmatter): string[] {
  const raw = frontmatter.tags ?? frontmatter.tag;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : raw.split(/[,\s]+/);
  const tags = list.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean);
  return [...new Set(tags)];
}

/** Texto corrido da nota, sem o primeiro título e sem marcação markdown, para o trecho. */
export function noteExcerpt(body: string, max = BRAIN_EXCERPT_LENGTH): string {
  let droppedTitle = false;
  const lines = body.split(/\r?\n/).flatMap((line) => {
    if (/^\s*(```|~~~)/.test(line)) return [];
    if (!droppedTitle && /^#\s+/.test(line)) {
      droppedTitle = true;
      return [];
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [];
    return [line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")];
  });
  const text = lines
    .join(" ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*/g, "$1$2")
    .replace(/(^|\W)_(?!\s)([^_]+?)_(?=\W|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
  return shorten(text, max);
}

/** Resumo de uma nota para a lista do navegador do Cérebro. */
export function summarizeNote(file: string, content: string, mtime?: Date): BrainNoteSummary {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    file,
    layer: noteLayer(file),
    title: noteTitle(file.split("/").pop() ?? file, content),
    date: noteDate(file, frontmatter, mtime),
    tags: noteTags(frontmatter),
    excerpt: noteExcerpt(body),
  };
}

/** Mais recentes primeiro; sem data vão para o fim; empate = nome do arquivo decrescente. */
export function newestFirst(a: BrainNoteSummary, b: BrainNoteSummary): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    const diff = Date.parse(b.date) - Date.parse(a.date);
    if (diff !== 0) return diff;
  }
  return b.file.localeCompare(a.file);
}
