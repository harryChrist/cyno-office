import type { AttentionAlert, AttentionKind } from "@cyno/shared";
import { useMemo } from "react";
import { useAttentionStore } from "../store/attentionStore";
import { useNavStore } from "../store/navStore";

/** O que um agente está pedindo ao dono: o tipo do pedido mais antigo, desde quando e quantos. */
export type AgentAttention = { kind: AttentionKind; since: string; count: number };

/**
 * Os agentes que precisam do dono, a partir dos alertas abertos (pura). Só entram os alertas que
 * esperam o dono e que têm agente; `workspaceId` limita a um workspace (a lista e a cena mostram
 * um workspace por vez). É daqui que sai a mão levantada da cena.
 */
export function agentAttentionOf(open: readonly AttentionAlert[], workspaceId?: string | null): Map<string, AgentAttention> {
  const result = new Map<string, AgentAttention>();
  for (const alert of [...open].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!alert.needsOwner || !alert.agentId) continue;
    if (workspaceId && alert.workspaceId !== workspaceId) continue;
    const current = result.get(alert.agentId);
    if (current) current.count += alert.count;
    else result.set(alert.agentId, { kind: alert.kind, since: alert.at, count: alert.count });
  }
  return result;
}

/**
 * PONTO DE ENCAIXE DA CENA. Quem desenha o escritório chama isto (de um efeito, ou com
 * `useAgentsNeedingAttention` num componente) para saber quem tem a mão levantada: o `Map` tem o id
 * do agente e `{ kind, since, count }`. Sem `workspaceId`, vale o workspace aberto agora.
 */
export function agentesQuePedemAtencao(workspaceId?: string | null): Map<string, AgentAttention> {
  const workspace = workspaceId === undefined ? useNavStore.getState().workspaceId : workspaceId;
  return agentAttentionOf(useAttentionStore.getState().open, workspace);
}

/** O mesmo, como gancho: refaz quando os alertas ou o workspace mudam. */
export function useAgentsNeedingAttention(): Map<string, AgentAttention> {
  const open = useAttentionStore((state) => state.open);
  const workspaceId = useNavStore((state) => state.workspaceId);
  return useMemo(() => agentAttentionOf(open, workspaceId), [open, workspaceId]);
}
