import path from "node:path";
import { estimateTokens, parseSkillMarkdown, skillBodyWarning, skillSizeLabel, SKILL_LIMITS, type SkillCeiling, type SkillFrontmatter } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";

/** Um arquivo de uma skill ainda não guardada: caminho relativo (com `/`) e bytes. */
export type SkillFile = { path: string; data: Buffer };

export type ValidatedSkill = {
  files: SkillFile[];
  frontmatter: SkillFrontmatter;
  skillMd: string;
  bytes: number;
  warnings: string[];
};

/** Cada segmento do caminho: letras, números, `_`, `.`, `-` (sem espaço, sem começar com ponto). */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Extensões de executável/biblioteca nativa: nunca entram (script de texto, como .py ou .sh, entra com aviso). */
const BLOCKED_EXTENSIONS = new Set([".exe", ".dll", ".so", ".dylib", ".bin", ".com", ".msi", ".jar", ".apk", ".app", ".bat", ".cmd", ".scr", ".class", ".wasm", ".o", ".a", ".deb", ".rpm", ".pyc"]);
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".php"]);

/** Binário executável pelos primeiros bytes (ELF, Windows PE, Mach-O, classe Java). */
export function looksExecutable(data: Buffer): boolean {
  if (data.length < 4) return false;
  const head = data.readUInt32BE(0);
  if (head === 0x7f454c46) return true; // ELF
  if (data[0] === 0x4d && data[1] === 0x5a) return true; // MZ (Windows)
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head); // Mach-O / Java class
}

/** Normaliza o caminho (barras, sem `./`); devolve `null` se for inseguro. */
export function safeRelativePath(raw: string, ceiling: SkillCeiling = SKILL_LIMITS): string | null {
  if (raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.length > ceiling.maxDepth) return null;
  if (!segments.every((segment) => segment !== ".." && SAFE_SEGMENT.test(segment))) return null;
  const joined = segments.join("/");
  return joined.length <= ceiling.maxPathLength ? joined : null;
}

/**
 * Se todos os arquivos estão dentro de uma pasta só ("minha-skill/SKILL.md", como o navegador e o zip
 * mandam), tira essa pasta. Só quando o SKILL.md está logo dentro dela.
 */
export function stripCommonRoot<T extends { path: string }>(files: T[]): T[] {
  if (files.length === 0 || files.some((file) => file.path === "SKILL.md")) return files;
  const roots = new Set(files.map((file) => file.path.split("/")[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0]!;
  if (!files.some((file) => file.path === `${root}/SKILL.md`)) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

/**
 * Confere uma skill inteira antes de guardar: `SKILL.md` na raiz com frontmatter `name` e
 * `description`; nomes de arquivo seguros; limites de tamanho; nada de executável nativo. Scripts de
 * texto entram (a pasta do agente nunca os roda sozinha) mas ficam sem permissão de execução e com
 * aviso. Arquivos "escondidos" (começam com ponto, como .DS_Store) são ignorados.
 */
export function validateSkillFiles(input: SkillFile[], ceiling: SkillCeiling = SKILL_LIMITS): ValidatedSkill {
  const warnings: string[] = [];
  const seen = new Map<string, SkillFile>();
  const visible = input.map((file) => ({ ...file, path: file.path.replace(/^\.\//, "") })).filter((file) => !file.path.split("/").some((segment) => segment.startsWith(".") && segment !== ".." && segment !== "."));
  for (const file of stripCommonRoot(visible)) {
    const clean = safeRelativePath(file.path, ceiling);
    if (!clean) throw new HttpError(400, `Nome de arquivo não permitido: "${file.path}". Use só letras, números, "_", "." e "-" (sem espaços), até ${ceiling.maxDepth} níveis e ${ceiling.maxPathLength} caracteres de caminho.`);
    if (seen.has(clean)) throw new HttpError(400, `Arquivo repetido: "${clean}".`);
    const extension = path.extname(clean).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(extension) || looksExecutable(file.data)) throw new HttpError(400, `"${clean}" é um executável/binário nativo: skills só podem ter texto, imagens e scripts simples.`);
    if (SCRIPT_EXTENSIONS.has(extension)) warnings.push(`Tem o script ${clean}: o agente só o roda se tiver terminal.`);
    seen.set(clean, { path: clean, data: file.data });
  }
  const files = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skillFile = files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new HttpError(400, "A skill precisa de um arquivo SKILL.md na raiz da pasta.");
  if (files.length > ceiling.maxFiles) throw new HttpError(413, `A skill tem ${files.length} arquivos (o teto técnico de segurança é ${ceiling.maxFiles}). Provavelmente é a pasta errada.`);
  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  if (bytes > ceiling.maxBytes) throw new HttpError(413, `A skill tem ${skillSizeLabel(bytes)} (o teto técnico de segurança é ${skillSizeLabel(ceiling.maxBytes)}). Provavelmente é a pasta errada.`);
  if (skillFile.data.includes(0)) throw new HttpError(400, "O SKILL.md não é um arquivo de texto.");
  const skillMd = skillFile.data.toString("utf8");
  const parsed = parseSkillMarkdown(skillMd);
  if (parsed.errors.length > 0 || !parsed.frontmatter) throw new HttpError(400, parsed.errors.join(" "));
  const bodyWarning = skillBodyWarning(estimateTokens(skillMd));
  if (bodyWarning) warnings.push(bodyWarning);
  if (!/^[a-z0-9]/i.test(parsed.frontmatter.name)) throw new HttpError(400, "O `name` precisa começar com letra ou número.");
  if (parsed.frontmatter.description.length < 12) warnings.push("A descrição é muito curta: diga QUANDO o agente deve usar esta skill.");
  return { files, frontmatter: parsed.frontmatter, skillMd, bytes, warnings };
}
