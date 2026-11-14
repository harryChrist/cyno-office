import { isConversationLogId, parseJointMarker, parseAskMarker, parseConfirmationMarker, parseProposalMarker, parseRequestMarker, type AgentLogEntry } from "@cyno/shared";
import { type StatusTone } from "../ui/format";
import { entryToActivity } from "./maestroActivity";

/**
 * A conversa com o Cyno como um chat: as falas do dono, as respostas do Cyno, os avisos (motor sem
 * cota, nova conversa, falhas) e, entre a fala e a resposta, o TRABALHO dele (ferramentas chamadas e
 * narração), que aparece ao vivo enquanto ele trabalha e depois fica recolhido.
 */
export type CynoWorkStep = {
  id: string;
  at: string;
  kind: "tool" | "note";
  label: string;
  detail?: string;
  tone: StatusTone;
  /** Ferramenta ainda rodando. */
  running: boolean;
};

export type CynoChatItem =
  | { kind: "message"; id: string; at: string; from: "user" | "agent"; text: string }
  | { kind: "notice"; id: string; at: string; text: string; tone: "info" | "attention" | "danger" }
  /** O Cyno enviou um pedido a um Maestro: cartão compacto, com o estado ao vivo (vem da lista de pedidos). */
  | { kind: "request"; id: string; at: string; workspace: string; projectId: string; title: string }
  /** O Cyno montou um projeto conjunto (uma parte em cada workspace): cartão ao vivo (vem da lista de projetos conjuntos). */
  | { kind: "joint"; id: string; at: string; jointId: string; title: string }
  /** Pedido de OK para uma ação perigosa: o cartão mostra o estado ao vivo (vem da lista de confirmações). */
  | { kind: "confirmation"; id: string; at: string; confirmationId: string }
  /** Proposta de workspace inteiro: o cartão mostra a proposta ao vivo (vem da lista de propostas). */
  | { kind: "proposal"; id: string; at: string; proposalId: string }
  /** Uma troca `ask_cyno` (o Maestro perguntou, o Cyno respondeu): linha discreta. */
  | { kind: "ask"; id: string; at: string; text: string }
  /** O que o Cyno fez entre a fala do dono e a resposta (`live`: ainda está fazendo). */
  | { kind: "work"; id: string; at: string; steps: CynoWorkStep[]; live: boolean };

/** Quantos itens o chat mostra (os mais recentes). */
export const CYNO_CHAT_LIMIT = 120;

const flat = (text: string) => text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").replace(/…$/, "").trim();
/** A narração é o começo da resposta? */
const sameStart = (note: string, reply: string) => flat(note).length > 0 && flat(reply).startsWith(flat(note).slice(0, 80));

function stepOf(entry: AgentLogEntry): CynoWorkStep | undefined {
  if (entry.thread !== undefined) return undefined;
  if (entry.kind !== "tool" && entry.kind !== "text") return undefined;
  const step = entryToActivity(entry);
  if (!step || (step.kind !== "tool" && step.kind !== "note")) return undefined;
  // Ferramenta sem argumentos mostra "{}" no resumo: não é detalhe.
  const detail = step.detail && step.detail !== "{}" ? step.detail : undefined;
  return { id: step.id, at: step.at, kind: step.kind, label: step.label, ...(detail ? { detail } : {}), tone: step.tone, running: entry.kind === "tool" && entry.status === "running" };
}

/** O log do Cyno como chat, mais antigos primeiro. `working`: o Cyno está num turno agora (o trabalho do fim é ao vivo). */
export function cynoChatItems(entries: readonly AgentLogEntry[], working: boolean, limit = CYNO_CHAT_LIMIT): CynoChatItem[] {
  const items: CynoChatItem[] = [];
  let pending: CynoWorkStep[] = [];
  const flush = (reply: string | undefined, live: boolean) => {
    // A narração logo antes da resposta costuma ser a própria resposta: fica só a resposta.
    const steps = pending.filter((step, index) => !(reply !== undefined && step.kind === "note" && index === pending.length - 1 && sameStart(step.label, reply)));
    pending = [];
    if (steps.length > 0) items.push({ kind: "work", id: `work-${steps[0]!.id}`, at: steps[0]!.at, steps, live });
  };
  for (const entry of entries) {
    if (!isConversationLogId(entry.taskId) || entry.thread !== undefined) continue;
    if (entry.kind === "chat") {
      flush(entry.from === "agent" ? entry.text : undefined, false);
      items.push({ kind: "message", id: entry.id, at: entry.at, from: entry.from, text: entry.text });
    } else if (entry.kind === "status" && parseRequestMarker(entry.message)) {
      flush(undefined, false);
      const request = parseRequestMarker(entry.message)!;
      items.push({ kind: "request", id: entry.id, at: entry.at, ...request });
    } else if (entry.kind === "status" && parseJointMarker(entry.message)) {
      flush(undefined, false);
      const joint = parseJointMarker(entry.message)!;
      items.push({ kind: "joint", id: entry.id, at: entry.at, ...joint });
    } else if (entry.kind === "status" && parseConfirmationMarker(entry.message)) {
      flush(undefined, false);
      items.push({ kind: "confirmation", id: entry.id, at: entry.at, confirmationId: parseConfirmationMarker(entry.message)! });
    } else if (entry.kind === "status" && parseProposalMarker(entry.message)) {
      flush(undefined, false);
      items.push({ kind: "proposal", id: entry.id, at: entry.at, proposalId: parseProposalMarker(entry.message)! });
    } else if (entry.kind === "status" && parseAskMarker(entry.message) !== undefined) {
      flush(undefined, false);
      items.push({ kind: "ask", id: entry.id, at: entry.at, text: parseAskMarker(entry.message)! });
    } else if (entry.kind === "status" && (entry.status === "waiting" || entry.status === "failed" || entry.status === "resumed")) {
      flush(undefined, false);
      items.push({ kind: "notice", id: entry.id, at: entry.at, text: entry.message, tone: entry.status === "failed" ? "danger" : entry.status === "waiting" ? "attention" : "info" });
    } else {
      const step = stepOf(entry);
      if (step) {
        // Entrada atualizada no lugar (ferramenta que terminou) já vem com o mesmo id: substitui.
        const index = pending.findIndex((current) => current.id === step.id);
        if (index === -1) pending.push(step);
        else pending[index] = step;
      }
    }
  }
  flush(undefined, working);
  return items.slice(-limit);
}

/** O Cyno está respondendo e ainda não mostrou nada além da fala do dono? (o "pensando…") */
export function cynoThinking(items: readonly CynoChatItem[], working: boolean, waking: boolean): boolean {
  if (!working && !waking) return false;
  const last = items.at(-1);
  if (!last) return false;
  if (last.kind === "message") return last.from === "user";
  return last.kind === "work" && !last.live;
}
