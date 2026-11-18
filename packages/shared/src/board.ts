import { z } from "zod";

/**
 * Quadro do workspace: um mural de dados para o DONO olhar. Os agentes guardam os dados num JSON
 * (qualquer formato) e escrevem a página HTML que mostra esses dados; a interface mostra a página
 * dentro de um iframe isolado (veja board-kit/document.ts). Diferente do Cérebro (texto curto que o
 * agente lê), o Quadro aguenta dado volumoso e ninguém precisa lê-lo ao iniciar.
 *
 * Em disco (data/workspaces/<ws>/boards/): `boards.json` (índice: Board[]), `<id>/page.html` e
 * `<id>/data.json`. Os nomes e descrições das ferramentas MCP ficam em inglês (mcp/board-tools.ts).
 */

/** Limites (bytes e caracteres). A página e os dados têm teto para não travar a tela. */
export const BOARD_LIMITS = {
  /** Quadros por workspace. */
  max: 100,
  title: 120,
  description: 300,
  source: 600,
  /** Página HTML (bytes). */
  pageBytes: 1024 * 1024,
  /** Dados JSON (bytes). */
  dataBytes: 20 * 1024 * 1024,
} as const;

export const BOARD_ID_PATTERN = /^Q-\d{4,}$/;
export const boardIdSchema = z.string().regex(BOARD_ID_PATTERN, "id inválido: use o formato Q-0001");

/** "Q-0001", sequencial por workspace. */
export function nextBoardId(items: readonly { id: string }[]): string {
  let max = 0;
  for (const item of items) {
    const n = Number(item.id.slice(2));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `Q-${String(max + 1).padStart(4, "0")}`;
}

/** Quem criou quando não foi um agente (hoje só agentes criam). */
export const BOARD_USER_CREATOR = "usuario";

export const boardSchema = z.object({
  id: boardIdSchema,
  title: z.string().min(1).max(BOARD_LIMITS.title),
  /** Uma linha: o que o quadro mostra. */
  description: z.string().max(BOARD_LIMITS.description),
  /** Como os dados são atualizados (ex.: "script atualizar.py na pasta obras"), para qualquer agente saber atualizar depois. */
  source: z.string().max(BOARD_LIMITS.source).optional(),
  /** Id do agente ou "usuario". */
  createdBy: z.string().min(1).max(80),
  createdAt: z.iso.datetime(),
  pageUpdatedAt: z.iso.datetime(),
  dataUpdatedAt: z.iso.datetime(),
  pageBytes: z.number().int().min(0),
  dataBytes: z.number().int().min(0),
});
export type Board = z.output<typeof boardSchema>;

/** boards/boards.json */
export const boardsFileSchema = z.array(boardSchema);

export const boardParamsSchema = z.object({ id: boardIdSchema });

/** PATCH /boards/:id: o dono renomeia (título e descrição). */
export const updateBoardBodySchema = z
  .strictObject({
    title: z.string().trim().min(1, "Dê um título ao quadro.").max(BOARD_LIMITS.title, `O título pode ter até ${BOARD_LIMITS.title} caracteres.`).optional(),
    description: z.string().trim().max(BOARD_LIMITS.description, `A descrição pode ter até ${BOARD_LIMITS.description} caracteres.`).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "Nada para mudar" });
export type UpdateBoardBody = z.input<typeof updateBoardBodySchema>;

/** O que mudou num `board:upserted`: a interface só recarrega o que mudou (dados = reenviar por postMessage, sem recarregar o iframe). */
export type BoardChange = "meta" | "page" | "data";

/** Rotas (dentro de /api/w/:ws). */
export const boardsPath = "/boards";
export const boardPath = (id: string) => `/boards/${encodeURIComponent(id)}`;
export const boardPagePath = (id: string) => `${boardPath(id)}/page`;
export const boardDataPath = (id: string) => `${boardPath(id)}/data`;

// ---------- Compartilhar por link e baixar ----------

/**
 * Link público de um Quadro: quem tem o link vê SÓ aquele quadro (uma foto do momento a cada abertura), sem senha e sem
 * mais nada do app. Só o dono liga, troca e desliga (os agentes não têm ferramenta para isso). O token NUNCA entra em
 * `Board` nem em evento: fica num arquivo da plataforma e só sai pelas rotas do dono.
 */
export const BOARD_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Validade do link em dias, escolhida ao compartilhar; 0 = sem validade. */
export const BOARD_SHARE_EXPIRY_DAY_OPTIONS = [0, 1, 7, 30] as const;

/** Estado do compartilhamento de um Quadro (rotas do dono). `path` é o caminho público, a juntar com o endereço do app. */
export type BoardShare = { shared: false } | { shared: true; token: string; path: string; createdAt: string; expiresAt?: string };

/** PUT /boards/:id/share: liga (cria o link se não houver) ou troca a validade. Sem `expiresInDays`, ou 0, o link não vence. */
export const setBoardShareBodySchema = z.strictObject({ expiresInDays: z.number().int().min(0).max(365).optional() });
export type SetBoardShareBody = z.input<typeof setBoardShareBodySchema>;

/** Rotas do dono (dentro de /api/w/:ws): GET e PUT e DELETE em `boardSharePath`; POST em `boardShareRotatePath` troca o token. */
export const boardSharePath = (id: string) => `${boardPath(id)}/share`;
export const boardShareRotatePath = (id: string) => `${boardSharePath(id)}/rotate`;

/** Rota pública (fora de /api/w/:ws e fora da senha): devolve o documento HTML pronto do quadro. */
export const PUBLIC_BOARD_PATH_PREFIX = "/api/share/";
export const publicBoardPath = (token: string) => `${PUBLIC_BOARD_PATH_PREFIX}${token}`;

/** O que um documento público (link ou arquivo baixado) leva do quadro: nada de ids, agentes, origem dos dados ou tamanhos. */
export type PublicBoardMeta = { title: string; description: string; dataUpdatedAt: string };
export function publicBoardMeta(board: Pick<Board, "title" | "description" | "dataUpdatedAt">): PublicBoardMeta {
  return { title: board.title, description: board.description, dataUpdatedAt: board.dataUpdatedAt };
}

/** Formatos que o SERVIDOR gera (GET `boardExportPath`, download). HTML, JSON, Markdown e CSV saem na própria tela. */
export const BOARD_SERVER_EXPORT_FORMATS = ["pdf"] as const;
export type BoardServerExportFormat = (typeof BOARD_SERVER_EXPORT_FORMATS)[number];
export const boardExportQuerySchema = z.object({ format: z.enum(BOARD_SERVER_EXPORT_FORMATS) });
export const boardExportPath = (id: string, format: BoardServerExportFormat) => `${boardPath(id)}/export?format=${format}`;

/**
 * Exportação feita pelo kit dentro do iframe (ele é isolado: a tela só conversa por postMessage).
 *   mãe para o iframe:  { type: "quadro:export", requestId, format: "md" | "csv" }
 *   iframe para a mãe:  { type: "quadro:export-result", requestId, format, ok: true, text } ou { ..., ok: false, error }
 * No kit: `Quadro.toMarkdown()`, `Quadro.toCsv()`, `Quadro.expandAll()` (mostra todas as linhas das tabelas, para imprimir),
 * `Quadro.exportMarkdown(fn)` (a página do agente escreve o próprio Markdown) e `window.__quadroSettled === true` quando o
 * primeiro desenho terminou (o servidor espera por isso antes de gerar o PDF).
 */
export const BOARD_KIT_EXPORT_FORMATS = ["md", "csv"] as const;
export type BoardKitExportFormat = (typeof BOARD_KIT_EXPORT_FORMATS)[number];
export type BoardExportRequestMessage = { type: "quadro:export"; requestId: string; format: BoardKitExportFormat };
export type BoardExportResultMessage = { type: "quadro:export-result"; requestId: string; format: BoardKitExportFormat } & ({ ok: true; text: string } | { ok: false; error: string });

/** Nome do arquivo baixado: o título em minúsculas sem acento, com hífens, e a extensão ("obras-do-site.pdf"). */
export function boardFileName(title: string, extension: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "quadro"}.${extension}`;
}

/** Mais mexido por último: o Quadro que o dono viu mudar mais recentemente vem primeiro. */
export function boardActivityAt(board: Pick<Board, "pageUpdatedAt" | "dataUpdatedAt" | "createdAt">): string {
  return [board.pageUpdatedAt, board.dataUpdatedAt, board.createdAt].reduce((a, b) => (a > b ? a : b));
}

/**
 * JSON Merge Patch (RFC 7396): `patch` objeto mescla chave a chave (`null` apaga a chave); qualquer outro
 * valor (lista, texto, número) substitui o alvo inteiro. Listas NÃO são mescladas (a lista nova troca a antiga).
 * Não altera os argumentos; ignora a chave `__proto__`.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> = typeof target === "object" && target !== null && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === "__proto__") continue;
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}
