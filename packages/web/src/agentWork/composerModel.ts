// Adaptado de Habblaud (github.com/marmottajr/habblaud), MIT, Copyright (c) 2026 Márcio Junior.
// Origem: client/src/ui/composer-model.ts (`enterSends`, `canSend`, `messageText`, `sendStatusText`,
// `DELIVERED_SHOW_MS`). Os estados aqui são os do Cyno (o servidor conhece a entrega: não há polling nem
// plugin) e vêm do evento `agent:chat-status`. Sem `tr()` (o Cyno é só pt-BR).
import { advanceChatStatus, type AgentChatStatus, type AgentTerminalInfo, type ChatMessageStatus } from "@cyno/shared";

/** Tamanho máximo de uma mensagem pela caixa (o servidor aceita mais; a caixa é de conversa, não de pedido). */
export const MESSAGE_MAX = 20_000;
/** O contador aparece quando a mensagem passa desta fração do limite. */
export const COUNTER_FROM = 0.8;
/** "Entregue" some sozinho depois deste tempo; "Respondeu" fica só um instante; erros ficam até o próximo envio. */
export const DELIVERED_SHOW_MS = 12_000;
export const ANSWERED_SHOW_MS = 4_000;
/** Na fila por mais que isto com o terminal parado: avisa e oferece subir o terminal. */
export const QUEUED_STALE_MS = 60_000;

/** O que sai da caixa: o texto como foi digitado, sem os espaços e linhas em branco do fim. */
export function messageText(raw: string): string {
  return raw.replace(/\s+$/, "");
}

export function canSend(raw: string, busy = false): boolean {
  const text = messageText(raw);
  return !busy && text.trim().length > 0 && text.length <= MESSAGE_MAX;
}

/** Enter manda; Shift+Enter (e Alt+Enter) quebram a linha; Enter compondo um acento (IME) não conta. */
export function enterSends(e: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "isComposing">): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing;
}

/** O contador de tamanho ("18.400 / 20.000"), só perto do fim; "" quando não precisa aparecer. */
export function counterText(length: number, max = MESSAGE_MAX): string {
  if (length < max * COUNTER_FROM) return "";
  return `${length.toLocaleString("pt-BR")} / ${max.toLocaleString("pt-BR")}`;
}

/** Situação do último envio de um agente: `sending` (o POST não voltou), `rejected` (o servidor recusou) ou a da entrega. */
export type SendPhase = "sending" | "rejected" | ChatMessageStatus;

export type SendState = {
  phase: SendPhase;
  /** Id da mensagem (depois da resposta do POST). */
  messageId?: string;
  mode?: "nota" | "conversa";
  /** O texto enviado: volta para a caixa se a entrega falhar, e é o que "tentar de novo" manda. */
  text: string;
  error?: string;
  /** Última mudança (epoch ms, relógio da página). */
  at: number;
};

/**
 * O estado que a tela mostra: o do envio, corrigido pelo que o servidor já disse da mensagem (o evento pode
 * chegar antes da resposta do POST). Só avança: "falhou" cede a uma confirmação atrasada, "entregue" não volta atrás.
 */
export function viewSend(state: SendState | undefined, byMessage: Readonly<Record<string, AgentChatStatus>>, now: number): SendState | undefined {
  if (!state) return undefined;
  const server = state.messageId ? byMessage[state.messageId] : undefined;
  if (!server || state.phase === "sending" || state.phase === "rejected") return state;
  const phase = advanceChatStatus(state.phase, server.status);
  const at = Math.max(state.at, Date.parse(server.at) || 0, phase === state.phase ? 0 : now);
  return { ...state, phase, at, ...(server.error ? { error: server.error } : {}) };
}

/** A mensagem ainda está na fila (ou sendo enviada)? */
export function isWaiting(phase: SendPhase): boolean {
  return phase === "sending" || phase === "queued";
}

/** Texto da linha de situação ('' = nada a mostrar). */
export function sendStatusText(state: SendState | undefined, now: number, terminal?: Pick<AgentTerminalInfo, "status">, who = "o agente"): string {
  if (!state) return "";
  const note = state.mode === "nota";
  switch (state.phase) {
    case "sending":
      return "Enviando…";
    case "queued":
      if (now - state.at >= QUEUED_STALE_MS && terminal && (terminal.status === "stopped" || terminal.status === "error")) return "Na fila há mais de 1 min: o terminal está parado.";
      return note ? `Na fila: ${who} termina o turno e lê a nota.` : `Na fila: ${who} termina o que está fazendo e lê.`;
    case "delivered":
      if (state.error) return `Entregue, mas o turno falhou: ${state.error}`;
      return now - state.at >= DELIVERED_SHOW_MS ? "" : note ? `Entregue ✓: ${who} levou a nota em conta.` : "Entregue ✓";
    case "answered":
      return now - state.at >= ANSWERED_SHOW_MS ? "" : note ? "Respondeu ✓: o turno com a nota terminou." : "Respondeu ✓";
    case "rejected":
      return `Não foi possível mandar: ${state.error ?? "erro desconhecido"}`;
    case "failed":
      return `Não foi entregue: ${state.error ?? "erro desconhecido"}`;
  }
}

/** Quando a linha de situação precisa ser reavaliada (ela some sozinha); null = não precisa. */
export function nextCheckIn(state: SendState | undefined, now: number): number | null {
  if (!state) return null;
  if (state.phase === "queued") return Math.max(0, state.at + QUEUED_STALE_MS - now) || null;
  if (state.phase === "delivered" && !state.error) return Math.max(0, state.at + DELIVERED_SHOW_MS - now);
  if (state.phase === "answered") return Math.max(0, state.at + ANSWERED_SHOW_MS - now);
  return null;
}

/** "Tentar de novo" só vale para o que falhou. */
export function canRetry(state: SendState | undefined): boolean {
  return state?.phase === "failed";
}

// ---------------------------------------------------------------- rascunho por agente (em memória)

const drafts = new Map<string, string>();

/** Rascunho guardado do agente: o texto que ficou na caixa ao trocar de agente. */
export function getDraft(agentId: string): string {
  return drafts.get(agentId) ?? "";
}

export function setDraft(agentId: string, text: string): void {
  if (text) drafts.set(agentId, text);
  else drafts.delete(agentId);
}
