import {
  ATTENTION_TEXT_MAX,
  ENGINE_LABELS,
  FOR_YOU_QUESTION_TYPE,
  forYouKind,
  maskSecrets,
  needsOwnerOf,
  type AgentEngine,
  type AttentionKind,
  type AttentionLevel,
  type AttentionTarget,
  type ForYouItem,
  type HelpKind,
  type SubscriptionUsage,
  type UsageWindow,
} from "@cyno/shared";

/**
 * As regras da cadeia de atenção, todas funções puras: que tipo de alerta cada coisa vira, o texto
 * (pt-BR, até 140 caracteres, sem segredos) e o nível do limite de uso. O `AttentionService` só
 * liga isto aos eventos dos workspaces.
 */

/** Texto de uma linha, sem segredos e cortado no teto. */
export function cutText(text: string, max = ATTENTION_TEXT_MAX): string {
  const clean = maskSecrets(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Corta um trecho para caber dentro de uma frase maior. */
const snippet = (text: string | undefined, max: number): string => {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/** Que tipo de alerta um item do "Para você" pendente vira. */
export function forYouAlertKind(item: Pick<ForYouItem, "kind" | "type">): AttentionKind {
  const kind = forYouKind(item);
  if (kind === "plano") return "plan";
  if (kind === "sprint") return "sprint";
  if (kind === "rotina") return "routine";
  if (kind === "questionario" || item.type === FOR_YOU_QUESTION_TYPE) return "question";
  return "approval";
}

export type ForYouAlertContext = { item: ForYouItem; agentName?: string; projectTitle?: string; sprintName?: string };

/** O texto do alerta de um item (ou de um lote de `count` itens). */
export function forYouText(kind: AttentionKind, context: ForYouAlertContext, count: number): string {
  const { item } = context;
  const who = context.agentName ?? "Um agente";
  const what = snippet(item.title ?? ([item.where, item.to].filter(Boolean).join(" · ") || item.text), 70);
  if (kind === "plan") return cutText(`${context.projectTitle ?? "Um plano"}: o plano espera o seu OK`);
  if (kind === "sprint") return cutText(`${context.sprintName ?? "Uma sprint"} terminou: confira a entrega`);
  if (kind === "routine") return cutText(`Rotina${item.routine?.title ? ` “${snippet(item.routine.title, 50)}”` : ""}: precisa do seu OK`);
  if (kind === "question") return cutText(count > 1 ? `${who} tem ${count} perguntas para você` : `${who} tem uma pergunta${what ? `: ${what}` : ""}`);
  return cutText(count > 1 ? `${who} pediu ${count} aprovações` : `${who} pede a sua aprovação${what ? `: ${what}` : ""}`);
}

/** "“Criar a imagem” (Projeto X) está travada: “Criar os textos” foi cancelada". */
export function blockedAlertText(taskTitle: string, projectTitle: string, deadTitle: string, deadStatus: string, more: number): string {
  const verb = deadStatus === "falhou" ? "falhou" : "foi cancelada";
  return cutText(`“${snippet(taskTitle, 40)}” (${snippet(projectTitle, 30)}) está travada: “${snippet(deadTitle, 40)}” ${verb}${more > 0 ? ` (e mais ${more})` : ""}`);
}

export function helpText(agentName: string | undefined, what: string, kind: HelpKind | undefined): string {
  const who = agentName ?? "Um agente";
  return cutText(kind === "access" ? `${who} precisa de um acesso: ${snippet(what, 90)}` : `${who} pediu ajuda e o Maestro não respondeu: ${snippet(what, 80)}`);
}

export function failedText(agentName: string | undefined, prompt: string, count: number, projectTitle?: string): string {
  if (count > 1) return cutText(`${count} tarefas falharam${projectTitle ? ` em ${projectTitle}` : ""}`);
  return cutText(`${agentName ? `${agentName}: a` : "A"} tarefa falhou${prompt ? ` · ${snippet(prompt, 80)}` : ""}`);
}

/** A entrega nova: a manchete do resultado (ou o pedido, se não houver texto). */
export function deliveryText(agentName: string | undefined, headline: string): string {
  return cutText(`${agentName ? `${agentName} entregou` : "Entrega pronta"}: ${snippet(headline, 100)}`);
}

export function projectDeliveredText(title: string): string {
  return cutText(`Projeto ${snippet(title, 80)} concluído`);
}

export function engineDownText(agentName: string | undefined, engine: AgentEngine | undefined): string {
  const label = engine ? ENGINE_LABELS[engine] : "O terminal";
  return cutText(`${label}${agentName ? ` de ${agentName}` : ""} caiu e não voltou`);
}

// ---------- Limite de uso ----------

/** 0 = sem alerta, 1 = 80%, 2 = 95%, 3 = esgotada. */
export type UsageLevel = 0 | 1 | 2 | 3;
export const USAGE_LEVEL_AT = [0, 0.8, 0.95, 1] as const;
export const USAGE_LEVEL_NAME = ["", "80", "95", "esgotado"] as const;

/** Em que nível de alerta a janela está (a janela `rejected` conta como esgotada). */
export function usageLevelOf(window: Pick<UsageWindow, "utilization" | "status">): UsageLevel {
  if (window.status === "rejected" || window.utilization >= 1) return 3;
  if (window.utilization >= USAGE_LEVEL_AT[2]) return 2;
  if (window.utilization >= USAGE_LEVEL_AT[1]) return 1;
  return 0;
}

/** O nível segue valendo até o uso cair `hysteresis` abaixo do limiar dele. */
export function usageLevelStillHolds(level: UsageLevel, window: Pick<UsageWindow, "utilization" | "status">, hysteresis: number): boolean {
  if (level === 0) return false;
  if (level === 3) return window.status === "rejected" || window.utilization >= 1 - hysteresis;
  return window.utilization >= USAGE_LEVEL_AT[level] - hysteresis;
}

/** 80% é aviso (warn); 95% e esgotada chamam (alert), mas limite de uso nunca entra no número da aba. */
export function usageAlertLevel(level: UsageLevel): { level: AttentionLevel; needsOwner: boolean } {
  const alertLevel: AttentionLevel = level >= 2 ? "alert" : "warn";
  return { level: alertLevel, needsOwner: needsOwnerOf("usage", alertLevel) };
}

const WINDOW_LABELS: Record<string, string> = { five_hour: "5 h", seven_day: "semana", seven_day_opus: "semana (Opus)", seven_day_sonnet: "semana (Sonnet)" };

export function usageWindowLabel(window: Pick<UsageWindow, "id" | "label">): string {
  return window.label ?? WINDOW_LABELS[window.id] ?? window.id;
}

/** "Claude Code: 5 h em 86%, volta às 15h" / "…esgotada, volta às 15h". */
export function usageText(usage: Pick<SubscriptionUsage, "provider">, window: UsageWindow, level: UsageLevel, resetClock: (iso: string) => string): string {
  const provider = ENGINE_LABELS[usage.provider as AgentEngine] ?? usage.provider;
  const when = window.resetsAt ? `, volta ${resetClock(window.resetsAt)}` : "";
  const label = usageWindowLabel(window);
  if (level === 3) return cutText(`${provider}: ${label} esgotada${when}`);
  return cutText(`${provider}: ${label} em ${Math.round(window.utilization * 100)}%${when}`);
}

/** Para onde cada tipo leva. */
export function targetOf(kind: AttentionKind, parts: { workspaceId?: string; ref?: string }): AttentionTarget {
  const base = parts.workspaceId ? { workspaceId: parts.workspaceId } : {};
  const ref = parts.ref ? { ref: parts.ref } : {};
  if (kind === "failed" || kind === "blocked" || kind === "help" || kind === "delivery") return { page: "trabalho", ...base, ...ref };
  if (kind === "engine_down") return { page: "agente", ...base, ...ref };
  if (kind === "usage" || kind === "budget") return { page: "gestao", ...base, ref: "gastos" };
  return { page: "para-voce", ...base, ...ref };
}
