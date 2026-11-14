import { randomUUID } from "node:crypto";
import {
  agentEngine,
  findMaestroAgent,
  findMaestroRoom,
  isActiveTaskStatus,
  isCliEngine,
  isMaestroTask,
  MAESTRO_TEXTS,
  subtasksOf,
  type AgentChatStatus,
  type AgentStatus,
  type EngineBlock,
  type ForYouItem,
  type ForYouSource,
  type OfficeState,
  type ServerEvent,
  type Task,
  type TaskProgressInfo,
} from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import type { QuestionInput } from "../for-you/service";
import type { ProjectHost, ProjectWakeKind } from "../projects/project-service";
import type { ApprovalCancel, ApprovalDecision } from "../../engines/runner/types";
import { errorMessage, shorten } from "../../util/text";
import { type CliMaestroDeps, type MaestroCore, type TurnState } from "./maestro-core";
import { delegateTask } from "./maestro-delegation";
import { MaestroForYou } from "./maestro-for-you";
import { MaestroPlanHost } from "./maestro-plan-host";
import { MaestroRequests } from "./maestro-requests";
import { resumeOpenRequests } from "./maestro-resume";
import { MaestroSession } from "./maestro-session";
import { describeTeam } from "./maestro-team";
import { CHAT_TAG_PREFIX, RESULT_IN_MESSAGE } from "./maestro-text";
import { MaestroTurns } from "./maestro-turns";

// A API pública do módulo continua aqui (quem importava de "./cli-maestro" não muda).
export type { CliMaestroDeps } from "./maestro-core";
export { MAESTRO_PRIMER_HEADER, MAESTRO_ROTATE_TOKENS, MAESTRO_SEED_HEADER, MAESTRO_SEED_SEPARATOR } from "./maestro-session";
export { looksLikeQuestion, restartResume } from "./maestro-text";

/**
 * O Maestro com motor de CLI. Falar com ele é CONVERSA: a mensagem vai para a sessão viva do
 * terminal dele sem criar tarefa (`converse`; digitar direto no terminal ou no Remote Control
 * também). Ele mesmo decide quando a conversa virou um pedido de verdade e o abre com
 * `open_request` (a tarefa do Maestro nasce aí); depois coordena pelas ferramentas MCP
 * (`get_team`, `delegate_task`, `get_task`, `complete_request`, `request_approval`). Um pedido criado
 * pela API (POST /tasks, sem time) continua chegando como "Pedido <id>: …", já aberto.
 *
 * - A conversa (fala do usuário, o que o Maestro fez no turno e a resposta) vai para o log da
 *   conversa do dia (`conversationLogId`), não para o de uma tarefa.
 * - `delegate_task`, `complete_request` e `request_approval` precisam de um pedido aberto: o `request_id`,
 *   o pedido do turno (mensagem sobre ele) ou o aberto neste turno; sem nenhum, voltam um erro
 *   dizendo para abrir com `open_request` antes.
 *
 * - `delegate_task` cria a subtarefa (projectId = o pedido) no orquestrador e volta na hora; quando ela
 *   termina, o resultado (ou a falha) é empurrado como mensagem para a sessão do Maestro, que segue.
 * - `complete_request` fecha o pedido com a resposta final (vira o resultado na UI).
 * - Se um turno acaba sem `complete_request`, sem subtarefa em andamento, sem aprovação pendente
 *   e sem mensagem na fila, o texto final do turno fecha o pedido (não fica pendurado).
 * - Tudo o que o Maestro faz vai para o log da tarefa do pedido (provider = motor dele).
 *
 * Quem decide se um pedido é daqui: o Maestro do workspace tem motor de CLI (veja `owns`).
 *
 * Esta classe compõe as partes (cada uma num arquivo): `MaestroSession` (terminal, fila, contexto e
 * rotação), `MaestroTurns` (início/fim de turno, subtarefas), `MaestroForYou` (aprovações e perguntas)
 * e `MaestroPlanHost` (o papel de host dos planos). O que elas pedem emprestado passa pelo `core`.
 */
export class CliMaestro implements ProjectHost {
  private readonly turn: TurnState = { current: undefined, chat: undefined, openedInTurn: [], turnTag: undefined, concluded: new Map(), queued: new Map() };
  private stopped = false;
  /** Mensagens de conversa do dono acompanhadas (id): só estas ganham `agent:chat-status`. */
  private readonly tracked = new Set<string>();
  private readonly now: () => Date;
  private readonly core: MaestroCore;
  private readonly requests: MaestroRequests;
  private readonly session: MaestroSession;
  private readonly turns: MaestroTurns;
  private readonly forYou: MaestroForYou;
  private readonly planHost: MaestroPlanHost;

  constructor(private readonly deps: CliMaestroDeps) {
    this.now = deps.now ?? (() => new Date());
    this.requests = new MaestroRequests(deps, this.now, this.turn, (state, task) => this.owns(state, task), () => ({ session: this.session, forYou: this.forYou }));
    // As partes enxergam só isto (sem acesso aos membros privados da classe).
    this.core = {
      deps,
      turn: this.turn,
      now: () => this.now(),
      isStopped: () => this.stopped,
      owns: (state, task) => this.owns(state, task),
      agentName: this.requests.agentName,
      isOpen: this.requests.isOpen,
      request: this.requests.request,
      setTask: this.requests.setTask,
      finish: this.requests.finish,
      logEntry: this.requests.logEntry,
      chatEntry: this.requests.chatEntry,
      setProgress: this.requests.setProgress,
      push: (taskId, raw) => this.session.push(taskId, raw),
      chatStatus: (tag, status, error) => this.chatStatus(tag, status, error),
    };
    this.session = new MaestroSession(this.core, (maestroId, terminal, event) => this.turns.onTerminalEvent(maestroId, terminal, event));
    this.forYou = new MaestroForYou(this.core, this.session);
    this.turns = new MaestroTurns(this.core, this.session, this.forYou);
    this.planHost = new MaestroPlanHost(this.core);
  }

  private chatStatus(tag: string | undefined, status: AgentChatStatus["status"], error?: string): void {
    if (this.stopped || !tag?.startsWith(CHAT_TAG_PREFIX)) return;
    const messageId = tag.slice(CHAT_TAG_PREFIX.length);
    if (!this.tracked.has(messageId)) return;
    const maestro = findMaestroAgent(this.deps.state.read());
    if (!maestro) return;
    this.deps.publish?.({ type: "agent:chat-status", chat: { messageId, agentId: maestro.id, status, mode: "conversa", ...(error ? { error: error.slice(0, 280) } : {}), at: this.now().toISOString() } });
  }

  /** Um texto montado na hora de cada mensagem que sai para o Maestro (o que há de novo no mural da plataforma). */
  addMessageExtra(extra: () => string): void {
    this.session.addExtra(extra);
  }

  /** Conversas renovadas desde o boot (para o log). */
  get rotations(): number {
    return this.session.rotations;
  }

  /** Evento do hub do workspace (o runtime repassa): acompanha as subtarefas dos pedidos daqui. */
  handleEvent(event: ServerEvent): void {
    if (event.type !== "task:upserted" || event.task.projectId === undefined) return;
    const subtask = structuredClone(event.task);
    queueMicrotask(() => this.turns.onSubtask(subtask));
  }

  /** O Maestro deste workspace roda numa CLI? */
  enabled(state: OfficeState = this.deps.state.read()): boolean {
    const maestro = findMaestroAgent(state);
    return maestro !== undefined && isCliEngine(agentEngine(maestro));
  }

  /** O pedido é do Maestro de CLI (tarefa do Maestro, com o Maestro em motor de CLI)? */
  owns(state: OfficeState, task: Pick<Task, "agentId" | "projectId">): boolean {
    return isMaestroTask(state, task) && this.enabled(state);
  }

  ownsId(taskId: string): boolean {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    return task !== undefined && this.owns(state, task);
  }

  /** Novo pedido (a tarefa já existe, "queued"): vai para a sessão do Maestro. */
  submit(task: Task): void {
    const state = this.deps.state.read();
    const current = state.tasks.find((candidate) => candidate.id === task.id);
    if (!current) return;
    this.requests.logEntry(current, { kind: "status", status: "started", message: `Pedido recebido: ‘${shorten(current.prompt, 160)}’` });
    this.requests.setTask(state, current, { status: "in_progress" });
    this.requests.setProgress(current, 0.1, "O Maestro está lendo o pedido…");
    this.session.push(current.id, `Pedido ${current.id}: ${current.prompt}`);
  }

  /**
   * Mensagem de conversa (a caixa "Fale com o Maestro"): vai para a sessão dele sem criar tarefa.
   * Devolve o id da mensagem. Sem terminal (motor sem adaptador), 409.
   */
  converse(text: string): string {
    const body = text.trim();
    if (!body) throw new HttpError(400, "A mensagem está vazia");
    const maestro = findMaestroAgent(this.deps.state.read());
    if (!maestro || !this.enabled()) throw new HttpError(409, "O Maestro deste workspace não roda numa CLI");
    try {
      this.session.terminal();
    } catch (error) {
      throw new HttpError(409, `O terminal do Maestro não está disponível: ${errorMessage(error)}`);
    }
    const id = randomUUID();
    this.requests.chatEntry(maestro.id, { kind: "chat", from: "user", text: body, via: "painel" });
    this.tracked.add(id);
    if (this.tracked.size > 100) this.tracked.delete(this.tracked.values().next().value as string);
    this.session.push(`${CHAT_TAG_PREFIX}${id}`, body);
    // A mensagem entrou na sessão do Maestro: espera o turno dela (o terminal diz quando ele começa).
    this.chatStatus(`${CHAT_TAG_PREFIX}${id}`, "queued");
    return id;
  }

  /**
   * `open_request`: a conversa virou um pedido de verdade. Cria a tarefa do Maestro (in_progress) com
   * o título e o briefing e devolve a tarefa; o que vem depois (delegar, aprovar, concluir) usa o id.
   */
  openRequest(input: { title: string; description: string; origin?: string; originLabel?: string }): Task {
    const state = this.deps.state.read();
    const maestro = findMaestroAgent(state);
    const room = findMaestroRoom(state);
    if (!maestro || !room) throw new Error("This workspace has no Maestro");
    const title = input.title.trim().replace(/\s+/g, " ");
    const brief = input.description.trim();
    if (!title) throw new Error("Give the request a title");
    const prompt = brief && brief !== title ? `${title}\n\n${brief}` : title;
    const at = this.now().toISOString();
    const task: Task = {
      id: randomUUID(),
      roomId: room.id,
      teamId: maestro.teamId,
      agentId: maestro.id,
      role: "request",
      prompt,
      status: "in_progress",
      createdAt: at,
      updatedAt: at,
    };
    state.tasks.push(task);
    void this.requests.commit(state, [task]);
    this.turn.openedInTurn.push(task.id);
    this.requests.logEntry(task, { kind: "status", status: "started", message: `${MAESTRO_TEXTS.openedByMaestro}: ‘${shorten(title, 160)}’` });
    const origin = input.origin?.trim();
    if (origin) this.requests.logEntry(task, { kind: "text", text: `${input.originLabel ?? "Da conversa"}: “${shorten(origin, 600)}”` });
    this.requests.setProgress(task, 0.1, "Pedido aberto: o Maestro está organizando o trabalho");
    this.deps.log.info({ taskId: task.id }, "Maestro (CLI) abriu um pedido");
    this.deps.refreshStatus();
    return task;
  }

  /**
   * Pedido aberto pelo SERVIDOR (fechamento semanal das rotinas, meta em risco): cria a tarefa do
   * Maestro (com a origem no log) e manda a mensagem para a sessão dele, uma vez. Sem Maestro de CLI,
   * quem chama nem tenta (veja `enabled`).
   */
  openServerRequest(input: { title: string; message: string | ((task: Task) => string); origin: string; originLabel?: string; description?: string; before?: (task: Task) => void }): Task {
    const text = (task: Task) => (typeof input.message === "function" ? input.message(task) : input.message);
    const task = this.openRequest({ title: input.title, description: input.description ?? (typeof input.message === "string" ? input.message : input.title), origin: input.origin, originLabel: input.originLabel ?? "Origem (servidor)" });
    // Não foi aberto por um turno do modelo: o id não vale como "pedido do turno" para as outras ferramentas.
    this.turn.openedInTurn = this.turn.openedInTurn.filter((id) => id !== task.id);
    // O que o pedido precisa ter antes de o Maestro ler (o Projeto-casca do Cyno).
    input.before?.(task);
    this.session.push(task.id, `Pedido ${task.id}: ${input.title}\n\n${text(task)}`);
    return task;
  }

  /**
   * Uma mensagem de fora (o Cyno falando com o Maestro, ou a resposta a um `ask_cyno`) vira CONVERSA:
   * a linha aparece no chat do Maestro e o texto vai para a sessão dele numa conversa (nunca num pedido:
   * o fim de um turno de pedido, sem plano, fecharia o pedido). Devolve false sem Maestro de CLI.
   */
  deliverNote(input: { id: string; text: string; line: string }): boolean {
    const maestro = findMaestroAgent(this.deps.state.read());
    if (!maestro || !this.enabled()) return false;
    this.requests.chatEntry(maestro.id, { kind: "status", status: "resumed", message: shorten(input.line, 290) });
    this.session.push(`${CHAT_TAG_PREFIX}${input.id}`, input.text);
    return true;
  }

  /** Boot: retoma os pedidos abertos (veja `resumeOpenRequests`). */
  resume(): void {
    resumeOpenRequests({ core: this.core, enabled: (state) => this.enabled(state), submit: (task) => this.submit(task), session: this.session, turns: this.turns, forYou: this.forYou });
  }

  /**
   * Passa a ouvir o terminal do Maestro já (sem esperar um pedido): o que alguém digitar direto nele
   * (ou no Remote Control) também vira pedido com log. Boot e troca de motor do Maestro.
   */
  attach(): void {
    if (this.stopped || !this.enabled()) return;
    try {
      // Só o terminal interativo recebe pedidos de fora; o headless só fala quando a gente manda.
      if (this.deps.terminals.maestroPty?.()) this.session.terminal();
    } catch {
      // Sem terminal agora (motor sem adaptador): o próximo pedido tenta de novo.
    }
  }

  /** Status do agente Maestro vindo daqui (undefined = nada aqui; o coordenador decide). */
  agentStatus(state: OfficeState): AgentStatus | undefined {
    if (!this.enabled(state)) return undefined;
    const open = state.tasks.filter((task) => this.owns(state, task) && isActiveTaskStatus(task.status));
    if (open.some((task) => task.status === "waiting_approval")) return "waiting_approval";
    // Pedido com plano rodando sozinho (sem turno nem mensagem na fila dele) não ocupa o Maestro.
    const plans = this.deps.plans?.();
    const busy = open.filter((task) => !plans?.holds(task.id) || this.turn.current === task.id || (this.turn.queued.get(task.id) ?? 0) > 0);
    if (busy.length > 0 || this.turn.chat) return "working";
    return undefined;
  }

  progressSnapshot(): Record<string, TaskProgressInfo> {
    return this.requests.progressSnapshot();
  }

  stop(): void {
    this.stopped = true;
    this.session.detach();
  }

  // ---------- Ferramentas MCP do Maestro ----------

  /** `get_team`: quartos, times e agentes do workspace (sem a Sala do Maestro). */
  team(): string {
    return describeTeam(this.deps, this.now);
  }

  /** `delegate_task`: cria a subtarefa para o agente (ou o melhor do time) e volta na hora (veja `delegateTask`). */
  delegate(input: { agentId?: string; teamId?: string; task: string; reason?: string; requestId?: string; dueAt?: string; priority?: "high" | "normal" | "low"; doneWhen?: string[]; approvalType?: string }): string {
    return delegateTask(this.deps, this.now, this.requests, input);
  }

  /** `get_task` (do Maestro). */
  viewTask(id: string): string {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Task "${id}" not found`);
    return [
      `Task ${task.id} — status: ${task.status}`,
      `Assignee: ${this.requests.agentName(state, task.agentId)}`,
      `Request: ${task.prompt}`,
      task.result ? `Result:\n${shorten(task.result, RESULT_IN_MESSAGE)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** `complete_request`: fecha o pedido com a resposta final. */
  conclude(input: { text: string; requestId?: string }): string {
    const state = this.deps.state.read();
    const request = this.requests.request(state, input.requestId);
    const text = input.text.trim();
    if (!text) throw new Error("The answer text is empty");
    if (this.turn.concluded.has(request.id)) throw new Error("This request was already completed");
    const blocked = this.deps.plans?.()?.blocksConclusion(request.id);
    if (blocked) throw new Error(blocked);
    // Fora de uma conversa (o Maestro foi acordado pelo servidor), a resposta final também aparece na conversa.
    if (!this.turn.chat) {
      const maestro = findMaestroAgent(state);
      if (maestro) this.requests.chatEntry(maestro.id, { kind: "chat", from: "agent", text: `**Pedido concluído: ${shorten(request.prompt.split("\n")[0] ?? "", 120)}**\n\n${text}` });
    }
    // No turno do próprio pedido, fecha no fim do turno (o resto do turno ainda entra no log).
    if (this.turn.current !== request.id) this.requests.finish(state, request, "done", text);
    else this.turns.deferConclusion(request.id, text);
    return "Request completed. The answer was delivered to the user.";
  }

  /** `request_approval`: item no "Para você"; o pedido fica esperando você; a decisão chega como mensagem. */
  requestApproval(input: { question: string; type?: string; text?: string; where?: string; to?: string; mediaIds?: string[]; sources?: ForYouSource[]; requestId?: string; onApproved?: () => void }): string {
    return this.forYou.requestApproval(input);
  }

  /** Decisão do usuário (pelo "Para você") numa aprovação pedida pelo Maestro. */
  decide(taskId: string, decision: ApprovalDecision): Promise<Task> {
    return this.forYou.decide(taskId, decision);
  }

  /** O item é uma aprovação do Maestro que o pedido espera? (vários itens do mesmo pedido podem estar abertos) */
  holdsItem(forYouId: string): boolean {
    return this.forYou.holdsItem(forYouId);
  }

  /** `ask_user`: questionário no "Para você" (veja `MaestroForYou.askQuestions`). */
  askQuestions(input: { title?: string; questions: QuestionInput[]; requestId?: string }): string {
    return this.forYou.askQuestions(input);
  }

  /** O usuário enviou um questionário do Maestro: UMA mensagem com todas as respostas (no pedido, ou na conversa). */
  answers(item: ForYouItem, answers: string): void {
    this.forYou.answers(item, answers);
  }

  /** Um item do Maestro no "Para você" foi cancelado (por ele ou descartado pelo usuário). */
  itemCancelled(item: ForYouItem, cancel: ApprovalCancel): void {
    this.forYou.itemCancelled(item, cancel);
  }

  /**
   * O usuário fecha um pedido (parado ou não): "concluir" fecha como está; "cancelar" fecha como
   * cancelado. As subtarefas ativas param; um plano aberto é cancelado (pelo ProjectService).
   */
  closeByUser(taskId: string, mode: "concluir" | "cancelar", note?: string): Task {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !this.owns(state, task)) throw new HttpError(404, `Pedido "${taskId}" não encontrado`);
    if (!isActiveTaskStatus(task.status)) throw new HttpError(409, "O pedido já está fechado");
    for (const subtask of subtasksOf(state.tasks, task.id)) {
      if (isActiveTaskStatus(subtask.status)) this.deps.orchestrator.cancelTask?.(subtask.id, "Cancelada: o pedido foi fechado pelo usuário");
    }
    const clean = note?.trim();
    const status = mode === "concluir" ? "done" : "failed";
    const result = mode === "concluir" ? clean || task.result || "Fechado pelo usuário" : `Cancelado pelo usuário${clean ? `: ${clean}` : ""}`;
    const fresh = this.deps.state.read();
    this.requests.finish(fresh, fresh.tasks.find((candidate) => candidate.id === taskId) ?? task, status, result, mode === "cancelar" ? "cancelled" : undefined);
    // Cancelar o pedido também retira os itens dele que ainda esperam você no "Para você" (não ficam órfãos).
    if (mode === "cancelar") {
      const ids = new Set([task.id, ...subtasksOf(state.tasks, task.id).map((subtask) => subtask.id)]);
      void this.deps.approvals.cancelAllFor?.(ids, { by: "usuario", reason: "Pedido cancelado" })?.catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao retirar os itens do pedido cancelado"));
    }
    return { ...task, status, result, ...(mode === "cancelar" ? { outcome: "cancelled" as const, failureKind: "cancelada" as const } : {}) };
  }

  /**
   * `cancel_request`: o Maestro desfaz um pedido aberto por engano (ou que o usuário desistiu). As
   * subtarefas ativas param, o plano aberto é cancelado (ProjectService) e os itens pendentes do pedido
   * no "Para você" viram "cancelado". O pedido fecha como falha, com o motivo.
   */
  async cancelRequest(requestId: string | undefined, reason: string): Promise<string> {
    const state = this.deps.state.read();
    const request = this.requests.request(state, requestId);
    const why = reason.trim();
    const subtasks = subtasksOf(state.tasks, request.id);
    for (const subtask of subtasks) {
      if (isActiveTaskStatus(subtask.status)) this.deps.orchestrator.cancelTask?.(subtask.id, `Cancelada: o Maestro cancelou o pedido${why ? ` (${why})` : ""}`);
    }
    const items = (await this.deps.approvals.cancelAllFor?.(new Set([request.id, ...subtasks.map((subtask) => subtask.id)]), { by: "maestro", reason: why ? `Pedido cancelado: ${why}` : "Pedido cancelado" })) ?? [];
    const fresh = this.deps.state.read();
    const current = fresh.tasks.find((candidate) => candidate.id === request.id);
    if (current && isActiveTaskStatus(current.status)) this.requests.finish(fresh, current, "failed", `Cancelado pelo Maestro${why ? `: ${why}` : ""}`, "cancelled");
    const cancelled = items.length > 0 ? ` Pending items cancelled: ${items.map((item) => item.id).join(", ")}.` : "";
    return `Request ${request.id} cancelled.${cancelled} Tell the user in one sentence.`;
  }

  // ---------- ProjectHost (o ProjectService avisa; o pedido é daqui) ----------

  awaitUser(requestId: string, why: string): void {
    this.planHost.awaitUser(requestId, why);
  }

  working(requestId: string, message: string, progress: number): void {
    this.planHost.working(requestId, message, progress);
  }

  wake(requestId: string, kind: ProjectWakeKind, build: () => string): void {
    this.planHost.wake(requestId, kind, build);
  }

  close(requestId: string, reason: string): void {
    this.planHost.close(requestId, reason);
  }

  // ---------- Sessão ----------

  /** Por que o Maestro está indisponível agora (undefined = pode trabalhar). */
  blocked(): EngineBlock | undefined {
    return this.session.blocked();
  }

  /** O motor pode ter voltado: as mensagens que esperavam vão para a sessão, na ordem. */
  flushHeld(): void {
    this.session.flushHeld();
  }

  // ---------- Infra ----------

  /** `create_project`/`add_project_tasks`/`resolve_task`/`get_project`: o pedido aberto que a ferramenta quer. */
  requestFor(requestId: string | undefined): Task {
    return this.requests.requestFor(requestId);
  }
}
