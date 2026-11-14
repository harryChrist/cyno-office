import { z } from "zod";

/**
 * Configurações do server (da instalação, não de um workspace nem do navegador), gravadas em
 * `DATA_DIR/settings.json`. Por enquanto só a retenção do histórico em disco.
 */

/** Dias que cada tipo de histórico fica no disco; 0 = nunca apagar. */
export const RETENTION_DAY_OPTIONS = {
  /** Conversas internas das CLIs dos NOSSOS agentes (Claude Code: ~/.claude/projects/<pasta do agente>/). */
  transcripts: [1, 3, 7, 14, 30, 90, 0],
  /** Logs de trabalho das tarefas (`data/workspaces/<ws>/logs/*.jsonl`). */
  logs: [7, 30, 90, 180, 365, 0],
} as const;

export const retentionSettingsSchema = z.object({
  transcriptsDays: z.number().int().min(0).max(3650),
  logsDays: z.number().int().min(0).max(3650),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

/** Padrões: conversas das CLIs por 7 dias; logs das tarefas por 90 dias. Tarefas, resultados e Cérebro ficam para sempre. */
export const DEFAULT_RETENTION: RetentionSettings = { transcriptsDays: 7, logsDays: 90 };

/** PATCH /api/settings/retention (só os campos que mudam). */
export const updateRetentionBodySchema = z.strictObject({
  transcriptsDays: retentionSettingsSchema.shape.transcriptsDays.optional(),
  logsDays: retentionSettingsSchema.shape.logsDays.optional(),
});
export type UpdateRetentionBody = z.input<typeof updateRetentionBodySchema>;

/** Uso de disco de uma categoria. */
export type DiskUsage = { bytes: number; files: number };

/** Resultado de uma limpeza. */
export type RetentionCleanupResult = {
  at: string;
  /** Arquivos apagados e bytes liberados, por categoria. */
  transcripts: DiskUsage;
  logs: DiskUsage;
};

/**
 * GET /api/settings/retention: a configuração, o uso de disco de cada categoria e a última limpeza.
 * `transcriptsManaged` = false quando o server não sabe onde ficam as conversas do Claude Code
 * (nada é apagado). O Antigravity guarda as conversas fora da pasta dos agentes (não gerenciado).
 */
export type RetentionResponse = {
  settings: RetentionSettings;
  usage: { transcripts: DiskUsage; logs: DiskUsage; brains: DiskUsage; tasks: DiskUsage };
  transcriptsManaged: boolean;
  lastCleanup: RetentionCleanupResult | null;
};

export const RETENTION_PATH = "/api/settings/retention";
export const RETENTION_CLEANUP_PATH = "/api/settings/retention/cleanup";
