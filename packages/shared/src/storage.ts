import { z } from "zod";

/**
 * Espaço em disco (contador "Espaço em disco" das Configurações): a pasta de dados do workspace e as
 * pastas de trabalho dele. O servidor mede em segundo plano (com cache) e a rota responde na hora com o
 * que já tem; `state` diz se o número está pronto, sendo calculado ou se a pasta não pôde ser lida.
 */
export const STORAGE_STATES = ["ready", "computing", "error"] as const;
export type StorageState = (typeof STORAGE_STATES)[number];

/** Partes da pasta do workspace (subpastas de primeiro nível), na ordem em que aparecem na barra. */
export const STORAGE_PART_IDS = ["media", "agents", "logs", "brains", "boards", "other"] as const;
export type StoragePartId = (typeof STORAGE_PART_IDS)[number];
export const STORAGE_PART_LABELS: Record<StoragePartId, string> = {
  media: "Mídia",
  agents: "Agentes",
  logs: "Registros",
  brains: "Cérebro",
  boards: "Quadros",
  other: "Outros",
};

/** Subpasta de primeiro nível de dados do workspace -> parte (o que não está aqui vira "Outros"). */
export function storagePartOf(dirName: string): StoragePartId {
  switch (dirName) {
    case "media":
      return "media";
    case "agents":
      return "agents";
    case "logs":
      return "logs";
    case "brains":
      return "brains";
    case "boards":
      return "boards";
    default:
      return "other";
  }
}

export const storagePartSchema = z.object({ id: z.enum(STORAGE_PART_IDS), label: z.string(), bytes: z.number().int().nonnegative() });
export type StoragePart = z.infer<typeof storagePartSchema>;

export const storageFolderSchema = z.object({
  id: z.string(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  state: z.enum(STORAGE_STATES),
  computedAt: z.string().nullable(),
});
export type StorageFolder = z.infer<typeof storageFolderSchema>;

export const storageWorkspaceSchema = z.object({
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  state: z.enum(STORAGE_STATES),
  computedAt: z.string().nullable(),
  parts: z.array(storagePartSchema),
});
export type StorageWorkspace = z.infer<typeof storageWorkspaceSchema>;

/** GET /api/w/:ws/storage e POST /api/w/:ws/storage/refresh. */
export const storageResponseSchema = z.object({ workspace: storageWorkspaceSchema, folders: z.array(storageFolderSchema) });
export type StorageResponse = z.infer<typeof storageResponseSchema>;

export const STORAGE_PATH = "storage";
