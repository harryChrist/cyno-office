import { fileExtension } from "@cyno/shared";

/** As cores que um trecho de código pode ter (cada uma é uma classe `files-tok--<nome>` no CSS). */
export type TokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "keyword"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "tag"
  | "meta"
  | "escape"
  | "selector"
  | "section"
  | "symbol"
  | "link"
  | "strong"
  | "emphasis"
  | "add"
  | "del";

export type CodeRun = { text: string; kind?: TokenKind };

/** Só até este tamanho o texto ganha cor (acima, vai sem cor: colorir pesa no celular). */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/** Extensão do arquivo e a linguagem do realçador. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonl: "json", ndjson: "json", json5: "json", webmanifest: "json", map: "json",
  py: "python", pyw: "python", pyi: "python",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", xhtml: "xml", plist: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini", properties: "properties", editorconfig: "ini",
  sql: "sql",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", m: "objectivec", mm: "objectivec",
  php: "php", rb: "ruby", pl: "perl", pm: "perl", lua: "lua", r: "r",
  diff: "diff", patch: "diff",
  graphql: "graphql", gql: "graphql", proto: "protobuf",
  mk: "makefile", dockerfile: "dockerfile", nginx: "nginx",
};

/** Arquivos conhecidos pelo nome inteiro (sem extensão, ou com uma que não diz nada). */
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".bash_profile": "bash",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/** A linguagem de um arquivo pelo nome, ou `null` quando não há o que colorir (texto comum, log, tipo desconhecido). */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  const known = BY_NAME[lower];
  if (known) return known;
  // ".env.example", "Dockerfile.dev": o começo do nome diz o tipo.
  if (lower.startsWith(".env.")) return "ini";
  if (lower.startsWith("dockerfile.")) return "dockerfile";
  return BY_EXTENSION[fileExtension(name)] ?? null;
}

/** O texto ganha cor? Só quando o tipo é conhecido e o tamanho é razoável. */
export const canHighlight = (name: string, text: string): boolean => text.length > 0 && text.length <= HIGHLIGHT_MAX_CHARS && languageOf(name) !== null;

/** Nome que o realçador dá a um trecho ("hljs-keyword", "hljs-title function_") e a nossa cor. */
function kindOf(classes: string): TokenKind | undefined {
  const [scope, detail] = classes.split(" ");
  switch (scope) {
    case "hljs-keyword":
    case "hljs-selector-tag":
    case "hljs-doctag":
      return "keyword";
    case "hljs-built_in":
    case "hljs-type":
      return "type";
    case "hljs-literal":
      return "literal";
    case "hljs-number":
      return "number";
    case "hljs-string":
    case "hljs-code":
      return "string";
    case "hljs-regexp":
    case "hljs-subst":
    case "hljs-char":
      return "escape";
    case "hljs-symbol":
    case "hljs-bullet":
      return "symbol";
    case "hljs-comment":
    case "hljs-quote":
      return "comment";
    case "hljs-title":
      return detail === "class_" ? "type" : "function";
    case "hljs-attr":
    case "hljs-attribute":
    case "hljs-property":
      return "key";
    case "hljs-variable":
      if (detail === "language_") return "keyword";
      return detail === "constant_" ? "literal" : "variable";
    case "hljs-template-variable":
      return "variable";
    case "hljs-meta":
      return "meta";
    case "hljs-tag":
    case "hljs-name":
      return "tag";
    case "hljs-selector-class":
    case "hljs-selector-id":
    case "hljs-selector-attr":
    case "hljs-selector-pseudo":
      return "selector";
    case "hljs-section":
      return "section";
    case "hljs-link":
      return "link";
    case "hljs-strong":
      return "strong";
    case "hljs-emphasis":
      return "emphasis";
    case "hljs-addition":
      return "add";
    case "hljs-deletion":
      return "del";
    default:
      return undefined;
  }
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const unescape = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);
const MARKUP = /<span class="([^"]*)">|<\/span>|[^<]+|</g;

/**
 * Transforma a saída do realçador (texto com `<span class="hljs-...">` aninhados) em trechos planos com uma cor
 * cada. Assim a tela desenha elementos comuns, sem inserir HTML pronto na página. Vale a cor do trecho mais de
 * dentro que tiver uma; trechos vizinhos da mesma cor viram um só.
 */
export function htmlToRuns(html: string): CodeRun[] {
  const runs: CodeRun[] = [];
  const stack: Array<TokenKind | undefined> = [];
  for (const match of html.matchAll(MARKUP)) {
    const piece = match[0];
    if (match[1] !== undefined) {
      stack.push(kindOf(match[1]));
      continue;
    }
    if (piece === "</span>") {
      stack.pop();
      continue;
    }
    let kind: TokenKind | undefined;
    for (let index = stack.length - 1; index >= 0 && kind === undefined; index -= 1) kind = stack[index];
    const text = unescape(piece);
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else runs.push(kind ? { text, kind } : { text });
  }
  return runs;
}

type Engine = { highlight: (text: string, language: string) => string | null };
let engine: Promise<Engine> | null = null;

/**
 * Colore o texto de um arquivo conforme o tipo. O realçador só é baixado na primeira vez que um arquivo com tipo
 * conhecido abre (fica fora do pacote inicial). Devolve `null` quando não há cor a dar ou algo falha: a tela mostra
 * o texto simples.
 */
export async function highlightRuns(name: string, text: string): Promise<CodeRun[] | null> {
  const language = languageOf(name);
  if (!language || !canHighlight(name, text)) return null;
  try {
    engine ??= import("./highlightEngine").then((module) => module.engine);
    const html = (await engine).highlight(text, language);
    return html === null ? null : htmlToRuns(html);
  } catch {
    engine = null;
    return null;
  }
}

/** Família do arquivo para a cor do ícone na árvore e nas abas. */
export type FileTone = "code" | "data" | "doc" | "web" | "style" | "shell" | "image";

const TONE_BY_LANGUAGE: Readonly<Record<string, FileTone>> = {
  json: "data", yaml: "data", ini: "data", properties: "data", sql: "data", graphql: "data", protobuf: "data",
  markdown: "doc",
  xml: "web",
  css: "style", scss: "style", less: "style",
  bash: "shell", powershell: "shell", dockerfile: "shell", makefile: "shell", nginx: "shell",
};
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const DATA_EXTENSIONS = new Set(["csv", "tsv"]);
const DOC_EXTENSIONS = new Set(["txt", "pdf", "doc", "docx", "rtf"]);

/** A família de um arquivo pelo nome; `undefined` = ícone na cor neutra. */
export function fileTone(name: string): FileTone | undefined {
  const ext = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  const language = languageOf(name);
  if (!language) return undefined;
  return TONE_BY_LANGUAGE[language] ?? "code";
}
