import type { Agent, DayUsage, Task, UsageRecord } from "@cyno/shared";
import { aggregateHistory } from "../../engines/usage/usage-aggregate";

/**
 * O que o histórico de gastos diz de um dia (tokens, custo, turnos e o "por conta"): é o mesmo `aggregateHistory` da
 * página Gastos, então a diária e Gastos nunca divergem. `records` pode trazer mais que o dia (o filtro é feito aqui).
 */
export function dayUsageOf(records: readonly UsageRecord[], day: string, usdBrl: number, lookup: { agents: readonly Agent[]; tasks: readonly Task[] }): DayUsage {
  const response = aggregateHistory(records, { fromDay: day, toDay: day, groupBy: "provider", usdBrl }, lookup);
  const { overall } = response;
  return {
    tokens: { input: overall.inputTokens, output: overall.outputTokens, cacheRead: overall.cacheReadTokens, cacheCreation: overall.cacheCreationTokens },
    costUsd: overall.costUsd,
    costBrl: overall.costBrl,
    turns: overall.turns,
    unmeasuredTurns: overall.unmeasuredTurns,
    providers: response.groups.map((group) => ({
      provider: group.provider ?? group.key,
      label: group.label,
      turns: group.totals.turns,
      unmeasuredTurns: group.totals.unmeasuredTurns,
      totalTokens: group.totals.totalTokens,
      costUsd: group.totals.costUsd,
      costBrl: group.totals.costBrl,
    })),
  };
}
