import { z } from "zod";
import { GOAL_CONFIDENCES } from "./goal-projection";
import { PACE_STATUSES } from "./routines";

/**
 * Métricas da Gestão: o `MetricsReport` que `computeMetrics` (server, `workspace/metrics/`) devolve.
 * Tudo é calculado por código sobre o que já está gravado; nenhum campo vem de IA. Dia e semana são os
 * de São Paulo. Cada indicador traz `value`, `n` (amostras), o período anterior (`prev`/`prevN`) e, onde
 * faz sentido, os grupos `byAgent`/`byType`/`byProject`.
 */

/** Rota do workspace: `GET /api/w/:ws/metrics?from&to&group_by`. */
export const WORKSPACE_METRICS_PATH = "/metrics";

/** Abaixo disto o indicador diz "poucos dados" e não leva seta. */
export const METRICS_MIN_SAMPLES = 5;
/** Janelas padrão quando o pedido não diz `from`/`to`: medianas em 28 dias, taxas e contagens em 7. */
export const METRICS_MEDIAN_DAYS = 28;
export const METRICS_RATE_DAYS = 7;
/** Quantas semanas a vazão mostra. */
export const METRICS_WEEKS = 8;
/** Uma tarefa parada esperando (sem bloqueio nem falha) só entra em "travados" depois disto. */
export const METRICS_STALL_MS = 2 * 3_600_000;

export const METRICS_GROUP_BY = ["agent", "project", "routine", "type", "none"] as const;
export type MetricsGroupBy = (typeof METRICS_GROUP_BY)[number];

/** Direção da mudança contra o período anterior (não diz se é bom ou ruim); só com `n` suficiente nos dois lados. */
export const METRIC_TRENDS = ["up", "down", "flat"] as const;
export type MetricTrend = (typeof METRIC_TRENDS)[number];

const nullableNumber = z.number().nullable();

export const metricValueSchema = z.object({
  /** Mediana (ms ou USD), taxa (0 a 1) ou contagem, conforme o indicador. null = sem amostra. */
  value: nullableNumber,
  /** Amostras do período. */
  n: z.number().int().nonnegative(),
  /** O mesmo valor no período anterior do mesmo tamanho. */
  prev: nullableNumber,
  prevN: z.number().int().nonnegative(),
  /** Taxas: quantos entraram no numerador. */
  hits: z.number().int().nonnegative().optional(),
  /** n < 5: "poucos dados", sem seta. */
  fewData: z.boolean(),
  note: z.string().optional(),
  trend: z.enum(METRIC_TRENDS).optional(),
});
export type MetricValue = z.infer<typeof metricValueSchema>;

export const metricGroupSchema = metricValueSchema.extend({ key: z.string(), label: z.string(), intensity: nullableNumber.optional() });
export type MetricGroup = z.infer<typeof metricGroupSchema>;

const windowSchema = z.object({ from: z.string(), to: z.string() });
export type MetricsWindow = z.infer<typeof windowSchema>;

const groups = { byAgent: z.array(metricGroupSchema), byType: z.array(metricGroupSchema), byProject: z.array(metricGroupSchema) };

export const throughputWeekSchema = z.object({
  /** "2026-W46". */
  key: z.string(),
  /** Segunda-feira da semana ("AAAA-MM-DD"). */
  start: z.string(),
  count: z.number().int().nonnegative(),
  /** Média das 4 semanas que terminam nesta (ela inclusa). */
  avg4: nullableNumber,
  /** A semana atual, ainda em andamento. */
  current: z.boolean(),
});

/** Entregas por semana de um agente: `counts` na mesma ordem de `throughput.weeks`. */
export const agentWeeksSchema = z.object({ key: z.string(), label: z.string(), counts: z.array(z.number().int().nonnegative()) });

export const blockedItemSchema = z.object({
  projectId: z.string(),
  projectTitle: z.string(),
  ref: z.string(),
  title: z.string(),
  /** voce, agente, cota, acesso (bloqueio gravado), espera (parada sem bloqueio) ou falha. */
  type: z.enum(["voce", "agente", "cota", "acesso", "espera", "falha"]),
  since: z.string(),
  ageMs: z.number().nonnegative(),
  agentId: z.string().optional(),
});

export const quotaWindowSchema = z.object({
  provider: z.string(),
  id: z.string(),
  label: z.string(),
  state: z.enum(["value", "renewed", "none"]),
  percent: z.number().nullable(),
  resetsAt: z.string().optional(),
  /** Frase pronta: "Claude: 5 h em 86%, volta às 15h". */
  text: z.string(),
  /** Uso / fração decorrida da janela (só nas janelas de 5 h e da semana). Acima de 1,2 = `warn`. */
  pace: nullableNumber,
  warn: z.boolean(),
});

export const FORECAST_CONFIDENCES = ["baixa", "media", "alta"] as const;
export type ForecastConfidence = (typeof FORECAST_CONFIDENCES)[number];
export const FORECAST_VERDICTS = ["no_prazo", "apertado", "atrasa"] as const;
export type ForecastVerdict = (typeof FORECAST_VERDICTS)[number];

/** Previsão de um projeto: quando termina no ritmo atual, a faixa (p25 a p75) e o veredito contra o prazo. */
export const projectForecastSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  dueAt: z.string().optional(),
  /** `sem_previsao`: faltam tarefas concluídas (deste agente ou do workspace) para estimar; `reason` diz o que falta. */
  state: z.enum(["previsto", "sem_previsao"]),
  reason: z.string().optional(),
  /** Tarefas que faltam. */
  remaining: z.number().int().nonnegative(),
  at: z.string().optional(),
  low: z.string().optional(),
  high: z.string().optional(),
  /** "12 tarefas": de quantas amostras saiu o tempo por tarefa. */
  basis: z.string().optional(),
  /** A base não é o histórico do próprio agente (veio dos outros agentes do workspace ou da média geral): a confiança nunca passa de baixa. */
  borrowed: z.boolean().optional(),
  n: z.number().int().nonnegative().optional(),
  confidence: z.enum(FORECAST_CONFIDENCES).optional(),
  /** Só com prazo (`dueAt`). "apertado" = o fim lento passa do prazo, o provável não. */
  verdict: z.enum(FORECAST_VERDICTS).optional(),
  lateByMs: z.number().nonnegative().optional(),
  /** Trabalho que falta (soma do tempo por tarefa) e o caminho crítico, em ms. */
  workMs: z.number().nonnegative().optional(),
  criticalMs: z.number().nonnegative().optional(),
  /** "No ritmo atual termina na quinta, 14 (entre quarta e sábado). Prazo: sexta, 15." */
  text: z.string(),
});
export type ProjectForecast = z.infer<typeof projectForecastSchema>;

export const goalProjectionSchema = z.object({
  routineId: z.string(),
  title: z.string(),
  period: z.enum(["week", "month"]),
  periodKey: z.string(),
  target: z.number(),
  delivered: z.number(),
  expected: z.number(),
  pace: z.enum(PACE_STATUSES),
  n: z.number().int().nonnegative(),
  ratePerDay: z.number().nullable(),
  daysLeft: z.number(),
  projected: z.number().nullable(),
  closes: z.boolean(),
  confidence: z.enum(GOAL_CONFIDENCES),
  text: z.string(),
});

export const metricsReportSchema = z.object({
  v: z.literal(1),
  workspace: z.string().optional(),
  /** Quando foi calculado (ISO) e o fuso dos dias. */
  now: z.string(),
  timeZone: z.string(),
  /** Janela das taxas e contagens; `medians` é a das medianas (28 dias, ou a mesma se o pedido deu `from`/`to`). */
  windows: z.object({ rates: windowSchema, medians: windowSchema }),
  prevWindows: z.object({ rates: windowSchema, medians: windowSchema }),
  /** Entregas por semana: tarefa de projeto concluída (fora rotina, fora pulada) + entrega registrada de rotina. */
  throughput: metricValueSchema.extend({ weeks: z.array(throughputWeekSchema), agentWeeks: z.array(agentWeeksSchema), ...groups }),
  /** Do pedido à entrega (mediana; p90 por posto mais próximo) e para onde foi o tempo parado. */
  cycleTime: metricValueSchema.extend({
    p90: nullableNumber,
    workingMs: nullableNumber,
    stoppedMs: nullableNumber,
    waitingYouMs: nullableNumber,
    queuedMs: nullableNumber,
    /** Do parado, o que veio de bloqueios gravados (`blockedSpans`): mediana por motivo. null = nenhum projeto da janela tem o histórico. */
    stoppedBy: z.object({ agente: nullableNumber, cota: nullableNumber, acesso: nullableNumber }),
    /** false = os projetos da janela são antigos (sem `blockedSpans`): o parado por motivo é só aproximado. */
    stoppedExact: z.boolean(),
    /** Por semana (as mesmas de `throughput.weeks`): quantos projetos, mediana e p90 do tempo até entregar. */
    weeks: z.array(z.object({ key: z.string(), n: z.number().int().nonnegative(), median: nullableNumber, p90: nullableNumber })),
    /** Mediana do tempo até entregar dos projetos em que o agente entregou (um projeto conta para cada agente que entregou nele). */
    byAgent: z.array(metricGroupSchema),
  }),
  /** Espera pelo OK do dono: itens decididos (mediana) e pendentes agora. */
  approvalWait: metricValueSchema.extend({
    p90: nullableNumber,
    /** Soma das esperas / soma dos ciclos das entregas da janela (0 a 1). */
    weightInCycle: nullableNumber,
    pending: z.object({
      count: z.number().int().nonnegative(),
      over24h: z.number().int().nonnegative(),
      oldestMs: nullableNumber,
      items: z.array(z.object({ id: z.string(), type: z.string(), agentId: z.string().optional(), ageMs: z.number().nonnegative() })),
    }),
    byAgent: z.array(metricGroupSchema),
    byType: z.array(metricGroupSchema),
  }),
  blockedNow: z.object({
    count: z.number().int().nonnegative(),
    byType: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(blockedItemSchema),
  }),
  failureRate: metricValueSchema.extend({
    byAgent: z.array(metricGroupSchema),
    byModel: z.array(metricGroupSchema),
    /** Só as falhas do agente: sem as de motor, cota e acesso (as sem origem gravada contam como do agente: `approx`). */
    agentOnly: metricValueSchema,
    /** Falhas por origem (`failureKind`; "desconhecida" = tarefa antiga sem o campo). */
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    /** true = alguma falha da janela não tem origem gravada: a taxa do agente é aproximada. */
    approx: z.boolean(),
  }),
  rejectionRate: metricValueSchema.extend({ byAgent: z.array(metricGroupSchema), byType: z.array(metricGroupSchema) }),
  rework: metricValueSchema.extend({ avgCount: nullableNumber, byAgent: z.array(metricGroupSchema) }),
  editRate: metricValueSchema.extend({
    /** Mediana de `1 - similaridade` (Dice sobre bigramas de palavras) dos textos que o dono mexeu. */
    intensity: metricValueSchema,
    byAgent: z.array(metricGroupSchema),
    byType: z.array(metricGroupSchema),
  }),
  /** Custo dos projetos rateado por entrega, equivalente à API (USD); NÃO é o que se paga (assinatura) nem o gasto da janela. */
  costPerDelivery: metricValueSchema.extend({ totalUsd: z.number(), deliveries: z.number().int().nonnegative(), byAgent: z.array(metricGroupSchema), byProject: z.array(metricGroupSchema) }),
  load: z.object({
    running: z.number().int().nonnegative(),
    maxRunning: z.number().int(),
    perAgentLimit: z.number().int(),
    queued: z.number().int().nonnegative(),
    agents: z.array(z.object({ id: z.string(), name: z.string(), doing: z.number().int(), queued: z.number().int(), waiting: z.number().int(), workedMs7d: z.number().nonnegative() })),
  }),
  /** Espera na fila (de `a_fazer` até começar), por agente. */
  queueWait: metricValueSchema.extend({ p90: nullableNumber, approx: z.boolean(), byAgent: z.array(metricGroupSchema) }),
  /** Gasto equivalente à API (USD) de tudo o que os agentes usaram na janela das taxas (não só das entregas), e na anterior. */
  spend: z.object({ usd: z.number(), prevUsd: z.number() }),
  quota: z.object({
    windows: z.array(quotaWindowSchema),
    /** Agentes que não rodam agora por falta de cota/motor. */
    blocked: z.array(z.object({ agentId: z.string(), name: z.string(), label: z.string() })),
  }),
  /** Previsão de entrega dos projetos abertos (os com prazo primeiro, do pior veredito ao melhor). */
  forecast: z.object({ projects: z.array(projectForecastSchema), text: z.string() }),
  /** Projeção das metas do período (`fecha em 7 de 10`). */
  goals: z.object({ items: z.array(goalProjectionSchema), text: z.string() }),
});
export type MetricsReport = z.infer<typeof metricsReportSchema>;

/** Rota da estimativa de economia ao trocar o modelo de um agente: `GET /api/w/:ws/metrics/model-saving?agentId=&model=`. */
export const MODEL_SAVING_PATH = "/metrics/model-saving";
/** Quantos dias de uso a estimativa reprecifica (e por quanto divide para chegar em "por semana"). */
export const MODEL_SAVING_DAYS = 14;

/**
 * Quanto custaria, no modelo novo, o que o agente usou nos últimos 14 dias (custo equivalente à API, não o que se paga).
 * Só estima: quem troca o modelo é o dono, pelo `PATCH /agents/:id`. `sem_dados` = nenhum turno medido e com preço dos dois
 * modelos para comparar: a tela diz "sem dados para estimar" em vez de inventar um número.
 */
export const modelSavingSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  /** O modelo de hoje (o do agente; vazio = o padrão da CLI). */
  currentModel: z.string().nullable(),
  model: z.string(),
  days: z.number().int(),
  state: z.enum(["estimado", "sem_dados"]),
  /** Turnos que entraram na conta (com tokens medidos e preço nos dois modelos) e os que ficaram de fora. */
  records: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Custo equivalente por semana hoje e no modelo novo (USD); só com `estimado`. */
  weeklyNowUsd: z.number().nullable(),
  weeklyNewUsd: z.number().nullable(),
  /** Economia por semana (USD): positiva = o modelo novo sai mais barato; negativa = mais caro. */
  savingPerWeekUsd: z.number().nullable(),
  /** Fatia do consumo equivalente de todos os agentes do mesmo motor que essa economia representa (0 a 1); null = não dá para calcular. */
  quotaShare: z.number().nullable(),
  /** Recusa do agente nas últimas semanas (0 a 1) e quantas decisões a sustentam; null = sem decisões. */
  rejectionRate: z.number().nullable(),
  rejectionN: z.number().int().nonnegative(),
  /** "cerca de US$ 4,10 a menos por semana (equivalente)" ou "sem dados para estimar". */
  text: z.string(),
  /** Por que não deu para estimar (só com `sem_dados`), ou o que ficou de fora da conta. */
  note: z.string().nullable(),
  /** "cerca de 12% menos do consumo da assinatura do Claude (pelo custo equivalente)"; null quando não dá para dizer. */
  quotaText: z.string().nullable(),
  /** "Taxa de recusa de Clara hoje: 12%; trocar pode piorar." (vazio quando não há recusas para citar). */
  warning: z.string().nullable(),
});
export type ModelSaving = z.infer<typeof modelSavingSchema>;
