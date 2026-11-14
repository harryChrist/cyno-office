import { z } from "zod";

/**
 * Atividade: o histórico do que foi feito no escritório (tarefas, aprovações, publicações, rotinas,
 * mídia, planos, agentes) e, à parte, os eventos do servidor (subiu, parou, caiu, memória baixa).
 * Um arquivo JSONL por dia (dia de São Paulo): `workspaces/<ws>/activity/AAAA-MM-DD.jsonl` e, para o
 * que é do servidor inteiro, `activity/AAAA-MM-DD.jsonl`. Nunca guarda segredos nem conteúdo de páginas.
 */

export const ACTIVITY_CATEGORIES = ["tarefa", "aprovacao", "publicacao", "rotina", "midia", "plano", "agente", "agenda", "sistema", "gasto"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  tarefa: "Tarefas",
  aprovacao: "Aprovações",
  publicacao: "Publicações",
  rotina: "Rotinas",
  midia: "Mídia",
  plano: "Planos",
  agente: "Agentes",
  agenda: "Agenda",
  sistema: "Sistema",
  gasto: "Gastos",
};

/** Quem fez: o usuário, o Maestro, o sistema (rotinas, servidor) ou o id de um agente. */
export const ACTIVITY_USER = "usuario";
export const ACTIVITY_MAESTRO = "maestro";
export const ACTIVITY_SYSTEM = "sistema";

export type ActivityRefs = {
  taskId?: string;
  rootTaskId?: string;
  forYouId?: string;
  routineId?: string;
  mediaId?: string;
  planId?: string;
  url?: string;
};

export type ActivityEntry = {
  id: string;
  /** ISO 8601 com o deslocamento de São Paulo (ex.: 2026-11-10T14:03:22.114-03:00). */
  at: string;
  workspaceId?: string;
  category: ActivityCategory;
  /** O que aconteceu, curto e estável (ex.: "concluida", "pedida", "publicada"). */
  action: string;
  actor: string;
  /** Uma frase em pt-BR. */
  summary: string;
  refs?: ActivityRefs;
  /** Detalhes pequenos (durationMs, costUsd, tokens, error, backfill…). */
  data?: Record<string, unknown>;
};

export const ACTIVITY_LIMITS = { defaultLimit: 100, maxLimit: 500 } as const;

const dateBound = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)), "use uma data (AAAA-MM-DD) ou data e hora ISO");
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/** GET /api/w/:ws/activity e GET /api/activity/system (mais novos primeiro). */
export const activityQuerySchema = z.object({
  from: z.preprocess(emptyToUndefined, dateBound.optional()),
  to: z.preprocess(emptyToUndefined, dateBound.optional()),
  category: z.preprocess(
    (value) => (typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : value),
    z.array(z.enum(ACTIVITY_CATEGORIES)).min(1).optional(),
  ),
  actor: z.preprocess(emptyToUndefined, z.string().max(80).optional()),
  q: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(ACTIVITY_LIMITS.maxLimit).default(ACTIVITY_LIMITS.defaultLimit)),
  cursor: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
});
export type ActivityQuery = z.output<typeof activityQuerySchema>;
export type ActivityQueryInput = z.input<typeof activityQuerySchema>;

export type ActivityResponse = {
  entries: ActivityEntry[];
  /** Passe como `cursor` para a próxima página; ausente = acabou. */
  nextCursor?: string;
};

/** GET /api/w/:ws/activity/summary?day= (ou from= e to=, para a semana). */
export const activitySummaryQuerySchema = z.object({
  day: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  from: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
});

export type ActivitySummary = {
  from: string;
  to: string;
  total: number;
  byCategory: Partial<Record<ActivityCategory, number>>;
  tasksDone: number;
  tasksFailed: number;
  approvals: { requested: number; approved: number; rejected: number; answered: number };
  publications: number;
  media: number;
  /** Soma do custo equivalente em dólar das tarefas concluídas (só as que têm custo registrado). */
  costUsd: number;
  tokens: number;
};

/** Como o processo anterior parou: limpo, morto/caiu (sem marca de desligamento), erro não tratado, reinício da máquina ou desconhecido. */
export type SystemPreviousStop = "clean" | "crash_or_kill" | "crash" | "system_reboot" | "unknown";

/** Estado do servidor agora (do batimento): subida, memória da última amostra. */
export type ActivityServerInfo = {
  pid: number;
  startedAt: string;
  heartbeatAt?: string;
  memAvailableMb?: number;
  memAvailablePct?: number;
  swapUsedMb?: number;
  serverRssMb?: number;
  terminalsRssMb?: number;
  browserRssMb?: number;
};

export type ActivitySystemResponse = ActivityResponse & { server?: ActivityServerInfo };

export const activityPath = (workspaceId: string) => `/api/w/${encodeURIComponent(workspaceId)}/activity`;
export const ACTIVITY_SYSTEM_PATH = "/api/activity/system";
