import { agentEngine, engineBlock, engineBlockLabel, type Agent, type EngineBlock, type EngineInfo, type SubscriptionUsage } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { useNavStore } from "../store/navStore";
import { useUsageStore, type UsageByProvider } from "../store/usageStore";
import { useEngines } from "./EngineFields";

/**
 * Agente indisponível agora: o motor dele está sem cota da assinatura (volta no `resetsAt`) ou a
 * CLI não está instalada. Nada troca de motor sozinho: o agente espera (as tarefas dele ficam na
 * fila e andam quando a cota volta).
 */
export type AgentAvailability = { block: EngineBlock; label: string };

const usageList = (usage: UsageByProvider): SubscriptionUsage[] => Object.values(usage).filter((value): value is SubscriptionUsage => value !== undefined);

/** Por que o agente está indisponível (null = disponível; o simulado sempre está). */
export function agentAvailability(agent: Pick<Agent, "engine" | "model"> & { id?: string }, usage: UsageByProvider, engines: readonly EngineInfo[] | undefined, now: number, workspaceId?: string): AgentAvailability | null {
  // O Freebuff cobra por hora aberta: quem já tem a hora aberta nunca espera (precisa saber quem pergunta).
  const ref = agent.id ? { agentId: agent.id, ...(workspaceId ? { workspaceId } : {}) } : undefined;
  const block = engineBlock(agentEngine(agent), { usage: usageList(usage), ...(engines ? { engines } : {}), now }, agent.model, ref);
  return block ? { block, label: engineBlockLabel(block, now) } : null;
}

/** Indisponibilidade de cada agente indisponível, por id (os disponíveis ficam de fora). */
export function availabilityByAgent(agents: readonly Agent[], usage: UsageByProvider, engines: readonly EngineInfo[] | undefined, now: number, workspaceId?: string): Record<string, AgentAvailability> {
  const out: Record<string, AgentAvailability> = {};
  for (const agent of agents) {
    const availability = agentAvailability(agent, usage, engines, now, workspaceId);
    if (availability) out[agent.id] = availability;
  }
  return out;
}

/** Relógio de minuto em minuto (a hora em que a cota volta passa sem evento nenhum). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Os agentes indisponíveis agora (por id), com o uso ao vivo e os motores do server. */
export function useAvailability(agents: readonly Agent[] | undefined): Record<string, AgentAvailability> {
  const usage = useUsageStore((state) => state.byProvider);
  const engines = useEngines();
  const now = useMinuteClock();
  const workspaceId = useNavStore((state) => state.workspaceId) ?? undefined;
  return useMemo(() => availabilityByAgent(agents ?? [], usage, engines, now, workspaceId), [agents, usage, engines, now, workspaceId]);
}

/** Um agente só (null = disponível). */
export function useAgentAvailability(agent: Agent | undefined): AgentAvailability | null {
  const agents = useMemo(() => (agent ? [agent] : []), [agent]);
  const map = useAvailability(agents);
  return agent ? (map[agent.id] ?? null) : null;
}
