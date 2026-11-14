import type { ForYouItem, ForYouRule, ForYouRuleScope } from "@cyno/shared";

/** Textos e contas do cartão "regra" (sem React, para testar). */

/** Uma chave estável do escopo (para o `key` do React e o `data-testid`). */
export function scopeKey(scope: ForYouRuleScope): string {
  if (scope.global) return "global";
  if (scope.agentId) return `agent-${scope.agentId}`;
  return `room-${scope.roomId ?? ""}`;
}

/** Dois escopos valem o mesmo lugar (o quarto que acompanha o agente não conta). */
export function sameScope(a: ForYouRuleScope, b: ForYouRuleScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** "Só Eco", "Todos do quarto Estúdio" ou "Todo o workspace". */
export function ruleScopeLabel(scope: ForYouRuleScope, agentName: string | undefined, roomName: string | undefined): string {
  if (scope.global) return "Todo o workspace";
  if (scope.agentId) return `Só ${agentName ?? "o agente"}`;
  return `Todos do quarto ${roomName ?? ""}`.trim();
}

export type RuleScopeOption = { scope: ForYouRuleScope; label: string; hint: string };

/** As três opções de escopo do cartão: o agente do cartão, o quarto dele e o workspace inteiro (cada uma diz onde a nota vai). */
export function ruleScopeOptions(item: Pick<ForYouItem, "agentId" | "roomId">, rule: Pick<ForYouRule, "scope">, agentName: string | undefined, roomName: string | undefined): RuleScopeOption[] {
  const agent: ForYouRuleScope = { agentId: rule.scope.agentId ?? item.agentId, roomId: rule.scope.roomId ?? item.roomId };
  return [
    { scope: agent, label: ruleScopeLabel(agent, agentName, roomName), hint: `Nota no Cérebro do quarto${roomName ? ` ${roomName}` : ""}, só para ele` },
    { scope: { roomId: rule.scope.roomId ?? item.roomId }, label: ruleScopeLabel({ roomId: item.roomId }, agentName, roomName), hint: "Nota no Cérebro do quarto, para quem trabalha nele" },
    { scope: { global: true }, label: "Todo o workspace", hint: "Nota no Cérebro global, para todos os agentes" },
  ];
}

export const ruleSourceLabel = (source: ForYouRule["source"]): string => (source === "molde" ? "Texto por molde, sem IA." : "Escrita pelo Maestro.");

/** "Aprovada em 13/11", "Recusada: volta só depois de 8 semanas". */
export function ruleStateText(item: Pick<ForYouItem, "status" | "decidedAt">): string {
  const when = item.decidedAt ? new Date(item.decidedAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }) : "";
  if (item.status === "aprovado") return `aprovada${when ? ` em ${when}` : ""}: a nota está no Cérebro`;
  if (item.status === "rejeitado") return `recusada${when ? ` em ${when}` : ""}: o padrão volta só depois de 8 semanas`;
  return "esperando o seu OK";
}
