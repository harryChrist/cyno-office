import { advanceChatStatus, type AgentChatStatus } from "@cyno/shared";
import { create } from "zustand";

/** Quantas mensagens o estado guarda (as mais antigas saem primeiro). */
const KEEP = 200;

/**
 * Aplica o estado de uma mensagem (função pura): só avança. Uma confirmação atrasada corrige "falhou" para
 * "entregue", nunca o contrário; o motivo do erro fica junto do estado (mesmo "entregue", se o turno falhou depois).
 */
export function applyChatStatus(byMessage: Readonly<Record<string, AgentChatStatus>>, incoming: AgentChatStatus): Record<string, AgentChatStatus> {
  const previous = byMessage[incoming.messageId];
  const status = advanceChatStatus(previous?.status, incoming.status);
  const error = incoming.error ?? (status === incoming.status ? undefined : previous?.error);
  const next: AgentChatStatus = { ...incoming, status, ...(error ? { error } : {}) };
  if (previous && previous.status === next.status && previous.error === next.error) return byMessage as Record<string, AgentChatStatus>;
  const merged = { ...byMessage, [incoming.messageId]: next };
  const ids = Object.keys(merged);
  if (ids.length > KEEP) for (const id of ids.slice(0, ids.length - KEEP)) delete merged[id];
  return merged;
}

/** O estado da mensagem mais recente do agente (por horário), se o servidor já disse algo dela. */
export function latestChatStatus(byMessage: Readonly<Record<string, AgentChatStatus>>, agentId: string): AgentChatStatus | undefined {
  let latest: AgentChatStatus | undefined;
  for (const item of Object.values(byMessage)) if (item.agentId === agentId && (!latest || item.at >= latest.at)) latest = item;
  return latest;
}

type ChatStatusState = {
  byMessage: Record<string, AgentChatStatus>;
  apply: (incoming: AgentChatStatus) => void;
  reset: () => void;
};

/** Em que pé está cada mensagem mandada a um agente pela caixa de conversa (evento `agent:chat-status`, sem polling). */
export const useChatStatusStore = create<ChatStatusState>()((set, get) => ({
  byMessage: {},
  apply(incoming) {
    const current = get().byMessage;
    const next = applyChatStatus(current, incoming);
    if (next !== current) set({ byMessage: next });
  },
  reset() {
    set({ byMessage: {} });
  },
}));
