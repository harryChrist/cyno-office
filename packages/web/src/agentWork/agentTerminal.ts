import { isConversationLogId, OFFICE_MCP_SERVER, type AgentLogEntry, type AgentLogStatus } from "@cyno/shared";
import { officeToolName, officeToolShort } from "./officeTools";
import { formatDuration } from "./agentLogTimeline";

/**
 * O log de trabalho de um agente como uma sessão de terminal (só leitura): uma linha por entrada,
 * com um prefixo de prompt e uma cor por tipo. É montado das entradas estruturadas (AgentLogEntry),
 * não da saída crua da CLI: o que o usuário vê é o mesmo para Claude Code, Antigravity e simulados.
 */
export type TerminalTone = "text" | "user" | "agent" | "tool" | "ok" | "error" | "warn" | "info" | "dim" | "result" | "section";

export type TerminalLine = {
  id: string;
  /** O tipo da entrada do log de onde veio (as linhas de seção usam "section"). */
  kind: AgentLogEntry["kind"] | "section";
  /** Quem falou, nas entradas `chat` (os filtros separam o dono do agente). */
  from?: "user" | "agent";
  at: string;
  /** Tarefa (ou log de conversa) de onde veio. */
  taskId: string;
  tone: TerminalTone;
  /** Prefixo estilo prompt ("❯", "⏺", "$"…). */
  prefix: string;
  /** Texto principal (pode ter várias linhas). */
  text: string;
  /** Sufixo curto (estado e duração da ferramenta, modelo do subagente). */
  meta?: string;
  /** Linhas a mais, mais apagadas (saída da ferramenta, objetivo do subagente, motivo). */
  detail?: string;
  /** Nome cru da ferramenta (a tela acha o conector dela, se for de um). */
  tool?: string;
  /** Rótulo do subagente, se a linha é da thread dele (a linha vem recuada). */
  thread?: string;
};

const STATUS_TONES: Record<AgentLogStatus, TerminalTone> = { started: "info", waiting: "warn", resumed: "info", done: "ok", failed: "error", canceled: "error" };
const OFFICE_PREFIX = `mcp__${OFFICE_MCP_SERVER}__`;

/**
 * Nome da ferramenta para a linha: as do escritório com o rótulo curto em pt-BR ("submit_result" ->
 * "entregar"; o nome antigo também), as de conector sem o prefixo MCP e as outras como vieram.
 */
export function toolLabel(name: string): string {
  const office = officeToolName(name);
  if (office) return officeToolShort(office);
  return name.startsWith(OFFICE_PREFIX) ? name.slice(OFFICE_PREFIX.length) : name;
}

/** "1 pergunta" / "3 perguntas". */
const questionsLabel = (count: number) => (count === 1 ? "1 pergunta" : `${count} perguntas`);

/** Uma entrada do log como linha de terminal. `agentName` vai nas respostas da conversa. */
export function entryToTerminalLine(entry: AgentLogEntry, agentName: string, threadLabel?: string): TerminalLine {
  const base = { id: entry.id, kind: entry.kind, at: entry.at, taskId: entry.taskId, ...(threadLabel ? { thread: threadLabel } : {}) };
  switch (entry.kind) {
    case "text":
      return { ...base, tone: "text", prefix: "●", text: entry.text };
    case "chat": {
      const conversation = isConversationLogId(entry.taskId);
      if (entry.from === "user") return { ...base, from: "user" as const, tone: "user", prefix: "❯", text: entry.text, meta: conversation ? "você" : "você · nota para a tarefa" };
      return { ...base, from: "agent" as const, tone: "agent", prefix: "◀", text: entry.text, meta: agentName };
    }
    case "tool": {
      const state = entry.status === "running" ? "rodando…" : entry.status === "ok" ? "✓" : "✗ erro";
      const meta = [state, entry.durationMs !== undefined && entry.status !== "running" ? formatDuration(entry.durationMs) : undefined].filter(Boolean).join(" ");
      return {
        ...base,
        tone: entry.status === "error" ? "error" : "tool",
        prefix: "⏺",
        text: `${toolLabel(entry.name)}(${entry.summary})`,
        meta,
        tool: entry.name,
        ...(entry.output?.trim() ? { detail: entry.output.replace(/\s+$/, "") } : {}),
      };
    }
    case "progress":
      return { ...base, tone: "info", prefix: "▸", text: `${Math.round(entry.progress * 100)}% ${entry.message}` };
    case "approval":
      return entry.phase === "asked"
        ? { ...base, tone: "warn", prefix: "?", text: entry.questions ? `mandou ${questionsLabel(entry.questions)} para você: ${entry.question}` : `pediu sua aprovação: ${entry.question}` }
        : { ...base, tone: entry.approved ? "ok" : "error", prefix: entry.approved ? "✓" : "✗", text: entry.approved ? "você aprovou" : "você recusou", ...(entry.note ? { detail: entry.note } : {}) };
    case "delegation":
      return { ...base, tone: "info", prefix: "→", text: `delegou para o time ${entry.teamName}${entry.toAgentName ? ` (${entry.toAgentName})` : ""}`, detail: entry.reason };
    case "subagent":
      return entry.phase === "started"
        ? { ...base, tone: "info", prefix: "⤷", text: `subagente ${entry.label}`, ...(entry.model ? { meta: entry.model } : {}), ...(entry.goal ? { detail: entry.goal } : {}) }
        : {
            ...base,
            tone: entry.status === "ok" ? "ok" : "error",
            prefix: "⤶",
            text: `subagente ${entry.label} ${entry.status === "ok" ? "terminou" : "falhou"}`,
            ...(entry.result ? { detail: entry.result } : {}),
          };
    case "status":
      return { ...base, tone: STATUS_TONES[entry.status], prefix: "·", text: entry.message };
    case "result":
      return { ...base, tone: "result", prefix: "✔", text: entry.text, meta: "resultado" };
    case "raw":
      return { ...base, tone: entry.stream === "stderr" ? "error" : "dim", prefix: entry.stream === "stderr" ? "!" : "$", text: entry.text };
  }
}

/**
 * As entradas do agente (de todas as tarefas e conversas, mais antigas primeiro) como linhas de
 * terminal. Quando muda a tarefa (ou a conversa), entra uma linha de seção com o título dela.
 * Entradas de subagentes vêm recuadas, com o rótulo do subagente.
 */
export function entriesToTerminalLines(entries: readonly AgentLogEntry[], options: { agentName: string; taskTitle?: (taskId: string) => string | undefined }): TerminalLine[] {
  const labels = new Map<string, string>();
  for (const entry of entries) if (entry.kind === "subagent" && entry.phase === "started") labels.set(entry.subagentId, entry.label);
  // Na conversa, a resposta final do agente chega duas vezes (o texto do turno e a fala `chat`): fica só a fala.
  const replies = new Set<string>();
  for (const entry of entries) if (entry.kind === "chat" && entry.from === "agent") replies.add(`${entry.taskId}\n${entry.text.trim()}`);
  const lines: TerminalLine[] = [];
  let section: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "text" && entry.thread === undefined && isConversationLogId(entry.taskId) && replies.has(`${entry.taskId}\n${entry.text.trim()}`)) continue;
    if (entry.taskId !== section) {
      section = entry.taskId;
      const title = isConversationLogId(entry.taskId) ? "conversa direta" : `tarefa · ${options.taskTitle?.(entry.taskId) ?? entry.taskId.slice(0, 8)}`;
      lines.push({ id: `section-${entry.id}`, kind: "section", at: entry.at, taskId: entry.taskId, tone: "section", prefix: "──", text: title });
    }
    const label = entry.thread ? (labels.get(entry.thread) ?? "subagente") : undefined;
    lines.push(entryToTerminalLine(entry, options.agentName, label));
  }
  return lines;
}
