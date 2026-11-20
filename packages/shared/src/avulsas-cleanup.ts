import { z } from "zod";
/** Prazos oferecidos ao dono para apagar avulsas terminadas (0 = qualquer idade / na retenção, "nunca"). */
export const AVULSAS_CLEANUP_DAYS = [0, 7, 14, 30, 90, 180] as const;
export const avulsasCleanupQuerySchema = z.object({ olderThanDays: z.coerce.number().int().min(0).max(365) });
export const avulsasCleanupBodySchema = z.object({ olderThanDays: z.number().int().min(0).max(365), includeArchive: z.boolean().optional() });
export type AvulsasCleanupBody = z.infer<typeof avulsasCleanupBodySchema>;
export type AvulsasCleanupPreview = { count: number; archivedCount: number; oldestAt?: string };
export type AvulsasCleanupResult = { deleted: number; archivedDeleted: number };
export type ProjectDeleteResult = { deleted: { tasks: number; logs: number } };
