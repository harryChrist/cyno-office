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
