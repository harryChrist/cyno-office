import { z } from "zod";

/**
 * Log de trabalho dos agentes: cada agente é um "terminal" observável. Cada entrada é uma linha
 * do que o agente (ou o Maestro) fez numa tarefa: narração, ferramentas, progresso, aprovações,
 * delegações, subagentes, mudanças de status, linhas cruas de terminal e o resultado final.
 *
 * O formato é neutro de provedor. Os agentes reais vão ser processos de CLI de assinatura, de vida
 * longa (Claude Code com `claude -p --input-format stream-json --output-format stream-json`,
 * depois Codex CLI, Gemini/Antigravity CLI, OpenCode), cada um com um adaptador de CLI que lê os
 * eventos JSON (stream-json) do processo e os traduz assim:
 * - texto do assistente -> `text`;
 * - chamada de ferramenta (id, nome, input) -> `tool` com `status: "running"` e `toolUseId` = id;
 * - resultado da ferramenta (id, erro?, conteúdo) -> a MESMA entrada `tool` atualizada no lugar
 *   (mesmo `id`) para "ok" | "error", com a prévia da saída e a duração;
 * - subagente (ex.: ferramenta Task do Claude Code) -> `subagent` "started" com `subagentId` = id
 *   da chamada; eventos do subagente (no Claude Code, os com `parent_tool_use_id`) -> entradas com
 *   `thread` = esse id;
 * - linha que não vira nenhum tipo estruturado (stdout/stderr do processo) -> `raw`;
 * - evento final do processo -> `result` (o orquestrador grava, a partir do `RunOutcome`).
 * `provider` diz de qual CLI veio a entrada (ausente = o próprio server: orquestrador/Maestro).
 *
 * Limites (veja AGENT_LOG_LIMITS): textos longos são cortados com "…" antes de gravar; o
 * `input` de uma ferramenta só fica se o JSON dele couber no limite (senão sobra o `summary`).
 */
export const AGENT_LOG_LIMITS = {
  /** Narração (`text`) e resultado (`result`), em markdown. */
  text: 4000,
  /** Linhas curtas: summary de ferramenta, mensagens de status/progresso, pergunta, motivo, nota, rótulo. */
  line: 300,
  /** Objetivo (goal) de um subagente. */
  goal: 1000,
  /** Linha crua de terminal (`raw`). */
  raw: 2000,
  /** Prévia da saída de uma ferramenta e resultado curto de um subagente. */
  output: 2000,
  /** Tamanho máximo do JSON do `input` de uma ferramenta. */
  inputJson: 2000,
  /** Entradas novas gravadas por tarefa (atualizações de ferramenta não contam). */
  perTask: 500,
  /** Entradas recentes guardadas em memória por agente (GET agents/:id/log). */
  perAgent: 300,
} as const;

/** Valor de `?thread=` que pede só as entradas do próprio agente (sem as dos subagentes). */
export const AGENT_LOG_MAIN_THREAD = "main";

/** De onde veio a entrada: o runner simulado ou o adaptador de uma CLI. */
export const AGENT_PROVIDERS = ["mock", "claude", "codex", "gemini", "opencode", "freebuff", "openclaw", "hermes"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_LOG_STATUSES = ["started", "waiting", "resumed", "done", "failed", "canceled"] as const;
export type AgentLogStatus = (typeof AGENT_LOG_STATUSES)[number];

export const TOOL_STATUSES = ["running", "ok", "error"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

const line = z.string().max(AGENT_LOG_LIMITS.line);
const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "thread inválida");

/** Narração/pensamento do agente (markdown). */
const textBodySchema = z.object({ kind: z.literal("text"), text: z.string().max(AGENT_LOG_LIMITS.text) });

/** Chamada de ferramenta: nasce "running" e é atualizada no lugar (mesmo id) quando o resultado chega. */
const toolBodySchema = z.object({
  kind: z.literal("tool"),
  toolUseId: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  /** Resumo de uma linha do input (ex.: a busca, o caminho do arquivo). */
  summary: line,
  /** A frase de atividade ("📖 Lendo App.tsx", até 46 caracteres, já mascarada); ausente em log antigo. */
  phrase: z.object({ icon: z.string().max(16), text: z.string().max(80) }).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(TOOL_STATUSES),
  /** Prévia (cortada) da saída. */
  output: z.string().max(AGENT_LOG_LIMITS.output).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

const progressBodySchema = z.object({ kind: z.literal("progress"), progress: z.number().min(0).max(1), message: line });

const approvalBodySchema = z.discriminatedUnion("phase", [
  z.object({
    kind: z.literal("approval"),
    phase: z.literal("asked"),
    question: line,
    /** Item do "Para você" criado para o pedido (ex.: "A-0001"). */
    forYouId: z.string().max(32).optional(),
    /** Questionário (ask_user): quantas perguntas. Ausente = pedido de aprovação. */
    questions: z.number().int().min(1).max(100).optional(),
  }),
  z.object({ kind: z.literal("approval"), phase: z.literal("decided"), approved: z.boolean(), note: line.optional() }),
]);

/** Só o Maestro: mandou a tarefa para um time. */
const delegationBodySchema = z.object({
  kind: z.literal("delegation"),
  teamId: z.string().max(64),
  teamName: line,
  toAgentId: z.string().max(64).optional(),
  toAgentName: line.optional(),
  reason: line,
  subtaskId: z.string().max(64),
});

/** Subagente (cópia focada do agente): "started" abre a thread `subagentId`, "finished" fecha. */
const subagentBodySchema = z.discriminatedUnion("phase", [
  z.object({
    kind: z.literal("subagent"),
    phase: z.literal("started"),
    subagentId: threadIdSchema,
    /** Ex.: "Rafa · pesquisa de concorrentes". */
    label: line,
    goal: z.string().max(AGENT_LOG_LIMITS.goal),
    /** Modelo com que o subagente roda (o que o agente pediu ou o padrão do workspace), se souber. */
    model: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal("subagent"),
    phase: z.literal("finished"),
    subagentId: threadIdSchema,
    label: line,
    status: z.enum(["ok", "error"]),
    result: z.string().max(AGENT_LOG_LIMITS.output).optional(),
  }),
]);

const statusBodySchema = z.object({ kind: z.literal("status"), status: z.enum(AGENT_LOG_STATUSES), message: line });

/** Resumo final da tarefa (ou de um subagente, na thread dele), em markdown. */
const resultBodySchema = z.object({ kind: z.literal("result"), text: z.string().max(AGENT_LOG_LIMITS.text) });

/**
 * Conversa com o Maestro (fora de um pedido): `from: "user"` é a mensagem do usuário (pelo painel
 * ou digitada direto no terminal/Remote Control: `via`); `from: "agent"` é a resposta do Maestro
 * no fim do turno. Vai no log da conversa do dia (veja conversationLogId), nunca no de uma tarefa.
 */
const chatBodySchema = z.object({
  kind: z.literal("chat"),
  from: z.enum(["user", "agent"]),
  text: z.string(),
  via: z.enum(["painel", "terminal"]).optional(),
});

/** Linha crua do processo do agente que não virou nenhum tipo estruturado. */
const rawBodySchema = z.object({ kind: z.literal("raw"), stream: z.enum(["stdout", "stderr"]), text: z.string().max(AGENT_LOG_LIMITS.raw) });

export const agentLogBodySchema = z.discriminatedUnion("kind", [
  textBodySchema,
  toolBodySchema,
  progressBodySchema,
  approvalBodySchema,
  delegationBodySchema,
  subagentBodySchema,
  statusBodySchema,
  resultBodySchema,
  chatBodySchema,
  rawBodySchema,
]);

const agentLogBaseSchema = z.object({
  /**
   * Único e ordenável: a ordem lexicográfica dos ids é a ordem em que as entradas nasceram
   * (inclusive entre tarefas e reinícios). Uma ferramenta atualizada mantém o id.
   */
  id: z.string().min(1).max(64),
  taskId: z.string().min(1).max(64),
  agentId: z.string().min(1).max(64),
  /** ISO 8601: quando a entrada nasceu. */
  at: z.string(),
  /** Ausente = o próprio agente; senão, o id do subagente (único dentro da tarefa). */
  thread: threadIdSchema.optional(),
  /** CLI de onde veio a entrada (ausente = o próprio server: orquestrador/Maestro). */
  provider: z.enum(AGENT_PROVIDERS).optional(),
});

export const agentLogEntrySchema = z.intersection(agentLogBaseSchema, agentLogBodySchema);

export type AgentLogBody = z.infer<typeof agentLogBodySchema>;
export type AgentLogKind = AgentLogBody["kind"];
export type AgentLogBodyOf<K extends AgentLogKind> = Extract<AgentLogBody, { kind: K }>;
export type AgentLogEntry = z.infer<typeof agentLogBaseSchema> & AgentLogBody;

/** Uma thread de subagente de uma tarefa (para a UI mostrar abas/árvore). */
export type AgentLogThread = {
  id: string;
  label: string;
  goal: string;
  status: "running" | "ok" | "error";
  startedAt: string;
  finishedAt?: string;
  /** Modelo do subagente, se souber. */
  model?: string;
};

/** GET /api/w/:ws/tasks/:taskId/log */
export type TaskLogResponse = {
  taskId: string;
  /** Mais antigas primeiro (filtradas por `?thread=`, se veio). */
  entries: AgentLogEntry[];
  /** Todas as threads de subagentes da tarefa (independe do filtro). */
  threads: AgentLogThread[];
};

/** Resumo em memória do que o agente está fazendo agora. */
export type AgentLogSummary = {
  /** Tarefa com log aberto agora (a mais recente), se houver. */
  activeTaskId?: string;
  /** Subagentes rodando agora (para mostrar "Rafa + 2"). */
  activeSubagents: number;
};

/** GET /api/w/:ws/agents/:agentId/log */
export type AgentLogResponse = {
  agentId: string;
  /** Entradas recentes de todas as tarefas do agente, as mais novas por último. */
  entries: AgentLogEntry[];
  summary: AgentLogSummary;
};

export const agentLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(AGENT_LOG_LIMITS.perAgent).default(100),
});

export const taskLogQuerySchema = z.object({
  /** Id de um subagente, ou "main" para só as entradas do próprio agente. */
  thread: threadIdSchema.optional(),
  /** CLI de onde veio a entrada (ausente = o próprio server: orquestrador/Maestro). */
  provider: z.enum(AGENT_PROVIDERS).optional(),
});

/** Começo do id do log de uma conversa com o Maestro (não é uma tarefa). */
export const CONVERSATION_LOG_PREFIX = "conversa-";
/** Quanto do id do agente entra no id do log da conversa (o id inteiro cabe nos 64 caracteres). */
const CONVERSATION_AGENT_CHARS = 45;

/** Pedaço do id do log da conversa que identifica o agente ("conversa-<agente>-"). */
export function conversationLogPrefix(agentId: string): string {
  return `${CONVERSATION_LOG_PREFIX}${agentId.slice(0, CONVERSATION_AGENT_CHARS)}-`;
}

/**
 * Id do log da conversa com o Maestro num dia (UTC): `conversa-<agente>-AAAAMMDD`. Um arquivo por
 * dia (cada log tem teto de entradas); as mensagens soltas (sem pedido) e as respostas vão nele.
 */
export function conversationLogId(agentId: string, at: Date | string): string {
  const iso = typeof at === "string" ? at : at.toISOString();
  return `${conversationLogPrefix(agentId)}${iso.slice(0, 10).replace(/-/g, "")}`;
}

/** O id de log é de uma conversa (e não de uma tarefa)? */
export function isConversationLogId(id: string): boolean {
  return id.startsWith(CONVERSATION_LOG_PREFIX) && /-\d{8}$/.test(id);
}

/** Ids de tarefa: os do server são UUIDs; a regra também protege o nome do arquivo de log. */
export const taskIdParamsSchema = z.object({ taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/i, "id de tarefa inválido") });

/** Corta com "…" se passar de `max` caracteres. */
export function clampLogText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Resumo de uma linha de um input de ferramenta: o primeiro valor de texto, ou o JSON curto. */
export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const first = Object.values(input).find((value) => typeof value === "string");
  const text = typeof first === "string" ? first : JSON.stringify(input);
  return clampLogText(text.replace(/\s+/g, " ").trim(), AGENT_LOG_LIMITS.line);
}

/** Aplica os limites de AGENT_LOG_LIMITS a um corpo de entrada (devolve uma cópia). */
export function boundAgentLogBody(body: AgentLogBody): AgentLogBody {
  const { line: lineMax, text, output, goal } = AGENT_LOG_LIMITS;
  const short = (value: string) => clampLogText(value, lineMax);
  switch (body.kind) {
    case "text":
      return { ...body, text: clampLogText(body.text, text) };
    case "result":
      return { ...body, text: clampLogText(body.text, text) };
    case "chat":
      // Conversa fica inteira (sem corte), do jeito que foi dita.
      return body;
    case "tool": {
      const inputFits = body.input !== undefined && JSON.stringify(body.input).length <= AGENT_LOG_LIMITS.inputJson;
      const bounded: AgentLogBodyOf<"tool"> = {
        ...body,
        name: clampLogText(body.name, 80),
        summary: short(body.summary || summarizeToolInput(body.input)),
        input: inputFits ? body.input : undefined,
        output: body.output === undefined ? undefined : clampLogText(body.output, output),
      };
      if (bounded.input === undefined) delete bounded.input;
      if (bounded.output === undefined) delete bounded.output;
      return bounded;
    }
    case "progress":
      return { ...body, progress: Math.min(1, Math.max(0, Number.isFinite(body.progress) ? body.progress : 0)), message: short(body.message) };
    case "approval":
      return body.phase === "asked"
        ? { ...body, question: short(body.question) }
        : { ...body, ...(body.note === undefined ? {} : { note: short(body.note) }) };
    case "delegation":
      return {
        ...body,
        teamName: short(body.teamName),
        reason: short(body.reason),
        ...(body.toAgentName === undefined ? {} : { toAgentName: short(body.toAgentName) }),
      };
    case "subagent":
      return body.phase === "started"
        ? { ...body, label: short(body.label), goal: clampLogText(body.goal, goal), ...(body.model === undefined ? {} : { model: clampLogText(body.model, 80) }) }
        : { ...body, label: short(body.label), ...(body.result === undefined ? {} : { result: clampLogText(body.result, output) }) };
    case "status":
      return { ...body, message: short(body.message) };
    case "raw":
      return { ...body, text: clampLogText(body.text, AGENT_LOG_LIMITS.raw) };
  }
}
