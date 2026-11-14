import { conversationLogId, engineBlockLabel, findMaestroAgent, isActiveTaskStatus, subtasksOf, type Task } from "@cyno/shared";
import { runnerLogHooks } from "../agent-log/hooks";
import { terminalLogBridge } from "../../engines/terminals/log-bridge";
import type { TerminalAgent, TerminalEvent } from "../../engines/terminals/types";
import { shorten } from "../../util/text";
import type { ChatTurn, MaestroCore } from "./maestro-core";
import type { MaestroForYou } from "./maestro-for-you";
import type { MaestroSession } from "./maestro-session";
import { citedRequestId, isChatTag, looksLikeQuestion, RESULT_IN_MESSAGE } from "./maestro-text";

/** Depois de `complete_request`, quanto esperar o fim do turno antes de fechar o pedido assim mesmo. */
const CONCLUDE_GRACE_MS = 30_000;

/**
 * O que acontece em cada turno do Maestro: o início (de qual pedido/conversa é, a ponte para o log),
 * o fim (fecha o pedido, espera o usuário ou segue) e o aviso do fim de cada subtarefa.
 */
export class MaestroTurns {
  private bridge: ReturnType<typeof terminalLogBridge> | undefined;
  /** Subtarefas cujo fim já foi avisado ao Maestro. */
  private readonly notified = new Set<string>();

  constructor(
    private readonly core: MaestroCore,
    private readonly session: MaestroSession,
    private readonly forYou: MaestroForYou,
  ) {}

  /** Boot: a subtarefa já tinha terminado antes do reinício (não avisa de novo). */
  markNotified(subtaskId: string): void {
    this.notified.add(subtaskId);
  }

  /** `complete_request` no turno do próprio pedido: fecha no fim do turno (ou no tempo esgotado). */
  deferConclusion(taskId: string, text: string): void {
    this.core.turn.concluded.set(taskId, text);
    setTimeout(() => this.closeConcluded(taskId), CONCLUDE_GRACE_MS).unref();
  }

  onTerminalEvent(maestroId: string, terminal: TerminalAgent, event: TerminalEvent): void {
    if (this.core.isStopped()) return;
    const { turn, deps } = this.core;
    switch (event.type) {
      case "turn_start": {
        this.bridge?.close("Turno encerrado");
        turn.openedInTurn = [];
        turn.chat = undefined;
        this.core.chatStatus(event.tag, "delivered");
        if (event.tag) turn.queued.set(event.tag, Math.max(0, (turn.queued.get(event.tag) ?? 1) - 1));
        // Turno sem tag: alguém escreveu direto no terminal do Maestro (ou pelo Remote Control).
        const typed = !event.tag && event.prompt !== undefined ? event.prompt.trim() : undefined;
        const cited = typed ? this.citedRequest(typed) : undefined;
        const tag = isChatTag(event.tag) ? undefined : (event.tag ?? cited);
        turn.current = tag;
        turn.turnTag = event.tag ? undefined : tag;
        if (tag) {
          this.bridge = terminalLogBridge(
            runnerLogHooks(deps.agentLog, { taskId: tag, agentId: maestroId, provider: terminal.provider }, () => this.core.isOpen(tag)),
          );
          return;
        }
        if (!isChatTag(event.tag) && !typed) {
          this.bridge = undefined;
          return;
        }
        // Conversa: o turno vai para o log da conversa do dia (a fala do painel já entrou no converse).
        if (typed) this.core.chatEntry(maestroId, { kind: "chat", from: "user", text: typed, via: "terminal" });
        const chat: ChatTurn = { logId: conversationLogId(maestroId, this.core.now()) };
        turn.chat = chat;
        this.bridge = terminalLogBridge(
          runnerLogHooks(deps.agentLog, { taskId: chat.logId, agentId: maestroId, provider: terminal.provider }, () => !this.core.isStopped()),
        );
        deps.refreshStatus();
        return;
      }
      case "turn_end": {
        this.bridge?.close("Turno encerrado");
        this.bridge = undefined;
        turn.current = undefined;
        const chat = turn.chat;
        turn.chat = undefined;
        const opened = turn.openedInTurn;
        turn.openedInTurn = [];
        const tag = isChatTag(event.tag) ? undefined : (event.tag ?? turn.turnTag);
        turn.turnTag = undefined;
        this.session.trackSize(event.contextTokens);
        if (chat) {
          this.core.chatStatus(event.tag, event.ok ? "answered" : "failed", event.ok ? undefined : event.result.trim() || "erro na CLI");
          this.afterChat(maestroId, event.ok, event.result, opened);
        }
        else if (tag) this.afterTurn(tag, event.ok, event.result);
        return;
      }
      case "dropped": {
        // A mensagem (talvez a que levava o contexto do Cérebro) não chegou: a próxima confere de novo.
        this.session.forgetHistory();
        if (isChatTag(event.tag)) {
          this.core.chatEntry(maestroId, { kind: "status", status: "failed", message: `A mensagem não chegou ao Maestro: ${event.reason}` });
          this.core.chatStatus(event.tag, "failed", event.reason);
          return;
        }
        if (!event.tag) return;
        const state = deps.state.read();
        const task = state.tasks.find((candidate) => candidate.id === event.tag);
        if (task && isActiveTaskStatus(task.status)) this.core.finish(state, task, "failed", event.reason, undefined, "motor");
        return;
      }
      default:
        this.bridge?.handle(event);
    }
  }

  /**
   * O que alguém digitou direto no terminal do Maestro (ou no Remote Control) cita um pedido aberto
   * ("Pedido <id>", ex.: uma mensagem nossa que perdeu a etiqueta)? Então o turno é dele. Senão é
   * conversa (nada vira tarefa sozinho). Comandos de barra e afins nem chegam aqui.
   */
  private citedRequest(prompt: string): string | undefined {
    const cited = citedRequestId(prompt);
    if (!cited) return undefined;
    const state = this.core.deps.state.read();
    return state.tasks.find((task) => task.id === cited && this.core.owns(state, task) && isActiveTaskStatus(task.status))?.id;
  }

  /** Fim de um turno de conversa: a resposta do Maestro entra no log da conversa (ou o erro). */
  private afterChat(maestroId: string, ok: boolean, result: string, opened: readonly string[] = []): void {
    const { deps, turn } = this.core;
    const text = result.trim();
    if (ok && text) this.core.chatEntry(maestroId, { kind: "chat", from: "agent", text });
    // Abriu um pedido e terminou perguntando (sem delegar, planejar nem concluir): o pedido espera a resposta.
    if (ok && opened.length > 0 && looksLikeQuestion(text)) {
      const state = deps.state.read();
      for (const id of opened) {
        const task = state.tasks.find((candidate) => candidate.id === id);
        if (!task || task.status !== "in_progress" || turn.concluded.has(id) || deps.plans?.()?.holds(id)) continue;
        if (subtasksOf(state.tasks, id).some((subtask) => isActiveTaskStatus(subtask.status))) continue;
        task.waiting = "O Maestro fez uma pergunta na conversa";
        this.core.setTask(state, task, { status: "waiting_approval" });
        this.core.logEntry(task, { kind: "status", status: "waiting", message: "Esperando sua resposta na conversa" });
        this.core.setProgress(task, 0.3, "Esperando sua resposta na conversa");
      }
    }
    else if (!ok) {
      const block = this.session.blocked();
      const message = block ? `Maestro ${engineBlockLabel(block, this.core.now().getTime())}: a resposta foi interrompida` : `O Maestro não respondeu: ${shorten(text || "erro na CLI", 200)}`;
      this.core.chatEntry(maestroId, { kind: "status", status: "failed", message });
    }
    deps.refreshStatus();
  }

  /** Fecha um pedido com `complete_request` pendente (fim do turno ou tempo esgotado). */
  private closeConcluded(taskId: string): boolean {
    const text = this.core.turn.concluded.get(taskId);
    if (text === undefined || this.core.isStopped()) return false;
    this.core.turn.concluded.delete(taskId);
    const state = this.core.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task && isActiveTaskStatus(task.status)) this.core.finish(state, task, "done", text);
    return true;
  }

  /** Fim de um turno do pedido: erro fecha como falha; sem nada pendente, o texto do turno fecha. */
  private afterTurn(taskId: string, ok: boolean, result: string): void {
    if (this.closeConcluded(taskId)) return;
    const { deps, turn } = this.core;
    const state = deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !isActiveTaskStatus(task.status)) return;
    if (!ok) {
      const block = this.session.blocked();
      if (block) {
        // A cota acabou no meio do turno: o pedido espera e o Maestro retoma quando o motor voltar.
        const resumeText = `O pedido ${taskId} foi interrompido porque a cota da assinatura acabou. Continue de onde parou: ${task.prompt}`;
        this.session.hold(taskId, () => resumeText, block);
        return;
      }
      this.core.finish(state, task, "failed", result || "Erro na CLI do Maestro", undefined, "motor");
      return;
    }
    const busy = subtasksOf(state.tasks, task.id).some((subtask) => isActiveTaskStatus(subtask.status));
    if (busy || this.forYou.hasPending(task.id) || (turn.queued.get(task.id) ?? 0) > 0) return;
    // Esperando o usuário (plano para aprovar, questionário) ou com plano rodando: o pedido fica aberto.
    if (task.status === "waiting_approval" || deps.plans?.()?.holds(task.id)) return;
    const text = result.trim();
    if (looksLikeQuestion(text)) {
      // Terminou perguntando algo ao usuário (sem complete_request): o pedido espera a resposta na conversa.
      const maestro = findMaestroAgent(state);
      if (maestro) this.core.chatEntry(maestro.id, { kind: "chat", from: "agent", text });
      task.waiting = "O Maestro fez uma pergunta na conversa";
      this.core.setTask(state, task, { status: "waiting_approval" });
      this.core.logEntry(task, { kind: "status", status: "waiting", message: "Esperando sua resposta na conversa" });
      this.core.setProgress(task, 0.3, "Esperando sua resposta na conversa");
      deps.refreshStatus();
      return;
    }
    this.core.finish(state, task, text ? "done" : "failed", text || "O Maestro terminou sem responder", undefined, "agente");
  }

  /** Uma subtarefa de um pedido daqui terminou: o resultado vai para a sessão do Maestro. */
  onSubtask(subtask: Task): void {
    if (this.core.isStopped() || subtask.projectId === undefined) return;
    // Etapa de plano: quem acompanha é o ProjectService (o Maestro só é acordado no fim ou se algo precisar dele).
    if (this.core.deps.plans?.()?.isPlanStep(subtask)) return;
    const state = this.core.deps.state.read();
    const parent = state.tasks.find((candidate) => candidate.id === subtask.projectId);
    if (!parent || !this.core.owns(state, parent) || !isActiveTaskStatus(parent.status)) return;
    if (subtask.status === "waiting_approval") {
      this.core.setProgress(parent, 0.4, `${this.core.agentName(state, subtask.agentId)} pede sua aprovação`);
      return;
    }
    if (subtask.status !== "done" && subtask.status !== "failed") return;
    if (this.notified.has(subtask.id)) return;
    this.notified.add(subtask.id);
    const who = this.core.agentName(state, subtask.agentId);
    const message =
      subtask.status === "done"
        ? `Resultado da tarefa ${subtask.id} de ${who}:\n\n${shorten(subtask.result ?? "(sem texto)", RESULT_IN_MESSAGE)}`
        : `A tarefa ${subtask.id} de ${who} falhou: ${subtask.result ?? "sem motivo informado"}`;
    this.core.logEntry(parent, { kind: "text", text: subtask.status === "done" ? `${who} entregou a tarefa.` : `A tarefa de ${who} falhou.` });
    this.core.setProgress(parent, 0.8, `Revisando a entrega de ${who}`);
    this.core.push(parent.id, `${message}\n\nPedido ${parent.id}: siga (delegue mais com delegate_task, ou feche com complete_request).`);
  }
}
