import { z } from "zod";
import type { AgentProvider } from "./agent-log";
import type { UsageSuspectReason } from "./usage-sanity";

/**
 * Histórico de gastos ("Gastos"): cada turno de um agente de CLI vira uma linha em
 * `workspaces/<ws>/usage/YYYY-MM.jsonl` (mês no fuso de São Paulo). As assinaturas não cobram por
 * token: o valor em dinheiro é "quanto custaria na API" (custo equivalente), calculado com a tabela
 * de preços do server na hora da leitura (uma correção de preço vale para o passado também).
 */

/** Fuso em que os dias, semanas (começam na segunda) e meses do histórico viram. */
export const USAGE_HISTORY_TIMEZONE = "America/Sao_Paulo";

/** Tokens de um turno (ou de uma mensagem, no histórico importado das conversas antigas). */
export type UsageRecordTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Parte do cache gravado com validade de 5 min / 1 h (quando a CLI separa). */
  cacheCreation5m?: number;
  cacheCreation1h?: number;
};

/**
 * Uma linha do histórico. `turns`: quanto conta como turno (ausente = 1; 0 = continuação de um
 * turno, ex.: mensagem do meio de um turno importado ou nota injetada). `measured: false` = a CLI
 * não informou tokens (o turno conta, sem custo). `costUsd`/`priceVersion`: o custo calculado na
 * gravação, só de referência (a leitura recalcula com a tabela atual).
 */
export type UsageRecord = {
  v: 1;
  /** Id único da linha (o id da mensagem no histórico importado: é o que evita importar duas vezes). */
  id: string;
  at: string;
  agentId: string;
  /** Nome do agente na hora (o agente pode ser excluído depois). */
  agentName?: string;
  provider: AgentProvider;
  /** Modelo que a CLI relatou ou, sem isso, o configurado no agente (alias como "opus" é resolvido na leitura). */
  model?: string;
  /** De onde veio o modelo: a CLI (`cli`) ou a configuração do agente (`config`). */
  modelSource?: "cli" | "config";
  taskId?: string;
  /** Título da tarefa na hora (o pedido pode sumir do quadro depois). */
  taskTitle?: string;
  /** Tarefa do Maestro que originou esta (subtarefa delegada). */
  parentTaskId?: string;
  /** O pedido de origem (o topo da cadeia de `parentId`); igual a `taskId` quando ele mesmo é o pedido. */
  rootTaskId?: string;
  /** Conversa direta com o agente (sem tarefa) ou outro turno sem tarefa. */
  channel?: "task" | "chat" | "other";
  /** Gasto do botão "Testar" da tela Motores (o pedido mínimo ao motor): entra nos totais de Gastos, marcado como teste. */
  test?: true;
  sessionId?: string;
  source: "live" | "backfill" | "seed";
  turns?: 0 | 1;
  /**
   * Turno cortado antes do fim (cancelado, terminal caiu, limite): só os tokens que a CLI já tinha
   * informado até o corte. Conta no gasto (a API cobrou), mas é estimado e não conta como turno.
   */
  partial?: true;
  /** Valor impossível (veja usage-sanity.ts): fica gravado, fora dos totais, e aparece à parte em Gastos. */
  suspect?: UsageSuspectReason;
  measured: boolean;
  tokens?: UsageRecordTokens;
  /** Tamanho do prompt da chamada (só numa mensagem isolada; é o que define a faixa de preço por tamanho). */
  promptTokens?: number;
  /** Velocidade da chamada (`fast` = modo rápido, preço maior). */
  speed?: "standard" | "fast";
  /** Buscas na web feitas pelo servidor do modelo (cobradas à parte na API). */
  webSearches?: number;
  durationMs?: number;
  /** Custo em dólar que o próprio programa relatou (OpenClaw/Hermes). Fora da tabela de preços: é o que a conta cobrou, se cobrou. */
  reportedCostUsd?: number;
  costUsd: number | null;
  priceVersion: string;
};

/** Totais de um grupo do histórico. Custo em USD e BRL (pela cotação configurada). */
export type UsageTotals = {
  turns: number;
  /** Turnos com tokens informados. */
  measuredTurns: number;
  /** Turnos sem tokens (a CLI não disse): contam como turno, sem custo. */
  unmeasuredTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Entrada + saída + cache lido + cache gravado. */
  totalTokens: number;
  costUsd: number;
  costBrl: number;
  /** De onde vem o custo (USD): entrada, saída, cache lido, cache gravado e buscas na web. */
  costByType: { input: number; output: number; cacheRead: number; cacheWrite: number; webSearch: number };
  /** Turnos/tokens de modelos sem preço na tabela (ficam fora do custo: "sem preço"). */
  unpricedTurns: number;
  unpricedTokens: number;
  /** Cache lido / (entrada + cache lido + cache gravado). null sem nenhum token de entrada. */
  cacheHitRatio: number | null;
  durationMs: number;
};

/** Uma fatia de um grupo de tempo (empilhada no gráfico: por agente ou por modelo). */
export type UsageStackPart = { key: string; label: string; costUsd: number; costBrl: number; totalTokens: number; turns: number };

export type UsageHistoryGroup = {
  key: string;
  label: string;
  /** Grupos de tempo: início (inclusive) e fim (exclusive) do período, ISO. */
  start?: string;
  end?: string;
  /** Grupo por agente/tarefa: o motor; por tarefa: o estado e quantas subtarefas tem. */
  provider?: AgentProvider;
  taskStatus?: string;
  subtasks?: number;
  totals: UsageTotals;
  stack?: UsageStackPart[];
};

export const USAGE_HISTORY_GROUPS = ["day", "week", "month", "agent", "model", "task", "provider"] as const;
export type UsageHistoryGroupBy = (typeof USAGE_HISTORY_GROUPS)[number];

/** Dia no formato YYYY-MM-DD (no fuso de São Paulo). */
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data inválida (use AAAA-MM-DD)");

/**
 * `GET /api/w/:ws/usage/history?from&to&groupBy&stackBy&agentId&provider`: `from`/`to` são dias
 * (inclusive) no fuso de São Paulo; padrão: os últimos 30 dias. `stackBy` só vale nos grupos de tempo.
 */
export const usageHistoryQuerySchema = z.object({
  from: dayKey.optional(),
  to: dayKey.optional(),
  groupBy: z.enum(USAGE_HISTORY_GROUPS).default("day"),
  stackBy: z.enum(["agent", "model"]).optional(),
  agentId: z.string().min(1).max(64).optional(),
  provider: z.enum(["claude", "gemini"]).optional(),
});
export type UsageHistoryQuery = z.input<typeof usageHistoryQuerySchema>;

/** Tabela de preços em uso (de onde veio e quando foi conferida). */
export type UsagePriceInfo = { version: string; verifiedAt: string; sources: string[] };

/** O que a guarda de sanidade deixou de fora dos totais do período (e o que é estimado). */
export type UsageHistoryFlags = {
  /** Turnos de valor impossível, fora dos totais. */
  suspect: { records: number; tokens: number; reasons: Partial<Record<UsageSuspectReason, number>>; latestAt?: string };
  /** Turnos cortados, com o gasto parcial já somado nos totais. */
  partial: { records: number; tokens: number; costUsd: number };
};

export type UsageHistoryResponse = {
  from: string;
  to: string;
  timezone: string;
  groupBy: UsageHistoryGroupBy;
  stackBy?: "agent" | "model";
  /** Cotação usada no BRL (editável em `PUT /api/settings/spend`). */
  usdBrl: number;
  prices: UsagePriceInfo;
  overall: UsageTotals;
  groups: UsageHistoryGroup[];
  flags: UsageHistoryFlags;
};

/** Um turno no detalhe de uma tarefa. */
export type UsageTurnRow = {
  at: string;
  agentId: string;
  agentName: string;
  model?: string;
  taskId?: string;
  measured: boolean;
  totalTokens: number;
  costUsd: number | null;
  durationMs?: number;
};

/** `GET /api/w/:ws/usage/history/task/:taskId`: o pedido, as subtarefas e os agentes, com os turnos. */
export type UsageTaskHistoryResponse = {
  taskId: string;
  title: string;
  status?: string;
  usdBrl: number;
  prices: UsagePriceInfo;
  totals: UsageTotals;
  /** O próprio pedido (os turnos do Maestro) e cada subtarefa. */
  tasks: UsageHistoryGroup[];
  agents: UsageHistoryGroup[];
  models: UsageHistoryGroup[];
  /** Os turnos mais recentes (no máximo 200). */
  turns: UsageTurnRow[];
};

/**
 * `GET /api/w/:ws/usage/task-costs`: o que cada tarefa custou (custo equivalente e tokens, só dos turnos dela,
 * sem as linhas suspeitas e com o gasto parcial dos turnos cortados). É a mesma conta da página Gastos; o cartão
 * da tarefa e o painel do agente leem daqui.
 */
export const USAGE_TASK_COSTS_PATH = "/usage/task-costs";
export type UsageTaskCostsResponse = { tasks: Record<string, { costUsd: number; tokens: number }> };

/** Configuração dos gastos (da instalação): cotação USD→BRL. */
export const SPEND_SETTINGS_PATH = "/api/settings/spend";
export const DEFAULT_USD_BRL = 5.51;
export const updateSpendSettingsBodySchema = z.strictObject({ usdBrl: z.number().min(0.01).max(1000) });
export type UpdateSpendSettingsBody = z.infer<typeof updateSpendSettingsBodySchema>;
export type SpendSettingsResponse = { usdBrl: number; defaultUsdBrl: number; updatedAt?: string };
