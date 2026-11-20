import { z } from "zod";

/**
 * Armazenamento dos motores: quanto cada motor guarda em disco e a limpeza (opcional, por idade) do que é
 * dos agentes do Cyno. Tudo vem desligado (0 = nunca apagar). Configuração da instalação, em
 * `DATA_DIR/platform/engine-storage.json`.
 */

/** Dias aceitos para apagar sozinho; 0 = nunca. */
export const ENGINE_STORAGE_DAY_OPTIONS = [0, 7, 14, 30, 90] as const;

const daysSchema = z
  .number()
  .int()
  .refine((value) => (ENGINE_STORAGE_DAY_OPTIONS as readonly number[]).includes(value), { message: "dias inválidos" });

export const engineStorageSettingsSchema = z.object({
  /** Logs do Antigravity (`log/cli-AAAAMMDD_HHMMSS.log`) mais velhos que isso saem; 0 = nunca. */
  antigravityLogsDays: daysSchema.default(0),
  /** Chats dos agentes do Cyno no Freebuff (`projects/fb-NOME/chats`) mais velhos que isso saem; 0 = nunca. */
  freebuffChatsDays: daysSchema.default(0),
});
export type EngineStorageSettings = z.infer<typeof engineStorageSettingsSchema>;

export const DEFAULT_ENGINE_STORAGE: EngineStorageSettings = { antigravityLogsDays: 0, freebuffChatsDays: 0 };

/** PUT /api/settings/engine-storage (só os campos que mudam). */
export const updateEngineStorageBodySchema = z.strictObject({
  antigravityLogsDays: daysSchema.optional(),
  freebuffChatsDays: daysSchema.optional(),
});
export type UpdateEngineStorageBody = z.input<typeof updateEngineStorageBodySchema>;

/** Query do GET .../preview (cada campo ausente usa o valor salvo). */
export const engineStoragePreviewQuerySchema = z.strictObject({
  antigravityLogsDays: z.coerce.number().pipe(daysSchema).optional(),
  freebuffChatsDays: z.coerce.number().pipe(daysSchema).optional(),
});

/** Quanto ocupa uma pasta: bytes, arquivos e a data (ISO) do arquivo mais velho, quando há. */
export type EngineStorageItem = { bytes: number; files: number; oldestAt: string | null };

export type EngineStorageUsage = {
  /** Conversas dos agentes do Cyno no Claude Code (a limpeza fica em Histórico). */
  claude: EngineStorageItem;
  antigravity: {
    /** `log/`: a limpeza por idade vale só para `cli-AAAAMMDD_HHMMSS.log`. */
    logs: EngineStorageItem;
    /** `conversations/` e `brain/`: só medido; inclui as conversas pessoais do dono. */
    conversations: EngineStorageItem;
  };
  freebuff: {
    /** `projects/fb-NOME/chats`: só as pastas dos agentes do Cyno. */
    chats: EngineStorageItem;
  };
  hermes: {
    /** Tudo na pasta de estado do Cyno (inclui o ambiente instalado). */
    total: EngineStorageItem;
    /** A parte que é cache (pastas `cache` e `.cache`). */
    cache: EngineStorageItem;
  };
  openclaw: EngineStorageItem;
};

/** Arquivos apagados (ou que sairiam, na pré-visualização) e bytes liberados. */
export type EngineStorageRemoval = { files: number; bytes: number };

export type EngineStoragePreview = { antigravityLogs: EngineStorageRemoval; freebuffChats: EngineStorageRemoval };

export type EngineStorageCleanupResult = EngineStoragePreview & { at: string };

/** GET /api/settings/engine-storage */
export type EngineStorageResponse = {
  settings: EngineStorageSettings;
  usage: EngineStorageUsage;
  lastCleanup: EngineStorageCleanupResult | null;
};

export const ENGINE_STORAGE_PATH = "/api/settings/engine-storage";
export const ENGINE_STORAGE_PREVIEW_PATH = "/api/settings/engine-storage/preview";
export const ENGINE_STORAGE_CLEANUP_PATH = "/api/settings/engine-storage/cleanup";
