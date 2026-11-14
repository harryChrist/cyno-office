import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { engineBlockLabel, type AgentProvider, type EngineBlock, type TerminalStatus } from "@cyno/shared";
import { trackTerminalExit, trackTerminalFailure, trackTerminalSpawn } from "../../platform/activity/hooks";
import { writeJsonAtomic } from "../../store/atomic-write";
import { errorMessage } from "../../util/text";
import { bracketedPaste, type PtyProcess, type PtySpawnFn } from "../terminals/pty-terminal";
import type { SendOptions, SessionInfo, TerminalAgent, TerminalEvent, TerminalListener, TerminalSpec } from "../terminals/types";
import { ChatLogTail, interpretLogEntry, type FreebuffLogEvent } from "./chat-log";
import { findLiveSession, listChats, processTree, chatsDirOf } from "./files";
import { chooseModel, type TuiDriver } from "./model-select";
import { ScreenBuffer } from "./screen";
import { isReadyScreen, isSettledScreen, parseHours } from "./screen-reader";
import type { FreebuffService } from "./service";

/**
 * Terminal do Freebuff: o `freebuff` de verdade (só existe a tela) num pseudoterminal, na pasta do agente.
 *
 * - O pedido vai como TEXTO na caixa (colagem + Enter, com uma pausa entre os dois). Quem diz o que o agente
 *   está fazendo e quando o turno acabou é o REGISTRO do chat que o Freebuff grava (`log.jsonl`, lido por
 *   ChatLogTail): ferramentas, texto e `shouldEndTurn`. A tela só serve para saber que ele subiu, para ler o
 *   saldo de horas e para escolher o modelo no `/model`.
 * - O resultado chega pelo caminho de sempre: o agente chama `submit_result` pelo MCP "office"; se o turno
 *   acaba sem isso, o runner usa o texto final (o `result` do `turn_end`).
 * - HORA ABERTA (veja FreebuffService): a hora começa na primeira mensagem do processo, dura 60 minutos e
 *   custa (multiplicador do modelo) horas do dia. Com a hora aberta o terminal NÃO fecha por ociosidade: fica
 *   vivo até a hora acabar (o Freebuff não fecha sozinho: o Cyno fecha), sem cortar um turno no meio. As
 *   tarefas seguintes do agente vão para a mesma conversa e a mesma hora.
 * - Problema (o processo cai, a tela não responde, o turno trava): fecha e abre de novo com
 *   `--continue <id do chat>`, que volta na MESMA conversa e na mesma hora, sem cobrar outra (medido em 12/11).
 *   Depois de `maxRetries` quedas seguidas, o agente fica com erro como nos outros motores.
 * - Reinício do servidor: a hora aberta fica gravada (engine-sessions.json) e, se ainda está dentro da hora,
 *   o terminal sobe com `--continue <id>` e segue.
 */

export type FreebuffTerminalOptions = {
  spec: TerminalSpec;
  /** A pasta do agente (session.json fica aqui; a pasta de trabalho do Freebuff é uma subpasta com nome único). */
  stateDir: string;
  /** Grava a pasta de trabalho antes de cada subida (instruções, MCP) e devolve a especificação atual. */
  prepare?: () => Promise<TerminalSpec>;
  service: FreebuffService;
  workspaceId: string;
  agentName: () => string | undefined;
  /** Nome da pasta de trabalho (o Freebuff guarda os chats por este nome). */
  folderName: string;
  command: { command: string; prefixArgs?: string[] };
  env: (base: NodeJS.ProcessEnv, spec: TerminalSpec) => NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  /** `~/.config/manicode` (só leitura). */
  manicodeDir: string;
  spawn?: PtySpawnFn;
  /** Sem hora aberta: ocioso por tanto tempo = processo parado. Com hora aberta: nunca. */
  idleMs: number;
  maxRetries: number;
  backoffMs?: (attempt: number) => number;
  stopGraceMs?: number;
  /** Consulta do registro e da tela (ms). Padrão 400. */
  pollMs?: number;
  /** Sem a caixa de pedido depois disto, a subida deu errado (e tenta de novo). Padrão 45 s. */
  readyTimeoutMs?: number;
  /** A mensagem não foi lida pelo Freebuff depois disto: aperta Enter de novo, depois reinicia. Padrão 90 s (ele segura a mensagem uns 30 s até entrar na sessão). */
  deliveryTimeoutMs?: number;
  /** Entre colar a mensagem e apertar Enter. Padrão 300 ms. */
  submitDelayMs?: number;
  /** Turno sem nenhum sinal no registro por tanto tempo = travado (reinicia com --continue). Padrão 10 min. */
  hangMs?: number;
  /** Vivo por tanto tempo = as quedas anteriores não contam mais. Padrão 60 s. */
  stableMs?: number;
  /** Com o fim da hora já medido, relê o arquivo da sessão a cada tanto (ms). Padrão 5 s. */
  liveRefreshMs?: number;
  /** Depois de a caixa aparecer, espera o catálogo carregar por no máximo isto (ms). Padrão 8 s. */
  settleCatalogMs?: number;
  /** Pausa entre as teclas do `/model` (ms). Padrão 300. */
  settleMs?: number;
  now?: () => Date;
};

type Message = { text: string; tag?: string; resent?: boolean };
type Turn = { message: Message; startedAt: number; registered: boolean; presses: number; lastSignal: number; lastText: string; deliveryTimer?: NodeJS.Timeout };

const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
export const FREEBUFF_PTY_SIZE = { cols: 140, rows: 100 } as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FreebuffTerminal implements TerminalAgent {
  readonly agentId: string;
  readonly provider: AgentProvider = "freebuff";
  private status_: TerminalStatus = "stopped";
  private error_: string | undefined;
  private pty: PtyProcess | undefined;
  private screen = new ScreenBuffer(FREEBUFF_PTY_SIZE.cols, FREEBUFF_PTY_SIZE.rows);
  private disposers: { dispose(): void }[] = [];
  private tail: ChatLogTail | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private disposed = false;
  private stopReason: string | undefined;
  private readonly killed = new WeakSet<PtyProcess>();
  private readonly queue: Message[] = [];
  private turn: Turn | undefined;
  private ready = false;
  private readySeenAt = 0;
  private modelBusy = false;
  private modelChecked = false;
  private spawnedAt = 0;
  private failures = 0;
  private chatId: string | undefined;
  private session: SessionInfo | undefined;
  private sessionWrites: Promise<void> = Promise.resolve();
  /** O processo vai ser fechado quando o turno em curso acabar (a hora acabou no meio dele). */
  private closeAfterTurn = false;
  /** O próximo fim de processo é um reinício pedido por nós (travou, tela não respondeu): conta como queda. */
  private restartReason: string | undefined;
  private waitingNote: string | undefined;
  private lastLiveCheck = 0;
  private timer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private unsubscribeService: (() => void) | undefined;
  private polling = false;
  private readonly listeners = new Set<TerminalListener>();
  private readonly now: () => Date;
  private readonly sessionFile: string;
  private readonly ref: { workspaceId: string; agentId: string };

  constructor(private readonly options: FreebuffTerminalOptions) {
    this.agentId = options.spec.agentId;
    this.ref = { workspaceId: options.workspaceId, agentId: options.spec.agentId };
    this.now = options.now ?? (() => new Date());
    this.sessionFile = path.join(options.stateDir, "session.json");
  }

  // ---------- TerminalAgent ----------

  status(): TerminalStatus {
    return this.status_;
  }

  sessionId(): string | undefined {
    return this.chatId ?? this.session?.sessionId;
  }

  lastError(): string | undefined {
    return this.error_;
  }

  /** O chat do Freebuff tem histórico (já houve uma mensagem)? */
  async hasHistory(): Promise<boolean> {
    return this.session?.started === true || this.options.service.sessionOf(this.ref) !== undefined;
  }

  onEvent(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Entra na fila. `freshSession` não vale: dentro da hora a conversa é uma só (abrir outra conversa no
   * mesmo processo não foi medido, e outro processo abriria outra hora). A memória de verdade é o Cérebro.
   */
  send(message: string, tag?: string, _options?: SendOptions): void {
    if (this.disposed) {
      this.emit({ type: "dropped", tag, reason: "Terminal encerrado" });
      return;
    }
    this.queue.push({ text: message, tag });
    this.clearIdle();
    // Sem hora aberta, este pedido vai abrir uma: já conta para o teto de horas abertas.
    if (!this.options.service.sessionOf(this.ref)) this.options.service.claim(this.ref, this.options.agentName());
    if (this.pty) this.pump();
    else if (!this.retryTimer) void this.ensureRunning().catch(() => undefined);
  }

  cancel(tag: string): string[] {
    const removed: string[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.tag === tag) removed.unshift(this.queue.splice(i, 1)[0]!.text);
    if (this.queue.length === 0 && !this.turn) this.options.service.release(this.ref);
    return removed;
  }

  /** Esc: o Freebuff interrompe o turno em curso (o processo e a hora continuam). */
  interrupt(): void {
    if (this.pty && this.status_ === "busy") this.pty.write("\x1b");
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error("Terminal encerrado");
    if (this.stopping) await this.stopping;
    if (this.pty) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  /** Parar à mão (ou desligar o servidor): fecha o processo e larga a fila. A hora continua contando (dá para reabrir nela). */
  async stop(reason = "Terminal parado"): Promise<void> {
    this.stopReason = reason;
    this.clearIdle();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.dropAll(reason);
    if (this.starting) await this.starting.catch(() => undefined);
    const pty = this.pty;
    if (!pty) {
      if (this.status_ !== "stopped") this.setStatus("stopped");
      return;
    }
    if (this.stopping) return this.stopping;
    this.stopping = this.kill(pty).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop("Terminal encerrado");
    this.unsubscribeService?.();
    this.unsubscribeService = undefined;
    this.listeners.clear();
  }

  // ---------- Subida ----------

  private async start(): Promise<void> {
    this.setStatus("starting");
    try {
      if (this.options.prepare) this.options.spec = await this.options.prepare();
      const spec = this.options.spec;
      await mkdir(spec.cwd, { recursive: true });
      const stored = this.options.service.sessionOf(this.ref);
      const chats = await listChats(this.options.manicodeDir, this.options.folderName);
      // Dentro da hora aberta e com a conversa ainda no disco: volta nela com --continue <id> (sem cobrar outra hora).
      const resume = stored?.chatId && chats.includes(stored.chatId) ? stored.chatId : undefined;
      const args = [...(this.options.command.prefixArgs ?? []), "--trust-agents", ...(resume ? ["--continue", resume] : [])];
      const spawn = this.options.spawn ?? (await loadNodePty());
      this.screen = new ScreenBuffer(FREEBUFF_PTY_SIZE.cols, FREEBUFF_PTY_SIZE.rows);
      this.ready = false;
      this.readySeenAt = 0;
      this.modelChecked = false;
      this.modelBusy = false;
      this.chatId = resume;
      this.spawnedAt = Date.now();
      const env = this.options.env(this.options.baseEnv ?? process.env, spec);
      const pty = spawn(this.options.command.command, args, { cwd: spec.cwd, env, cols: FREEBUFF_PTY_SIZE.cols, rows: FREEBUFF_PTY_SIZE.rows, name: "xterm-256color" });
      this.pty = pty;
      trackTerminalSpawn(this, { agentId: spec.agentId, pid: pty.pid });
      this.disposers = [pty.onData((data) => this.onData(pty, data)), pty.onExit((event) => this.onPtyExit(pty, event.exitCode))];
      this.options.service.setProcess(this.ref, true);
      this.unsubscribeService ??= this.options.service.subscribe((event) => {
        if (event.type === "expired" && event.agentId === this.agentId && event.workspaceId === this.options.workspaceId) this.onHourEnd();
        else if (event.type === "changed") this.pump();
      });
      this.timer = setInterval(() => void this.tick(pty), this.options.pollMs ?? 400);
      this.timer.unref();
      if (this.disposed) {
        await this.kill(pty);
        return;
      }
      if (resume) this.emit({ type: "session", sessionId: resume });
      this.emitRaw(resume ? `Freebuff reaberto com --continue ${resume} (a mesma hora, sem cobrar outra).` : "Freebuff aberto.");
      this.error_ = undefined;
    } catch (error) {
      this.pty = undefined;
      this.error_ = `Não foi possível iniciar o Freebuff: ${errorMessage(error)}`;
      this.emitRaw(this.error_);
      trackTerminalFailure(this, "start_failed", { error: errorMessage(error) }, this.options.spec.agentId);
      this.failures += 1;
      this.afterFailure();
      throw error;
    }
  }

  private onData(pty: PtyProcess, data: string): void {
    if (pty !== this.pty) return;
    for (const reply of this.screen.write(data)) {
      try {
        pty.write(reply);
      } catch {
        // saiu no meio
      }
    }
  }

  /** O relógio do terminal: pronto, registro, fim da hora, travamento. */
  private async tick(pty: PtyProcess): Promise<void> {
    if (pty !== this.pty || this.polling) return;
    this.polling = true;
    try {
      const text = this.screen.text();
      if (!this.ready) {
        if (isReadyScreen(text)) {
          // A caixa aparece ~1 s antes de o catálogo e a sessão carregarem (até lá o rodapé mostra um modelo embutido).
          this.readySeenAt ||= Date.now();
          if (isSettledScreen(text) || Date.now() - this.readySeenAt > (this.options.settleCatalogMs ?? 8000)) await this.markReady(pty, text);
        } else if (Date.now() - this.spawnedAt > (this.options.readyTimeoutMs ?? 45_000)) this.restart(pty, "A tela do Freebuff não respondeu (a caixa de pedido não apareceu)");
        return;
      }
      if (!this.chatId) await this.detectChat();
      const tail = this.tail;
      if (tail) {
        await tail.poll();
        if (tail.grew) {
          tail.grew = false;
          if (this.turn) this.turn.lastSignal = Date.now();
        }
      }
      await this.refreshHourEnd(pty);
      this.watchdog(pty);
    } finally {
      this.polling = false;
    }
  }

  private async markReady(pty: PtyProcess, text: string): Promise<void> {
    this.ready = true;
    const hours = parseHours(text);
    if (hours) await this.options.service.measure(hours);
    await this.detectChat();
    if (pty !== this.pty) return;
    if (this.status_ === "starting") this.setStatus("idle");
    this.failures = this.failures > 0 && Date.now() - this.spawnedAt >= (this.options.stableMs ?? 60_000) ? 0 : this.failures;
    void this.ensureModelThenPump(pty);
  }

  /** O chat deste processo: o de `--continue`, ou a pasta de chat mais nova criada depois da subida. */
  private async detectChat(): Promise<void> {
    if (this.chatId && this.tail) return;
    if (!this.chatId) {
      const chats = await listChats(this.options.manicodeDir, this.options.folderName);
      const latest = chats.at(-1);
      if (!latest) return;
      this.chatId = latest;
      this.emit({ type: "session", sessionId: latest });
    }
    const file = path.join(chatsDirOf(this.options.manicodeDir, this.options.folderName), this.chatId, "log.jsonl");
    this.tail = new ChatLogTail({ file, fromEnd: true, onEntry: (entry) => this.onLogEntry(entry) });
    await this.tail.prime();
    if (this.options.service.sessionOf(this.ref)) await this.options.service.setChat(this.ref, this.chatId);
    this.saveSession({ sessionId: this.chatId });
  }

  /** Antes da primeira mensagem de uma hora nova: o modelo da plataforma (por teclas, na própria TUI). */
  private async ensureModelThenPump(pty: PtyProcess): Promise<void> {
    if (!this.modelChecked && !this.options.service.sessionOf(this.ref)) {
      this.modelBusy = true;
      try {
        const settings = this.options.service.settings();
        const driver: TuiDriver = { text: () => this.screen.text(), write: (keys) => pty.write(keys), sleep, alive: () => this.pty === pty };
        const result = await chooseModel(driver, { model: settings.model, effort: settings.effort }, { settleMs: this.options.settleMs ?? 300 });
        if (!result.ok) this.emitRaw(`Não consegui escolher o modelo do Freebuff: ${result.error} Sigo com o que a tela mostra.`);
        else if (result.changed) {
          this.emitRaw(`Modelo do Freebuff: ${settings.model} · ${settings.effort}.`);
          if (result.multiplier !== undefined) await this.options.service.noteMultiplier(settings.model, result.multiplier);
        }
      } catch (error) {
        this.emitRaw(`Não consegui escolher o modelo do Freebuff: ${errorMessage(error)}`);
      } finally {
        this.modelBusy = false;
      }
    }
    this.modelChecked = true;
    if (pty === this.pty) this.pump();
  }

  // ---------- Fila e entrega ----------

  private pump(): void {
    const pty = this.pty;
    if (!pty || !this.ready || this.modelBusy || this.turn || this.stopping || this.status_ !== "idle") return;
    if (this.closeAfterTurn) return;
    const next = this.queue[0];
    if (!next) {
      this.options.service.release(this.ref);
      this.armIdle();
      return;
    }
    if (!this.options.service.sessionOf(this.ref)) {
      // Hora nova: o teto de horas abertas e o saldo do dia mandam. Quem chega aqui espera na fila, com o motivo.
      const block = this.options.service.blockFor(this.ref);
      if (block) {
        this.noteWaiting(block);
        return;
      }
    }
    this.waitingNote = undefined;
    this.queue.shift();
    void this.deliver(pty, next);
  }

  private noteWaiting(block: EngineBlock): void {
    const note = block.reason === "hour" ? `Esperando: ${engineBlockLabel(block, this.now().getTime())}` : `Sem horas no Freebuff hoje: ${engineBlockLabel(block, this.now().getTime())}`;
    if (this.waitingNote === note) return;
    this.waitingNote = note;
    this.emitRaw(note);
  }

  private async deliver(pty: PtyProcess, message: Message): Promise<void> {
    this.setStatus("busy");
    if (!this.options.service.sessionOf(this.ref)) {
      // A primeira mensagem do processo abre a hora (e a reserva já, para o teto valer para os outros).
      const opened = await this.options.service.openHour({
        agentId: this.agentId,
        workspaceId: this.options.workspaceId,
        ...(this.options.agentName() ? { agentName: this.options.agentName()! } : {}),
        folder: this.options.folderName,
        cwd: this.options.spec.cwd,
        ...(this.chatId ? { chatId: this.chatId } : {}),
      });
      if (!opened) {
        // Outro agente abriu a hora no meio: a mensagem volta para a frente da fila e espera.
        this.queue.unshift(message);
        this.setStatus("idle");
        return;
      }
      this.emitRaw(`Hora do Freebuff aberta: vai até ${new Date(opened.endsAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} (gasta ${opened.multiplier} ${opened.multiplier === 1 ? "hora" : "horas"} do dia).`);
    }
    if (pty !== this.pty) {
      this.queue.unshift(message);
      return;
    }
    const turn: Turn = { message, startedAt: Date.now(), registered: false, presses: 1, lastSignal: Date.now(), lastText: "" };
    this.turn = turn;
    this.emit({ type: "turn_start", tag: message.tag });
    this.type(pty, message.text);
    turn.deliveryTimer = setTimeout(() => this.onDeliveryTimeout(pty, turn), this.options.deliveryTimeoutMs ?? 90_000);
    turn.deliveryTimer.unref();
  }

  /** Cola o texto e aperta Enter depois de uma pausa (um Enter junto do texto não é lido como envio). */
  private type(pty: PtyProcess, text: string): void {
    pty.write(bracketedPaste(text));
    const timer = setTimeout(() => {
      if (this.pty === pty) pty.write("\r");
    }, this.options.submitDelayMs ?? 300);
    timer.unref();
  }

  private onDeliveryTimeout(pty: PtyProcess, turn: Turn): void {
    if (this.turn !== turn || turn.registered || pty !== this.pty) return;
    if (turn.presses < 2) {
      turn.presses += 1;
      this.emitRaw("O Freebuff não leu a mensagem: apertando Enter de novo.");
      pty.write("\r");
      turn.deliveryTimer = setTimeout(() => this.onDeliveryTimeout(pty, turn), this.options.deliveryTimeoutMs ?? 90_000);
      turn.deliveryTimer.unref();
      return;
    }
    this.restart(pty, "A tela do Freebuff não respondeu à mensagem");
  }

  // ---------- Registro do chat ----------

  private onLogEntry(entry: unknown): void {
    for (const event of interpretLogEntry(entry)) this.onLogEvent(event);
  }

  private onLogEvent(event: FreebuffLogEvent): void {
    const turn = this.turn;
    if (!turn) return;
    turn.lastSignal = Date.now();
    switch (event.kind) {
      case "sent":
        turn.registered = true;
        if (turn.deliveryTimer) clearTimeout(turn.deliveryTimer);
        this.lastLiveCheck = 0;
        return;
      case "text":
        turn.registered = true;
        turn.lastText = event.text;
        this.emit({ type: "text", text: event.text });
        return;
      case "tool_use":
        turn.registered = true;
        this.emit({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        return;
      case "tool_result":
        this.emit({ type: "tool_result", id: event.id, ok: event.ok, ...(event.output ? { output: event.output } : {}) });
        return;
      case "error":
        this.emitRaw(event.text);
        return;
      case "turn_end":
        this.finishTurn(turn, event.result || turn.lastText);
        return;
    }
  }

  private finishTurn(turn: Turn, result: string): void {
    if (this.turn !== turn) return;
    if (turn.deliveryTimer) clearTimeout(turn.deliveryTimer);
    this.turn = undefined;
    this.failures = 0;
    if (!this.session?.started) this.saveSession({ started: true });
    if (result && result !== turn.lastText) this.emit({ type: "text", text: result });
    this.emit({ type: "turn_end", tag: turn.message.tag, ok: true, result });
    if (this.pty && this.status_ === "busy") this.setStatus("idle");
    if (this.closeAfterTurn) {
      void this.closeForHourEnd();
      return;
    }
    this.pump();
  }

  // ---------- A hora ----------

  /** O fim real da hora vem do arquivo da sessão do Freebuff (até lá vale o relógio: abertura + 60 min). */
  private async refreshHourEnd(pty: PtyProcess): Promise<void> {
    const session = this.options.service.sessionOf(this.ref);
    // Lê de novo de tempos em tempos mesmo depois de medido: o processo novo primeiro retoma a hora que outro processo deixou
    // (com o fim dela) e, na primeira mensagem, o Freebuff pode abrir uma hora nova e regravar o arquivo (visto em 12/11).
    if (!session || Date.now() - this.lastLiveCheck < (session.endsAtSource === "measured" ? (this.options.liveRefreshMs ?? 5000) : 1500)) return;
    this.lastLiveCheck = Date.now();
    const pids = await processTree(pty.pid);
    const live = await findLiveSession(this.options.manicodeDir, pids);
    if (live && pty === this.pty) await this.options.service.setEnd(this.ref, live.expiresAt);
  }

  /** A hora acabou (o relógio do serviço avisou). Sem turno em andamento fecha já; com turno, depois dele. */
  private onHourEnd(): void {
    if (!this.pty) return;
    this.emitRaw("A hora do Freebuff acabou.");
    if (this.turn) {
      this.closeAfterTurn = true;
      return;
    }
    void this.closeForHourEnd();
  }

  /** Fecha o processo (o Freebuff não fecha sozinho no fim da hora). A fila segue: a próxima mensagem abre uma hora NOVA. */
  private async closeForHourEnd(): Promise<void> {
    this.closeAfterTurn = false;
    const pty = this.pty;
    if (!pty || this.stopping) return;
    await this.options.service.closeHour(this.ref, "a hora acabou");
    this.stopReason = "A hora do Freebuff acabou";
    this.clearIdle();
    this.stopping = this.kill(pty).finally(() => {
      this.stopping = undefined;
    });
    await this.stopping;
  }

  // ---------- Queda e travamento ----------

  private watchdog(pty: PtyProcess): void {
    const turn = this.turn;
    if (!turn || pty !== this.pty) return;
    if (Date.now() - turn.lastSignal > (this.options.hangMs ?? 600_000)) this.restart(pty, "O turno do Freebuff travou (sem sinal no registro)");
  }

  /** Fecha o processo e abre de novo (com --continue, na mesma hora): conta como uma queda. */
  private restart(pty: PtyProcess, reason: string): void {
    if (pty !== this.pty || this.stopping) return;
    this.restartReason = reason;
    this.emitRaw(`${reason}: fechando e abrindo de novo com --continue.`);
    void this.kill(pty);
  }

  private onPtyExit(pty: PtyProcess, code: number | null): void {
    if (pty !== this.pty) return;
    const expected = Boolean(this.stopping || this.disposed || (this.killed.has(pty) && !this.restartReason));
    trackTerminalExit(this, { agentId: this.options.spec.agentId, code, expected, reason: this.stopReason });
    this.pty = undefined;
    for (const disposer of this.disposers) disposer.dispose();
    this.disposers = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tail = undefined;
    this.ready = false;
    this.clearIdle();
    this.options.service.setProcess(this.ref, false);
    if (this.turn?.deliveryTimer) clearTimeout(this.turn.deliveryTimer);
    this.requeueInterrupted();
    if (expected) {
      this.setStatus("stopped");
      this.restartReason = undefined;
      if (!this.disposed && this.queue.length > 0) queueMicrotask(() => void this.ensureRunning().catch(() => undefined));
      return;
    }
    const lived = Date.now() - this.spawnedAt;
    this.error_ = this.restartReason ?? `O Freebuff saiu (código ${code ?? "?"})`;
    this.restartReason = undefined;
    this.emitRaw(this.error_);
    if (lived >= (this.options.stableMs ?? 60_000)) this.failures = 0;
    this.failures += 1;
    this.afterFailure();
  }

  /** O turno em curso volta para a frente da fila (o agente lembra da conversa: --continue). */
  private requeueInterrupted(): void {
    const turn = this.turn;
    this.turn = undefined;
    this.closeAfterTurn = false;
    if (!turn) return;
    const { message } = turn;
    this.queue.unshift({ ...message, resent: true, text: message.resent ? message.text : `(Mensagem reenviada: o terminal caiu e voltou. Veja na conversa o que você já fez antes de repetir.)\n\n${message.text}` });
  }

  private afterFailure(): void {
    this.setStatus("error");
    if (this.disposed) return;
    const wanted = this.queue.length > 0 || this.options.service.sessionOf(this.ref) !== undefined;
    if (!wanted) return;
    if (this.failures > this.options.maxRetries) {
      trackTerminalFailure(this, "gave_up", { failures: this.failures, error: this.error_ }, this.options.spec.agentId);
      this.dropAll(`O Freebuff caiu ${this.failures} vezes seguidas: ${this.error_ ?? "erro desconhecido"}`);
      return;
    }
    const wait = (this.options.backoffMs ?? defaultBackoff)(this.failures);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.disposed && !this.pty) void this.ensureRunning().catch(() => undefined);
    }, wait);
    this.retryTimer.unref();
  }

  private async kill(pty: PtyProcess): Promise<void> {
    const grace = this.options.stopGraceMs ?? 3000;
    let exited = false;
    const done = new Promise<void>((resolve) => {
      const sub = pty.onExit(() => {
        exited = true;
        sub.dispose();
        resolve();
      });
    });
    const within = (ms: number) => Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())]);
    this.killed.add(pty);
    try {
      pty.kill("SIGHUP");
    } catch {
      // já saiu
    }
    if (exited || (await within(grace))) return;
    try {
      pty.kill("SIGKILL");
    } catch {
      // já saiu
    }
    await within(grace);
    if (this.pty === pty) this.onPtyExit(pty, null);
  }

  private dropAll(reason: string): void {
    this.options.service.release(this.ref);
    const turn = this.turn;
    if (turn?.deliveryTimer) clearTimeout(turn.deliveryTimer);
    this.turn = undefined;
    const dropped = [...(turn ? [turn.message] : []), ...this.queue.splice(0)];
    for (const message of dropped) this.emit({ type: "dropped", tag: message.tag, reason });
  }

  // ---------- Ociosidade ----------

  /** Sem hora aberta o processo fecha por ociosidade como os outros; com hora aberta ele fica até a hora acabar. */
  private armIdle(): void {
    this.clearIdle();
    if (this.options.idleMs <= 0 || this.options.service.sessionOf(this.ref)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.status_ === "idle" && this.queue.length === 0 && !this.turn && !this.options.service.sessionOf(this.ref)) void this.stop("Parado por ociosidade");
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // ---------- Estado, sessão, eventos ----------

  private setStatus(status: TerminalStatus): void {
    if (this.status_ === status) return;
    this.status_ = status;
    const reason = status === "stopped" ? this.stopReason : status === "starting" ? (this.stopReason = undefined) : undefined;
    this.emit({ type: "status", status, ...(status === "error" && this.error_ ? { error: this.error_ } : {}), ...(reason ? { reason } : {}) });
  }

  private emitRaw(text: string): void {
    this.emit({ type: "raw", stream: "stderr", text });
  }

  private emit(event: TerminalEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Um ouvinte com erro não derruba o terminal.
      }
    }
  }

  private saveSession(change: Partial<Pick<SessionInfo, "sessionId" | "started">>): void {
    const current = this.session;
    const sessionId = change.sessionId ?? current?.sessionId ?? this.chatId ?? "freebuff";
    const started = change.started ?? current?.started ?? false;
    if (current && current.sessionId === sessionId && current.started === started) return;
    this.session = { provider: this.provider, sessionId, started, updatedAt: this.now().toISOString() };
    const snapshot = { ...this.session };
    this.sessionWrites = this.sessionWrites.then(() => mkdir(this.options.stateDir, { recursive: true }).then(() => writeJsonAtomic(this.sessionFile, snapshot))).catch(() => undefined);
  }

  /** Espera as gravações de session.json (testes e shutdown). */
  flushSession(): Promise<void> {
    return this.sessionWrites;
  }

  /** O que a tela do Freebuff mostra agora (depuração e testes). */
  screenText(): string {
    return this.screen.text();
  }

  /** Lê o session.json salvo (o `everStarted` do manager também olha este arquivo). */
  async savedSession(): Promise<SessionInfo | undefined> {
    try {
      return JSON.parse(await readFile(this.sessionFile, "utf8")) as SessionInfo;
    } catch {
      return undefined;
    }
  }
}

/** node-pty só é carregado quando um terminal sobe (binário nativo pré-compilado). */
async function loadNodePty(): Promise<PtySpawnFn> {
  const pty = await import("@lydell/node-pty");
  return (file, args, options) => pty.spawn(file, args, options);
}
