import path from "node:path";
import type { TurnUsage } from "@cyno/shared";
import { claudeProjectDirName } from "../../platform/retention/retention";
import type { TerminalEvent } from "./types";

/**
 * O que sai da conversa (transcript) que o Claude Code interativo grava em disco:
 * - os TerminalEvents de sempre (texto, ferramentas, fim de turno, Remote Control);
 * - `prompt`: alguém pediu algo (uma mensagem nossa colada no terminal, alguém digitando nele ou
 *   pelo Remote Control). Quem lê decide de quem é o turno (veja PtyTerminal).
 */
export type TranscriptEvent = TerminalEvent | { type: "prompt"; text: string };

/**
 * Pasta em que o Claude Code guarda as conversas de um cwd: `<projects>/<cwd com tudo que não é
 * [a-zA-Z0-9] trocado por "-">` (a mesma regra da retenção). Nome comprido demais = undefined.
 */
export function claudeTranscriptDir(projectsDir: string, cwd: string): string | undefined {
  const name = claudeProjectDirName(cwd);
  return name ? path.join(projectsDir, name) : undefined;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** Ferramentas do Claude Code que abrem um subagente. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/**
 * Mensagens de "usuário" que não são pedidos: comandos de barra (`/help`), a saída deles, o modo
 * bash (`!cmd`), avisos da própria CLI e lembretes internos.
 */
const NOT_A_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-memory-input)/;

/** O usuário interrompeu o turno (Esc): a CLI grava isto como mensagem do usuário. */
const INTERRUPTED = /^\[Request interrupted by user/;

/** Texto de um tool_result (string ou blocos [{type:"text", text}]). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : isObject(block) ? `[${String(block.type)}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Colagem longa: o Claude Code grava o texto colado entre `<pasted_content id="…">` e
 * `</pasted_content id="…">`. Tira as marcas (o prompt fica igual ao que foi colado).
 */
export function unwrapPasted(text: string): string {
  if (!text.includes("<pasted_content")) return text;
  return text.replace(/<\/?pasted_content(?:\s+id="[^"]*")?\s*>\n?/g, "").trim();
}

/** Texto de uma mensagem do usuário (string ou blocos de texto; imagens viram "[imagem]"). */
function promptText(content: unknown): string | undefined {
  if (typeof content === "string") return unwrapPasted(content);
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => isObject(block) && block.type === "tool_result")) return undefined;
  const parts = content.map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : isObject(block) && block.type === "image" ? "[imagem]" : ""));
  const text = unwrapPasted(parts.filter(Boolean).join("\n"));
  return text || undefined;
}

/**
 * Lê, linha a linha, a conversa `<sessão>.jsonl` do Claude Code interativo (o TUI não é legível por
 * máquina; a conversa é). Só a linha principal (isSidechain = false) conta:
 * - user com texto (sem ser comando de barra, saída de comando, modo bash ou lembrete) -> prompt;
 * - user "[Request interrupted by user…]" -> turn_end com erro "Interrompido";
 * - user com tool_result -> tool_result (ou subagent_end, se fechar um Task/Agent);
 * - assistant: text -> text; tool_use -> tool_use (ou subagent_start); thinking fica de fora;
 *   o `usage` de cada mensagem (uma vez por id) soma os tokens do turno;
 * - system/turn_duration -> turn_end (com o último texto do turno, os tokens e o tamanho da conversa);
 * - system/bridge_status -> remote (Remote Control no ar, com o link);
 * - system/api_error e afins -> raw (stderr);
 * - o resto (snapshots, títulos, custo, anexos) é ignorado. Nunca lança.
 */
export class ClaudeTranscriptParser {
  private lastText = "";
  private usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  private lastPromptTokens: number | undefined;
  private readonly seenMessages = new Set<string>();
  private readonly subagents = new Set<string>();

  parse(line: string): TranscriptEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObject(data) || data.isSidechain === true) return [];
    try {
      return this.event(data);
    } catch {
      return [];
    }
  }

  private event(data: Json): TranscriptEvent[] {
    switch (data.type) {
      case "user":
        return this.user(data);
      case "assistant":
        return this.assistant(data);
      case "system":
        return this.system(data);
      default:
        return [];
    }
  }

  private user(data: Json): TranscriptEvent[] {
    const message = isObject(data.message) ? data.message : undefined;
    const content = message?.content;
    if (Array.isArray(content) && content.some((block) => isObject(block) && block.type === "tool_result")) return this.toolResults(content);
    if (data.isMeta === true || data.isCompactSummary === true) return [];
    const text = promptText(content);
    if (!text || NOT_A_PROMPT.test(text)) return [];
    if (INTERRUPTED.test(text)) return [this.turnEnd(false, "Interrompido no terminal")];
    this.resetTurn();
    return [{ type: "prompt", text }];
  }

  private toolResults(content: unknown[]): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      const ok = block.is_error !== true;
      const output = resultText(block.content);
      if (this.subagents.delete(id)) events.push({ type: "subagent_end", id, ok, ...(output ? { result: output } : {}) });
      else events.push({ type: "tool_result", id, ok, ...(output ? { output } : {}) });
    }
    return events;
  }

  private assistant(data: Json): TranscriptEvent[] {
    const message = isObject(data.message) ? data.message : undefined;
    if (!message) return [];
    this.countUsage(str(message.id), message.usage);
    const content = message.content;
    if (typeof content === "string") return this.text(content);
    if (!Array.isArray(content)) return [];
    const events: TranscriptEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text") events.push(...this.text(str(block.text) ?? ""));
      else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name) ?? "?";
        if (!id) continue;
        const input = isObject(block.input) ? block.input : undefined;
        if (SUBAGENT_TOOLS.has(name)) {
          const label = str(input?.description) ?? str(input?.subagent_type) ?? "Subagente";
          this.subagents.add(id);
          const model = str(input?.model);
          events.push({ type: "subagent_start", id, label, goal: str(input?.prompt) ?? label, ...(model ? { model } : {}) });
        } else {
          events.push({ type: "tool_use", id, name, ...(input ? { input } : {}) });
        }
      }
    }
    return events;
  }

  private text(text: string): TranscriptEvent[] {
    if (!text.trim()) return [];
    this.lastText = text;
    return [{ type: "text", text }];
  }

  /** O mesmo `message.id` aparece em várias linhas (uma por bloco): conta uma vez só. */
  private countUsage(id: string | undefined, usage: unknown): void {
    if (!isObject(usage) || (id && this.seenMessages.has(id))) return;
    if (id) this.seenMessages.add(id);
    this.usage.inputTokens += count(usage.input_tokens);
    this.usage.outputTokens += count(usage.output_tokens);
    this.usage.cacheReadTokens += count(usage.cache_read_input_tokens);
    this.usage.cacheCreationTokens += count(usage.cache_creation_input_tokens);
    const prompt = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (prompt > 0) this.lastPromptTokens = prompt;
  }

  private system(data: Json): TranscriptEvent[] {
    switch (data.subtype) {
      case "turn_duration":
        return [this.turnEnd(true, this.lastText)];
      case "bridge_status": {
        const url = str(data.url);
        const content = str(data.content) ?? "";
        const active = !/\b(disconnected|failed|error|inactive|stopped)\b/i.test(content);
        return [{ type: "remote", remote: { active, ...(url ? { url } : {}) } }];
      }
      case "api_error":
        return [{ type: "raw", stream: "stderr", text: str(data.content) ?? "Erro da API na CLI" }];
      default:
        return [];
    }
  }

  private turnEnd(ok: boolean, result: string): TranscriptEvent {
    const total = this.usage.inputTokens + this.usage.outputTokens + this.usage.cacheReadTokens + this.usage.cacheCreationTokens;
    const event: TranscriptEvent = {
      type: "turn_end",
      ok,
      result,
      ...(total > 0 ? { usage: { ...this.usage } } : {}),
      ...(this.lastPromptTokens ? { contextTokens: this.lastPromptTokens } : {}),
    };
    this.resetTurn();
    return event;
  }

  private resetTurn(): void {
    this.lastText = "";
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    this.lastPromptTokens = undefined;
  }
}
