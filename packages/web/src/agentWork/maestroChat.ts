import { isConversationLogId, type AgentLogEntry, type OfficeState } from "@cyno/shared";
import type { TaskProgressMap } from "../store/taskProgress";
import type { StatusTone } from "../ui/format";
import { requestItem } from "./maestroTimeline";

/**
 * A conversa com o Maestro como um chat (o painel dele quando não há terminal interativo): as falas
 * do usuário e as respostas do Maestro (do log da conversa) e, entre elas, os pedidos que ele abriu
 * (com o estado e, quando fecham, a resposta final).
 */
export type ChatItem =
  | { kind: "message"; id: string; at: string; from: "user" | "agent"; text: string; fromTerminal: boolean }
  /** Aviso da conversa (mensagem esperando a cota, resposta que falhou). */
  | { kind: "notice"; id: string; at: string; text: string; tone: StatusTone }
  | { kind: "pedido"; id: string; at: string; taskId: string; title: string; stageLabel: string; tone: StatusTone; result?: string };

/** Quantos itens o chat mostra (os mais recentes). */
export const CHAT_ITEMS_LIMIT = 80;

/** O log do Maestro (e os pedidos dele) como chat, mais antigos primeiro. */
export function maestroChatItems(entries: readonly AgentLogEntry[], office: OfficeState, maestroId: string, progress: TaskProgressMap, limit = CHAT_ITEMS_LIMIT): ChatItem[] {
  const items: ChatItem[] = [];
  for (const entry of entries) {
    if (entry.agentId !== maestroId || entry.thread !== undefined || !isConversationLogId(entry.taskId)) continue;
    if (entry.kind === "chat") items.push({ kind: "message", id: entry.id, at: entry.at, from: entry.from, text: entry.text, fromTerminal: entry.via === "terminal" });
    else if (entry.kind === "status" && (entry.status === "waiting" || entry.status === "failed")) {
      items.push({ kind: "notice", id: entry.id, at: entry.at, text: entry.message, tone: entry.status === "failed" ? "danger" : "attention" });
    }
  }
  for (const task of office.tasks) {
    if (task.agentId !== maestroId || task.projectId !== undefined) continue;
    const item = requestItem(office, task, progress);
    items.push({
      kind: "pedido",
      id: `pedido-${task.id}`,
      at: task.createdAt,
      taskId: task.id,
      title: (task.prompt.split("\n")[0] ?? task.prompt).trim(),
      stageLabel: item.progress ? `${item.stageLabel} · ${item.progress.message}` : item.stageLabel,
      tone: item.tone,
      ...(item.result ? { result: item.result } : {}),
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return items.slice(-limit);
}

/** O Maestro ainda está respondendo à última fala do usuário? */
export function awaitingReply(items: readonly ChatItem[], working: boolean): boolean {
  if (!working) return false;
  const last = items.findLast((item) => item.kind === "message" || item.kind === "notice");
  return last?.kind === "message" && last.from === "user";
}
