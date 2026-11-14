/**
 * Markdown pequeno e seguro para as notas do Cérebro: vira uma árvore de nós (sem HTML) que o
 * componente <Markdown> transforma em elementos React. HTML cru nunca é interpretado: aparece
 * como texto. Cobre títulos, parágrafos, listas (com aninhamento), citações, linhas, tabelas,
 * blocos de código, `código`, **negrito**, *itálico*, links http(s) (também "site.com/x" sem o
 * esquema) e [[wiki links]].
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "break" }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  /** `[[alvo]]` ou `[[alvo|rótulo]]`; `target` já vem sem "#seção" e sem ".md". */
  | { type: "wiki"; target: string; label: string };

export type ListItem = { children: Inline[]; blocks: Block[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

export type TableAlign = "left" | "center" | "right" | null;

// ---------- Blocos ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

const indentOf = (line: string) => /^ */.exec(line)![0].length;
const isBlank = (line: string) => line.trim() === "";
const expandTabs = (line: string) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));

/** A linha começa outro bloco (e por isso encerra um parágrafo)? */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

/** Linha separadora da tabela (GFM): `| --- | :---: | ---: |`. */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Células de uma linha `| a | b |` (o "\|" escapado fica dentro da célula). */
function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Tabela começa aqui: linha com "|" seguida da separadora com o mesmo número de colunas. */
function startsTable(lines: string[], i: number): boolean {
  const head = lines[i]!;
  const delimiter = lines[i + 1];
  if (delimiter === undefined || !head.includes("|") || !delimiter.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false;
  return tableCells(head).length === tableCells(delimiter).length;
}

function parseTable(lines: string[], start: number): { block: Block; next: number } {
  const head = tableCells(lines[start]!);
  const align = tableCells(lines[start + 1]!).map((cell): TableAlign => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|") && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!)) {
    const cells = tableCells(lines[i]!);
    rows.push(head.map((_, column) => parseInline(cells[column] ?? "")));
    i++;
  }
  return { block: { type: "table", align, head: head.map((cell) => parseInline(cell)), rows }, next: i };
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[][] = [];
  let contentIndent = 0;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = LIST_ITEM.exec(line);
    if (item && item[1]!.length <= baseIndent + 1 && /\d/.test(item[2]!) === ordered) {
      items.push([item[3]!]);
      contentIndent = item[1]!.length + item[2]!.length + 1;
      i++;
      continue;
    }
    if (isBlank(line)) {
      // Linha em branco só continua a lista se a próxima linha com texto estiver recuada.
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j]!)) j++;
      if (j < lines.length && indentOf(lines[j]!) > baseIndent && !(LIST_ITEM.test(lines[j]!) && indentOf(lines[j]!) <= baseIndent + 1)) {
        items[items.length - 1]!.push("");
        i++;
        continue;
      }
      break;
    }
    const indent = indentOf(line);
    if (indent > baseIndent) {
      items[items.length - 1]!.push(line.slice(Math.min(indent, contentIndent)));
      i++;
      continue;
    }
    // Continuação "preguiçosa" de um parágrafo do item (sem recuo).
    const current = items[items.length - 1]!;
    if (!startsBlock(line) && !isBlank(current[current.length - 1] ?? "")) {
      current.push(line);
      i++;
      continue;
    }
    break;
  }
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : 1;
  return {
    block: {
      type: "list",
      ordered,
      start: Number.isFinite(startNumber) ? startNumber : 1,
      items: items.map((itemLines) => {
        const blocks = parseLines(itemLines);
        const [lead, ...rest] = blocks;
        return lead?.type === "paragraph" ? { children: lead.children, blocks: rest } : { children: [], blocks };
      }),
    },
    next: i,
  };
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
      i++; // fecha (ou fim do texto)
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(QUOTE, ""));
      blocks.push({ type: "quote", blocks: parseLines(quoted) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (startsTable(lines, i)) {
      const { block, next } = parseTable(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (paragraph.length === 0 || (!startsBlock(lines[i]!) && !startsTable(lines, i)))) {
      paragraph.push(lines[i++]!.trim());
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

/** Markdown -> blocos. */
export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, "\n").split("\n").map(expandTabs));
}

// ---------- Inline ----------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>~]/;
const LINK = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/;
const AUTOLINK = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
/**
 * Endereço sem "https://" ("linkedin.com/in/fulano", "www.site.com.br"): só com domínios comuns,
 * para "nota.md" ou "pasta/arquivo.ts" não virarem link.
 */
const BARE_DOMAIN =
  /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com\.br|org\.br|gov\.br|com|br|net|org|io|dev|app|ai|co|me|in)(?![\w-])(?:\/[^\s<>()]*[^\s<>().,;:!?'"*_])?/i;
/** Antes do endereço sem esquema: começo de palavra (nada de "a@b.com", "x/y.com" ou "-z.com"). */
const BARE_BEFORE = /[\p{L}\p{N}@/._\-:]/u;

/** Só http(s): nada de javascript:, data:, caminhos relativos etc. */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href);
}

/** "Nota#Seção" e "Nota.md" -> "Nota". */
export function wikiTarget(raw: string): string {
  return raw.replace(/[#^].*$/, "").replace(/\.md$/i, "").trim();
}

/** Posição do delimitador que fecha `delim` a partir de `from` (pula `código` e **negrito** internos). */
function findClose(src: string, from: number, delim: string): number {
  for (let j = from; j < src.length; j++) {
    const char = src[j]!;
    if (char === "\\") {
      j++;
      continue;
    }
    if (char === "`") {
      const end = src.indexOf("`", j + 1);
      if (end === -1) return -1;
      j = end;
      continue;
    }
    if (delim.length === 1 && src.startsWith(delim + delim, j)) {
      const end = src.indexOf(delim + delim, j + 2);
      if (end === -1) return -1;
      j = end + 1;
      continue;
    }
    if (src.startsWith(delim, j)) return j;
  }
  return -1;
}

/** Abre/fecha ênfase: sem espaço logo depois de abrir nem logo antes de fechar; "_" não vale no meio de palavras. */
function emphasisAt(src: string, i: number, delim: string): { inner: string; end: number } | null {
  const contentStart = i + delim.length;
  if (contentStart >= src.length || /\s/.test(src[contentStart]!)) return null;
  if (delim[0] === "_" && i > 0 && WORD_CHAR.test(src[i - 1]!)) return null;
  let j = findClose(src, contentStart, delim);
  while (j !== -1) {
    // "***x***": o fechamento fica no fim da sequência de delimitadores.
    while (src[j + delim.length] === delim[0]) j++;
    const valid = j > contentStart && !/\s/.test(src[j - 1]!) && !(delim[0] === "_" && WORD_CHAR.test(src[j + delim.length] ?? ""));
    if (valid) return { inner: src.slice(contentStart, j), end: j + delim.length };
    j = findClose(src, j + delim.length, delim);
  }
  return null;
}

/** Texto inline -> nós (texto, quebra, código, negrito, itálico, link, wiki link). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };

  let i = 0;
  while (i < src.length) {
    const char = src[i]!;
    const rest = src.slice(i);

    if (char === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (char === "\n") {
      push({ type: "break" });
      i++;
      continue;
    }

    if (char === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      if (end !== -1) {
        const code = src.slice(i + run.length, end).replace(/\n/g, " ");
        push({ type: "code", text: /^ .* $/.test(code) ? code.slice(1, -1) : code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (rest.startsWith("[[")) {
      const end = src.indexOf("]]", i + 2);
      const inner = end === -1 ? "" : src.slice(i + 2, end);
      if (inner.trim() && !inner.includes("\n") && !inner.includes("[")) {
        const [rawTarget = "", alias] = inner.split("|");
        const target = wikiTarget(rawTarget);
        push({ type: "wiki", target, label: alias?.trim() || rawTarget.trim() });
        i = end + 2;
        continue;
      }
    }

    if (char === "[") {
      const link = LINK.exec(rest);
      if (link) {
        const children = parseInline(link[1]!);
        if (isSafeHref(link[2]!)) push({ type: "link", href: link[2]!, children });
        else {
          flush();
          out.push(...children);
        }
        i += link[0].length;
        continue;
      }
    }

    if ((char === "h" || char === "H") && (i === 0 || !WORD_CHAR.test(src[i - 1]!))) {
      const auto = AUTOLINK.exec(rest);
      if (auto) {
        push({ type: "link", href: auto[0], children: [{ type: "text", text: auto[0] }] });
        i += auto[0].length;
        continue;
      }
    }

    if (/[a-z0-9]/i.test(char) && (i === 0 || !BARE_BEFORE.test(src[i - 1]!))) {
      const bare = BARE_DOMAIN.exec(rest);
      if (bare) {
        push({ type: "link", href: `https://${bare[0]}`, children: [{ type: "text", text: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const double = src[i + 1] === char ? char + char : null;
      const strong = double ? emphasisAt(src, i, double) : null;
      if (strong) {
        push({ type: "strong", children: parseInline(strong.inner) });
        i = strong.end;
        continue;
      }
      const em = emphasisAt(src, i, char);
      if (em) {
        push({ type: "em", children: parseInline(em.inner) });
        i = em.end;
        continue;
      }
      // Sem par: o delimitador (simples ou duplo) fica como texto.
      const literal = double ?? char;
      text += literal;
      i += literal.length;
      continue;
    }

    text += char;
    i++;
  }
  flush();
  return out;
}

/** Texto puro de nós inline (para comparar títulos, rótulos acessíveis etc.). */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return " ";
        case "wiki":
          return node.label;
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}

// ---------- Texto limpo ----------

/** Textos de cada bloco, na ordem (títulos, parágrafos, itens de lista, citações e código). */
function blockTexts(blocks: Block[]): string[] {
  return blocks.flatMap((block): string[] => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return [inlineText(block.children)];
      case "list":
        return block.items.flatMap((item) => [inlineText(item.children), ...blockTexts(item.blocks)]);
      case "quote":
        return blockTexts(block.blocks);
      case "code":
        return [block.text];
      case "table":
        return [block.head, ...block.rows].map((row) => row.map(inlineText).join(" "));
      case "rule":
        return [];
    }
  });
}

/** O bloco é só um título: `## Título` ou uma linha inteira em negrito ou itálico. */
function isTitleBlock(block: Block | undefined): boolean {
  if (block?.type === "heading") return true;
  if (block?.type !== "paragraph" || block.children.length !== 1) return false;
  const only = block.children[0]!;
  return only.type === "strong" || only.type === "em";
}

/**
 * Markdown -> texto corrido de uma linha (para resumos): sem `#`, marcadores, ênfase nem links
 * (fica o texto deles). Uma primeira linha que é só título (ex.: "## Resultado (simulado)") é
 * pulada quando há mais texto depois dela.
 */
export function plainText(source: string): string {
  const blocks = parseMarkdown(source);
  const body = blocks.length > 1 && isTitleBlock(blocks[0]) ? blocks.slice(1) : blocks;
  return blockTexts(body)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

// ---------- Sumário ----------

export type OutlineItem = { id: string; level: 1 | 2 | 3 | 4 | 5 | 6; text: string };

/** Âncora de um título de primeiro nível do texto (pelo índice do bloco, único mesmo com títulos repetidos). */
export function headingId(prefix: string, blockIndex: number): string {
  return `${prefix}-h${blockIndex}`;
}

/** Títulos de seção (até o nível 3) do texto, na ordem, com a âncora de cada um. Base do sumário das notas longas. */
export function headingOutline(blocks: Block[], prefix: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  blocks.forEach((block, index) => {
    if (block.type !== "heading" || block.level > 3) return;
    const text = inlineText(block.children).replace(/\s+/g, " ").trim();
    if (text) items.push({ id: headingId(prefix, index), level: block.level, text });
  });
  return items;
}
