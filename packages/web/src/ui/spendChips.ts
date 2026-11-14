/** Contas dos chips de gasto (funções puras, testáveis sem tela). Sempre "equiv.": é o custo na API, não o que o dono paga. */

export type Chip = { key: "task" | "today"; label: string; tokens: string; cost: string; title: string };

const tokensText = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000).toLocaleString("pt-BR")} mil`;
  if (tokens >= 1000) return `${(tokens / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return tokens.toLocaleString("pt-BR");
};

const costText = (usd: number): string => (usd > 0 && usd < 0.005 ? "< US$ 0,01" : `US$ ${usd.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * Os chips de um agente: "Esta tarefa" (a que ele está fazendo, se tiver custo) e "Hoje". Sem nada gasto, nenhum chip
 * (um agente que ainda não trabalhou hoje não mostra "0").
 */
export function agentUsageChips(input: {
  today?: { tokens: number; costUsd: number; turns: number };
  task?: { tokens: number; costUsd: number };
}): Chip[] {
  const chips: Chip[] = [];
  const { task, today } = input;
  if (task && task.tokens > 0) {
    chips.push({ key: "task", label: "Esta tarefa", tokens: `${tokensText(task.tokens)} tokens`, cost: `${costText(task.costUsd)} equiv.`, title: "O que a tarefa em andamento custou até agora, em custo equivalente na API" });
  }
  if (today && today.tokens > 0) {
    chips.push({ key: "today", label: "Hoje", tokens: `${tokensText(today.tokens)} tokens`, cost: `${costText(today.costUsd)} equiv.`, title: `Tudo o que este agente gastou hoje (${today.turns} ${today.turns === 1 ? "turno" : "turnos"}), em custo equivalente na API. Mesma conta da página Gastos` });
  }
  return chips;
}

/** O que uma tarefa custou ("US$ 0,31 equiv. · 82 mil tokens"); undefined se ela não gastou nada. */
export function taskCostText(cost: { tokens: number; costUsd: number } | undefined): string | undefined {
  if (!cost || cost.tokens <= 0) return undefined;
  return `${costText(cost.costUsd)} equiv. · ${tokensText(cost.tokens)} tokens`;
}
