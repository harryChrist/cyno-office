import { isConversationLogId, type AgentLogEntry, type AgentTerminalInfo, type ChatMessageStatus } from "@cyno/shared";
import type { StatusTone } from "../ui/format";

/**
 * A conversa direta com um agente (a coluna "Conversa" da tela de trabalho dele): as falas do usuário
 * e as respostas do agente nos logs de conversa (`conversa-<agente>-AAAAMMDD`) e as notas que o
 * usuário mandou para uma tarefa em andamento (entradas `chat` no log da tarefa).
 */
export type AgentChatItem =
  | { kind: "message"; id: string; at: string; from: "user" | "agent"; text: string; taskId: string; note: boolean }
  | { kind: "notice"; id: string; at: string; text: string; tone: StatusTone };

/** Quantos itens a conversa mostra (os mais recentes). */
export const AGENT_CHAT_LIMIT = 80;
/** Fala do usuário sem resposta há mais que isto: para de mostrar "respondendo…" (a resposta se perdeu). */
export const AWAIT_REPLY_MS = 3 * 60_000;
/** O balão fica mais um pouco depois da resposta (respostas rápidas também aparecem no escritório). */
export const BUBBLE_AFTER_REPLY_MS = 8_000;

const QUEUED_NOTE = /^Nota na fila/;

export function agentChatItems(entries: readonly AgentLogEntry[], agentId: string, limit = AGENT_CHAT_LIMIT): AgentChatItem[] {
  const items: AgentChatItem[] = [];
  for (const entry of entries) {
    if (entry.agentId !== agentId || entry.thread !== undefined) continue;
    const conversation = isConversationLogId(entry.taskId);
    if (entry.kind === "chat") {
      items.push({ kind: "message", id: entry.id, at: entry.at, from: entry.from, text: entry.text, taskId: entry.taskId, note: !conversation });
    } else if (entry.kind === "status" && ((conversation && (entry.status === "waiting" || entry.status === "failed")) || QUEUED_NOTE.test(entry.message))) {
      items.push({ kind: "notice", id: entry.id, at: entry.at, text: entry.message, tone: entry.status === "failed" ? "danger" : "attention" });
    }
  }
  return items.slice(-limit);
}

/** O agente ainda está respondendo à última fala de conversa do usuário? (notas para tarefa não esperam resposta) */
export function awaitingAgentReply(items: readonly AgentChatItem[], now: number, windowMs = AWAIT_REPLY_MS): boolean {
  const last = items.findLast((item) => item.kind === "notice" || !item.note);
  if (!last || last.kind !== "message" || last.from !== "user") return false;
  const at = Date.parse(last.at);
  return Number.isFinite(at) && now - at < windowMs;
}

/**
 * "Fulano está respondendo…": o agente está num turno de conversa agora?
 * - o servidor diz que o terminal está conversando (`chatting`, que vem no estado inicial da página): sim;
 * - a mensagem foi vista ao vivo nesta aba (o servidor avisou na fila ou entregue): vale a janela de espera;
 * - recarregou a página (nada visto ao vivo) e o servidor conhece o terminal: não, ele não está conversando;
 * - o servidor não conhece o terminal (agente simulado, sem CLI): só a janela de espera da última fala.
 * Respondeu ou falhou: não.
 */
export function agentReplying(input: { items: readonly AgentChatItem[]; now: number; terminal: Pick<AgentTerminalInfo, "chatting"> | undefined; lastStatus: ChatMessageStatus | undefined }): boolean {
  const { items, now, terminal, lastStatus } = input;
  if (lastStatus === "failed" || lastStatus === "answered") return false;
  if (terminal?.chatting === true) return true;
  if (lastStatus === undefined && terminal) return false;
  return awaitingAgentReply(items, now);
}

/**
 * Agentes conversando com o usuário agora (o balão de fala no escritório): o terminal diz que está
 * num turno de conversa, a última fala de conversa do log é do usuário e ainda espera resposta, ou
 * o agente acabou de responder (BUBBLE_AFTER_REPLY_MS).
 */
export function chattingAgentIds(
  logs: Readonly<Record<string, readonly AgentLogEntry[]>>,
  terminals: Readonly<Record<string, AgentTerminalInfo>>,
  now: number,
): Set<string> {
  const out = new Set<string>();
  for (const [agentId, info] of Object.entries(terminals)) if (info.chatting) out.add(agentId);
  for (const [agentId, entries] of Object.entries(logs)) {
    if (out.has(agentId)) continue;
    let last: AgentLogEntry | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.thread === undefined && isConversationLogId(entry.taskId) && (entry.kind === "chat" || entry.kind === "status")) {
        last = entry;
        break;
      }
    }
    if (last?.kind !== "chat") continue;
    const age = now - Date.parse(last.at);
    if (age < (last.from === "user" ? AWAIT_REPLY_MS : BUBBLE_AFTER_REPLY_MS)) out.add(agentId);
  }
  return out;
}
