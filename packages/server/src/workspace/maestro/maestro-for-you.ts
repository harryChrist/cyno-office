import { randomUUID } from "node:crypto";
import { findMaestroAgent, findMaestroRoom, forYouKind, isActiveTaskStatus, type ForYouItem, type ForYouSource, type OfficeState, type Task } from "@cyno/shared";
import { cancelNote, toQuestions, type QuestionInput } from "../for-you/service";
import { HttpError } from "../../platform/http/errors";
import type { ApprovalCancel, ApprovalDecision } from "../../engines/runner/types";
import { shorten } from "../../util/text";
import type { MaestroCore } from "./maestro-core";
import type { MaestroSession } from "./maestro-session";
import { CHAT_TAG_PREFIX } from "./maestro-text";

/**
 * A ponte do Maestro com o "Para você": aprovações pedidas por ele (`request_approval`), questionários
 * (`ask_user`), a decisão/as respostas do usuário e o cancelamento de itens. O pedido espera o usuário
 * sem acordar o Maestro; a decisão chega como uma mensagem para a sessão.
 */
export class MaestroForYou {
  /**
   * Aprovações do próprio Maestro esperando o usuário, por id do item do "Para você" (um pedido pode
   * ter várias abertas ao mesmo tempo). `hook` roda quando a aprovação sai (ex.: o navegador libera
   * a ação aprovada).
   */
  private readonly pendingApprovals = new Map<string, { requestId: string; question: string; hook?: () => void }>();
  /** Decisões já tomadas de um pedido que ainda tem outras aprovações abertas: vão juntas ao Maestro quando a última sai. */
  private readonly decided = new Map<string, string[]>();

  constructor(
    private readonly core: MaestroCore,
    private readonly session: MaestroSession,
  ) {}

  /** O pedido tem alguma aprovação do Maestro esperando o usuário? */
  hasPending(requestId: string): boolean {
    return this.pendingOf(requestId).length > 0;
  }

  /** O item do "Para você" é uma aprovação do Maestro que o pedido ainda espera? */
  holdsItem(forYouId: string): boolean {
    return this.pendingApprovals.has(forYouId);
  }

  /** Os itens (id e pergunta) de aprovação pendentes do pedido, do mais antigo ao mais novo. */
  private pendingOf(requestId: string): [string, { requestId: string; question: string; hook?: () => void }][] {
    return [...this.pendingApprovals.entries()].filter(([, entry]) => entry.requestId === requestId);
  }

  /** Boot: o pedido esperava a aprovação `forYouId` (`question`) quando o servidor caiu. */
  restorePending(requestId: string, forYouId: string, question: string): void {
    this.pendingApprovals.set(forYouId, { requestId, question });
  }

  /** O pedido fechou: as aprovações pendentes dele saem. */
  clear(requestId: string): void {
    for (const [id] of this.pendingOf(requestId)) this.pendingApprovals.delete(id);
    this.decided.delete(requestId);
  }

  /** `request_approval`: item no "Para você"; o pedido fica esperando você; a decisão chega como mensagem. Pode haver várias abertas. */
  requestApproval(input: { question: string; type?: string; text?: string; where?: string; to?: string; mediaIds?: string[]; sources?: ForYouSource[]; requestId?: string; onApproved?: () => void }): string {
    const { deps } = this.core;
    const state = deps.state.read();
    const request = this.core.request(state, input.requestId);
    delete request.waiting;
    this.core.setTask(state, request, { status: "waiting_approval" });
    const item = deps.approvals.open(request, {
      question: input.question,
      ...(input.text || input.mediaIds?.length || input.sources?.length
        ? {
            draft: {
              text: input.text ?? input.question,
              ...(input.text ? { type: input.type ?? "outro" } : input.type ? { type: input.type } : {}),
              ...(input.where ? { where: input.where } : {}),
              ...(input.to ? { to: input.to } : {}),
              ...(input.mediaIds?.length ? { mediaIds: input.mediaIds } : {}),
              ...(input.sources?.length ? { sources: input.sources } : {}),
            },
          }
        : {}),
    });
    this.pendingApprovals.set(item.id, { requestId: request.id, question: input.question, ...(input.onApproved ? { hook: input.onApproved } : {}) });
    this.core.logEntry(request, { kind: "approval", phase: "asked", question: input.question, forYouId: item.id });
    this.core.logEntry(request, { kind: "status", status: "waiting", message: "Esperando você" });
    this.core.setProgress(request, 0.5, input.question);
    deps.refreshStatus();
    return `Approval request ${item.id} sent to the user. End this turn: the decision arrives in a message.`;
  }

  /**
   * Decisão do usuário (pelo "Para você") numa aprovação pedida pelo Maestro: `decision.itemId` diz
   * qual (sem ele, a mais antiga do pedido). Com outras ainda abertas, o pedido segue esperando e a
   * decisão fica guardada; quando a última sai, o Maestro recebe UMA mensagem com todas.
   */
  async decide(taskId: string, decision: ApprovalDecision): Promise<Task> {
    const { deps } = this.core;
    const state = deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new HttpError(404, `Tarefa "${taskId}" não encontrada`);
    const pending = this.pendingOf(taskId);
    const picked = decision.itemId ? pending.find(([id]) => id === decision.itemId) : pending[0];
    if (task.status !== "waiting_approval" || !picked) throw new HttpError(409, "A tarefa não está aguardando aprovação");
    const [itemId, entry] = picked;
    this.pendingApprovals.delete(itemId);
    if (decision.approved) entry.hook?.();
    this.core.logEntry(task, { kind: "approval", phase: "decided", approved: decision.approved, ...(decision.reason ?? decision.response ? { note: decision.reason ?? decision.response } : {}) });
    const lines = this.decided.get(taskId) ?? [];
    lines.push(
      [
        `Decisão do usuário sobre "${entry.question}" (${itemId}): ${decision.approved ? "APROVADO" : "RECUSADO"}.`,
        decision.approved && decision.text ? `Texto final:\n${decision.text}` : "",
        !decision.approved && decision.reason ? `Motivo da recusa: ${decision.reason}` : "",
        decision.response && decision.response !== decision.reason ? `Nota do usuário: ${decision.response}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    const left = this.pendingOf(taskId).length;
    if (left > 0) {
      this.decided.set(taskId, lines);
      this.core.logEntry(task, { kind: "status", status: "waiting", message: `${decision.approved ? "Aprovada" : "Recusada"}: ainda ${left === 1 ? "falta 1 aprovação" : `faltam ${left} aprovações`}` });
      deps.refreshStatus();
      return task;
    }
    this.decided.delete(taskId);
    const saved = this.resume(state, task, lines, decision.approved ? "Aprovada: o Maestro segue" : "Recusada: o Maestro decide o que fazer", true);
    deps.refreshStatus();
    await saved;
    return deps.state.read().tasks.find((candidate) => candidate.id === taskId)!;
  }

  /** Todas as aprovações do pedido saíram: o pedido volta a andar e o Maestro recebe as decisões numa mensagem. */
  private resume(state: OfficeState, task: Task, lines: string[], note: string, strict = false): Promise<void> {
    this.core.logEntry(task, { kind: "status", status: "resumed", message: note });
    const saved = this.core.setTask(state, task, { status: "in_progress" }, { strict });
    this.core.setProgress(task, 0.6, "O Maestro está seguindo com a decisão");
    this.core.push(task.id, [...lines, "Continue o pedido e termine com complete_request."].join("\n\n"));
    return saved;
  }

  /**
   * `ask_user`: questionário no "Para você". O usuário responde no tempo dele (rascunho no
   * server, sem acordar ninguém) e manda tudo de uma vez: as respostas chegam numa mensagem só.
   * Com pedido, ele fica esperando você; sem pedido, as respostas voltam para a conversa.
   */
  askQuestions(input: { title?: string; questions: QuestionInput[]; requestId?: string }): string {
    const { deps, turn } = this.core;
    const state = deps.state.read();
    const maestro = findMaestroAgent(state);
    const room = findMaestroRoom(state);
    if (!maestro || !room || !deps.approvals.openSpecial) throw new Error("This workspace has no Maestro");
    const request = input.requestId || turn.current || turn.openedInTurn.length > 0 ? this.core.request(state, input.requestId) : undefined;
    const questions = toQuestions(input.questions);
    if (questions.length === 0) throw new Error("Send at least one question");
    const title = input.title?.trim() || (request ? `Perguntas sobre: ${shorten(request.prompt.split("\n")[0] ?? "", 80)}` : "Perguntas do Maestro");
    const item = deps.approvals.openSpecial({
      kind: "questionario",
      agentId: maestro.id,
      roomId: request?.roomId ?? room.id,
      ...(request ? { taskId: request.id } : {}),
      title,
      why: `${questions.length} pergunta(s); responda no seu tempo e envie tudo de uma vez`,
      questions,
    });
    if (request) {
      delete request.waiting;
      this.core.setTask(state, request, { status: "waiting_approval" });
      this.core.logEntry(request, { kind: "approval", phase: "asked", question: title, forYouId: item.id, questions: questions.length });
      this.core.logEntry(request, { kind: "status", status: "waiting", message: "Esperando suas respostas no Para você" });
      this.core.setProgress(request, 0.2, "Esperando suas respostas no Para você");
    } else {
      this.core.chatEntry(maestro.id, { kind: "status", status: "waiting", message: `O Maestro mandou ${questions.length} pergunta(s) para o Para você (${item.id})` });
    }
    deps.refreshStatus();
    return `Questionnaire ${item.id} sent to the user (Para você). Say so in one sentence and end the turn: the answers arrive together in one message when the user sends them (it may take a while; do not ask again).`;
  }

  /** O usuário enviou um questionário do Maestro: UMA mensagem com todas as respostas (no pedido, ou na conversa). */
  answers(item: ForYouItem, answers: string): void {
    const { deps } = this.core;
    const state = deps.state.read();
    const maestro = findMaestroAgent(state);
    if (!maestro) return;
    const request = item.taskId ? state.tasks.find((task) => task.id === item.taskId && this.core.owns(state, task) && isActiveTaskStatus(task.status)) : undefined;
    this.core.chatEntry(maestro.id, { kind: "chat", from: "user", text: `Respostas para “${item.title ?? "perguntas"}”:\n${answers}`, via: "painel" });
    const header = `Respostas do usuário ao seu questionário ${item.id} (“${item.title ?? ""}”). “decida você” = escolha você (com o padrão sugerido, se houver).`;
    if (!request) {
      this.core.push(`${CHAT_TAG_PREFIX}${randomUUID()}`, `${header}\n\n${answers}\n\nSiga a conversa com isso (se for para fazer, abra o pedido).`);
      return;
    }
    this.core.logEntry(request, { kind: "approval", phase: "decided", approved: true, note: shorten(answers, 300) });
    this.core.setTask(state, request, { status: "in_progress" });
    this.core.setProgress(request, 0.3, "O Maestro está lendo as suas respostas");
    this.core.push(request.id, `Pedido ${request.id}: ${header}\n\n${answers}\n\nSiga o pedido (planeje com create_project, delegue com delegate_task, ou feche com complete_request).`);
    deps.refreshStatus();
  }

  /**
   * Um item do Maestro no "Para você" foi cancelado (por ele ou descartado pelo usuário): a aprovação
   * pendente do pedido sai; sem outro item segurando, o pedido fica esperando o usuário (com o
   * porquê), sem acordar o Maestro. Descartado pelo usuário: o Maestro fica sabendo na próxima mensagem.
   */
  itemCancelled(item: ForYouItem, cancel: ApprovalCancel): void {
    const { deps } = this.core;
    const state = deps.state.read();
    const maestro = findMaestroAgent(state);
    const request = item.taskId ? state.tasks.find((task) => task.id === item.taskId && this.core.owns(state, task) && isActiveTaskStatus(task.status)) : undefined;
    const label = item.title ?? item.why ?? "";
    if (cancel.by === "usuario") {
      const reason = cancel.reason?.trim() ? ` Motivo: ${cancel.reason.trim()}.` : "";
      this.session.addNotice(
        `O usuário descartou o seu item ${item.id} do Para você (“${shorten(label, 120)}”)${request ? `, do pedido ${request.id}` : ""}.${reason} Não mande de novo sem ele pedir.`,
      );
    }
    if (!request) {
      if (maestro && cancel.by === "usuario") this.core.chatEntry(maestro.id, { kind: "status", status: "waiting", message: `Você descartou ${item.id}: o Maestro fica sabendo na próxima mensagem` });
      deps.refreshStatus();
      return;
    }
    if (forYouKind(item) === "aprovacao") this.pendingApprovals.delete(item.id);
    this.core.logEntry(request, { kind: "approval", phase: "decided", approved: false, note: cancelNote(cancel) });
    const held = deps.state.readForYou().some((other) => other.id !== item.id && other.status === "pendente" && other.taskId === request.id);
    const decidedBefore = this.decided.get(request.id);
    if (!held && decidedBefore && request.status === "waiting_approval" && !this.hasPending(request.id)) {
      // As outras aprovações do pedido já tinham sido decididas: o Maestro recebe todas agora.
      this.decided.delete(request.id);
      void this.resume(state, request, decidedBefore, "A última aprovação foi retirada: o Maestro segue");
      deps.refreshStatus();
      return;
    }
    if (!held && request.status === "waiting_approval" && !deps.plans?.()?.holds(request.id)) {
      const why = cancel.by === "usuario" ? `Você descartou ${item.id}: fale com o Maestro para seguir` : `O Maestro retirou ${item.id} do Para você`;
      request.waiting = why;
      void this.core.setTask(state, request, { status: "waiting_approval" });
      this.core.logEntry(request, { kind: "status", status: "waiting", message: why });
      this.core.setProgress(request, 0.3, why);
    }
    deps.refreshStatus();
  }
}
