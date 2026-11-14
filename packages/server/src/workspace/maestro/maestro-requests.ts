import { conversationLogId, isActiveTaskStatus, type AgentLogBody, type FailureKind, type OfficeState, type ServerEvent, type Task, type TaskProgressInfo } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { persist, persistOrThrow } from "../../util/persist";
import { shorten } from "../../util/text";
import type { CliMaestroDeps, TurnState } from "./maestro-core";
import type { MaestroForYou } from "./maestro-for-you";
import type { MaestroSession } from "./maestro-session";

/**
 * Os pedidos do Maestro: achar o pedido aberto que uma ferramenta quer, gravar a mudança de uma
 * tarefa, fechar o pedido, escrever no log e publicar o progresso. É o "chão" que as outras partes
 * do Maestro usam (via `MaestroCore`).
 */
export class MaestroRequests {
  private readonly progress = new Map<string, TaskProgressInfo>();

  constructor(
    private readonly deps: CliMaestroDeps,
    private readonly now: () => Date,
    private readonly turn: TurnState,
    private readonly owns: (state: OfficeState, task: Pick<Task, "agentId" | "projectId">) => boolean,
    /** As partes que o fechamento de um pedido e o log da conversa avisam (criadas depois desta). */
    private readonly links: () => { session: MaestroSession; forYou: MaestroForYou },
  ) {}

  progressSnapshot(): Record<string, TaskProgressInfo> {
    const active = new Set(this.deps.state.read().tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id));
    return Object.fromEntries([...this.progress].filter(([taskId]) => active.has(taskId)));
  }

  /**
   * O pedido aberto que a ferramenta quer: o `request_id` dado, o do turno em curso (mensagem sobre
   * um pedido) ou o último aberto neste turno. Nada disso = erro dizendo para abrir um antes (nunca
   * pendura o trabalho num pedido qualquer).
   */
  request = (state: OfficeState, id: string | undefined): Task => {
    const open = state.tasks.filter((task) => this.owns(state, task) && isActiveTaskStatus(task.status));
    const list = open.length > 0 ? ` Open requests: ${open.map((task) => `${task.id} (“${shorten(task.prompt.split("\n")[0] ?? "", 60)}”)`).join("; ")}.` : "";
    if (id) {
      const task = open.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Request "${id}" is not open.${list} For new work, open a request with open_request.`);
      return task;
    }
    const wanted = this.turn.current ?? this.turn.openedInTurn.at(-1);
    const task = wanted ? open.find((candidate) => candidate.id === wanted) : undefined;
    if (!task) {
      throw new Error(
        `There is no open request in this conversation. If the user wants something done, first open the request with open_request(title, description) and pass the id it returns as request_id.${list}`,
      );
    }
    return task;
  };

  /** O pedido esperava uma resposta na conversa e o Maestro voltou a mexer nele: anda de novo. */
  unwait(state: OfficeState, task: Task): void {
    if (!task.waiting) return;
    this.setTask(state, task, { status: "in_progress" });
    this.deps.refreshStatus();
  }

  /** `create_plan`/`add_plan_tasks`/`resolve_plan_task`/`get_plan`: o pedido aberto que a ferramenta quer (veja `request`). */
  requestFor(requestId: string | undefined): Task {
    const state = this.deps.state.read();
    const task = this.request(state, requestId);
    this.unwait(state, task);
    return task;
  }

  isOpen = (taskId: string): boolean => {
    const task = this.deps.state.read().tasks.find((candidate) => candidate.id === taskId);
    return task !== undefined && isActiveTaskStatus(task.status);
  };

  agentName = (state: OfficeState, agentId: string | undefined): string => state.agents.find((agent) => agent.id === agentId)?.name ?? agentId ?? "?";

  finish = (state: OfficeState, task: Task, status: "done" | "failed", result: string, outcome?: "cancelled", kind?: FailureKind): void => {
    const { session, forYou } = this.links();
    session.dropHeld(task.id);
    forYou.clear(task.id);
    this.turn.concluded.delete(task.id);
    this.progress.delete(task.id);
    if (status === "done") this.logEntry(task, { kind: "result", text: result });
    this.deps.agentLog.close(
      { taskId: task.id, agentId: task.agentId ?? "" },
      "Interrompida",
      { kind: "status", status, message: status === "done" ? "Concluída" : result },
    );
    this.deps.log.info({ taskId: task.id, status }, "pedido do Maestro (CLI) fechado");
    void this.setTask(state, task, { status, result, ...(status === "failed" && outcome ? { outcome } : {}), ...(status === "failed" ? { failureKind: outcome ? ("cancelada" as const) : (kind ?? "outro") } : {}) });
    this.deps.refreshStatus();
  };

  setTask = (state: OfficeState, task: Task, change: Partial<Pick<Task, "status" | "result" | "outcome" | "failureKind">>, options: { strict?: boolean } = {}): Promise<void> => {
    Object.assign(task, change, { updatedAt: this.now().toISOString() });
    // `waiting` só vale com o pedido esperando o usuário (a pergunta na conversa).
    if (task.status !== "waiting_approval") delete task.waiting;
    // `outcome` ("cancelled") só vale com o pedido falho.
    if (task.status !== "failed") {
      delete task.outcome;
      delete task.failureKind;
    }
    return this.commit(state, [task], options);
  };

  /**
   * Grava as tarefas. Disparo do servidor: 3 tentativas e, se não der, aviso visível (nunca lança).
   * `strict` (caminho disparado pelo usuário, ex.: decidir uma aprovação): o erro de verdade volta.
   */
  commit(state: OfficeState, changed: Task[], options: { strict?: boolean } = {}): Promise<void> {
    const events: ServerEvent[] = changed.map((task) => ({ type: "task:upserted", task }));
    const write = (attempt: number) => this.deps.state.commit({ tasks: state.tasks, events: attempt === 0 ? events : [] });
    const base = { label: "o pedido do Maestro", log: this.deps.log, publish: (event: ServerEvent) => this.deps.state.publish(event), now: this.now };
    if (options.strict) {
      return persistOrThrow(write, { ...base, fail: (error) => new HttpError(500, `Não consegui gravar o pedido no disco: ${error instanceof Error ? error.message : String(error)}`) });
    }
    return persist(write, base).then(() => undefined);
  }

  /** Entrada do próprio server (sem `provider`); o que a CLI faz entra pela ponte, com `provider`. */
  logEntry = (task: Task, body: AgentLogBody): void => {
    this.deps.agentLog.append({ taskId: task.id, agentId: task.agentId ?? "" }, body);
  };

  /** Entrada no log da conversa do dia (a fala também vai para o resumo de uma conversa nova). */
  chatEntry = (maestroId: string, body: AgentLogBody): void => {
    this.deps.agentLog.append({ taskId: conversationLogId(maestroId, this.now()), agentId: maestroId }, body);
    this.links().session.rememberChat(body);
  };

  setProgress = (task: Task, progress: number, message: string): void => {
    const agentId = task.agentId ?? "";
    this.progress.set(task.id, { agentId, progress, message });
    this.deps.state.publish({ type: "task:progress", taskId: task.id, agentId, progress, message });
  };
}
