import { z } from "zod";

/**
 * Orçamento de consumo (Junção V2, J2-09). O dono define quanto quer gastar por dia, semana ou mês, em
 * custo EQUIVALENTE (o que custaria na API; a assinatura não cobra por token). O Cyno só AVISA ao chegar
 * em 80% e em 100% (uma vez por degrau e por período): nunca segura a fila nem para um agente.
 * Os totais são os de todos os workspaces juntos, na mesma fonte da página Gastos (sem as linhas
 * suspeitas, com o gasto parcial dos turnos cortados).
 */

export const BUDGET_PATH = "/api/spend/budget";

export const BUDGET_PERIODS = ["day", "week", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, { name: string; today: string }> = {
  day: { name: "dia", today: "hoje" },
  week: { name: "semana", today: "nesta semana" },
  month: { name: "mês", today: "neste mês" },
};

/** Os degraus do aviso, em porcentagem do limite. */
export const BUDGET_STEPS = [80, 100] as const;
export type BudgetStep = (typeof BUDGET_STEPS)[number];

/** Valores em dólar equivalente; ausente = sem orçamento naquele período. */
export type BudgetLimits = { dayUsd?: number; weekUsd?: number; monthUsd?: number };

const limit = z.number().positive().max(1_000_000).nullable().optional();
/** `PUT /api/spend/budget`: troca só o que veio; `null` tira o limite daquele período. */
export const updateBudgetBodySchema = z.strictObject({ dayUsd: limit, weekUsd: limit, monthUsd: limit });
export type UpdateBudgetBody = z.infer<typeof updateBudgetBodySchema>;

export const budgetLimitKey = (period: BudgetPeriod): keyof BudgetLimits => `${period}Usd`;

/** Cores da barra, as mesmas do uso do plano: ok abaixo de 50%, aviso de 50 a 79, perigo a partir de 80. */
export type BudgetTone = "ok" | "warn" | "danger";

export type BudgetPeriodStatus = {
  period: BudgetPeriod;
  limitUsd: number;
  /** Custo equivalente já gasto no período (todos os workspaces). */
  spentUsd: number;
  spentBrl: number;
  /** spentUsd / limitUsd em porcentagem, sem teto (150 = estourou em 50%). */
  percent: number;
  /** O degrau já alcançado: 0 (abaixo de 80), 80 ou 100. */
  step: 0 | BudgetStep;
  tone: BudgetTone;
  /** Início (inclusive) e fim (exclusivo) do período, ISO, no fuso de São Paulo. */
  start: string;
  end: string;
};

/** `GET /api/spend/budget`. Sem nenhum limite, `periods` vem vazio (nada aparece). */
export type BudgetResponse = { limits: BudgetLimits; usdBrl: number; periods: BudgetPeriodStatus[]; updatedAt?: string };

/** O degrau alcançado por uma porcentagem. */
export function budgetStepOf(percent: number): 0 | BudgetStep {
  // Uma folga minúscula: somar centavos em ponto flutuante dá 99,99999999 onde a conta exata é 100.
  if (percent >= 100 - 1e-9) return 100;
  if (percent >= 80 - 1e-9) return 80;
  return 0;
}

export function budgetToneOf(percent: number): BudgetTone {
  if (percent >= 80) return "danger";
  if (percent >= 50) return "warn";
  return "ok";
}

const usd = (value: number): string => `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatBudgetUsd = usd;

/** "Orçamento de hoje: US$ 4,10 de US$ 5,00 equiv. (82%)" (texto do alerta; só o equivalente, nunca "o que você paga"). */
export function budgetAlertText(status: Pick<BudgetPeriodStatus, "period" | "limitUsd" | "spentUsd" | "percent">): string {
  const label = BUDGET_PERIOD_LABELS[status.period];
  const head = status.percent >= 100 ? `Orçamento ${label.today} estourado` : `Orçamento ${label.today} em ${Math.floor(status.percent)}%`;
  return `${head}: ${usd(status.spentUsd)} de ${usd(status.limitUsd)} equiv.`;
}
