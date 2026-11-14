import { z } from "zod";
import { metricsReportSchema } from "./metrics";

/**
 * Relatórios da Gestão (fatia 5): o resumo do dia, a revisão da semana e o mensal. Tudo por código, sobre o
 * `MetricsReport`; o relatório de um período fechado é GRAVADO congelado e nunca muda. A retrospectiva
 * (`retro`) é da fatia 6: a pasta `reports/retro/` fica livre para ela.
 */

export const REPORT_KINDS = ["day", "week", "month"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_KIND_LABELS: Record<ReportKind, string> = { day: "Dia", week: "Semana", month: "Mês" };

/** Rotas do workspace (dentro de `/api/w/:ws`). */
export const WORKSPACE_REPORTS_PATH = "/reports";
export const WORKSPACE_REPORTS_GENERATE_PATH = "/reports/generate";
export const workspaceReportPath = (workspace: string, kind: ReportKind, period: string): string => `/api/w/${encodeURIComponent(workspace)}${WORKSPACE_REPORTS_PATH}/${kind}/${encodeURIComponent(period)}`;

/** Dias que o resumo do dia fica guardado (semana e mês não são apagados). */
export const REPORT_DAY_RETENTION_DAYS = 90;

// ---------- Configurações (`Workspace.gestao`) ----------

export const GESTAO_WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"] as const;
export type GestaoWeekday = (typeof GESTAO_WEEKDAYS)[number];
export const GESTAO_WEEKDAY_LABELS: Record<GestaoWeekday, string> = { seg: "segunda", ter: "terça", qua: "quarta", qui: "quinta", sex: "sexta", sab: "sábado", dom: "domingo" };

export type GestaoSettings = {
  /** Horário do resumo do dia ("18:30"); null = não gera sozinho (continua dando para gerar na mão). */
  dailyAt: string | null;
  /** Dia e horário da revisão da semana ("seg 08:30"). Na segunda ela fecha a semana que passou; em outro dia, a semana de agora. */
  weekly: string;
  /** Parágrafo escrito pelo Maestro por cima dos números (desligado por padrão: ligar gasta cota). */
  ai: { daily: boolean; weekly: boolean };
};

export const DEFAULT_GESTAO: GestaoSettings = { dailyAt: "18:30", weekly: "seg 08:30", ai: { daily: false, weekly: false } };

/** O que o workspace guarda (só o que o dono mexeu; o resto vale o padrão). */
export type GestaoOverrides = { dailyAt?: string | null; weekly?: string; ai?: { daily?: boolean; weekly?: boolean } };

/** "18:30" -> minutos desde a meia-noite (undefined se inválido). */
export function parseGestaoClock(text: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** "seg 08:30" -> dia da semana ISO (1 = segunda) e minutos desde a meia-noite (undefined se inválido). */
export function parseGestaoWeekly(text: string): { weekday: number; minutes: number } | undefined {
  const match = /^(seg|ter|qua|qui|sex|sab|dom)\s+(\d{2}:\d{2})$/.exec(text.trim().toLowerCase());
  if (!match) return undefined;
  const minutes = parseGestaoClock(match[2]!);
  return minutes === undefined ? undefined : { weekday: GESTAO_WEEKDAYS.indexOf(match[1] as GestaoWeekday) + 1, minutes };
}

/** O que vale agora: o que o workspace guardou, completado com o padrão (valor inválido guardado vira o padrão). */
export function gestaoSettings(own?: GestaoOverrides): GestaoSettings {
  const dailyAt = own?.dailyAt === undefined ? DEFAULT_GESTAO.dailyAt : own.dailyAt === null ? null : parseGestaoClock(own.dailyAt) === undefined ? DEFAULT_GESTAO.dailyAt : own.dailyAt.trim();
  const weekly = own?.weekly !== undefined && parseGestaoWeekly(own.weekly) ? own.weekly.trim().toLowerCase() : DEFAULT_GESTAO.weekly;
  return { dailyAt, weekly, ai: { daily: own?.ai?.daily === true, weekly: own?.ai?.weekly === true } };
}

/** Corpo do `PATCH /api/workspaces/:ws` na parte `gestao`. */
export const gestaoPatchSchema = z
  .strictObject({
    dailyAt: z
      .string()
      .refine((value) => parseGestaoClock(value) !== undefined, { message: "Use o horário no formato 18:30" })
      .nullable()
      .optional(),
    weekly: z
      .string()
      .refine((value) => parseGestaoWeekly(value) !== undefined, { message: 'Use o dia e o horário, como "seg 08:30"' })
      .optional(),
    ai: z.strictObject({ daily: z.boolean().optional(), weekly: z.boolean().optional() }).optional(),
  })
  .refine((body) => body.dailyAt !== undefined || body.weekly !== undefined || body.ai !== undefined, { message: "Nada para mudar" });

// ---------- Relatório guardado ----------

const nullableNumber = z.number().nullable();
const rateSchema = z.object({ hits: z.number().int().nonnegative(), n: z.number().int().nonnegative() });
const medianSchema = z.object({ median: nullableNumber, p90: nullableNumber, n: z.number().int().nonnegative() });

/**
 * O resumo dos números de um período, somável: é o que o mensal soma (semana a semana) e o que a plataforma soma
 * (workspace a workspace). Taxas guardam `hits/n` (somam sem perder nada); medianas não somam, ficam por semana.
 */
export const reportDigestSchema = z.object({
  deliveries: z.number().int().nonnegative(),
  /** Gasto equivalente à API (USD) de tudo o que os agentes usaram no período; NÃO é o que se paga (assinatura). */
  spendUsd: z.number().nonnegative(),
  /** Custo equivalente das entregas (soma) e por entrega. */
  deliveryCostUsd: z.number().nonnegative(),
  costPerDelivery: nullableNumber,
  cycle: medianSchema,
  approvalWait: medianSchema,
  failure: rateSchema,
  rejection: rateSchema,
  rework: rateSchema,
  edit: rateSchema,
  goals: z.object({ hit: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  /** Maior uso (%) entre as janelas de cota lidas na hora de gerar; null = sem leitura. */
  quotaPeak: nullableNumber,
});
export type ReportDigest = z.infer<typeof reportDigestSchema>;

export const reportDeliverySchema = z.object({
  title: z.string(),
  at: z.string(),
  kind: z.enum(["projeto", "rotina"]),
  agentId: z.string().optional(),
  agent: z.string().optional(),
  /** Onde abrir no app: projeto + tarefa. */
  projectId: z.string().optional(),
  ref: z.string().optional(),
  /** O link da entrega de uma rotina (a publicação). */
  url: z.string().optional(),
});
export type ReportDelivery = z.infer<typeof reportDeliverySchema>;

export const reportGoalSchema = z.object({ routineId: z.string(), title: z.string(), periodKey: z.string(), target: z.number(), delivered: z.number(), outcome: z.enum(["bateu", "nao_bateu", "pulada"]) });
export type ReportGoal = z.infer<typeof reportGoalSchema>;

export const reportSectionsSchema = z.object({
  /** Gerado dentro do próprio período: "o que vem a seguir" vale. Gerado depois (dia passado pedido na hora): a posição de agora não é a daquele dia. */
  live: z.boolean(),
  /** Nome de cada agente do workspace (id -> nome): os itens de metrics só trazem o id. */
  names: z.record(z.string(), z.string()),
  /** O que cada agente fez (do que mais entregou ao que menos), com as entregas (as mais recentes primeiro, no máximo 6 por agente). */
  agents: z.array(z.object({ agentId: z.string(), name: z.string(), count: z.number().int().nonnegative(), deliveries: z.array(reportDeliverySchema) })),
  /** Entregas sem agente conhecido (raro) entram aqui. */
  otherDeliveries: z.array(reportDeliverySchema),
  /** O que vem a seguir (só com `live`; só no resumo do dia). */
  next: z
    .object({
      routines: z.array(z.object({ title: z.string(), at: z.string(), label: z.string().optional(), agent: z.string().optional() })),
      tasks: z.array(z.object({ title: z.string(), project: z.string().optional(), agent: z.string().optional() })),
      agenda: z.array(z.object({ title: z.string(), start: z.string(), end: z.string() })),
    })
    .optional(),
  /** Metas fechadas no período (revisão da semana). */
  goals: z.array(reportGoalSchema),
  /** O mesmo dia da semana passada (só no resumo do dia). */
  compare: z.object({ day: z.string(), deliveries: z.number().int().nonnegative(), spendUsd: z.number().nonnegative() }).optional(),
});
export type ReportSections = z.infer<typeof reportSectionsSchema>;

export const reportAiSchema = z.object({ text: z.string().min(1).max(2000), at: z.string(), by: z.string().optional() });
export type ReportAi = z.infer<typeof reportAiSchema>;

export const REPORT_TRIGGERS = ["schedule", "manual", "mcp"] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];

export const storedReportSchema = z.object({
  v: z.literal(1),
  kind: z.enum(REPORT_KINDS),
  /** "2026-11-10" (dia), "2026-W46" (semana) ou "2026-11" (mês). */
  period: z.string(),
  workspace: z.string(),
  workspaceName: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  /** Congelado: o período fechou (ou o horário da cerimônia chegou). Um relatório final nunca é refeito. */
  final: z.boolean(),
  trigger: z.enum(REPORT_TRIGGERS),
  /** Os números do período, como o `computeMetrics` deu na hora de gerar (o mensal não tem: soma as semanas). */
  metrics: metricsReportSchema.optional(),
  digest: reportDigestSchema,
  sections: reportSectionsSchema,
  /** Mensal: as semanas guardadas que entraram na soma (as que faltam aparecem em `missing`). */
  weeks: z.array(z.object({ period: z.string(), from: z.string(), to: z.string(), digest: reportDigestSchema })).optional(),
  missing: z.array(z.string()).optional(),
  ai: reportAiSchema.optional(),
});
export type StoredReport = z.infer<typeof storedReportSchema>;

/** Uma linha da lista da aba Relatórios. */
export const reportListItemSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  period: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  final: z.boolean(),
  deliveries: z.number().int().nonnegative(),
  hasAi: z.boolean(),
});
export type ReportListItem = z.infer<typeof reportListItemSchema>;

export const reportListSchema = z.object({
  items: z.array(reportListItemSchema),
  /** O navegador do workspace está ligado? (sem ele não há "Imagem"). */
  imageAvailable: z.boolean(),
  settings: z.object({ dailyAt: z.string().nullable(), weekly: z.string() }),
  now: z.string(),
});
export type ReportList = z.infer<typeof reportListSchema>;

export const generateReportBodySchema = z.strictObject({ kind: z.enum(REPORT_KINDS), period: z.string().trim().max(20).optional() });
export type GenerateReportBody = z.infer<typeof generateReportBodySchema>;

export const generateReportResultSchema = z.object({ report: storedReportSchema, regenerated: z.boolean(), note: z.string().optional() });
export type GenerateReportResult = z.infer<typeof generateReportResultSchema>;

// ---------- Plataforma ----------

/** A semana da plataforma: a soma dos workspaces e um bloco por workspace. Gerada depois que o último workspace fecha a semana. */
export const platformReportSchema = z.object({
  v: z.literal(1),
  kind: z.literal("week"),
  period: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  total: reportDigestSchema,
  workspaces: z.array(z.object({ workspace: z.string(), name: z.string(), digest: reportDigestSchema, deliveries: z.number().int().nonnegative(), bestAgent: z.string().optional() })),
});
export type PlatformReport = z.infer<typeof platformReportSchema>;

/** Soma de resumos (mensal e plataforma): contagens, gasto e taxas somam; medianas ficam de fora (média de medianas mente). */
export function sumDigests(digests: readonly ReportDigest[]): ReportDigest {
  const rate = (pick: (digest: ReportDigest) => { hits: number; n: number }) => digests.reduce((total, digest) => ({ hits: total.hits + pick(digest).hits, n: total.n + pick(digest).n }), { hits: 0, n: 0 });
  const deliveries = digests.reduce((total, digest) => total + digest.deliveries, 0);
  const deliveryCostUsd = digests.reduce((total, digest) => total + digest.deliveryCostUsd, 0);
  const peaks = digests.map((digest) => digest.quotaPeak).filter((value): value is number => value !== null);
  return {
    deliveries,
    spendUsd: digests.reduce((total, digest) => total + digest.spendUsd, 0),
    deliveryCostUsd,
    costPerDelivery: deliveries > 0 ? deliveryCostUsd / deliveries : null,
    cycle: { median: null, p90: null, n: digests.reduce((total, digest) => total + digest.cycle.n, 0) },
    approvalWait: { median: null, p90: null, n: digests.reduce((total, digest) => total + digest.approvalWait.n, 0) },
    failure: rate((digest) => digest.failure),
    rejection: rate((digest) => digest.rejection),
    rework: rate((digest) => digest.rework),
    edit: rate((digest) => digest.edit),
    goals: digests.reduce((total, digest) => ({ hit: total.hit + digest.goals.hit, total: total.total + digest.goals.total }), { hit: 0, total: 0 }),
    quotaPeak: peaks.length > 0 ? Math.max(...peaks) : null,
  };
}

/** A semana da plataforma na página do Cyno: `GET /api/cyno/reports/week/:period?format=json|html|md|text` (`period` = "latest" ou "2026-W46"). */
export const PLATFORM_REPORTS_PATH = "/api/cyno/reports";
export const platformReportPath = (period: string): string => `${PLATFORM_REPORTS_PATH}/week/${encodeURIComponent(period)}`;
