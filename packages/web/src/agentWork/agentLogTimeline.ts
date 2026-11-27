import { ENGINE_LABELS, type AgentLogEntry, type AgentLogStatus, type AgentProvider } from "@cyno/shared";
import { phraseOfTool } from "../store/agentLog";
import type { StepItem, StepState } from "./timelineLogic";

/** Rótulo de cada provedor (de qual CLI veio o trabalho; o mesmo de ENGINE_LABELS: "gemini" é o Antigravity). */
export const PROVIDER_LABELS: Record<AgentProvider, string> = ENGINE_LABELS;

const STATUS_STATE: Record<AgentLogStatus, StepState> = {
  started: "info",
  waiting: "attention",
  resumed: "info",
  done: "ok",
  failed: "error",
  canceled: "error",
};

const STATUS_LABELS: Record<AgentLogStatus, string> = {
  started: "Começou",
  waiting: "Esperando",
  resumed: "Retomou",
  done: "Concluiu",
  failed: "Falhou",
  canceled: "Cancelada",
};

/** "820 ms", "4,2 s", "1 min 05 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(".", ",")} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

function inputJson(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return undefined;
  }
}

/** Uma entrada do log de trabalho como passo da linha do tempo. */
export function entryToStep(entry: AgentLogEntry): StepItem {
  const base = { kind: "step" as const, id: entry.id, at: entry.at };
  switch (entry.kind) {
    case "text":
      return { ...base, variant: "text", state: "info", text: entry.text, markdown: true };
    case "raw":
      return { ...base, variant: "raw", state: entry.stream === "stderr" ? "error" : "info", text: entry.text, stream: entry.stream, tag: entry.stream === "stderr" ? "stderr" : undefined };
    case "tool":
      return {
        ...base,
        variant: "tool",
        state: entry.status,
        text: entry.summary || entry.name,
        tag: entry.name,
        tool: {
          name: entry.name,
          summary: entry.summary,
          phrase: phraseOfTool(entry),
          ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
          ...(entry.output === undefined ? {} : { output: entry.output }),
          ...(inputJson(entry.input) === undefined ? {} : { input: inputJson(entry.input) }),
        },
      };
    case "progress":
      return { ...base, variant: "progress", state: "info", text: entry.message, progress: entry.progress };
    case "approval":
      return entry.phase === "asked"
        ? entry.questions
          ? { ...base, variant: "approval", state: "attention", text: `Mandou ${entry.questions === 1 ? "1 pergunta" : `${entry.questions} perguntas`} para você: ${entry.question}`, tag: "perguntas" }
          : { ...base, variant: "approval", state: "attention", text: `Pediu sua aprovação: ${entry.question}`, tag: "aprovação" }
        : {
            ...base,
            variant: "approval",
            state: entry.approved ? "ok" : "error",
            text: entry.approved ? "Você aprovou" : "Você recusou",
            detail: entry.note,
            tag: "aprovação",
          };
    case "delegation":
      return {
        ...base,
        variant: "delegation",
        state: "info",
        text: `Mandou para o time ${entry.teamName}${entry.toAgentName ? ` com ${entry.toAgentName}` : ""}`,
        detail: entry.reason,
        agentId: entry.toAgentId,
        tag: "delegou",
      };
    case "subagent":
      return entry.phase === "started"
        ? {
            ...base,
            variant: "subagent",
            state: "running",
            text: `Subagente: ${entry.label}${entry.model ? ` (${entry.model})` : ""}`,
            detail: entry.goal || undefined,
            threadId: entry.subagentId,
            tag: "subagente",
          }
        : {
            ...base,
            variant: "subagent",
            state: entry.status,
            text: `${entry.status === "ok" ? "Subagente terminou" : "Subagente falhou"}: ${entry.label}`,
            detail: entry.result,
            threadId: entry.subagentId,
            tag: "subagente",
          };
    case "status":
      return { ...base, variant: "status", state: STATUS_STATE[entry.status], text: entry.message, tag: STATUS_LABELS[entry.status].toLowerCase() };
    case "result":
      return { ...base, variant: "result", state: "ok", text: entry.text, markdown: true, tag: "resultado" };
    case "chat":
      return { ...base, variant: "text", state: "info", text: entry.text, markdown: true, tag: entry.from === "user" ? "você" : "respondeu" };
  }
}

/**
 * Entradas de uma thread como passos. Progressos seguidos viram um só (o mais novo); o "começou"
 * de um subagente que já terminou deixa de pulsar.
 */
export function entriesToSteps(entries: readonly AgentLogEntry[]): StepItem[] {
  const finished = new Set<string>();
  for (const entry of entries) if (entry.kind === "subagent" && entry.phase === "finished") finished.add(entry.subagentId);
  const steps: StepItem[] = [];
  let previous: AgentLogEntry | undefined;
  for (const entry of entries) {
    const step = entryToStep(entry);
    if (step.variant === "subagent" && step.state === "running" && step.threadId && finished.has(step.threadId)) step.state = "info";
    const sameStream = previous?.kind === "progress" && previous.taskId === entry.taskId && previous.thread === entry.thread;
    if (entry.kind === "progress" && sameStream) steps[steps.length - 1] = step;
    else steps.push(step);
    previous = entry;
  }
  return steps;
}

/** O provedor mais recente que aparece nas entradas (de qual CLI vem o trabalho). */
export function latestProvider(entries: readonly AgentLogEntry[]): AgentProvider | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const provider = entries[i]!.provider;
    if (provider) return provider;
  }
  return undefined;
}

/** O `engine` do agente lido com cuidado: texto ("claude") ou objeto com `kind`/`provider`. */
function agentEngine(agent: object | undefined): string | undefined {
  const engine: unknown = agent && "engine" in agent ? (agent as { engine?: unknown }).engine : undefined;
  if (typeof engine === "string") return engine.trim() || undefined;
  if (engine && typeof engine === "object") {
    const { kind, provider } = engine as { kind?: unknown; provider?: unknown };
    if (typeof kind === "string" && kind) return kind;
    if (typeof provider === "string" && provider) return provider;
  }
  return undefined;
}

/**
 * Motor do agente para o selo do cabeçalho/lista: o campo `engine` do agente, se existir (o tipo
 * Agent ainda pode não ter), senão o provedor das entradas do log.
 */
export function engineLabel(agent: object | undefined, entries: readonly AgentLogEntry[]): string | undefined {
  const key = agentEngine(agent) ?? latestProvider(entries);
  if (!key) return undefined;
  return (PROVIDER_LABELS as Record<string, string>)[key] ?? key;
}

/** Uma linha do que o agente fez por último (para a lista de agentes). */
export function lastActivity(entries: readonly AgentLogEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.thread !== undefined) continue;
    switch (entry.kind) {
      case "tool":
        return `${entry.name}${entry.summary ? `: ${entry.summary}` : ""}`;
      case "progress":
      case "status":
        return entry.message;
      case "text": {
        const line = entry.text.split("\n").find((part) => part.trim());
        if (line) return line.replace(/[*_`#>]/g, "").trim();
        continue;
      }
      case "approval":
        return entry.phase === "asked" ? `Esperando aprovação: ${entry.question}` : undefined;
      case "delegation":
        return `Mandou para o time ${entry.teamName}`;
      case "subagent":
        return entry.phase === "started" ? `Subagente: ${entry.label}` : undefined;
      default:
        continue;
    }
  }
  return undefined;
}
