import { z } from "zod";

/**
 * Navegação de pastas do disco do servidor (`GET /api/fs/browse`): usada pelo seletor de pastas
 * no navegador (Linux, Docker ou acesso remoto). Lista apenas nomes de subpastas (nunca arquivos).
 */
export const FS_BROWSE_PATH = "/api/fs/browse";

/** Quantidade máxima de subpastas devolvidas por consulta (acima disso, `truncated: true`). */
export const FS_BROWSE_LIMIT = 500;

/** Query de `GET /api/fs/browse?path=<caminho>&hidden=0|1`. */
export const fsBrowseQuerySchema = z.object({
  path: z.string().max(4096).optional(),
  hidden: z.enum(["0", "1"]).optional(),
});
export type FsBrowseQuery = z.infer<typeof fsBrowseQuerySchema>;

/** Uma subpasta devolvida pela navegação. */
export const fsBrowseEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isGitRepo: z.boolean(),
});
export type FsBrowseEntry = z.infer<typeof fsBrowseEntrySchema>;

/** Resposta de `GET /api/fs/browse`. */
export const fsBrowseResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(fsBrowseEntrySchema),
  roots: z.array(z.string()),
  home: z.string(),
  truncated: z.boolean(),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

/** Monta a URL de `GET /api/fs/browse` com `path` e `hidden` opcionais. */
export function fsBrowsePath(dirPath?: string, hidden = false): string {
  const parts: string[] = [];
  if (dirPath !== undefined && dirPath.trim().length > 0) parts.push(`path=${encodeURIComponent(dirPath)}`);
  if (hidden) parts.push("hidden=1");
  return parts.length > 0 ? `${FS_BROWSE_PATH}?${parts.join("&")}` : FS_BROWSE_PATH;
}
