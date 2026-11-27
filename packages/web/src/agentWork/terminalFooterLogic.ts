import { fraseDeAtividade, isConversationLogId, type AgentLogEntry } from "@cyno/shared";

/**
 * O rodapé de estado do terminal (o que o agente está fazendo agora). Tudo sai das entradas do log e do
 * "ao vivo" que a tela já sabe: nada novo no servidor. O estado exato do Cyno (esperando o Maestro, sem
 * cota) fica no selo do cabeçalho da tela; aqui vai o que o próprio log conta.
 */
export type TerminalFooter = {
  kind: "tool" | "waiting" | "working" | "failed" | "idle";
  icon?: string;
  text: string;
  /** Desde quando está nesse estado (ISO), para "há 12 s". */
  since?: string;
};

/** Há quanto tempo (ms) em português curto: "agora", "há 12 s", "há 3 min", "há 2 h". */
export function sinceLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 2_000) return "agora";
  if (ms < 60_000) return `há ${Math.floor(ms / 1000)} s`;
  if (ms < 3_600_000) return `há ${Math.floor(ms / 60_000)} min`;
  return `há ${Math.floor(ms / 3_600_000)} h`;
}

export function terminalFooter(entries: readonly AgentLogEntry[], live: boolean): TerminalFooter {
  let last: AgentLogEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.thread !== undefined) continue;
    last = entry;
    break;
  }
  if (!last) return live ? { kind: "working", text: "Trabalhando…" } : { kind: "idle", text: "Aguardando um pedido" };

  // O pedido de aprovação em aberto (nenhuma decisão depois dele) manda: o agente está esperando o dono.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind !== "approval" || entry.thread !== undefined) continue;
    if (entry.phase === "asked") return { kind: "waiting", icon: "✋", text: `Esperando você: ${entry.question}`.slice(0, 160), since: entry.at };
    break;
  }
  if (last.kind === "tool" && last.status === "running" && live) {
    const phrase = last.phrase ?? fraseDeAtividade({ name: last.name, ...(last.input ? { input: last.input } : {}) });
    return { kind: "tool", icon: phrase.icon, text: phrase.text, since: last.at };
  }
  if (last.kind === "status" && last.status === "failed") return { kind: "failed", icon: "⚠️", text: last.message.slice(0, 160), since: last.at };
  if (live) {
    const conversation = isConversationLogId(last.taskId);
    return { kind: "working", text: conversation ? "Respondendo…" : "Trabalhando…", since: last.at };
  }
  return { kind: "idle", text: "Aguardando", since: last.at };
}
