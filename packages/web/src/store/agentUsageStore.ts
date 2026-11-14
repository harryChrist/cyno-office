import type { AgentUsageResponse, AgentUsageTally, AgentUsageTurn } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { useNavStore } from "./navStore";

const weight = (tally: AgentUsageTally) => tally.inputTokens + tally.outputTokens + tally.cacheCreationTokens;

/**
 * Soma um turno (evento `usage:agents`) ao "Por agente" já carregado (função pura, mesma ordem do
 * server: maior uso primeiro). Turno de antes do começo da soma não entra.
 */
export function addAgentTurn(summary: AgentUsageResponse, turn: AgentUsageTurn): AgentUsageResponse {
  if (Date.parse(turn.at) < Date.parse(summary.since)) return summary;
  const current = summary.agents.find((tally) => tally.agentId === turn.agentId);
  const base: AgentUsageTally = current ?? {
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
  const usage = turn.usage;
  const next: AgentUsageTally = {
    ...base,
    provider: turn.provider,
    turns: base.turns + 1,
    lastAt: turn.at > base.lastAt ? turn.at : base.lastAt,
    ...(usage
      ? {
          measuredTurns: base.measuredTurns + 1,
          inputTokens: base.inputTokens + usage.inputTokens,
          outputTokens: base.outputTokens + usage.outputTokens,
          cacheReadTokens: base.cacheReadTokens + usage.cacheReadTokens,
          cacheCreationTokens: base.cacheCreationTokens + usage.cacheCreationTokens,
        }
      : {}),
  };
  const agents = [...summary.agents.filter((tally) => tally.agentId !== turn.agentId), next].sort(
    (a, b) => weight(b) - weight(a) || b.turns - a.turns || a.agentId.localeCompare(b.agentId),
  );
  return { ...summary, agents };
}

type AgentUsageState = {
  /** O "Por agente" do workspace (GET uma vez + eventos usage:agents); undefined = ainda não carregado. */
  data?: AgentUsageResponse;
  error?: string;
  /** Busca o "Por agente" desde `since` (ao abrir o detalhe do uso). */
  load: (since: string) => Promise<void>;
  /** Aplica um turno terminado (`usage:agents`). */
  apply: (turn: AgentUsageTurn) => void;
  /** Troca de workspace ou ressincronização total: o próximo detalhe aberto busca de novo. */
  reset: () => void;
};

/** Sobe a cada load/reset: resposta de um pedido anterior é descartada. */
let generation = 0;
/** Turnos que chegaram durante o GET em voo (somados por cima da resposta). */
let pending: AgentUsageTurn[] | null = null;

/**
 * Uso relatado por agente (estimativa) do workspace atual. Sem polling: um GET ao abrir o detalhe
 * e depois cada turno chega pelo WebSocket (`usage:agents`) e entra na soma.
 */
export const useAgentUsageStore = create<AgentUsageState>()((set, get) => ({
  async load(since) {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const mine = ++generation;
    pending = [];
    try {
      const fetched = await api.agentUsage(since);
      if (mine !== generation || useNavStore.getState().workspaceId !== workspaceId) return;
      // O turno pode já estar na resposta: só soma os que terminaram depois do que o server já contou.
      const counted = new Map(fetched.agents.map((tally) => [tally.agentId, tally.lastAt]));
      const data = (pending ?? []).filter((turn) => turn.at > (counted.get(turn.agentId) ?? "")).reduce(addAgentTurn, fetched);
      pending = null;
      set({ data, error: undefined });
    } catch (error) {
      if (mine !== generation) return;
      pending = null;
      set({ error: describeError(error) });
    }
  },

  apply(turn) {
    pending?.push(turn);
    const { data } = get();
    if (data) set({ data: addAgentTurn(data, turn) });
  },

  reset() {
    generation += 1;
    pending = null;
    set({ data: undefined, error: undefined });
  },
}));
