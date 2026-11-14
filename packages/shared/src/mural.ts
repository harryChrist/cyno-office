import { z } from "zod";
import { MAX_ID_LENGTH } from "./ids";
import { MEDIA_KINDS } from "./media";

/**
 * Mural: o que um workspace compartilha com a plataforma (mídia, entrega, nota) para os outros
 * aproveitarem. Nenhum workspace lê arquivo de outro direto: `mural_use` copia. Declarada na Fatia 1
 * do Cyno; o serviço, as ferramentas e a aba entram na Fatia 6.
 */

export const MURAL_ID_PATTERN = /^N-\d{4,}$/;
export const MURAL_LIMITS = { title: 120, note: 500, text: 2000, tags: 5, active: 200, perDayPerWorkspace: 10 } as const;

export const muralEntrySchema = z.object({
  id: z.string().regex(MURAL_ID_PATTERN),
  kind: z.enum(["media", "deliverable", "note"]),
  workspace: z.string().max(MAX_ID_LENGTH),
  by: z.string().max(140),
  title: z.string().trim().min(1).max(MURAL_LIMITS.title),
  note: z.string().max(MURAL_LIMITS.note).default(""),
  mediaRef: z.object({ workspace: z.string().max(MAX_ID_LENGTH), mediaId: z.string().max(16) }).optional(),
  /** Tipo da mídia compartilhada (a tela escolhe imagem, vídeo ou ícone sem abrir o arquivo). */
  mediaKind: z.enum(MEDIA_KINDS).optional(),
  projectRef: z.object({ workspace: z.string().max(MAX_ID_LENGTH), projectId: z.string().max(80) }).optional(),
  text: z.string().max(MURAL_LIMITS.text).optional(),
  tags: z.array(z.string().max(40)).max(MURAL_LIMITS.tags).default([]),
  createdAt: z.iso.datetime(),
  seenBy: z.record(z.string(), z.string()).default({}),
  usedBy: z.array(z.string().max(MAX_ID_LENGTH)).default([]),
  status: z.enum(["ativo", "retirado"]).default("ativo"),
});
export type MuralEntry = z.output<typeof muralEntrySchema>;

/** `mural-seen.json` de cada workspace: até onde o Maestro já viu o mural. */
export const muralSeenSchema = z.object({ seenUntil: z.iso.datetime().optional() });

// ---------- API e eventos (Fatia 6) ----------

/** GET /api/mural -> MuralResponse; POST /api/mural/share; POST /api/mural/:id/use; DELETE /api/mural/:id (retira). */
export const MURAL_PATH = "/api/mural";

/** O mural como o dono vê: as entradas (as mais novas primeiro) e, por workspace, quantas ele ainda não viu. */
export type MuralResponse = { entries: MuralEntry[]; news: Record<string, number> };

/** POST /api/mural/share: o dono compartilha uma mídia ou uma nota em nome de um workspace. */
export const muralShareBodySchema = z.strictObject({
  workspace: z.string().trim().min(1).max(MAX_ID_LENGTH),
  mediaId: z.string().trim().max(16).optional(),
  projectId: z.string().trim().max(80).optional(),
  text: z.string().trim().max(MURAL_LIMITS.text).optional(),
  title: z.string().trim().max(MURAL_LIMITS.title).optional(),
  note: z.string().trim().max(MURAL_LIMITS.note).optional(),
});
export type MuralShareBody = z.input<typeof muralShareBodySchema>;

/** POST /api/mural/:id/use: o workspace traz o item para a própria biblioteca de mídia. */
export const muralUseBodySchema = z.strictObject({ workspace: z.string().trim().min(1).max(MAX_ID_LENGTH) });
export type MuralUseBody = z.input<typeof muralUseBodySchema>;
export type MuralUseResponse = { mediaId: string; workspace: string; entry: MuralEntry };

/** O mural mudou (entrada nova, retirada ou usada): a tela busca de novo. */
export type MuralServerEvent = { type: "mural:changed" };
export const MURAL_EVENT_TYPES = ["mural:changed"] as const;
