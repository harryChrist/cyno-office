import { open } from "node:fs/promises";
import { shorten } from "../../util/text";

/**
 * O registro de um chat do Freebuff (`projects/<pasta>/chats/<id>/log.jsonl`): uma linha JSON por
 * evento, gravada em fluxo. Cada passo do agente principal traz as chamadas de ferramenta, os resultados,
 * o texto e `shouldEndTurn` (true no último passo do turno). É por aqui que o Cyno sabe o que o agente
 * fez e quando o turno acabou (a tela só serve de reserva).
 */

export type FreebuffLogEvent =
  /** O Freebuff começou a processar uma mensagem (sinal de que a nossa foi lida). */
  | { kind: "sent" }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; ok: boolean; output: string }
  /** Último passo do turno: `result` é a resposta final do agente. */
  | { kind: "turn_end"; result: string }
  | { kind: "error"; text: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Ferramentas internas do Freebuff que não dizem nada ao dono (sugestões de próximos passos). */
const SILENT_TOOLS = new Set(["suggest_followups"]);

/** `office__submit_result` (servidor MCP + ferramenta) vira o nome do log dos outros motores: `mcp__office__submit_result`. */
export function freebuffToolName(name: string): string {
  return name.includes("__") && !name.startsWith("mcp__") ? `mcp__${name}` : name;
}

function resultText(result: Json): { ok: boolean; output: string } {
  const content = result.content;
  const parts: string[] = [];
  let ok = true;
  for (const item of Array.isArray(content) ? content : []) {
    if (!isObject(item)) continue;
    const value = item.value ?? item.text;
    if (typeof value === "string") parts.push(value);
    else if (value !== undefined) {
      if (isObject(value) && ("error" in value || value.isError === true)) ok = false;
      parts.push(JSON.stringify(value));
    }
  }
  return { ok, output: shorten(parts.join("\n"), 4000) };
}

/** Traduz uma linha do `log.jsonl` (já em objeto) nos eventos do Cyno. Linhas que não interessam dão []. */
export function interpretLogEntry(entry: unknown): FreebuffLogEvent[] {
  if (!isObject(entry)) return [];
  const message = typeof entry.msg === "string" ? entry.msg : "";
  const data = isObject(entry.data) ? entry.data : undefined;
  if (message.startsWith("[send-message]") || message.startsWith("[message-queue] Processing next message")) return [{ kind: "sent" }];
  if (entry.level === "ERROR" && message) return [{ kind: "error", text: shorten(message, 300) }];
  if (!data || typeof data.shouldEndTurn !== "boolean") return [];
  if (data.agentId !== undefined && data.agentId !== "main-agent") return [];
  const events: FreebuffLogEvent[] = [];
  const response = typeof data.fullResponse === "string" ? data.fullResponse.trim() : "";
  if (response && !data.shouldEndTurn) events.push({ kind: "text", text: response });
  const results = new Map<string, { ok: boolean; output: string }>();
  for (const raw of Array.isArray(data.toolResults) ? data.toolResults : []) {
    if (isObject(raw) && typeof raw.toolCallId === "string") results.set(raw.toolCallId, resultText(raw));
  }
  for (const raw of Array.isArray(data.toolCalls) ? data.toolCalls : []) {
    if (!isObject(raw) || typeof raw.toolName !== "string" || SILENT_TOOLS.has(raw.toolName)) continue;
    const id = typeof raw.toolCallId === "string" ? raw.toolCallId : `${raw.toolName}-${events.length}`;
    events.push({ kind: "tool_use", id, name: freebuffToolName(raw.toolName), input: isObject(raw.input) ? raw.input : {} });
    const result = results.get(id);
    if (result) events.push({ kind: "tool_result", id, ok: result.ok, output: result.output });
  }
  if (data.shouldEndTurn) events.push({ kind: "turn_end", result: response });
  return events;
}

export type ChatLogTailOptions = {
  file: string;
  /** Começa do fim do arquivo (retomada: nada antigo vira evento novo). */
  fromEnd: boolean;
  onEntry: (entry: unknown) => void;
};

/** Lê o que o Freebuff acrescentou ao `log.jsonl` desde a última leitura (a linha incompleta espera). */
export class ChatLogTail {
  private offset = 0;
  private partial = "";
  private primed = false;
  /** Bytes novos desde o começo (o vigia de travamento compara). */
  grew = false;

  constructor(private readonly options: ChatLogTailOptions) {}

  /** Marca a posição inicial: o fim do arquivo (se pedido) ou o começo. */
  async prime(): Promise<void> {
    this.primed = true;
    if (!this.options.fromEnd) return;
    try {
      const handle = await open(this.options.file, "r");
      try {
        this.offset = (await handle.stat()).size;
      } finally {
        await handle.close();
      }
    } catch {
      this.offset = 0;
    }
  }

  async poll(): Promise<void> {
    if (!this.primed) await this.prime();
    let handle;
    try {
      handle = await open(this.options.file, "r");
    } catch {
      return;
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.partial = "";
      }
      if (size === this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      this.grew = true;
      const lines = (this.partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.options.onEntry(JSON.parse(line));
        } catch {
          // linha quebrada: ignora
        }
      }
    } finally {
      await handle.close();
    }
  }
}
