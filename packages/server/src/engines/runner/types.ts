import type { FailureKind, ForYouActor, ForYouQuestion, ForYouSource } from "@cyno/shared";
import type { Agent, AgentLogBodyOf, AgentProvider, BrainContext, Task, Team, Room } from "@cyno/shared";

/** Tudo o que um runner precisa para executar uma tarefa em nome de um agente. */
export type RunInput = {
  task: Task;
  agent: Agent;
  team: Team;
  room: Room;
  /** Contexto do Cérebro (veja buildContext): só o que este quarto pode ver. */
  context: BrainContext;
  /** Últimas entradas do diário do agente (agentes de CLI: cada tarefa começa numa sessão nova). */
  diary?: string;
  /**
   * A tarefa recomeça depois de um reinício do server e o usuário JÁ decidiu a aprovação (ou respondeu
   * às perguntas) que ela pedia antes: o runner de CLI manda a decisão junto com a tarefa, para o agente
   * não perguntar de novo (se perguntar, a mesma decisão volta na hora).
   */
  resumedDecision?: ApprovalDecision;
  /** Abortado quando a tarefa é cancelada (agente/time/room removido) ou o server desliga. */
  signal: AbortSignal;
};

/** Rascunho que o agente quer que o usuário aprove (vira um item do "Para você"). */
export type ApprovalDraft = {
  /** Id (ou nome) do tipo; um tipo que o workspace não tem é criado na hora (ausente = deduzido da tarefa). */
  type?: string;
  /** Texto que vai sair (o usuário pode editar antes de aprovar). */
  text: string;
  title?: string;
  where?: string;
  to?: string;
  why?: string;
  meta?: Record<string, string>;
  /** Mídia da biblioteca anexada ao pedido (ids M-0001). */
  mediaIds?: string[];
  /** O que o rascunho analisou (post original, perfil, referências): o contexto do cartão. */
  sources?: ForYouSource[];
};

/** Um rascunho de um lote de aprovações (`request_approval` com `items`). */
export type ApprovalBatchItem = { question: string; draft?: ApprovalDraft };

/** Máximo de rascunhos de um lote de aprovações. */
export const APPROVAL_BATCH_MAX = 10;

/**
 * Pedido de aprovação: a pergunta curta (vira o progresso da tarefa) e o rascunho, se houver. Com
 * `questions` (ask_user), o item vira um questionário: as respostas voltam em `response`. Com
 * `items` (lote, até 10), cada rascunho vira um item do "Para você" (mesmo `groupId`) e a tarefa
 * espera todos: o agente recebe UMA decisão com o resultado de cada item.
 */
export type ApprovalRequest = { question: string; draft?: ApprovalDraft; questions?: ForYouQuestion[]; items?: ApprovalBatchItem[] };

/** Resultado de um item de um lote (ou do único item de um pedido simples). */
export type ApprovalItemResult = {
  itemId: string;
  question: string;
  status: "approved" | "rejected" | "cancelled";
  /** Aprovado: o texto final (editado ou não). */
  text?: string;
  /** Nota do usuário. */
  response?: string;
  /** Recusado: o motivo dado pelo usuário. */
  reason?: string;
  cancelled?: ApprovalCancel;
};

/**
 * Decisão do usuário. Aprovada: `text` é o texto final (editado ou não) e `response` a resposta
 * (pergunta) ou a nota para o time. Recusada: `response` é a nota, que vira o motivo (`reason`).
 * `cancelled` (com approved: true): o item foi retirado sem resposta (pelo Maestro, pelo próprio
 * agente ou descartado pelo usuário); a tarefa segue sem a aprovação/as respostas.
 * `retry` (com approved: false): recusa com motivo dentro do limite de retrabalho: a tarefa NÃO
 * falha, volta para o mesmo agente com o motivo. Lote (`items`): `approved: true` = a tarefa
 * segue com o resultado de cada item (recusados inclusos, para refazer); `approved: false` = a
 * tarefa falha como "Recusado" (a recusa não pode mais voltar ao agente).
 */
export type ApprovalDecision = {
  approved: boolean;
  text?: string;
  response?: string;
  reason?: string;
  cancelled?: ApprovalCancel;
  retry?: boolean;
  /** Com `retry`: em que retrabalho está (`count` de `max`). */
  rework?: { count: number; max: number };
  /** Item do "Para você" que gerou a decisão (aprovações do Maestro, que podem ter várias abertas). */
  itemId?: string;
  items?: ApprovalItemResult[];
};

/** Item do "Para você" retirado sem resposta: quem retirou e por quê. */
export type ApprovalCancel = { by: ForYouActor; reason?: string };

/**
 * O que um runner escreve no log de trabalho. Status, aprovações, delegações e o resultado
 * final são do orquestrador; o progresso vai por `onProgress`.
 * - `text`: narração/pensamento (markdown);
 * - `tool`: chamada de ferramenta, nasce "running" (o resultado chega por `toolResult`);
 *   `summary` é opcional (padrão: o primeiro texto do `input`);
 * - `raw`: linha crua do processo (stdout/stderr) que não virou nada estruturado.
 */
export type RunnerLogInput =
  | AgentLogBodyOf<"text">
  | AgentLogBodyOf<"raw">
  | { kind: "tool"; toolUseId: string; name: string; input?: Record<string, unknown>; summary?: string };

/** Resultado de uma ferramenta: atualiza no lugar a entrada `tool` com o mesmo `toolUseId`. */
export type ToolResultInput = { status: "ok" | "error"; output?: string };

/** Ganchos de log de uma "thread" (o agente ou um subagente dele). */
export type ThreadHooks = {
  log(entry: RunnerLogInput): void;
  toolResult(toolUseId: string, result: ToolResultInput): void;
};

/**
 * Subagente: cópia focada do agente, com a própria thread no log. `id` é opcional (único na
 * tarefa; um adaptador de CLI passa o id da chamada que criou o subagente, ex.: o tool_use da
 * Task no Claude Code, e as mensagens com `parent_tool_use_id` vão para essa thread).
 */
export type SubagentSpec = {
  label: string;
  goal: string;
  id?: string;
  /** Modelo do subagente (vai no log), se souber. */
  model?: string;
};

export type SubagentHooks = ThreadHooks & {
  /** Id da thread do subagente. */
  readonly id: string;
  /** Progresso do subagente (vira entrada `progress` na thread dele; não mexe no da tarefa). */
  progress(progress: number, message: string): void;
  /** Fecha o subagente (só a primeira chamada conta): `result` na thread e `subagent` "finished". */
  finish(result: { status: "ok" | "error"; result?: string }): void;
};

export type RunHooks = ThreadHooks & {
  /**
   * Progresso de 0 a 1 com uma mensagem curta em pt-BR (vira o evento task:progress e, sem
   * repetir, uma entrada `progress` no log: só quando a mensagem muda ou o progresso anda 10%).
   */
  onProgress(progress: number, message: string): void;
  /**
   * Pausa a tarefa até o usuário decidir (task e agente ficam "waiting_approval"). O
   * orquestrador cria o item do "Para você" com o rascunho. Resolve com a decisão
   * (`approved: false` se recusada ou cancelada).
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Abre um subagente (entrada `subagent` "started") e devolve os ganchos da thread dele. */
  subagent(spec: SubagentSpec): SubagentHooks;
};

/** `cancelled`: o usuário parou o agente (não foi uma falha dele): a tarefa fica "failed" com `outcome: "cancelled"`. */
/**
 * `kind`: onde a falha nasceu (só com `failed`): `motor` = a CLI caiu ou parou, `agente` = o agente terminou sem entregar.
 * Ausente = o orquestrador grava "outro" (ou "cancelada" quando `cancelled`).
 */
export type RunOutcome = { status: "done" | "failed"; result: string; cancelled?: boolean; kind?: FailureKind };

/**
 * Executa tarefas de agentes. O orquestrador cuida de fila, status, persistência, eventos,
 * do log de status/aprovação/resultado e de salvar o resultado no Cérebro; o runner só "faz o
 * trabalho" e narra o que faz pelos ganchos.
 *
 * Implementações:
 * - MockRunner: agentes simulados (motor "mock", o padrão).
 * - CliAgentRunner (terminals/cli-runner.ts): agentes com motor de CLI ("claude"; depois Codex,
 *   Gemini/Antigravity e OpenCode). Cada agente é um terminal de vida longa (processo de CLI de
 *   assinatura) que conversa com o escritório pelo servidor MCP "office": a tarefa vira uma
 *   mensagem na sessão viva (com `context.text`), cada evento JSON do processo vira
 *   `log`/`toolResult`/`subagent` (veja terminalLogBridge), `submit_result` resolve o run,
 *   `request_approval` chama `requestApproval` e `signal` interrompe o turno.
 * - EngineRunner: escolhe entre os dois pelo `agent.engine` (é o runner de cada workspace).
 *
 * Contrato: respeitar `signal` (parar logo e rejeitar quando abortado) e nunca chamar os
 * hooks depois de resolver (nem os de subagentes).
 */
export interface AgentRunner {
  /** Provedor das entradas de log deste runner (vai em `provider`; ausente = sem provedor). */
  readonly provider?: AgentProvider;
  /** Provedor por agente (runners que despacham por motor); tem prioridade sobre `provider`. */
  providerFor?(agent: Agent): AgentProvider | undefined;
  run(input: RunInput, hooks: RunHooks): Promise<RunOutcome>;
}
