import { AGENT_USAGE_MAX_AGE_MS, type AgentProvider, type AgentUsageResponse, type AgentUsageTally, type AgentUsageTurn, type TurnUsage, type UsageRecord } from "@cyno/shared";

/** Um turno terminado por um agente (com os tokens, se a CLI mandou). */
/** `turns: 0` = linha só de tokens (nota no meio do turno): soma tokens, não conta turno (igual ao histórico de Gastos). */
type TurnRecord = { agentId: string; provider: AgentProvider; at: number; usage?: TurnUsage; turns: 0 | 1 };

/** Teto de turnos guardados por workspace (os mais antigos saem primeiro). */
export const AGENT_USAGE_MAX_TURNS = 5000;

/**
 * Uso relatado por agente (estimativa): cada turno que um terminal de CLI termina entra aqui com os
 * tokens que a CLI informou no evento final. A assinatura só diz o uso da CONTA inteira; isto é o
 * que dá para atribuir a cada agente. Fica em memória, mas no boot é recarregado do histórico em disco
 * (`seed`, usage/*.jsonl): reiniciar o server não zera. Guarda as últimas 24 h (AGENT_USAGE_MAX_AGE_MS) e soma por agente a partir de um instante (`since`), em geral o
 * começo da sessão de 5 h.
 */
export class AgentUsageLedger {
  private turns: TurnRecord[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Registra o turno e o devolve (o evento `usage:agents` que o web soma no "Por agente"). */
  record(agentId: string, provider: AgentProvider, usage?: TurnUsage, turns: 0 | 1 = 1): AgentUsageTurn {
    const at = this.now().getTime();
    this.turns.push({ agentId, provider, at, turns, ...(usage ? { usage: { ...usage } } : {}) });
    this.prune(at);
    return { agentId, provider, at: new Date(at).toISOString(), ...(usage ? { usage: { ...usage } } : {}) };
  }

  /**
   * Recarrega do histórico em disco (linhas ao vivo das últimas 24 h) as que ainda não estão aqui:
   * mistura por horário, sem duplicar o que já foi gravado neste processo.
   */
  seed(records: readonly UsageRecord[]): void {
    const now = this.now().getTime();
    const floor = now - AGENT_USAGE_MAX_AGE_MS;
    const firstLive = this.turns[0]?.at ?? Infinity;
    const older: TurnRecord[] = [];
    for (const record of records) {
      if (record.source !== "live") continue;
      const at = Date.parse(record.at);
      if (Number.isNaN(at) || at < floor || at >= firstLive) continue;
      const usage: TurnUsage | undefined = record.measured && record.tokens
        ? { inputTokens: record.tokens.input, outputTokens: record.tokens.output, cacheReadTokens: record.tokens.cacheRead, cacheCreationTokens: record.tokens.cacheCreation, ...(record.reportedCostUsd ? { reportedCostUsd: record.reportedCostUsd } : {}) }
        : undefined;
      older.push({ agentId: record.agentId, provider: record.provider, at, turns: record.turns === 0 ? 0 : 1, ...(usage ? { usage } : {}) });
    }
    older.sort((a, b) => a.at - b.at);
    this.turns = [...older, ...this.turns];
    this.prune(now);
  }

  /** Soma por agente desde `since` (no máximo as últimas 24 h; sem `since`, as últimas 5 h). Maior uso primeiro. */
  summary(since?: string): AgentUsageResponse {
    const now = this.now().getTime();
    this.prune(now);
    const floor = now - AGENT_USAGE_MAX_AGE_MS;
    const asked = since ? Date.parse(since) : now - 5 * 60 * 60 * 1000;
    const from = Math.max(floor, Number.isNaN(asked) ? floor : asked);
    const byAgent = new Map<string, AgentUsageTally>();
    for (const turn of this.turns) {
      if (turn.at < from) continue;
      const tally = byAgent.get(turn.agentId) ?? {
        agentId: turn.agentId,
        provider: turn.provider,
        turns: 0,
        measuredTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        lastAt: "",
      };
      tally.turns += turn.turns;
      tally.provider = turn.provider;
      tally.lastAt = new Date(turn.at).toISOString();
      if (turn.usage) {
        tally.measuredTurns += turn.turns;
        tally.inputTokens += turn.usage.inputTokens;
        tally.outputTokens += turn.usage.outputTokens;
        tally.cacheReadTokens += turn.usage.cacheReadTokens;
        tally.cacheCreationTokens += turn.usage.cacheCreationTokens;
        if (turn.usage.reportedCostUsd) tally.reportedCostUsd = (tally.reportedCostUsd ?? 0) + turn.usage.reportedCostUsd;
      }
      byAgent.set(turn.agentId, tally);
    }
    const weight = (tally: AgentUsageTally) => tally.inputTokens + tally.outputTokens + tally.cacheCreationTokens;
    const agents = [...byAgent.values()].sort((a, b) => weight(b) - weight(a) || b.turns - a.turns || a.agentId.localeCompare(b.agentId));
    return { since: new Date(from).toISOString(), agents };
  }

  private prune(now: number): void {
    const floor = now - AGENT_USAGE_MAX_AGE_MS;
    let drop = 0;
    while (drop < this.turns.length && this.turns[drop]!.at < floor) drop += 1;
    if (this.turns.length - drop > AGENT_USAGE_MAX_TURNS) drop = this.turns.length - AGENT_USAGE_MAX_TURNS;
    if (drop > 0) this.turns = this.turns.slice(drop);
  }
}
