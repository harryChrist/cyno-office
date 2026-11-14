import type { BrainFrontmatter } from "@cyno/shared";

/** Campos do frontmatter YAML das notas que o orquestrador grava no Cérebro. */
export type NoteFrontmatter = {
  task: string;
  agent: string;
  team: string;
  /** Na nota do Maestro: a subtarefa do time que fez o trabalho. */
  subtask?: string;
  /** Data/hora ISO 8601. */
  data: string;
  tags: string[];
};

/** Strings JSON são escalares YAML entre aspas válidos (escapes incluídos). */
const yamlString = (value: string) => JSON.stringify(value);

export function renderFrontmatter(fields: NoteFrontmatter): string {
  const lines = [
    `task: ${yamlString(fields.task)}`,
    `agent: ${yamlString(fields.agent)}`,
    `team: ${yamlString(fields.team)}`,
    ...(fields.subtask === undefined ? [] : [`subtask: ${yamlString(fields.subtask)}`]),
    `data: ${yamlString(fields.data)}`,
    `tags: [${fields.tags.map(yamlString).join(", ")}]`,
  ];
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Frontmatter genérico (notas salvas pelos agentes): texto entre aspas, listas inline; vazios saem. */
export function renderFields(fields: Record<string, string | string[] | undefined>): string {
  const lines = Object.entries(fields).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return [`${key}: [${value.map(yamlString).join(", ")}]`];
    return value === "" ? [] : [`${key}: ${yamlString(value)}`];
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Separa o bloco "---" inicial (se houver) do corpo da nota. */
export function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

const FRONTMATTER_BLOCK = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY_LINE = /^([A-Za-z0-9_][\w-]*)[ \t]*:[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/;

/** Escalar YAML simples: "aspas duplas" (com escapes), 'aspas simples' ou texto puro. */
function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Escape que o JSON não entende: devolve sem as aspas.
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** Lista inline `[a, "b, c", 'd']` (vírgulas dentro de aspas não separam). */
function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"' && i + 1 < inner.length) current += inner[++i];
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map(parseScalar).filter((item) => item !== "");
}

/**
 * Lê o bloco "---" inicial como um YAML simples: `chave: valor`, listas inline (`[a, b]`) e
 * listas em bloco (`- item`). Objetos aninhados e outras construções são ignorados (não
 * quebram a leitura). Sem bloco, o frontmatter fica vazio e o corpo é o texto todo.
 */
export function parseFrontmatter(content: string): { frontmatter: BrainFrontmatter; body: string } {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: BrainFrontmatter = {};
  let listKey: string | null = null;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = LIST_ITEM.exec(line);
    if (item && listKey) {
      const value = parseScalar(item[1]!);
      const list = frontmatter[listKey];
      if (value && Array.isArray(list)) list.push(value);
      continue;
    }
    listKey = null;
    // Linha indentada que não é item de lista: parte de um objeto aninhado (ignorado).
    if (/^[ \t]/.test(line)) continue;
    const pair = KEY_LINE.exec(line);
    if (!pair) continue;
    const key = pair[1]!;
    const value = pair[2]!.trim();
    if (value === "") {
      frontmatter[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = parseInlineList(value);
    } else {
      frontmatter[key] = parseScalar(value);
    }
  }
  return { frontmatter, body: content.slice(match[0].length) };
}
