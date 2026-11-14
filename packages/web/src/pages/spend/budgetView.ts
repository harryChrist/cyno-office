import { BUDGET_PERIOD_LABELS, BUDGET_PERIODS, budgetLimitKey, type BudgetLimits, type BudgetPeriod, type BudgetResponse, type BudgetTone, type UpdateBudgetBody } from "@cyno/shared";

/** Contas da barra de orçamento da página Gastos e do Painel (funções puras). */

export type BudgetRow = {
  period: BudgetPeriod;
  /** "Hoje", "Esta semana", "Este mês". */
  title: string;
  /** "US$ 4,10 de US$ 5,00" já na moeda da página (`money`). */
  amounts: string;
  /** "82%" (a barra para em 100, o número não). */
  percentText: string;
  /** 0 a 100: a largura da barra. */
  width: number;
  tone: BudgetTone;
  /** 0 = abaixo de 80%; 80 ou 100 = o degrau que já avisou. */
  step: 0 | 80 | 100;
  /** Frase curta sobre o estado (vazia abaixo de 80%). */
  note: string;
};

const TITLES: Record<BudgetPeriod, string> = { day: "Hoje", week: "Esta semana", month: "Este mês" };

export function budgetRows(response: BudgetResponse | null, money: (usd: number) => string): BudgetRow[] {
  if (!response) return [];
  return response.periods.map((status) => {
    const percent = Math.max(0, status.percent);
    return {
      period: status.period,
      title: TITLES[status.period],
      amounts: `${money(status.spentUsd)} de ${money(status.limitUsd)}`,
      percentText: `${Math.floor(percent)}%`,
      width: Math.min(100, percent),
      tone: status.tone,
      step: status.step,
      note: status.step === 100 ? "Estourou: o Cyno avisou, e o trabalho segue." : status.step === 80 ? "Passou de 80%: o Cyno avisou." : "",
    };
  });
}

const SHORT: Record<BudgetPeriod, string> = { day: "Hoje", week: "Semana", month: "Mês" };

/** Resumo de uma linha para o Painel ("Hoje 82% · Semana 40%"). */
export function budgetSummary(rows: BudgetRow[]): string {
  return rows.map((row) => `${SHORT[row.period]} ${row.percentText}`).join(" · ");
}

/** "5", "5,50", "5.50" -> 5.5; vazio = null (tira o limite); inválido ou fora de 0,01 a 1.000.000 = undefined. */
export function parseBudgetField(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const normalized = trimmed.replace(/\s/g, "").replace(/^US\$/i, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0.01 || value > 1_000_000) return undefined;
  return Math.round(value * 100) / 100;
}

export type BudgetForm = Record<BudgetPeriod, string>;

export function budgetFormOf(limits: BudgetLimits | undefined): BudgetForm {
  const text = (value: number | undefined) => (value === undefined ? "" : value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  return { day: text(limits?.dayUsd), week: text(limits?.weekUsd), month: text(limits?.monthUsd) };
}

/** O corpo do PUT só com o que mudou; campo inválido devolve o erro (e o período). */
export function budgetBodyOf(form: BudgetForm, limits: BudgetLimits | undefined): { body: UpdateBudgetBody } | { error: string; period: BudgetPeriod } {
  const body: UpdateBudgetBody = {};
  for (const period of BUDGET_PERIODS) {
    const parsed = parseBudgetField(form[period]);
    if (parsed === undefined) return { error: `Valor inválido para ${BUDGET_PERIOD_LABELS[period].name}: use um número a partir de 0,01.`, period };
    const key = budgetLimitKey(period);
    const current = limits?.[key];
    if (parsed === null) {
      if (current !== undefined) body[key] = null;
    } else if (parsed !== current) body[key] = parsed;
  }
  return { body };
}
