import { isActiveTaskStatus, type Task } from "@cyno/shared";
import { shorten } from "../../util/text";

/** Etiqueta (tag do terminal) de uma mensagem de conversa: "conversa:<id>". */
export const CHAT_TAG_PREFIX = "conversa:";
export const isChatTag = (tag: string | undefined): tag is string => tag !== undefined && tag.startsWith(CHAT_TAG_PREFIX);

/** Limite do resultado de uma subtarefa repassado ao Maestro numa mensagem. */
export const RESULT_IN_MESSAGE = 6000;

/**
 * Boot: um pedido aberto do Maestro (em andamento, sem plano nem espera do usuário) precisa acordá-lo?
 * - Sem subtarefa em andamento: sim (`wake`). O turno dele foi cortado pelo reinício, ou a última
 *   entrega se perdeu na fila: a mensagem traz o pedido e o estado de cada subtarefa.
 * - Com alguma em andamento: não. O fim de cada uma acorda o Maestro com o resultado; as que já
 *   terminaram vão só num aviso (`notice`) junto da próxima mensagem dele.
 */
export function restartResume(
  task: Pick<Task, "id" | "prompt">,
  subtasks: Task[],
  agentName: (agentId: string | undefined) => string,
): { wake: string } | { notice?: string } {
  const finished = subtasks.filter((subtask) => !isActiveTaskStatus(subtask.status));
  if (finished.length < subtasks.length) {
    if (finished.length === 0) return {};
    const list = finished.map((subtask) => `${subtask.id} (${agentName(subtask.agentId)}): ${subtask.status}`).join("; ");
    return { notice: `O servidor reiniciou enquanto o pedido ${task.id} esperava subtarefas; estas já tinham terminado (detalhes com get_task): ${list}.` };
  }
  const lines = subtasks.map((subtask) => `- ${subtask.id} (${agentName(subtask.agentId)}): ${subtask.status}${subtask.result ? ` — ${shorten(subtask.result, 600)}` : ""}`);
  return {
    wake: [`O servidor reiniciou. O pedido ${task.id} ainda está aberto: ${task.prompt}`, lines.length > 0 ? `Subtarefas:\n${lines.join("\n")}` : "Nenhuma subtarefa ainda.", "Continue de onde parou."].join("\n\n"),
  };
}

/**
 * O texto final de um turno é uma pergunta ao usuário? (a última linha termina em "?", ou há várias
 * perguntas no fim de um texto curto). Aí o pedido não fecha: espera a resposta na conversa.
 */
export function looksLikeQuestion(text: string): boolean {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = (lines.at(-1) ?? "").replace(/[*_`)\]\s]+$/u, "");
  if (last.endsWith("?")) return true;
  // Várias perguntas seguidas só valem num texto curto de pergunta. Um relatório longo que termina
  // listando decisões em aberto ("- quer que eu crie X?") é um relatório, não um pedido de resposta.
  if (lines.length > SHORT_QUESTION_LINES || text.length > SHORT_QUESTION_CHARS) return false;
  return lines.slice(-4).filter((line) => /\?[*_`)\s]*$/u.test(line)).length >= 2;
}

const SHORT_QUESTION_LINES = 6;
const SHORT_QUESTION_CHARS = 600;

/** Id de pedido ("Pedido <uuid>") citado num texto digitado direto no terminal do Maestro. */
export function citedRequestId(prompt: string): string | undefined {
  return /Pedido ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(prompt)?.[1];
}
