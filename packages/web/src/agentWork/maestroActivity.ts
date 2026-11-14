import { isConversationLogId, MAESTRO_TEXTS, type AgentLogEntry, type OfficeState } from "@cyno/shared";
import type { TaskProgressMap } from "../store/taskProgress";
import { truncate, type StatusTone } from "../ui/format";
import { requestItem } from "./maestroTimeline";
import { officeToolDoneWith, officeToolName } from "./officeTools";

/**
 * "Atividade" do Maestro em linguagem de gente: o log de trabalho dele agrupado por pedido
 * (pedido → leu → consultou → delegou para fulano → aprovação → resultado), com um selo de estado
 * por pedido, e as trocas de conversa (sem pedido) como grupos leves, um por fala do usuário.
 * Linhas cruas da CLI (stderr, avisos) ficam de fora: o terminal ao lado mostra tudo.
 */

export type ActivityStepKind = "received" | "tool" | "delegation" | "approval" | "decision" | "note" | "waiting" | "resumed" | "result" | "failure";

export type ActivityStep = {
  id: string;
  at: string;
  kind: ActivityStepKind;
  label: string;
  detail?: string;
  tone: StatusTone;
  /** Agente envolvido (delegação): avatar e "ver trabalho". */
  agentId?: string;
  /** Repetições seguidas do mesmo passo (ex.: 3 leituras de nota viram uma linha "×3"). */
  count?: number;
};

export type ActivityGroup = {
  /** "pedido": uma tarefa do Maestro; "conversa": uma fala do usuário e o que o Maestro fez/respondeu (sem pedido). */
  kind: "pedido" | "conversa";
  /** Pedido: o id da tarefa. Conversa: uma chave única da troca (não abre em Trabalho). */
  taskId: string;
  prompt: string;
  at: string;
  stageLabel: string;
  tone: StatusTone;
  /** O pedido (ou a fala) veio do próprio terminal (digitado nele ou pelo Remote Control). */
  fromTerminal: boolean;
  /** Pedido que o próprio Maestro abriu numa conversa (`open_request`). */
  fromChat: boolean;
  /** Conversa: a resposta do Maestro (inteira; os passos mostram só o começo). */
  reply?: string;
  steps: ActivityStep[];
};

/** Quantos pedidos a atividade mostra (os mais recentes). */
export const ACTIVITY_GROUPS_LIMIT = 15;

/** Ferramentas do escritório que já aparecem por outra entrada do log (delegação, aprovação, resultado). */
const COVERED_TOOLS = new Set(["delegate_task", "request_approval", "complete_request"]);

const BUILTIN_TOOL_LABELS: Record<string, string> = {
  Read: "Leu um arquivo",
  Glob: "Procurou arquivos",
  Grep: "Procurou nos arquivos",
  Write: "Escreveu um arquivo",
  Edit: "Editou um arquivo",
  TodoWrite: "Atualizou a lista de passos",
};

/** Nome de gente de uma ferramenta ("mcp__office__get_team" -> "Consultou a equipe"; o nome antigo pt-BR também). */
export function toolLabel(name: string, input?: Record<string, unknown>): string | null {
  const tool = officeToolName(name);
  if (tool) return COVERED_TOOLS.has(tool) ? null : officeToolDoneWith(tool, input);
  // Conector (`mcp__office__notion__create_page`) ou outro servidor MCP (`mcp__github__create_issue`).
  const external = /^mcp__(?:office__)?([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (external) return `${external[2]!.replace(/_/g, " ")} (${external[1]})`;
  return BUILTIN_TOOL_LABELS[name] ?? `Usou ${name}`;
}

const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").replace(/[*_`#>]/g, "").trim();

/** Um passo da atividade (ou null: a entrada não aparece aqui). */
export function entryToActivity(entry: AgentLogEntry): ActivityStep | null {
  if (entry.thread !== undefined) return null;
  const base = { id: entry.id, at: entry.at };
  switch (entry.kind) {
    case "status":
      if (entry.status === "started") {
        if (entry.message.startsWith(MAESTRO_TEXTS.openedByMaestro)) return { ...base, kind: "received", label: "Abriu o pedido a partir da conversa", tone: "neutral" };
        return { ...base, kind: "received", label: "Recebeu o pedido", tone: "neutral" };
      }
      if (entry.status === "waiting") return { ...base, kind: "waiting", label: entry.message, tone: "attention" };
      if (entry.status === "resumed") return { ...base, kind: "resumed", label: entry.message, tone: "busy" };
      if (entry.status === "failed" || entry.status === "canceled") return { ...base, kind: "failure", label: entry.status === "failed" ? "Não concluiu" : "Cancelado", detail: entry.message, tone: "danger" };
      return null; // "done": o resultado já diz
    case "tool": {
      const label = toolLabel(entry.name, entry.input);
      if (!label) return null;
      return { ...base, kind: "tool", label, ...(entry.summary ? { detail: truncate(entry.summary, 140) } : {}), tone: entry.status === "error" ? "danger" : entry.status === "running" ? "busy" : "neutral" };
    }
    case "delegation":
      return {
        ...base,
        kind: "delegation",
        label: `Delegou para ${entry.toAgentName ?? `o time ${entry.teamName}`}${entry.toAgentName ? ` · ${entry.teamName}` : ""}`,
        ...(entry.reason ? { detail: entry.reason } : {}),
        tone: "busy",
        ...(entry.toAgentId ? { agentId: entry.toAgentId } : {}),
      };
    case "approval":
      return entry.phase === "asked"
        ? { ...base, kind: "approval", label: entry.questions ? "Mandou perguntas para você" : "Pediu sua aprovação", detail: entry.question, tone: "attention" }
        : { ...base, kind: "decision", label: entry.approved ? "Você aprovou" : "Você recusou", ...(entry.note ? { detail: entry.note } : {}), tone: entry.approved ? "success" : "danger" };
    case "text": {
      const line = firstLine(entry.text);
      return line ? { ...base, kind: "note", label: truncate(line, 160), tone: "neutral" } : null;
    }
    case "result":
      return { ...base, kind: "result", label: "Respondeu", detail: truncate(entry.text.trim(), 420), tone: "success" };
    case "chat":
      // A fala do usuário é o título do grupo; a resposta do Maestro, o último passo.
      return entry.from === "agent" ? { ...base, kind: "result", label: "Respondeu", detail: truncate(entry.text.trim(), 420), tone: "neutral" } : null;
    default:
      return null; // progresso (o selo do pedido já mostra), subagentes e linhas cruas
  }
}

const flat = (text: string) => text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").replace(/…$/, "").trim();
/** A narração é o começo da resposta? */
const sameStart = (note: string, result: string) => flat(note).length > 0 && flat(result).startsWith(flat(note).slice(0, 80));

/** Passos seguidos iguais (mesma ferramenta, sem detalhe diferente) viram um só com contagem. */
function collapse(steps: ActivityStep[]): ActivityStep[] {
  const out: ActivityStep[] = [];
  for (const step of steps) {
    const previous = out.at(-1);
    if (previous && step.kind === "tool" && previous.kind === "tool" && previous.label === step.label && previous.tone === step.tone) {
      out[out.length - 1] = { ...step, count: (previous.count ?? 1) + 1 };
      continue;
    }
    // Narrações seguidas: fica a mais nova (o terminal tem o texto inteiro). A narração logo antes
    // da resposta costuma ser a própria resposta: fica só a resposta.
    if (previous && previous.kind === "note" && (step.kind === "note" || (step.kind === "result" && sameStart(previous.label, step.detail ?? "")))) {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}

/**
 * Um dia de conversa em trocas: cada fala do usuário abre uma troca com o que o Maestro fez e a
 * resposta. O que vem antes da primeira fala (ex.: o fim de uma troca de ontem) vira uma troca sem título.
 */
function conversationGroups(logId: string, list: readonly AgentLogEntry[]): ActivityGroup[] {
  const turns: AgentLogEntry[][] = [];
  for (const entry of list) {
    if ((entry.kind === "chat" && entry.from === "user") || turns.length === 0) turns.push([entry]);
    else turns.at(-1)!.push(entry);
  }
  return turns.flatMap((turn) => {
    const head = turn[0]!;
    const said = head.kind === "chat" && head.from === "user" ? head : undefined;
    const steps = collapse(turn.map(entryToActivity).filter((step): step is ActivityStep => step !== null));
    if (!said && steps.length === 0) return [];
    const reply = turn.findLast((entry) => entry.kind === "chat" && entry.from === "agent");
    const failed = steps.some((step) => step.kind === "failure");
    return [
      {
        kind: "conversa" as const,
        taskId: `${logId}:${head.id}`,
        prompt: said?.text ?? "(continuação da conversa)",
        at: head.at,
        stageLabel: failed ? "Sem resposta" : reply ? "Conversa" : "Respondendo…",
        tone: failed ? ("danger" as const) : reply ? ("neutral" as const) : ("busy" as const),
        fromTerminal: said?.via === "terminal",
        fromChat: false,
        ...(reply?.kind === "chat" ? { reply: reply.text } : {}),
        steps,
      },
    ];
  });
}

/**
 * O log do Maestro agrupado: os pedidos (os `limit` mais recentes) e as trocas de conversa (também
 * as `limit` mais recentes), tudo na ordem em que aconteceu.
 */
export function maestroActivityGroups(entries: readonly AgentLogEntry[], office: OfficeState, progress: TaskProgressMap, limit = ACTIVITY_GROUPS_LIMIT): ActivityGroup[] {
  const byTask = new Map<string, AgentLogEntry[]>();
  const chats: ActivityGroup[] = [];
  for (const entry of entries) {
    const list = byTask.get(entry.taskId);
    if (list) list.push(entry);
    else byTask.set(entry.taskId, [entry]);
  }
  const groups: ActivityGroup[] = [];
  for (const [taskId, list] of byTask) {
    if (isConversationLogId(taskId)) {
      chats.push(...conversationGroups(taskId, list));
      continue;
    }
    const task = office.tasks.find((candidate) => candidate.id === taskId);
    const steps = collapse(list.map(entryToActivity).filter((step): step is ActivityStep => step !== null));
    const started = list.find((entry) => entry.kind === "status" && entry.status === "started");
    const fromTerminal = started?.kind === "status" && started.message.startsWith("Pedido pelo terminal");
    const fromChat = started?.kind === "status" && started.message.startsWith(MAESTRO_TEXTS.openedByMaestro);
    if (task) {
      const item = requestItem(office, task, progress);
      groups.push({ kind: "pedido", taskId, prompt: task.prompt, at: task.createdAt, stageLabel: item.stageLabel, tone: item.tone, fromTerminal, fromChat, steps });
    } else if (steps.length > 0) {
      groups.push({ kind: "pedido", taskId, prompt: "(pedido removido)", at: list[0]!.at, stageLabel: "Removido", tone: "neutral", fromTerminal, fromChat, steps });
    }
  }
  const byTime = (a: ActivityGroup, b: ActivityGroup) => a.at.localeCompare(b.at);
  return [...groups.sort(byTime).slice(-limit), ...chats.sort(byTime).slice(-limit)].sort(byTime);
}
