import { randomUUID } from "node:crypto";
import {
  agentEngine,
  conversationLogId,
  isActiveTaskStatus,
  isCliEngine,
  isConversationLogId,
  isMaestroAgent,
  advanceChatStatus,
  type AgentChatResponse,
  type AgentChatStatus,
  type AgentLogBody,
  type AgentLogEntry,
  type OfficeState,
  type ServerEvent,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { runnerLogHooks } from "../../workspace/agent-log/hooks";
import type { AgentLogService } from "../../workspace/agent-log/service";
import { HttpError } from "../../platform/http/errors";
import { NO_ENGINE_RESULT } from "../runner/no-engine-runner";
import { errorMessage } from "../../util/text";
import type { CliAgentRunner } from "./cli-runner";
import { terminalLogBridge } from "./log-bridge";
import type { TerminalManager } from "./manager";
import type { TerminalAgent, TerminalEvent } from "./types";

/** Etiqueta (tag do terminal) de uma mensagem de conversa direta: "conversa:<id>". */
const CHAT_TAG_PREFIX = "conversa:";
/** Chave da sessão da CLI da conversa direta (uma só, separada das sessões de tarefa). */
export const AGENT_CHAT_SESSION_KEY = "conversa";
/** Quantas falas recentes entram no resumo quando a conversa abre numa sessão nova da CLI (e quanto de cada). */
const RECAP = { lines: 8, chars: 300 } as const;
/** Quanto o agente simulado "pensa" antes da resposta pronta. */
const MOCK_REPLY_MS = 900;

/** Respostas prontas do agente simulado (conversa e nota), em rodízio. */
const MOCK_CHAT_REPLIES = [
  "(Simulado) Oi! Sou um agente simulado: não penso de verdade, mas li sua mensagem. Para um trabalho novo, peça ao Maestro.",
  "(Simulado) Boa pergunta! Como agente simulado, só consigo responder com textos prontos. O Maestro abre o pedido quando for para fazer.",
  "(Simulado) Anotado. Quando quiser que eu faça algo, fale com o Maestro: ele organiza o pedido e me passa.",
] as const;
const MOCK_NOTE_REPLY = "(Simulado) Anotado: vou levar isso em conta no que falta desta tarefa.";

export type AgentChatDeps = {
  state: { read(): OfficeState };
  terminals: Pick<TerminalManager, "get" | "setChatting">;
  runner: Pick<CliAgentRunner, "note">;
  agentLog: AgentLogService;
  log: Pick<FastifyBaseLogger, "warn">;
  now: () => Date;
  /** Publica o estado de entrega das mensagens (`agent:chat-status`) para os clientes do workspace. */
  publish?: (event: ServerEvent) => void;
  /** Atraso da resposta pronta do agente simulado (padrão MOCK_REPLY_MS; 0 nos testes). */
  mockReplyMs?: number;
  /** Modo simulado ligado (só testes): só então o agente sem motor responde com as falas prontas. */
  simulated?: boolean;
};

/** Uma mensagem mandada pela caixa, acompanhada até a resposta (ou a falha). */
type Pending = {
  messageId: string;
  agentId: string;
  mode: "nota" | "conversa";
  status: AgentChatStatus["status"];
  /** Tag da mensagem no terminal (conversa); a nota não tem: ela é entregue no próximo turno. */
  tag?: string | undefined;
  taskId?: string | undefined;
};

/** Quantas mensagens o acompanhamento guarda (as que falharam ficam, para uma confirmação atrasada corrigir). */
const PENDING_KEEP = 100;

/** Turno de conversa em curso de um agente (para onde vão os eventos do terminal). */
type ChatTurn = { logId: string; bridge: ReturnType<typeof terminalLogBridge> };

/**
 * Conversa direta do usuário com um agente de time (a caixa na tela de trabalho dele). Nada vira
 * pedido sozinho. Roteamento:
 * - agente numa tarefa (em andamento ou esperando aprovação): NOTA na sessão da tarefa (CLI: ao vivo
 *   no turno em curso, se a CLI aceitar; senão no próximo limite de turno) e no log da tarefa;
 * - agente livre: CONVERSA numa sessão própria da CLI (chave "conversa", separada das tarefas), com o
 *   log do dia `conversa-<agente>-AAAAMMDD` (entradas `chat`; o que o agente fizer no turno vai junto);
 * - agente simulado: a fala entra no log certo e ele responde com um texto pronto.
 * O Maestro tem a caixa dele (409 aqui).
 */
export class AgentChat {
  private readonly attached = new Map<string, { terminal: TerminalAgent; off: () => void }>();
  private readonly turns = new Map<string, ChatTurn>();
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private mockCounter = 0;
  private stopped = false;

  constructor(private readonly deps: AgentChatDeps) {}

  async send(agentId: string, rawText: string): Promise<AgentChatResponse> {
    const text = rawText.trim();
    if (!text) throw new HttpError(400, "A mensagem está vazia");
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new HttpError(404, `Agente "${agentId}" não encontrado`);
    if (isMaestroAgent(state, agent)) throw new HttpError(409, "Fale com o Maestro pela caixa do painel dele");
    const engine = agentEngine(agent);
    const task = state.tasks.find((candidate) => candidate.agentId === agentId && (candidate.status === "in_progress" || candidate.status === "waiting_approval"));
    const messageId = randomUUID();

    if (!isCliEngine(engine)) {
      if (!this.deps.simulated) throw new HttpError(409, NO_ENGINE_RESULT);
      if (task) {
        const rec = this.track(messageId, agentId, "nota", { taskId: task.id });
        this.userEntry(task.id, agentId, text);
        this.setStatus(rec, "delivered");
        this.later(() => {
          this.append(task.id, agentId, { kind: "chat", from: "agent", text: MOCK_NOTE_REPLY });
          this.setStatus(rec, "answered");
        });
        return { mode: "nota", taskId: task.id, live: true, messageId };
      }
      const rec = this.track(messageId, agentId, "conversa");
      const logId = conversationLogId(agentId, this.deps.now());
      this.userEntry(logId, agentId, text);
      this.setStatus(rec, "delivered");
      const reply = MOCK_CHAT_REPLIES[this.mockCounter++ % MOCK_CHAT_REPLIES.length]!;
      this.later(() => {
        this.append(conversationLogId(agentId, this.deps.now()), agentId, { kind: "chat", from: "agent", text: reply });
        this.setStatus(rec, "answered");
      });
      return { mode: "conversa", logId, messageId };
    }

    // Agente de CLI numa tarefa: nota na sessão da tarefa.
    if (task && isActiveTaskStatus(task.status)) {
      const note = this.deps.runner.note(agentId, text);
      if (note) {
        const rec = this.track(messageId, agentId, "nota", { taskId: note.taskId });
        this.watchTerminal(agentId);
        this.userEntry(note.taskId, agentId, text);
        if (note.live) this.setStatus(rec, "delivered");
        else this.append(note.taskId, agentId, { kind: "status", status: "waiting", message: "Nota na fila: chega ao agente no fim do turno em curso" });
        return { mode: "nota", ...note, messageId };
      }
    }

    // Livre: conversa numa sessão própria.
    return this.converse(agentId, agent.name, text, text, messageId);
  }

  /**
   * Nota que ficou na fila quando a tarefa acabou (o agente entregou antes do próximo turno; comum no
   * Antigravity, que só lê notas entre turnos): em vez de se perder, vira uma mensagem de conversa
   * (sessão "conversa", nunca a próxima tarefa), e o agente diz se ela muda algo no que entregou.
   */
  async lateNotes(agentId: string, taskId: string, notes: readonly string[]): Promise<void> {
    const text = notes.map((note) => note.trim()).filter(Boolean).join("\n\n");
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (!text || !agent || this.stopped) return;
    // O título da tarefa (1ª linha do pedido) diz de QUAL entrega se trata (a conversa pode lembrar de outras).
    const title = state.tasks.find((task) => task.id === taskId)?.prompt.split("\n")[0]?.trim().slice(0, 160);
    const message = [
      `(Esta nota era para a tarefa ${title ? `“${title}” (${taskId})` : taskId}, que você acabou de entregar: ela chegou depois da entrega. Não refaça o trabalho por conta própria: diga ao usuário, curto, se ela muda algo NESSA entrega e o que faria diferente.)`,
      text,
    ].join("\n\n");
    // As notas que ainda esperavam na fila seguem junto: são entregues quando esta conversa abrir o turno.
    const messageId = randomUUID();
    const queued = [...this.pending.values()].filter((rec) => rec.agentId === agentId && rec.mode === "nota" && rec.taskId === taskId && rec.status === "queued");
    for (const rec of queued) rec.tag = chatTag(messageId);
    try {
      await this.converse(agentId, agent.name, `Nota que chegou depois da entrega: ${text}`, message, messageId);
    } catch (error) {
      for (const rec of queued) this.setStatus(rec, "failed", `A nota não chegou ao agente: ${errorMessage(error)}`);
      this.append(taskId, agentId, { kind: "status", status: "failed", message: `A nota não chegou ao agente: ${errorMessage(error)}`.slice(0, 280) });
    }
  }

  /** Conversa com o agente livre: `shown` vai para o log da conversa, `message` para a CLI. */
  private async converse(agentId: string, name: string, shown: string, message: string, messageId: string = randomUUID()): Promise<AgentChatResponse> {
    let terminal: TerminalAgent;
    try {
      terminal = this.deps.terminals.get(agentId);
    } catch (error) {
      throw new HttpError(409, `O terminal de ${name} não está disponível: ${errorMessage(error)}`);
    }
    this.attach(agentId, terminal);
    const logId = conversationLogId(agentId, this.deps.now());
    // Sessão nova da CLI (a última conversa era de uma tarefa): leva um resumo das falas recentes.
    const recap = terminal.currentSessionKey?.() === AGENT_CHAT_SESSION_KEY ? undefined : await this.recap(agentId);
    this.userEntry(logId, agentId, shown);
    const tag = chatTag(messageId);
    const rec = this.pending.get(messageId) ?? this.track(messageId, agentId, "conversa", { tag });
    rec.tag = tag;
    terminal.send(chatMessage(message, recap), tag, { freshSession: true, sessionKey: AGENT_CHAT_SESSION_KEY });
    return { mode: "conversa", logId, messageId };
  }

  /** Shutdown: nada mais entra no log. */
  close(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const { off } of this.attached.values()) off();
    this.attached.clear();
    for (const turn of this.turns.values()) turn.bridge.close("Server desligando");
    this.turns.clear();
  }

  // ---------- Terminal ----------

  private attach(agentId: string, terminal: TerminalAgent): void {
    const current = this.attached.get(agentId);
    if (current?.terminal === terminal) return;
    current?.off();
    this.attached.set(agentId, { terminal, off: terminal.onEvent((event) => this.onEvent(agentId, terminal, event)) });
  }

  private onEvent(agentId: string, terminal: TerminalAgent, event: TerminalEvent): void {
    if (this.stopped) return;
    switch (event.type) {
      case "turn_start": {
        this.endTurn(agentId);
        this.onTurnStart(agentId, event.tag);
        if (!isChatTag(event.tag)) return;
        const logId = conversationLogId(agentId, this.deps.now());
        const hooks = runnerLogHooks(this.deps.agentLog, { taskId: logId, agentId, provider: terminal.provider }, () => !this.stopped);
        this.turns.set(agentId, { logId, bridge: terminalLogBridge(hooks) });
        this.deps.terminals.setChatting(agentId, true);
        return;
      }
      case "turn_end": {
        const turn = this.endTurn(agentId);
        this.onTurnEnd(agentId, event.tag, event.ok, event.result);
        if (!turn || !isChatTag(event.tag)) return;
        const text = event.result.trim();
        if (event.ok && text) this.append(turn.logId, agentId, { kind: "chat", from: "agent", text });
        else if (!event.ok) this.append(turn.logId, agentId, { kind: "status", status: "failed", message: `Não respondeu: ${(text || "erro na CLI").slice(0, 200)}` });
        return;
      }
      case "dropped":
        this.onDropped(agentId, event.tag, event.reason);
        if (!isChatTag(event.tag)) return;
        this.endTurn(agentId);
        this.append(conversationLogId(agentId, this.deps.now()), agentId, { kind: "status", status: "failed", message: `A mensagem não chegou: ${event.reason}`.slice(0, 280) });
        return;
      case "status":
        if (event.status === "stopped" || event.status === "error") this.endTurn(agentId);
        if (event.status === "error") this.failQueued(agentId, terminal.lastError() ?? "o terminal caiu");
        return;
      default:
        this.turns.get(agentId)?.bridge.handle(event);
    }
  }

  // ---------- Acompanhamento da entrega ----------

  /** Começa a acompanhar uma mensagem (na fila) e já avisa os clientes. */
  private track(messageId: string, agentId: string, mode: Pending["mode"], extra: { tag?: string; taskId?: string } = {}): Pending {
    const rec: Pending = { messageId, agentId, mode, status: "queued", ...extra };
    this.pending.set(messageId, rec);
    for (const [id, old] of this.pending) {
      if (this.pending.size <= PENDING_KEEP) break;
      if (old.status !== "queued" && old.status !== "delivered") this.pending.delete(id);
    }
    this.publishStatus(rec);
    return rec;
  }

  /** Muda o estado (só avança; "falhou" pode ser corrigido por uma confirmação atrasada) e avisa se mudou. */
  private setStatus(rec: Pending, next: AgentChatStatus["status"], error?: string): void {
    const status = advanceChatStatus(rec.status, next);
    if (status === rec.status) return;
    rec.status = status;
    this.publishStatus(rec, status === "failed" ? error : undefined);
  }

  private publishStatus(rec: Pending, error?: string): void {
    if (this.stopped) return;
    const chat: AgentChatStatus = { messageId: rec.messageId, agentId: rec.agentId, status: rec.status, mode: rec.mode, ...(error ? { error: error.slice(0, 280) } : {}), at: this.deps.now().toISOString() };
    this.deps.publish?.({ type: "agent:chat-status", chat });
  }

  /** A nota fica atenta ao terminal do agente (a conversa já se liga a ele ao mandar). */
  private watchTerminal(agentId: string): void {
    try {
      this.attach(agentId, this.deps.terminals.get(agentId));
    } catch (error) {
      this.deps.log.warn({ err: error, agentId }, "não foi possível acompanhar a entrega da nota");
    }
  }

  /** As mensagens do agente neste estado que pertencem a esta tag (a nota não tem tag: vale para o próximo turno). */
  private records(agentId: string, tag: string | undefined, status: AgentChatStatus["status"]): Pending[] {
    return [...this.pending.values()].filter((rec) => rec.agentId === agentId && rec.status === status && (rec.tag === tag || (rec.mode === "nota" && rec.tag === undefined)));
  }

  /** Um turno abriu: a mensagem dele foi entregue (a nota na fila entra no próximo turno que abrir). */
  private onTurnStart(agentId: string, tag: string | undefined): void {
    for (const rec of this.records(agentId, tag, "queued")) this.setStatus(rec, "delivered");
    // Uma confirmação atrasada (depois de "falhou") também corrige para "entregue".
    if (tag !== undefined) for (const rec of this.records(agentId, tag, "failed")) if (rec.tag === tag) this.setStatus(rec, "delivered");
  }

  /** O turno acabou: quem tinha sido entregue nele foi respondido (ou o turno deu erro). */
  private onTurnEnd(agentId: string, tag: string | undefined, ok: boolean, result: string): void {
    for (const rec of this.records(agentId, tag, "delivered")) {
      if (ok) this.setStatus(rec, "answered");
      // A entrega já aconteceu (nunca volta a "falhou"): o motivo vai junto, no mesmo estado, e a tela avisa.
      else this.publishStatus(rec, `O turno falhou: ${(result.trim() || "erro na CLI").slice(0, 200)}`);
    }
  }

  private onDropped(agentId: string, tag: string | undefined, reason: string): void {
    for (const rec of this.records(agentId, tag, "queued")) this.setStatus(rec, "failed", `A mensagem não chegou: ${reason}`);
  }

  private failQueued(agentId: string, reason: string): void {
    for (const rec of this.pending.values()) {
      if (rec.agentId !== agentId || rec.status !== "queued") continue;
      this.setStatus(rec, "failed", `O terminal caiu: ${reason}`);
      // A conversa também deixa o aviso no log do dia (o histórico conta o que não chegou).
      if (rec.mode === "conversa") this.append(conversationLogId(agentId, this.deps.now()), agentId, { kind: "status", status: "failed", message: `A mensagem não chegou: ${reason}`.slice(0, 280) });
    }
  }

  private endTurn(agentId: string): ChatTurn | undefined {
    const turn = this.turns.get(agentId);
    if (!turn) return undefined;
    this.turns.delete(agentId);
    turn.bridge.close("Turno encerrado");
    this.deps.terminals.setChatting(agentId, false);
    return turn;
  }

  // ---------- Log ----------

  private userEntry(logId: string, agentId: string, text: string): void {
    this.append(logId, agentId, { kind: "chat", from: "user", text, via: "painel" });
  }

  private append(logId: string, agentId: string, body: AgentLogBody): void {
    if (this.stopped) return;
    this.deps.agentLog.append({ taskId: logId, agentId }, body);
  }

  private later(action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, this.deps.mockReplyMs ?? MOCK_REPLY_MS);
    timer.unref();
    this.timers.add(timer);
  }

  /**
   * Contexto para a sessão nova da CLI não começar no escuro: as últimas falas da conversa direta e
   * o que o agente entregou nas últimas tarefas (a sessão da conversa não vê as sessões das tarefas).
   */
  private async recap(agentId: string): Promise<{ chat: string; work: string } | undefined> {
    let entries: AgentLogEntry[];
    try {
      entries = await this.deps.agentLog.recentForAgent(agentId, 300);
    } catch (error) {
      this.deps.log.warn({ err: error, agentId }, "não foi possível ler a conversa recente do agente");
      return undefined;
    }
    const tasks = this.deps.state.read().tasks;
    const title = (taskId: string) => tasks.find((task) => task.id === taskId)?.prompt.split("\n")[0]?.trim();
    return { chat: chatRecap(entries), work: workRecap(entries, title) };
  }
}

const chatTag = (messageId: string) => `${CHAT_TAG_PREFIX}${messageId}`;
const isChatTag = (tag: string | undefined): tag is string => tag !== undefined && tag.startsWith(CHAT_TAG_PREFIX);

/** Resumo das falas recentes da conversa direta (entradas `chat` dos logs de conversa), as mais novas por último. */
export function chatRecap(entries: readonly AgentLogEntry[]): string {
  const lines = entries
    .filter((entry): entry is Extract<AgentLogEntry, { kind: "chat" }> => entry.kind === "chat" && isConversationLogId(entry.taskId))
    .slice(-RECAP.lines)
    .map((entry) => {
      const flat = entry.text.replace(/\s+/g, " ").trim();
      return `- ${entry.from === "user" ? "Usuário" : "Você"}: ${flat.length > RECAP.chars ? `${flat.slice(0, RECAP.chars - 1)}…` : flat}`;
    });
  return lines.join("\n");
}

/** Quantas entregas recentes entram no contexto da conversa (e quanto de cada). */
const WORK_RECAP = { tasks: 3, chars: 600, title: 120 } as const;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** O que o agente entregou nas últimas tarefas (entradas `result` do próprio agente), as mais novas por último. */
export function workRecap(entries: readonly AgentLogEntry[], titleOf: (taskId: string) => string | undefined = () => undefined): string {
  return entries
    .filter((entry): entry is Extract<AgentLogEntry, { kind: "result" }> => entry.kind === "result" && entry.thread === undefined && !isConversationLogId(entry.taskId))
    .slice(-WORK_RECAP.tasks)
    .map((entry) => `- Tarefa “${clip(titleOf(entry.taskId) ?? entry.taskId, WORK_RECAP.title)}”: ${clip(entry.text, WORK_RECAP.chars)}`)
    .join("\n");
}

/** Mensagem de conversa direta para a sessão da CLI (com o contexto, se a conversa abriu numa sessão nova). */
export function chatMessage(text: string, recap?: { chat: string; work: string }): string {
  return [
    "Mensagem direta do usuário (conversa pela sua tela de trabalho; NÃO é uma tarefa):",
    text,
    ...(recap?.chat ? ["", "## Conversa recente com o usuário (para contexto)", recap.chat] : []),
    ...(recap?.work ? ["", "## O que você entregou nas últimas tarefas (para contexto)", recap.work] : []),
  ].join("\n");
}
