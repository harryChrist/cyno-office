import type { AgentTerminalInfo, ServerEvent } from "@cyno/shared";
import { create } from "zustand";

/** Estado do terminal de CLI de cada agente do workspace aberto (agentId -> info). */
export type TerminalsByAgent = Record<string, AgentTerminalInfo>;

/**
 * Aplica um evento (função pura): o `office:snapshot` troca tudo (sem `terminals` = nenhum);
 * `agent:terminal` troca o do agente. Outros eventos não mexem (devolve o mesmo objeto).
 */
export function applyTerminalEvent(state: TerminalsByAgent, event: ServerEvent): TerminalsByAgent {
  if (event.type === "office:snapshot") return event.terminals ? { ...event.terminals } : {};
  if (event.type === "agent:terminal") return { ...state, [event.terminal.agentId]: event.terminal };
  return state;
}

type TerminalsStoreState = {
  byAgent: TerminalsByAgent;
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

/** Terminais de CLI do workspace aberto (status, modo interativo e Remote Control do Maestro). */
export const useTerminalsStore = create<TerminalsStoreState>()((set, get) => ({
  byAgent: {},
  apply(event) {
    const current = get().byAgent;
    const next = applyTerminalEvent(current, event);
    if (next !== current) set({ byAgent: next });
  },
  reset() {
    set({ byAgent: {} });
  },
}));
