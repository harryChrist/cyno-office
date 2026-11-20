import { z } from "zod";

/**
 * Arquivos do workspace (página "Arquivos"): navegar, ler e baixar o que está nas pastas do workspace e, nas pastas
 * de trabalho com escrita, editar, criar, enviar, renomear e apagar.
 *
 * Quem pode ser alterado: só as pastas de trabalho que o workspace marcou como "leitura e escrita" (`writable`). A
 * raiz "Dados do workspace" e as pastas "só leitura" nunca são alteradas por aqui. Itens trancados (segredos) não
 * abrem, não são editados, renomeados nem apagados, e não dá para criar item com nome trancado.
 *
 * As raízes são a pasta de dados do próprio workspace ("Dados do workspace": agentes, cérebros, logs, tarefas,
 * scripts) e cada pasta de trabalho cadastrada nele. A raiz `data/` do Cyno (senha, sessões de login) NÃO entra.
 * Todo caminho é relativo a uma raiz e conferido pelo caminho real no servidor: um link que aponta para fora da raiz
 * não abre. Arquivos e pastas sensíveis aparecem na lista com cadeado e não abrem nem baixam.
 */

/** Id fixo da raiz "Dados do workspace"; as pastas de trabalho usam o id delas (`WorkFolder.id`). */
export const FILE_ROOT_DATA = "dados";

export type FileRootKind = "data" | "folder";

/** Uma raiz navegável. */
export type FileRoot = {
  id: string;
  kind: FileRootKind;
  /** "Dados do workspace" ou o nome da pasta de trabalho. */
  name: string;
  /** Caminho real no computador (dica na tela e "Copiar caminho"). */
  path: string;
  /** Dá para editar, criar, enviar, renomear e apagar aqui (pasta de trabalho com "leitura e escrita"). */
  writable: boolean;
  /** A raiz não pôde ser aberta agora (pasta removida, sem permissão): aparece apagada, com o motivo. */
  error?: string;
};

export const FILE_LIMITS = {
  /** Itens por página de uma pasta (o resto vem com "mostrar mais"). */
  pageSize: 200,
  maxPageSize: 1000,
  /** Quanto de um arquivo de texto vai na prévia (bytes); maior que isso vem cortado, com aviso, e o resto só baixando. */
  previewBytes: 512 * 1024,
  /** Imagem maior que isso não é mostrada na tela, só baixada (bytes). */
  imageBytes: 25 * 1024 * 1024,
  /** Busca por nome: quantos resultados voltam e quantos itens o servidor percorre no máximo. */
  searchResults: 100,
  searchScan: 30_000,
  searchQuery: 80,
  /** Tamanho máximo de um caminho relativo. */
  path: 4096,
  /** Abas abertas ao mesmo tempo na tela. */
  tabs: 20,
  /** Maior texto que a tela edita e salva (bytes): o mesmo teto da prévia, para nunca salvar um arquivo cortado. */
  editBytes: 512 * 1024,
  /** Maior arquivo que se envia de uma vez (bytes). */
  uploadBytes: 2 * 1024 * 1024 * 1024,
  /** Tamanho máximo do nome de um item. */
  name: 255,
  /** Até quantos itens a contagem de uma pasta percorre (para a confirmação de apagar). */
  countScan: 20_000,
} as const;

/** Pastas que a busca por nome não percorre (enormes e sem interesse). Na árvore elas aparecem normalmente. */
export const FILE_SEARCH_SKIP = ["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".cache", "target"] as const;

export type FileEntryKind = "dir" | "file";

/** Um item de uma pasta. */
export type FileEntry = {
  name: string;
  kind: FileEntryKind;
  /** Bytes (só arquivo). */
  size?: number;
  /** Última modificação (ISO). */
  mtime?: string;
  /** Sensível: aparece com cadeado e não abre nem baixa (arquivo) ou não expande (pasta). */
  locked?: true;
  /** É um link simbólico (o alvo fica dentro da raiz; link para fora vem como `locked`). */
  link?: true;
};

/** GET /files/roots. */
export type FileRootsResponse = { roots: FileRoot[] };

/**
 * GET /files/list?root=&path=&offset=&limit=&filter=: uma página dos itens de uma pasta. Pastas primeiro, depois
 * arquivos, em ordem natural de nome ("v0_i2" antes de "v0_i10"). `filter` = parte do nome, sem diferenciar
 * maiúsculas. `total` conta os itens que passam no filtro.
 */
export type FileListResponse = { root: string; path: string; entries: FileEntry[]; total: number; offset: number; more: boolean };

/** Como a tela mostra um arquivo. */
export type FileView = "markdown" | "text" | "image" | "binary" | "locked";

/**
 * GET /files/read?root=&path=&known=: os dados de um arquivo e, se for texto, o conteúdo (até
 * FILE_LIMITS.previewBytes, com segredos mascarados). `version` muda quando o arquivo muda (tamanho + data): a tela
 * manda a que já tem em `known` e recebe `{ unchanged: true }` se nada mudou.
 *
 * Com `edit=1` (só em raiz `writable`) o texto vem EXATO, sem máscara e inteiro, para o editor: salvar um texto
 * mascarado ou cortado estragaria o arquivo. Nesse modo o servidor recusa o que não dá para editar com segurança:
 * arquivo maior que FILE_LIMITS.editBytes, que não é texto ou que não está em UTF-8 válido.
 */
export type FileReadResponse =
  | {
      root: string;
      path: string;
      name: string;
      size: number;
      mtime: string;
      version: string;
      view: FileView;
      /** Só em `markdown` e `text`. */
      text?: string;
      /** O texto veio cortado em FILE_LIMITS.previewBytes. */
      truncated: boolean;
      /** A prévia teve segredo mascarado: o texto mostrado NÃO é igual ao do disco (para editar, a tela pede com `edit`). */
      masked?: true;
    }
  | { unchanged: true; version: string };

/** GET /files/search?root=&q=: arquivos e pastas cujo NOME contém `q` (sem diferenciar maiúsculas), dentro de uma raiz. */
export type FileSearchMatch = { path: string; name: string; kind: FileEntryKind };
export type FileSearchResponse = { root: string; query: string; matches: FileSearchMatch[]; truncated: boolean };

// ---------------------------------------------------------------- alterações (só em raiz `writable`)

/**
 * PUT /files/write: salva o texto de um arquivo. `baseVersion` = a versão que a tela leu: se o arquivo mudou no
 * disco depois disso, o servidor responde 409 e NÃO salva (a tela oferece recarregar ou salvar por cima, que é
 * mandar de novo sem `baseVersion`). Arquivo que ainda não existe é criado.
 */
export type FileWriteResponse = { root: string; path: string; name: string; size: number; mtime: string; version: string };

/** POST /files/create: cria um arquivo vazio ou uma pasta. Já existe = 409. */
export type FileCreateResponse = { root: string; path: string; kind: FileEntryKind };

/** POST /files/rename: renomeia ou move dentro da MESMA raiz. Destino já existe = 409 (com `overwrite`, substitui se for arquivo). */
export type FileRenameResponse = { root: string; path: string };

/** POST /files/delete: apaga um arquivo ou uma pasta inteira, de vez. `deleted` = quantos itens saíram. */
export type FileDeleteResponse = { root: string; path: string; deleted: number };

/** GET /files/count?root=&path=: quantos arquivos e pastas há dentro de uma pasta (para a confirmação de apagar). */
export type FileCountResponse = { root: string; path: string; files: number; dirs: number; truncated: boolean };

/**
 * POST /files/upload?root=&path=<pasta>&name=<nome>&overwrite=1: o corpo é o arquivo cru. Já existe = 409, a não
 * ser com `overwrite`. Responde como o `write`.
 */
export type FileUploadResponse = FileWriteResponse;

/**
 * Por que um nome de item não serve (pt-BR), ou null se serve. Vale para criar, enviar e renomear: sem barra, sem
 * `.`/`..`, sem caractere de controle, até FILE_LIMITS.name, e nunca um nome trancado.
 */
export function fileNameError(name: string, kind: FileEntryKind = "file"): string | null {
  if (name.trim() === "") return "Dê um nome.";
  if (name !== name.trim()) return "O nome não pode começar nem terminar com espaço.";
  if (name.length > FILE_LIMITS.name) return `O nome pode ter até ${FILE_LIMITS.name} caracteres.`;
  if (name === "." || name === "..") return "Esse nome não vale.";
  // eslint-disable-next-line no-control-regex -- recusar justamente os caracteres de controle
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return "O nome não pode ter barra nem caractere de controle.";
  if (kind === "dir" ? isLockedDirName(name) : isLockedFileName(name)) return "Esse nome é de item protegido e não pode ser criado por aqui.";
  return null;
}

// ---------------------------------------------------------------- caminhos relativos

/**
 * Normaliza um caminho relativo a uma raiz: barras `/`, sem barra no começo nem no fim, sem segmento vazio. Devolve
 * null se for inválido (absoluto, com `..`, `.`, barra invertida, caractere nulo ou grande demais). "" = a própria raiz.
 */
export function normalizeFilePath(input: string): string | null {
  if (typeof input !== "string" || input.length > FILE_LIMITS.path || input.includes("\0") || input.includes("\\")) return null;
  if (input.startsWith("/")) return null;
  const parts = input.split("/").filter((part) => part !== "");
  for (const part of parts) if (part === "." || part === "..") return null;
  return parts.join("/");
}

export const joinFilePath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const fileDirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const fileSegments = (path: string): string[] => (path ? path.split("/") : []);

const relativePathSchema = z
  .string()
  .max(FILE_LIMITS.path)
  .default("")
  .transform((value, ctx) => {
    const normalized = normalizeFilePath(value);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: "Caminho inválido" });
      return z.NEVER;
    }
    return normalized;
  });
const rootIdSchema = z.string().min(1).max(64);

export const fileListQuerySchema = z.object({
  root: rootIdSchema,
  path: relativePathSchema,
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(FILE_LIMITS.maxPageSize).default(FILE_LIMITS.pageSize),
  filter: z.string().trim().max(FILE_LIMITS.searchQuery).optional(),
});
export const fileReadQuerySchema = z.object({ root: rootIdSchema, path: relativePathSchema, known: z.string().max(64).optional(), edit: z.string().optional() });
export const fileRawQuerySchema = z.object({ root: rootIdSchema, path: relativePathSchema, download: z.string().optional() });
export const fileSearchQuerySchema = z.object({ root: rootIdSchema, q: z.string().trim().min(1).max(FILE_LIMITS.searchQuery) });
export const fileCountQuerySchema = z.object({ root: rootIdSchema, path: relativePathSchema });

/** Caminho de um item que precisa existir fora da raiz: nunca vazio (a raiz em si não se cria, renomeia nem apaga). */
const itemPathSchema = relativePathSchema.refine((value) => value !== "", { message: "Caminho inválido" });

export const fileWriteBodySchema = z.strictObject({
  root: rootIdSchema,
  path: itemPathSchema,
  /** O servidor confere o tamanho em bytes (FILE_LIMITS.editBytes). */
  text: z.string().max(FILE_LIMITS.editBytes),
  baseVersion: z.string().max(64).optional(),
});
export type FileWriteBody = z.input<typeof fileWriteBodySchema>;

export const fileCreateBodySchema = z.strictObject({ root: rootIdSchema, path: itemPathSchema, kind: z.enum(["file", "dir"]) });
export type FileCreateBody = z.input<typeof fileCreateBodySchema>;

export const fileRenameBodySchema = z.strictObject({ root: rootIdSchema, from: itemPathSchema, to: itemPathSchema, overwrite: z.boolean().optional() });
export type FileRenameBody = z.input<typeof fileRenameBodySchema>;

export const fileDeleteBodySchema = z.strictObject({ root: rootIdSchema, path: itemPathSchema });
export type FileDeleteBody = z.input<typeof fileDeleteBodySchema>;

export const fileUploadQuerySchema = z.object({
  root: rootIdSchema,
  /** A pasta de destino ("" = a raiz). */
  path: relativePathSchema,
  name: z.string().min(1).max(FILE_LIMITS.name),
  overwrite: z.string().optional(),
});

// ---------------------------------------------------------------- endereços

const filesBase = (workspaceId: string): string => `/api/w/${encodeURIComponent(workspaceId)}/files`;
const query = (params: Record<string, string | number | undefined>): string => {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") pairs.push(`${key}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
};

export const fileRootsPath = (workspaceId: string): string => `${filesBase(workspaceId)}/roots`;
export const fileListPath = (workspaceId: string, root: string, path: string, options: { offset?: number; limit?: number; filter?: string } = {}): string =>
  `${filesBase(workspaceId)}/list${query({ root, path, offset: options.offset, limit: options.limit, filter: options.filter })}`;
export const fileReadPath = (workspaceId: string, root: string, path: string, known?: string, edit = false): string =>
  `${filesBase(workspaceId)}/read${query({ root, path, known, edit: edit ? "1" : undefined })}`;
/** O arquivo em si: na tela (imagem) ou, com `download`, como anexo. */
export const fileRawPath = (workspaceId: string, root: string, path: string, download = false): string =>
  `${filesBase(workspaceId)}/raw${query({ root, path, download: download ? "1" : undefined })}`;
export const fileSearchPath = (workspaceId: string, root: string, q: string): string => `${filesBase(workspaceId)}/search${query({ root, q })}`;
export const fileCountPath = (workspaceId: string, root: string, path: string): string => `${filesBase(workspaceId)}/count${query({ root, path })}`;
export const fileWritePath = (workspaceId: string): string => `${filesBase(workspaceId)}/write`;
export const fileCreatePath = (workspaceId: string): string => `${filesBase(workspaceId)}/create`;
export const fileRenamePath = (workspaceId: string): string => `${filesBase(workspaceId)}/rename`;
export const fileDeletePath = (workspaceId: string): string => `${filesBase(workspaceId)}/delete`;
export const fileUploadPath = (workspaceId: string, root: string, dir: string, name: string, overwrite = false): string =>
  `${filesBase(workspaceId)}/upload${query({ root, path: dir, name, overwrite: overwrite ? "1" : undefined })}`;

// ---------------------------------------------------------------- tipos de arquivo

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
/** Imagens que o navegador mostra com segurança numa tag de imagem (SVG fica de fora: é texto com script). */
export const FILE_IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const TEXT_EXT = new Set([
  "txt", "log", "json", "jsonl", "ndjson", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "csv", "tsv", "xml", "svg", "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "py", "rb", "php", "java", "kt", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "lua", "sh", "bash", "zsh", "fish",
  "ps1", "bat", "sql", "graphql", "gql", "proto", "tex", "rst", "adoc", "diff", "patch", "lock", "gitignore", "gitattributes", "dockerignore", "editorconfig", "npmignore", "prettierrc", "eslintrc", "srt", "vtt",
]);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "license", "licence", "readme", "changelog", "authors", "notice", "procfile", "gemfile", "rakefile", "caddyfile", "codeowners"]);

/** Extensão em minúsculas, sem o ponto ("" se não tem). Um nome que começa por ponto (`.gitignore`) conta o resto como extensão. */
export function fileExtension(name: string): string {
  const at = name.lastIndexOf(".");
  return at < 0 ? "" : name.slice(at + 1).toLowerCase();
}

/**
 * O que o NOME diz sobre como mostrar o arquivo. `undefined` = o nome não decide: o servidor olha o começo do
 * conteúdo (sem byte nulo = texto).
 */
export function fileViewByName(name: string): Exclude<FileView, "locked"> | undefined {
  const ext = fileExtension(name);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (ext in FILE_IMAGE_MIME) return "image";
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(name.toLowerCase())) return "text";
  return undefined;
}

/**
 * Arquivo sensível pelo nome: chaves, senhas e credenciais. Aparece na lista com cadeado e não abre nem baixa.
 * `.env.example` e parecidos (modelos sem segredo) abrem normalmente.
 */
export function isLockedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (/^\.env(\..+)?$/.test(lower)) return !/\.(example|sample|template|dist)$/.test(lower);
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)) return !lower.endsWith(".pub");
  if ([".netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd", "device-key.json", "auth.json", "auth-sessions.json"].includes(lower)) return true;
  // O ponto na frente não muda nada: `.credentials.json` é tão sensível quanto `credentials.json`.
  const bare = lower.replace(/^\.+/, "");
  if (/^(credentials?|secrets?|tokens?)(\..+)?$/.test(bare)) return true;
  if (/(^|[._-])(credentials?|secrets?)\.(json|ya?ml|toml|txt)$/.test(lower)) return true;
  return false;
}

/**
 * Pasta sensível pelo nome, dentro da raiz "Dados do workspace": `browser` guarda o perfil do navegador dos agentes
 * (cookies e logins). Vale só para o primeiro nível dessa raiz.
 */
export const LOCKED_DATA_DIRS = ["browser"] as const;

/** Pasta sensível em qualquer raiz e em qualquer nível. */
export function isLockedDirName(name: string): boolean {
  return [".ssh", ".gnupg", ".aws", ".kube"].includes(name.toLowerCase());
}

// ---------------------------------------------------------------- ordem e rótulos

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

/** Ordem natural de nomes ("v0_i2" antes de "v0_i10"; maiúsculas e acentos não mudam a ordem). */
export function compareFileNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Pastas primeiro, depois arquivos; dentro de cada grupo, ordem natural. */
export function compareFileEntries(a: Pick<FileEntry, "name" | "kind">, b: Pick<FileEntry, "name" | "kind">): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return compareFileNames(a.name, b.name);
}

/** Tamanho legível em pt-BR: "812 B", "48 KB", "1,4 MB", "2,1 GB". */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(".", ",").replace(/,0$/, "");
  return `${text} ${units[unit]}`;
}

/** A versão de um arquivo para o `known` da leitura (tamanho + data de modificação em ms). */
export const fileVersion = (size: number, mtimeMs: number): string => `${size}-${Math.round(mtimeMs)}`;
