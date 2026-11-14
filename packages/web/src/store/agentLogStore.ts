import { AGENT_LOG_LIMITS, type AgentLogEntry, type AgentLogSummary } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { AGENT_LOG_CAP, mergeEntry, mergeHistory, TASK_LOG_CACHE, TASK_LOG_CAP } from "./agentLog";
import { useNavStore } from "./navStore";

/** idle = nunca pedido (ou invalidado na reconexão); loading; ready; error (com a mensagem). */
export type LogLoad = { state: "loading" | "ready" } | { state: "error"; message: string };

type AgentLogState = {
  /** Entradas recentes por agente (histórico do GET + eventos ao vivo), as mais novas por último. */
  byAgent: Record<string, AgentLogEntry[]>;
  /** Resumo do server por agente (o que veio no último GET). */
  summaries: Record<string, AgentLogSummary>;
  agentLoad: Record<string, LogLoad>;
  /** Log completo das tarefas abertas na tela (inclui as threads dos subagentes). */
  byTask: Record<string, AgentLogEntry[]>;
  taskLoad: Record<string, LogLoad>;
  /** Ordem em que os logs de tarefa entraram (para tirar os mais antigos do cache). */
  taskOrder: string[];
  /** Sobe a cada reconexão: as telas abertas recarregam o que estão mostrando. */
  generation: number;
  /** Carrega o histórico do agente (GET agents/:id/log). `force` busca de novo mesmo se já carregou. */
  loadAgent: (agentId: string, force?: boolean) => Promise<void>;
  /** Carrega o log de uma tarefa (GET tasks/:id/log), com as entradas dos subagentes. */
  loadTask: (taskId: string, force?: boolean) => Promise<void>;
  /** Aplica um `agent:log` do WebSocket. */
  apply: (entry: AgentLogEntry) => void;
  /** Reconexão: o que foi carregado pode ter perdido eventos; as telas abertas recarregam. */
  invalidate: () => void;
  /** Troca de workspace: esquece tudo. */
  reset: () => void;
};

const EMPTY = { byAgent: {}, summaries: {}, agentLoad: {}, byTask: {}, taskLoad: {}, taskOrder: [] };

/** Sobe a cada reset: respostas de um workspace anterior são descartadas. */
let session = 0;

export const useAgentLogStore = create<AgentLogState>()((set, get) => ({
  ...EMPTY,
  generation: 0,

  async loadAgent(agentId, force = false) {
    const current = get().agentLoad[agentId];
    if (current?.state === "loading" || (current?.state === "ready" && !force)) return;
    if (!useNavStore.getState().workspaceId) return;
    const mine = session;
    set((state) => ({ agentLoad: { ...state.agentLoad, [agentId]: { state: "loading" } } }));
    try {
      const response = await api.getAgentLog(agentId, AGENT_LOG_LIMITS.perAgent);
      if (mine !== session) return;
      set((state) => ({
        byAgent: { ...state.byAgent, [agentId]: mergeHistory(state.byAgent[agentId] ?? [], response.entries, AGENT_LOG_CAP) },
        summaries: { ...state.summaries, [agentId]: response.summary },
        agentLoad: { ...state.agentLoad, [agentId]: { state: "ready" } },
      }));
    } catch (error) {
      if (mine !== session) return;
      set((state) => ({ agentLoad: { ...state.agentLoad, [agentId]: { state: "error", message: describeError(error) } } }));
    }
  },

  async loadTask(taskId, force = false) {
    const current = get().taskLoad[taskId];
    if (current?.state === "loading" || (current?.state === "ready" && !force)) return;
    if (!useNavStore.getState().workspaceId) return;
    const mine = session;
    set((state) => ({ taskLoad: { ...state.taskLoad, [taskId]: { state: "loading" } } }));
    try {
      const response = await api.getTaskLog(taskId);
      if (mine !== session) return;
      set((state) => {
        const order = [...state.taskOrder.filter((id) => id !== taskId), taskId];
        const byTask = { ...state.byTask, [taskId]: mergeHistory(state.byTask[taskId] ?? [], response.entries, TASK_LOG_CAP) };
        const taskLoad = { ...state.taskLoad, [taskId]: { state: "ready" } as LogLoad };
        // Cache cheio: sai o log de tarefa mais antigo.
        while (order.length > TASK_LOG_CACHE) {
          const old = order.shift()!;
          delete byTask[old];
          delete taskLoad[old];
        }
        return { byTask, taskLoad, taskOrder: order };
      });
    } catch (error) {
      if (mine !== session) return;
      set((state) => ({ taskLoad: { ...state.taskLoad, [taskId]: { state: "error", message: describeError(error) } } }));
    }
  },

  apply(entry) {
    set((state) => {
      const changes: Partial<AgentLogState> = {
        byAgent: { ...state.byAgent, [entry.agentId]: mergeEntry(state.byAgent[entry.agentId] ?? [], entry, AGENT_LOG_CAP) },
      };
      // O log da tarefa só é mantido ao vivo se já foi carregado (senão o GET traz tudo depois).
      const task = state.byTask[entry.taskId];
      if (task) changes.byTask = { ...state.byTask, [entry.taskId]: mergeEntry(task, entry, TASK_LOG_CAP) };
      return changes;
    });
  },

  invalidate() {
    set((state) => ({ agentLoad: {}, taskLoad: {}, generation: state.generation + 1 }));
  },

  reset() {
    session += 1;
    set((state) => ({ ...EMPTY, generation: state.generation + 1 }));
  },
}));
