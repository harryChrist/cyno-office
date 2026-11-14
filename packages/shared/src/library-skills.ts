import { z } from "zod";
import type { LibraryGrants, LibraryUse } from "./library";

/**
 * Skills da Biblioteca: uma pasta (`SKILL.md` com frontmatter `name`/`description` + arquivos de
 * apoio) guardada em `data/platform/library/skills/<id>/`. O agente recebe uma CÓPIA na pasta dele,
 * uma linha de índice no prompt e lê o `SKILL.md` sob demanda (nada vem da configuração pessoal).
 */

// ---------- Limites ----------

export const SKILL_LIMITS = {
  /** Avisa (não bloqueia) acima disso, por agente. */
  maxPerAgent: 12,
  /** Avisa acima disso (tokens do índice de todas as skills do agente). */
  maxIndexTokens: 6000,
  /** Só AVISA (não recusa): SKILL.md grande entra inteiro no contexto quando o agente usa a skill. */
  warnBodyTokens: 8000,
  /** Só aviso discreto na tela: skill "grande". */
  warnBytes: 1024 * 1024,
  warnFiles: 200,
  /** Teto técnico contra acidente (uma pasta errada, um zip bomb); no uso normal nada barra. */
  maxBytes: 100 * 1024 * 1024,
  maxFiles: 5000,
  maxPathLength: 240,
  maxDepth: 12,
  /** Descrição que entra na linha do índice. */
  indexDescriptionChars: 200,
} as const;

/** O maior corpo de envio (pasta ou .zip em base64) = o teto técnico em bytes, com a folga do base64. */
export const SKILL_UPLOAD_BASE64_MAX = Math.ceil((SKILL_LIMITS.maxBytes * 4) / 3) + 1024;

/** O teto técnico (injetável nos testes, para não gerar 100 MB). */
export type SkillCeiling = { maxBytes: number; maxFiles: number; maxPathLength: number; maxDepth: number };

/** "449 KB", "1,2 MB". */
export function skillSizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** Aviso (não bloqueia) para uma skill grande: `null` quando está dentro do normal. */
export function skillBigNote(bytes: number, files: number): string | null {
  if (bytes < SKILL_LIMITS.warnBytes && files < SKILL_LIMITS.warnFiles) return null;
  return `grande: ${skillSizeLabel(bytes)} em ${files} arquivos`;
}

/** Aviso do SKILL.md grande (o texto vira contexto do agente). */
export function skillBodyWarning(tokens: number): string | null {
  return tokens > SKILL_LIMITS.warnBodyTokens ? `Este SKILL.md é grande: ~${tokens} tokens entram no contexto do agente quando ele usa a skill.` : null;
}

/** Estimativa de tokens (caracteres / 4), a mesma da Biblioteca de conectores. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// ---------- SKILL.md ----------

export type SkillFrontmatter = { name: string; description: string; fields: Record<string, string> };
export type ParsedSkillMarkdown = { frontmatter: SkillFrontmatter | null; body: string; errors: string[] };

/** Valor de uma linha `chave: valor` (aspas simples ou duplas tiradas). */
function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    const inner = text.slice(1, -1);
    return text.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return text;
}

/**
 * Lê o frontmatter de um SKILL.md (o subconjunto de YAML que as skills usam: `chave: valor`, aspas,
 * blocos `>`/`|` e continuação indentada). Sem biblioteca: roda no servidor e na prévia do editor.
 */
export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { frontmatter: null, body: source, errors: ["O SKILL.md precisa começar com um frontmatter (--- name: … description: … ---)."] };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();
    const block = /^([>|])[+-]?$/.exec(rest);
    if (block || rest === "") {
      const collected: string[] = [];
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) collected.push(lines[++i]!.trim());
      const joined = block?.[1] === "|" ? collected.join("\n") : collected.filter(Boolean).join(" ");
      fields[key] = joined.replace(/\s+$/g, "").trim();
      continue;
    }
    // Valor simples, com continuação indentada (YAML plano de várias linhas).
    const parts = [unquote(rest)];
    if (!/^["']/.test(rest)) while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
    fields[key] = parts.join(" ").trim();
  }
  const body = source.slice(match[0].length);
  const errors: string[] = [];
  const name = (fields.name ?? "").trim();
  const description = (fields.description ?? "").trim();
  if (!name) errors.push("O frontmatter precisa de `name`.");
  if (!description) errors.push("O frontmatter precisa de `description` (diz ao agente QUANDO usar a skill).");
  if (name.length > 80) errors.push("`name` passa de 80 caracteres.");
  if (description.length > 1024) errors.push("`description` passa de 1024 caracteres.");
  return { frontmatter: { name, description, fields }, body, errors };
}

/** Texto de um SKILL.md novo (o editor "criar" começa daqui). */
export function skillMarkdownTemplate(name: string, description: string, body = ""): string {
  const quote = (value: string) => (/[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value);
  return `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

// ---------- Origem, estado e visão ----------

export const SKILL_ORIGIN_KINDS = ["manual", "upload", "folder", "app", "url"] as const;

const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
export const librarySkillIdSchema = slugSchema;
export const librarySkillParamsSchema = z.object({ skillId: slugSchema });

/** Um arquivo da skill como a API mostra (sem o conteúdo). */
export type LibrarySkillFile = { path: string; bytes: number };

/** A skill como a API mostra: o registro mais "quem usa", o custo do índice, os avisos e os arquivos. */
export type LibrarySkillView = {
  id: string;
  name: string;
  description: string;
  origin: { kind: "manual" } | { kind: "upload"; at: string } | { kind: "folder"; from: string; copiedAt: string } | { kind: "app"; appId: string; path: string } | { kind: "url"; url: string; sha256: string; fetchedAt: string };
  requires: string[];
  files: number;
  bytes: number;
  /** Tokens do corpo (SKILL.md), só gastos quando o agente lê. */
  weightTokens: number;
  /** Tokens da linha do índice (sempre no contexto de quem recebe). */
  indexTokens: number;
  readonly: boolean;
  usage: { reads: number; lastAt?: string };
  grants: LibraryGrants;
  version: number;
  /** Há uma versão anterior guardada (dá para restaurar). */
  hasPrevious: boolean;
  previousVersion?: number;
  createdAt: string;
  updatedAt: string;
  warnings: string[];
  uses: LibraryUse[];
};

/** Um arquivo da pasta, com o conteúdo, para o editor. */
export type LibrarySkillDetail = LibrarySkillView & { content: string; fileList: LibrarySkillFile[] };

/** Uma skill candidata a importar (só nome e descrição, lidos do frontmatter; nada é copiado ainda). */
export type SkillImportCandidate = {
  /** Chave opaca que o servidor reconhece (nunca um caminho que o cliente escolha). */
  key: string;
  name: string;
  description: string;
  /** De onde vem, para mostrar ("~/.claude/skills" ou "plugin <nome>"). */
  source: string;
  files: number;
  bytes: number;
  /** Já existe uma skill da Biblioteca com este nome. */
  alreadyInLibrary: boolean;
  /** Não dá para importar (grande demais, executável…): o motivo. */
  problem?: string;
};
export type SkillImportResponse = { available: boolean; reason?: string; candidates: SkillImportCandidate[] };

// ---------- Corpos das rotas ----------

/** POST /api/library/skills: o SKILL.md inteiro escrito na tela. */
export const createLibrarySkillBodySchema = z.object({
  content: z.string().min(1).max(4_000_000),
  /** Id (opcional): senão sai do `name` do frontmatter. */
  id: slugSchema.optional(),
  requires: z.array(z.string().max(80)).max(10).optional(),
});
export type CreateLibrarySkillBody = z.input<typeof createLibrarySkillBodySchema>;

/** PUT /api/library/skills/:id: troca o SKILL.md (a versão atual vira a anterior). */
export const updateLibrarySkillBodySchema = z.object({
  content: z.string().min(1).max(4_000_000).optional(),
  requires: z.array(z.string().max(80)).max(10).optional(),
});
export type UpdateLibrarySkillBody = z.input<typeof updateLibrarySkillBodySchema>;

/** POST /api/library/skills/upload: uma pasta (lista de arquivos) ou um .zip, em base64. */
export const uploadLibrarySkillBodySchema = z
  .object({
    files: z.array(z.object({ path: z.string().min(1).max(400), dataBase64: z.string().max(SKILL_UPLOAD_BASE64_MAX) })).max(SKILL_LIMITS.maxFiles).optional(),
    zipBase64: z.string().max(SKILL_UPLOAD_BASE64_MAX).optional(),
    id: slugSchema.optional(),
  })
  .refine((body) => Boolean(body.files?.length) !== Boolean(body.zipBase64), { message: "Mande os arquivos da pasta ou um .zip (um dos dois)." });
export type UploadLibrarySkillBody = z.input<typeof uploadLibrarySkillBodySchema>;

/** POST /api/library/skills/import: as chaves marcadas na lista de candidatas. */
export const importLibrarySkillsBodySchema = z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(50) });
export type ImportLibrarySkillsBody = z.input<typeof importLibrarySkillsBodySchema>;
export type ImportLibrarySkillsResponse = { imported: LibrarySkillView[]; failed: { key: string; reason: string }[] };

// ---------- Avisos por agente ----------

/** Limites por agente: quantas skills e quantos tokens de índice; passou, a tela e o MCP só avisam. */
export function skillBudgetWarnings(skills: readonly Pick<LibrarySkillView, "indexTokens">[]): string[] {
  const warnings: string[] = [];
  if (skills.length > SKILL_LIMITS.maxPerAgent) warnings.push(`Mais de ${SKILL_LIMITS.maxPerAgent} skills (${skills.length}): o agente escolhe pior entre tantas.`);
  const tokens = skills.reduce((total, skill) => total + skill.indexTokens, 0);
  if (tokens > SKILL_LIMITS.maxIndexTokens) warnings.push(`O índice das skills passa de ${SKILL_LIMITS.maxIndexTokens} tokens (~${tokens}): pesa em todo turno.`);
  return warnings;
}

/** Nome da pasta, dentro da pasta do agente, onde as skills liberadas ficam copiadas. */
export const AGENT_SKILLS_DIR = "skills";
/** Id da skill de autoteste (a frase secreta só aparece no SKILL.md dela). */
export const SELFTEST_SKILL_ID = "cyno-selftest";

/** SKILL.md da skill de autoteste: a frase secreta só aparece aqui (se o agente a diz, ele leu o arquivo). */
export function selftestSkillMarkdown(phrase: string): string {
  return skillMarkdownTemplate(
    SELFTEST_SKILL_ID,
    "Use when the user asks for the Cyno self-test phrase, the secret phrase, or to prove that skills reach you.",
    `\n# Cyno self-test\n\nThe secret phrase is: ${phrase}\n\nWhen asked for it, reply with that phrase exactly and say that you read it from this skill file.\n`,
  );
}
