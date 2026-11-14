import {
  engineBlockLabel,
  ENGINE_LABELS,
  IMPLEMENTED_CLI_ENGINES,
  sortUsageWindows,
  usageWindowLabel,
  type AgentEngine,
  type AgentUsageResponse,
  type EngineBlock,
  type EngineInfo,
  type SubscriptionUsage,
} from "@cyno/shared";

export type UsageReportInput = {
  usages: readonly SubscriptionUsage[];
  engines: readonly EngineInfo[];
  /** Por que um motor está indisponível agora (undefined = disponível). */
  availability?: (engine: AgentEngine) => EngineBlock | undefined;
  /** Uso relatado por agente (turnos e tokens) nas últimas horas. */
  agentUsage?: AgentUsageResponse;
  /** Nome de cada agente (id -> nome); sem nome, vale o id. */
  names: ReadonlyMap<string, string>;
  now: number;
};

/**
 * O texto do `get_usage` (em inglês, para o modelo): a cota da assinatura por motor (janelas de 5 h e da
 * semana, quando zeram), quais motores estão disponíveis e quem mais gastou. É o mesmo do Maestro e do Cyno.
 */
export async function usageReport(input: UsageReportInput): Promise<string> {
  const { usages, engines, now } = input;
  const lines: string[] = [];
  for (const engine of IMPLEMENTED_CLI_ENGINES) {
    const info = engines.find((candidate) => candidate.engine === engine);
    const block = input.availability?.(engine);
    const state = block ? `UNAVAILABLE (${engineBlockLabel(block, now)}${block.reason === "unavailable" && block.detail ? `: ${block.detail}` : ""})` : info && !info.available ? "not installed" : "available";
    lines.push(`## ${ENGINE_LABELS[engine]} — ${state}`);
    const usage = usages.find((candidate) => candidate.provider === engine);
    if (!usage || usage.windows.length === 0) {
      lines.push("- no usage data yet");
      continue;
    }
    for (const window of sortUsageWindows(usage.windows)) {
      const resets = window.resetsAt ? `; resets ${new Date(window.resetsAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "";
      lines.push(`- ${usageWindowLabel(window.id)}: ${Math.round(window.utilization * 100)}% used${resets}`);
    }
    lines.push(`- updated ${usage.updatedAt.slice(0, 16).replace("T", " ")} UTC${usage.stale ? ` (may be stale: ${usage.stale.reason})` : ""}`);
  }
  const perAgent = input.agentUsage;
  if (perAgent && perAgent.agents.length > 0) {
    lines.push("", "## Agents since " + perAgent.since.slice(0, 16).replace("T", " ") + " UTC (estimate)");
    for (const tally of perAgent.agents.slice(0, 10)) {
      const tokens = tally.measuredTurns > 0 ? `, ${Math.round((tally.inputTokens + tally.outputTokens + tally.cacheCreationTokens) / 1000)}k tokens (+${Math.round(tally.cacheReadTokens / 1000)}k cache)` : "";
      lines.push(`- ${input.names.get(tally.agentId) ?? tally.agentId}: ${tally.turns} turn(s)${tokens}`);
    }
  }
  return lines.join("\n");
}
