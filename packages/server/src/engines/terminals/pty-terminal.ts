import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentProvider, RemoteControlInfo, TerminalStatus } from "@cyno/shared";
import { trackTerminalExit, trackTerminalFailure, trackTerminalSpawn } from "../../platform/activity/hooks";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { ToolsWait, ToolsWaitOutcome } from "../../mcp/tokens";
import { errorMessage } from "../../util/text";
import { ClaudeTranscriptParser, claudeTranscriptDir } from "./claude-transcript";
import { TranscriptTail } from "./transcript-tail";
import type { SendOptions, SessionInfo, TerminalAgent, TerminalEvent, TerminalListener, TerminalSpec, ToolsGate } from "./types";

/** O pedaço do node-pty que o terminal usa (os testes passam um falso). */
export type PtyProcess = {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type PtySpawnFn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name: string }) => PtyProcess;

/** O que o terminal interativo precisa da CLI (o ClaudeCliAdapter implementa). */
export interface InteractiveCliAdapter {
  readonly provider: AgentProvider;
  /** Comando do modo interativo (TUI): `remoteControl` = nome da sessão do Remote Control (ausente = sem). */
  interactiveCommand(spec: TerminalSpec, session: { sessionId: string; resume: boolean }, options: { remoteControl?: string }): { command: string; args: string[] };
  env(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv;
  newSessionId(): string;
}

export type PtyTerminalOptions = {
  adapter: InteractiveCliAdapter;
  spec: TerminalSpec;
  /** Grava a pasta do agente antes de cada subida e devolve a especificação atualizada. */
  prepare?: () => Promise<TerminalSpec>;
  env?: NodeJS.ProcessEnv;
  /** Pasta de projetos do Claude Code (`~/.claude/projects`): de onde vem a conversa estruturada. */
  projectsDir: string;
  /** Manter sempre rodando (sobe de novo se sair, nunca para por ociosidade)? Lido a cada decisão. */
  keepAlive: () => boolean;
  /** Sem keepAlive: ocioso por tanto tempo = processo parado (a próxima ordem retoma a sessão). */
  idleMs: number;
  /** Quedas seguidas antes de desistir (status "error" até a próxima ordem ou o próximo `start`). */
  maxRetries: number;
  backoffMs?: (attempt: number) => number;
  /** Nome da sessão do Remote Control (ausente = sem Remote Control). Lido a cada subida. */
  remoteControlName?: () => string | undefined;
  spawn?: PtySpawnFn;
  /** Consulta da conversa em disco (ms). Padrão 300. */
  pollMs?: number;
  /** Sem sinal de prompt pronto, o terminal é dado como pronto depois disto. Padrão 8 s. */
  readyTimeoutMs?: number;
  /** Uma mensagem colada que não apareceu na conversa depois disto é colada de novo (uma vez). Padrão 45 s. */
  deliveryTimeoutMs?: number;
  /** Entre colar a mensagem e apertar Enter. Padrão 250 ms. */
  submitDelayMs?: number;
  /** Vivo por tanto tempo = as quedas anteriores não contam mais. Padrão 60 s. */
  stableMs?: number;
  stopGraceMs?: number;
  /** Quanto da saída recente fica guardado para quem abre o terminal depois (bytes). Padrão 256 KB. */
  replayBytes?: number;
  /**
   * Espera a CLI conectar no MCP do escritório antes da primeira mensagem de cada subida (ausente =
   * não espera). Enquanto isso o terminal fica "starting"; o que alguém digitar nele passa direto.
   */
  waitForTools?: ToolsGate;
  now?: () => Date;
};

type Message = { text: string; tag?: string; resent?: boolean; fresh?: string };
type Inflight = { message: Message; attempts: number; timer?: NodeJS.Timeout };
/** Turno em curso: o da nossa mensagem (`message`) ou de alguém no terminal. */
type Turn = { tag?: string; message?: Message };

const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
export const DEFAULT_PTY_SIZE = { cols: 120, rows: 36 } as const;

/** Tira as sequências de controle (cores, cursor) para procurar texto na tela. */
export function stripAnsi(text: string): string {
  return (
    text
      // O TUI separa palavras movendo o cursor (CSI n C) em vez de escrever espaços.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[(\d*)C/g, (_, n: string) => " ".repeat(Math.min(200, Number(n) || 1)))
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, "")
  );
}

/** Texto da tela sem nenhum espaço (para achar frases mesmo com o cursor pulando entre as palavras). */
const compact = (text: string) => text.replace(/\s+/g, "");

/** Texto de uma mensagem colada no terminal: sem ESC (nada de sequência escondida) e com quebras \n. */
export function pasteText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Mensagem colada (bracketed paste): a CLI recebe como colagem, não como teclas. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${pasteText(text)}\x1b[201~`;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** O prompt que apareceu na conversa é a nossa mensagem? (começo igual, ignorando espaços) */
export function promptMatches(prompt: string, message: string): boolean {
  const head = normalize(pasteText(message)).slice(0, 120);
  return head.length > 0 && normalize(prompt).startsWith(head);
}

/** Diálogo de confiança na pasta ("Yes, I trust this folder"), procurado sem espaços. */
const TRUST_PROMPT = /Yes,?Itrustthisfolder/i;
const TRUST_SCREEN = /trustthisfolder|Quicksafetycheck|Accessingworkspace/i;
/** A seleção do diálogo está no "Yes" (o "❯" logo antes dele). */
const TRUST_SELECTED = /❯(\d\.)?Yes,?Itrustthisfolder/i;
/** Teclas tentadas para descer a seleção: seta normal, seta no modo de cursor da aplicação, seta de novo. */
const TRUST_KEYS = ["\x1b[B", "\x1bOB", "\x1b[B"];
const READY_MARK = /❯/;
const REMOTE_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;

/**
 * Terminal interativo (TUI) de uma CLI num pseudo-terminal: o Maestro de Claude Code roda o
 * `claude` de verdade, que o usuário vê e usa pelo navegador (comandos `/`, Remote Control), e o
 * server conversa com ele como os outros terminais (TerminalAgent):
 *
 * - `send` coloca a mensagem na fila; quando o terminal está ocioso, ela é colada (bracketed paste)
 *   e enviada com Enter. Quem diz que o turno começou e acabou é a CONVERSA que a CLI grava em disco
 *   (`~/.claude/projects/<cwd>/<sessão>.jsonl`, lida por TranscriptTail + ClaudeTranscriptParser):
 *   o prompt que aparece lá e bate com a mensagem colada abre o turno com a `tag` dela; um prompt
 *   que não bate (alguém digitou no terminal ou no Remote Control) abre um turno sem tag, com o texto;
 *   `turn_duration` fecha o turno. Texto, ferramentas e resultados viram os TerminalEvents de sempre.
 * - Sessão: a mesma de session.json (`--session-id` na primeira vez, `--resume` depois de um turno
 *   completo), então reiniciar o server volta na mesma conversa. Um `/clear` (ou `/resume`) no
 *   terminal muda a conversa seguida, e o session.json acompanha. `freshSession` vira um `/clear`.
 * - Vida: com keepAlive, nunca para por ociosidade e sobe de novo se sair (com espera crescente, até
 *   `maxRetries` quedas seguidas); sem, para depois de `idleMs` ocioso e sobe sob demanda.
 * - Diálogo de confiança na pasta (a pasta é do próprio agente): respondido "sim" sozinho.
 */
export class PtyTerminal implements TerminalAgent {
  readonly agentId: string;
  readonly provider: AgentProvider;
  private status_: TerminalStatus = "stopped";
  private error_: string | undefined;
  private pty: PtyProcess | undefined;
  private disposers: { dispose(): void }[] = [];
  private tail: TranscriptTail | undefined;
  private parser = new ClaudeTranscriptParser();
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private disposed = false;
  /** Por que o processo está parando (vai no status "stopped"). */
  private stopReason: string | undefined;
  /** Processos que o próprio terminal mandou parar (a saída deles não é queda). */
  private readonly killed = new WeakSet<PtyProcess>();
  private readonly queue: Message[] = [];
  private inflight: Inflight | undefined;
  private turn: Turn | undefined;
  private session: SessionInfo | undefined;
  private sessionLoaded = false;
  private sessionWrites: Promise<void> = Promise.resolve();
  private failures = 0;
  private spawnedAt = 0;
  private sawPrompt = false;
  private resumed = false;
  private ready = false;
  /** Esperando a CLI desta subida conectar no MCP (initialize + tools/list): a fila não anda. */
  private toolsWait: ToolsWait | undefined;
  /** Diálogo de confiança na pasta: nada visto, movendo a seleção para "Yes" ou resolvido. */
  private trust: "none" | "moving" | "done" = "none";
  private trustTries = 0;
  private trustTimer: NodeJS.Timeout | undefined;
  private screen = "";
  private readyTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private clearing = false;
  private size: { cols: number; rows: number } = { ...DEFAULT_PTY_SIZE };
  private remote_: RemoteControlInfo | undefined;
  private remoteName: string | undefined;
  /** Nome novo da sessão do Remote Control esperando o terminal ficar livre (vai num `/rename`). */
  private pendingRename: string | undefined;
  private replay_: string[] = [];
  private replayLength = 0;
  private readonly listeners = new Set<TerminalListener>();
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private readonly sessionFile: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;

  constructor(private readonly options: PtyTerminalOptions) {
    this.agentId = options.spec.agentId;
    this.provider = options.adapter.provider;
    this.sessionFile = path.join(options.spec.cwd, "session.json");
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  // ---------- TerminalAgent ----------

  status(): TerminalStatus {
    return this.status_;
  }

  sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  async hasHistory(): Promise<boolean> {
    if (this.sessionLoaded) return this.session?.started === true;
    try {
      const data = JSON.parse(await readFile(this.sessionFile, "utf8")) as Partial<SessionInfo>;
      return data.provider === this.provider && data.started === true;
    } catch {
      return false;
    }
  }

  lastError(): string | undefined {
    return this.error_;
  }

  onEvent(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: string, tag?: string, options?: SendOptions): void {
    if (this.disposed) {
      this.emit({ type: "dropped", tag, reason: "Terminal encerrado" });
      return;
    }
    const fresh = options?.freshSession ? (options.sessionKey ?? tag ?? randomUUID()) : undefined;
    this.queue.push({ text: message, tag, ...(fresh ? { fresh } : {}) });
    this.clearIdle();
    if (this.pty) this.pump();
    else if (!this.retryTimer) void this.ensureRunning().catch(() => undefined);
  }

  cancel(tag: string): string[] {
    const removed: string[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.tag === tag) removed.unshift(this.queue.splice(i, 1)[0]!.text);
    return removed;
  }

  /** Esc no terminal: a CLI interrompe o turno em curso (o processo continua). */
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
    this.listeners.clear();
    this.outputListeners.clear();
    this.exitListeners.clear();
  }

  // ---------- Tela (navegador) ----------

  /** Remote Control desta sessão (undefined = desligado nesta subida). */
  remote(): RemoteControlInfo | undefined {
    return this.remote_ ? { ...this.remote_ } : undefined;
  }

  /**
   * O nome da sessão do Remote Control mudou (relido de `remoteControlName`). Com a CLI de pé, vai
   * um `/rename <nome>` quando o terminal estiver livre: o Claude Code renomeia a conversa ao vivo
   * (a sessão do Remote Control acompanha), sem reiniciar. Parado, a próxima subida já usa o nome novo.
   */
  renameRemote(): void {
    if (this.disposed || !this.remoteName) return;
    const name = this.options.remoteControlName?.();
    if (!name) return;
    if (!this.pty && !this.starting) {
      this.pendingRename = undefined;
      this.remoteName = name;
      if (this.remote_) this.setRemote({ ...this.remote_, name });
      return;
    }
    if (name === this.remoteName && !this.pendingRename) return;
    this.pendingRename = name === this.remoteName ? undefined : name;
    if (this.remote_) this.setRemote({ ...this.remote_ });
    this.pump();
  }

  /** Tamanho atual da tela do terminal. */
  dimensions(): { cols: number; rows: number } {
    return { ...this.size };
  }

  /** A saída recente (para desenhar a tela de quem conectou agora). */
  replay(): string {
    return this.replay_.join("");
  }

  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Teclas e coladas vindas do navegador (do jeito que o xterm manda). */
  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    try {
      this.pty?.resize(cols, rows);
    } catch {
      // Processo saindo: o próximo resize (ou a próxima subida) usa o tamanho guardado.
    }
  }

  /** Força a CLI a redesenhar a tela inteira (um "resize" de ida e volta): para quem acabou de conectar. */
  redraw(): void {
    const pty = this.pty;
    if (!pty) return;
    const { cols, rows } = this.size;
    try {
      pty.resize(Math.max(20, cols - 1), rows);
      setTimeout(() => {
        try {
          if (this.pty === pty) pty.resize(this.size.cols, this.size.rows);
        } catch {
          // saiu no meio
        }
      }, 60).unref();
    } catch {
      // saiu no meio
    }
  }

  /** A política mudou (manter sempre rodando ligado/desligado): sobe agora ou volta a contar a ociosidade. */
  refreshPolicy(): void {
    if (this.disposed) return;
    if (this.options.keepAlive()) {
      this.clearIdle();
      if (!this.pty && !this.retryTimer) void this.ensureRunning().catch(() => undefined);
    } else if (this.pty && this.status_ === "idle" && this.queue.length === 0 && !this.inflight) {
      this.armIdle();
    }
  }

  // ---------- Processo ----------

  private async start(): Promise<void> {
    this.setStatus("starting");
    let tools: ToolsWait | undefined;
    try {
      if (this.options.prepare) this.options.spec = await this.options.prepare();
      const spec = this.options.spec;
      await mkdir(spec.cwd, { recursive: true });
      const dir = claudeTranscriptDir(this.options.projectsDir, spec.cwd);
      if (!dir) throw new Error("A pasta do agente tem um caminho comprido demais para a CLI");
      let session = await this.loadSession();
      // Retoma só se a conversa ainda existe no disco (a retenção pode ter apagado).
      if (session.started && !(await exists(path.join(dir, `${session.sessionId}.jsonl`)))) {
        this.emitRaw("A conversa anterior do Maestro não está mais no disco: começando uma nova.");
        session = this.newSession();
      }
      if (this.needsFreshSession()) {
        session = this.newSession(this.queue[0]?.fresh);
      }
      this.remoteName = this.options.remoteControlName?.();
      // Subindo já com o nome novo: o `/rename` pendente não precisa mais.
      if (this.pendingRename === this.remoteName) this.pendingRename = undefined;
      const { command, args } = this.options.adapter.interactiveCommand(spec, { sessionId: session.sessionId, resume: session.started }, this.remoteName ? { remoteControl: this.remoteName } : {});
      const spawn = this.options.spawn ?? (await loadNodePty());
      this.resumed = session.started;
      this.sawPrompt = false;
      this.ready = false;
      this.trust = "none";
      this.trustTries = 0;
      this.screen = "";
      this.parser = new ClaudeTranscriptParser();
      this.spawnedAt = Date.now();
      this.replay_ = [];
      this.replayLength = 0;
      const env = { ...this.options.adapter.env(this.env, spec), TERM: "xterm-256color", COLORTERM: "truecolor" };
      // A conversa em disco: anota o que já existe antes da CLI subir (nada antigo vira evento novo).
      const holder: { pty?: PtyProcess } = {};
      const tail = new TranscriptTail({
        dir,
        sessionId: session.sessionId,
        fromEnd: session.started,
        pollMs: this.options.pollMs ?? 300,
        onLine: (line) => holder.pty && this.onTranscriptLine(holder.pty, line),
        onSession: (sessionId) => this.onSessionSwitch(sessionId),
      });
      await tail.prime();
      // Antes de subir: o `initialize` + `tools/list` desta subida é que libera a primeira mensagem.
      tools = this.options.waitForTools?.();
      const pty = spawn(command, args, { cwd: spec.cwd, env, cols: this.size.cols, rows: this.size.rows, name: "xterm-256color" });
      holder.pty = pty;
      this.pty = pty;
      trackTerminalSpawn(this, { agentId: spec.agentId, pid: pty.pid });
      this.tail = tail;
      if (tools) {
        const wait = tools;
        this.toolsWait = wait;
        void wait.done.then((outcome) => this.onTools(pty, wait, outcome));
      }
      this.disposers = [pty.onData((data) => this.onData(pty, data)), pty.onExit((event) => this.onPtyExit(pty, event.exitCode))];
      this.tail.start();
      this.emit({ type: "session", sessionId: session.sessionId });
      if (this.remoteName) this.setRemote({ active: false, name: this.remoteName });
      this.readyTimer = setTimeout(() => this.onReadyTimeout(pty), this.options.readyTimeoutMs ?? 8000);
      this.readyTimer.unref();
      if (this.disposed) {
        await this.kill(pty);
        return;
      }
      this.error_ = undefined;
    } catch (error) {
      tools?.cancel();
      this.toolsWait = undefined;
      this.pty = undefined;
      this.error_ = `Não foi possível iniciar o terminal: ${errorMessage(error)}`;
      this.emitRaw(this.error_);
      trackTerminalFailure(this, "start_failed", { error: errorMessage(error) }, this.options.spec.agentId);
      this.failures += 1;
      this.afterFailure();
      throw error;
    }
  }

  private onData(pty: PtyProcess, data: string): void {
    if (pty !== this.pty) return;
    this.remember(data);
    for (const listener of [...this.outputListeners]) {
      try {
        listener(data);
      } catch {
        // um ouvinte com erro não derruba o terminal
      }
    }
    this.screen = (this.screen + stripAnsi(data)).slice(-4000);
    const flat = compact(this.screen);
    if (this.trust === "none" && TRUST_PROMPT.test(flat)) {
      // A pasta é do próprio agente: escolhe "Yes, I trust this folder" (a segunda opção). O Enter só
      // vai quando a tela mostra a seleção no "Yes" (Enter no "No, exit" fecharia a CLI).
      this.trust = "moving";
      this.trustStep(pty, 500);
      return;
    }
    if (this.trust === "moving") {
      if (TRUST_SELECTED.test(flat)) this.confirmTrust(pty);
      return;
    }
    // Pronto: o "❯" da caixa de texto, fora de qualquer diálogo de confiança (que também tem um "❯").
    if (!this.ready && READY_MARK.test(this.screen) && !TRUST_SCREEN.test(flat)) this.markReady(pty);
    const url = REMOTE_URL.exec(flat)?.[0];
    if (url && this.remoteName && (this.remote_?.url !== url || !this.remote_.active)) this.setRemote({ active: true, name: this.remoteName, url });
  }

  /** Move a seleção do diálogo de confiança (seta para baixo; no modo de cursor da aplicação, a outra sequência). */
  private trustStep(pty: PtyProcess, delayMs: number): void {
    if (this.trustTimer) clearTimeout(this.trustTimer);
    this.trustTimer = setTimeout(() => {
      this.trustTimer = undefined;
      if (pty !== this.pty || this.trust !== "moving") return;
      if (TRUST_SELECTED.test(compact(this.screen))) {
        this.confirmTrust(pty);
        return;
      }
      if (this.trustTries >= TRUST_KEYS.length) {
        this.trust = "done";
        this.emitRaw("Não deu para responder sozinho o diálogo de confiança da pasta: escolha “Yes, I trust this folder” no terminal do painel.");
        return;
      }
      this.screen = "";
      pty.write(TRUST_KEYS[this.trustTries++]!);
      this.trustStep(pty, 800);
    }, delayMs);
    this.trustTimer.unref();
  }

  private confirmTrust(pty: PtyProcess): void {
    if (this.trustTimer) clearTimeout(this.trustTimer);
    this.trustTimer = undefined;
    this.trust = "done";
    this.screen = "";
    pty.write("\r");
    this.emitRaw("Pasta do agente marcada como confiável no Claude Code (diálogo de confiança respondido).");
  }

  /** Sem sinal de pronto a tempo: dá como pronto, menos se a tela ainda é o diálogo de confiança. */
  private onReadyTimeout(pty: PtyProcess): void {
    if (pty !== this.pty || this.ready) return;
    if (TRUST_SCREEN.test(compact(this.screen))) {
      this.emitRaw("O terminal do Maestro está esperando uma resposta no diálogo de confiança da pasta (responda no painel).");
      this.readyTimer = setTimeout(() => this.onReadyTimeout(pty), this.options.readyTimeoutMs ?? 8000);
      this.readyTimer.unref();
      return;
    }
    this.markReady(pty);
  }

  private markReady(pty: PtyProcess): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    if (pty !== this.pty || this.ready) return;
    this.ready = true;
    if (this.status_ === "starting" && !this.toolsWait) this.setStatus(this.turn ? "busy" : "idle");
    this.pump();
  }

  /** A CLI desta subida conectou no MCP (ou o tempo acabou): a fila anda. */
  private onTools(pty: PtyProcess, wait: ToolsWait, outcome: ToolsWaitOutcome): void {
    if (pty !== this.pty || this.toolsWait !== wait) return;
    this.toolsWait = undefined;
    if (outcome === "timeout") this.emitRaw("A CLI não conectou no MCP do escritório a tempo: a mensagem vai assim mesmo (as ferramentas do escritório podem faltar neste turno).");
    if (!this.ready) return;
    if (this.status_ === "starting") this.setStatus(this.turn ? "busy" : "idle");
    this.pump();
  }

  private remember(data: string): void {
    const max = this.options.replayBytes ?? 256 * 1024;
    this.replay_.push(data);
    this.replayLength += data.length;
    while (this.replayLength > max && this.replay_.length > 1) this.replayLength -= this.replay_.shift()!.length;
  }

  private onTranscriptLine(pty: PtyProcess, line: string): void {
    if (pty !== this.pty) return;
    for (const event of this.parser.parse(line)) {
      if (event.type === "prompt") this.onPrompt(event.text);
      else if (event.type === "turn_end") this.onTurnEnd(event);
      else if (event.type === "remote") this.setRemote({ ...event.remote, ...(this.remoteName ? { name: this.remoteName } : {}) });
      else this.emit(event);
    }
  }

  private onPrompt(text: string): void {
    this.sawPrompt = true;
    // Um turno anterior sem fim registrado (ex.: a CLI caiu no meio): fecha antes de abrir outro.
    if (this.turn) this.onTurnEnd({ type: "turn_end", ok: false, result: "Turno interrompido" });
    const inflight = this.inflight;
    if (inflight && promptMatches(text, inflight.message.text)) {
      if (inflight.timer) clearTimeout(inflight.timer);
      this.inflight = undefined;
      const { message } = inflight;
      if (message.fresh && this.session && this.session.key !== message.fresh) this.saveSession({ key: message.fresh });
      this.turn = { tag: message.tag, message };
      this.setStatus("busy");
      this.emit({ type: "turn_start", tag: message.tag });
      return;
    }
    this.turn = {};
    this.clearIdle();
    this.setStatus("busy");
    this.emit({ type: "turn_start", prompt: text });
  }

  private onTurnEnd(event: Extract<TerminalEvent, { type: "turn_end" }>): void {
    const turn = this.turn;
    this.turn = undefined;
    this.failures = 0;
    if (!this.session?.started) this.saveSession({ started: true });
    this.emit({ ...event, tag: turn?.tag });
    if (this.pty && this.status_ !== "starting") {
      this.setStatus("idle");
      this.pump();
    }
  }

  /** A CLI passou a escrever em outra conversa (`/clear`, `/resume`): o session.json acompanha. */
  private onSessionSwitch(sessionId: string): void {
    this.saveSession({ sessionId, started: true });
    this.emit({ type: "session", sessionId });
  }

  private pump(): void {
    const pty = this.pty;
    if (!pty || !this.ready || this.toolsWait || this.turn || this.inflight || this.clearing || this.stopping) return;
    if (this.status_ !== "idle") return;
    if (this.needsFreshSession()) {
      // Conversa nova sem matar o processo (o Remote Control continua): `/clear` e espera a CLI.
      this.clearing = true;
      this.saveSession({ started: false, key: this.queue[0]?.fresh });
      this.emitRaw("Conversa nova (/clear): a anterior fica salva, mas não é mais enviada.");
      pty.write("/clear\r");
      setTimeout(() => {
        this.clearing = false;
        this.pump();
      }, 1500).unref();
      return;
    }
    if (this.pendingRename) {
      this.applyRename(pty, this.pendingRename);
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.armIdle();
      return;
    }
    this.deliver({ message: next, attempts: 0 });
  }

  /**
   * `/rename <nome>` no terminal livre (comando local do Claude Code: não gasta turno nem entra na
   * conversa como prompt). As mensagens da fila esperam um instante, como no `/clear`.
   */
  private applyRename(pty: PtyProcess, name: string): void {
    this.pendingRename = undefined;
    this.clearing = true;
    this.remoteName = name;
    // Uma quebra de linha no nome enviaria o comando no meio: caracteres de controle viram espaço.
    // eslint-disable-next-line no-control-regex
    pty.write(`/rename ${name.replace(/[\u0000-\u001f\u007f]/g, " ")}`);
    setTimeout(() => {
      if (this.pty === pty) pty.write("\r");
    }, this.options.submitDelayMs ?? 250).unref();
    setTimeout(() => {
      this.clearing = false;
      this.pump();
    }, 1500).unref();
    if (this.remote_) this.setRemote({ ...this.remote_, name });
    this.emitRaw(`Sessão do Remote Control renomeada para “${name}” (/rename).`);
  }

  /** Cola a mensagem e aperta Enter; se ela não aparecer na conversa a tempo, tenta mais uma vez. */
  private deliver(inflight: Inflight): void {
    const pty = this.pty;
    if (!pty) return;
    inflight.attempts += 1;
    this.inflight = inflight;
    this.setStatus("busy");
    pty.write(bracketedPaste(inflight.message.text));
    setTimeout(() => {
      if (this.pty === pty && this.inflight === inflight) pty.write("\r");
    }, this.options.submitDelayMs ?? 250).unref();
    inflight.timer = setTimeout(() => this.onDeliveryTimeout(inflight), this.options.deliveryTimeoutMs ?? 45_000);
    inflight.timer.unref();
  }

  private onDeliveryTimeout(inflight: Inflight): void {
    if (this.inflight !== inflight) return;
    if (this.turn) {
      // Alguém está usando o terminal: espera o turno dele acabar.
      inflight.timer = setTimeout(() => this.onDeliveryTimeout(inflight), this.options.deliveryTimeoutMs ?? 45_000);
      inflight.timer.unref();
      return;
    }
    this.inflight = undefined;
    if (inflight.attempts < 2 && this.pty) {
      this.emitRaw("A mensagem não apareceu na conversa do terminal: colando de novo.");
      this.pty.write("\x15"); // Ctrl+U: limpa o que sobrou na caixa de texto
      this.deliver(inflight);
      return;
    }
    this.emit({ type: "dropped", tag: inflight.message.tag, reason: "O terminal do Maestro não recebeu a mensagem (está num diálogo ou ocupado?)" });
    this.setStatus("idle");
    this.pump();
  }

  private onPtyExit(pty: PtyProcess, code: number | null): void {
    if (pty !== this.pty) return;
    trackTerminalExit(this, { agentId: this.options.spec.agentId, code, expected: Boolean(this.stopping || this.disposed || this.killed.has(pty)), reason: this.stopReason });
    this.pty = undefined;
    for (const disposer of this.disposers) disposer.dispose();
    this.disposers = [];
    this.tail?.stop();
    this.tail = undefined;
    this.clearIdle();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.toolsWait?.cancel();
    this.toolsWait = undefined;
    this.clearing = false;
    for (const listener of [...this.exitListeners]) listener(code);
    if (this.remote_) this.setRemote({ ...this.remote_, active: false });
    this.requeueInterrupted();
    if (this.stopping || this.disposed || this.killed.has(pty)) {
      this.setStatus("stopped");
      if (!this.disposed && this.queue.length > 0) queueMicrotask(() => void this.ensureRunning().catch(() => undefined));
      return;
    }
    const lived = Date.now() - this.spawnedAt;
    if (this.resumed && !this.sawPrompt && lived < 15_000) {
      // Saiu logo ao retomar: a conversa salva pode não abrir mais. A próxima subida começa outra.
      this.session = undefined;
      this.sessionLoaded = true;
      this.emitRaw("A conversa anterior não abriu: a próxima subida começa uma nova.");
    }
    this.error_ = `O terminal do Maestro saiu (código ${code ?? "?"})`;
    this.emitRaw(this.error_);
    if (lived >= (this.options.stableMs ?? 60_000)) this.failures = 0;
    this.failures += 1;
    this.afterFailure();
  }

  /** A mensagem colada (ou o turno nosso em curso) volta para a frente da fila; um turno de fora termina com erro. */
  private requeueInterrupted(): void {
    const pending: Message[] = [];
    if (this.turn) {
      const { message } = this.turn;
      if (message) pending.push(message);
      else this.emit({ type: "turn_end", ok: false, result: "O terminal caiu no meio do turno" });
      this.turn = undefined;
    }
    if (this.inflight) {
      if (this.inflight.timer) clearTimeout(this.inflight.timer);
      pending.push(this.inflight.message);
      this.inflight = undefined;
    }
    for (const message of pending.reverse()) {
      this.queue.unshift({ ...message, resent: true, text: message.resent ? message.text : `(Mensagem reenviada: o terminal caiu e voltou.)\n\n${message.text}` });
    }
  }

  private afterFailure(): void {
    this.setStatus("error");
    if (this.disposed) return;
    const wanted = this.options.keepAlive() || this.queue.length > 0;
    if (!wanted) return;
    if (this.failures > this.options.maxRetries) {
      trackTerminalFailure(this, "gave_up", { failures: this.failures, error: this.error_ }, this.options.spec.agentId);
      this.dropAll(`O terminal caiu ${this.failures} vezes seguidas: ${this.error_ ?? "erro desconhecido"}`);
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
    const within = (ms: number) => Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
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
    // Se nem o SIGKILL deu sinal (processo falso nos testes), o terminal desiste dele assim mesmo.
    if (this.pty === pty) this.onPtyExit(pty, null);
  }

  private dropAll(reason: string): void {
    const dropped = [...(this.inflight ? [this.inflight.message] : []), ...this.queue.splice(0)];
    if (this.inflight?.timer) clearTimeout(this.inflight.timer);
    this.inflight = undefined;
    for (const message of dropped) this.emit({ type: "dropped", tag: message.tag, reason });
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.options.keepAlive() || this.options.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.status_ === "idle" && this.queue.length === 0 && !this.inflight && !this.turn && !this.options.keepAlive()) void this.stop("Parado por ociosidade");
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private setRemote(remote: RemoteControlInfo): void {
    const next: RemoteControlInfo = { ...remote };
    if (this.pendingRename) next.pendingName = this.pendingRename;
    else delete next.pendingName;
    const current = this.remote_;
    if (current && current.active === next.active && current.url === next.url && current.name === next.name && current.pendingName === next.pendingName) return;
    this.remote_ = next;
    this.emit({ type: "remote", remote: { ...this.remote_ } });
  }

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

  // ---------- Sessão ----------

  private async loadSession(): Promise<SessionInfo> {
    if (!this.sessionLoaded) {
      this.sessionLoaded = true;
      try {
        const data = JSON.parse(await readFile(this.sessionFile, "utf8")) as Partial<SessionInfo>;
        if (data.provider === this.provider && typeof data.sessionId === "string" && data.sessionId) {
          this.session = {
            provider: this.provider,
            sessionId: data.sessionId,
            started: data.started === true,
            updatedAt: String(data.updatedAt ?? ""),
            ...(typeof data.key === "string" && data.key ? { key: data.key } : {}),
          };
        }
      } catch {
        // Sem arquivo (ou quebrado): sessão nova.
      }
    }
    if (!this.session || !this.session.started) return this.newSession(this.session?.key);
    return this.session;
  }

  private newSession(key?: string): SessionInfo {
    this.saveSession({ sessionId: this.options.adapter.newSessionId(), started: false, key });
    return this.session!;
  }

  private needsFreshSession(): boolean {
    const fresh = this.queue[0]?.fresh;
    return fresh !== undefined && this.session?.started === true && this.session.key !== fresh;
  }

  private saveSession(change: Partial<Pick<SessionInfo, "sessionId" | "started" | "key">>): void {
    const current = this.session;
    const sessionId = change.sessionId ?? current?.sessionId ?? this.options.adapter.newSessionId();
    const sameId = sessionId === current?.sessionId;
    const started = change.started ?? (sameId ? (current?.started ?? false) : false);
    const key = "key" in change ? change.key : current?.key;
    if (current && sameId && started === current.started && key === current.key) return;
    this.session = { provider: this.provider, sessionId, started, updatedAt: this.now().toISOString(), ...(key ? { key } : {}) };
    const snapshot = { ...this.session };
    this.sessionWrites = this.sessionWrites.then(() => writeJsonAtomic(this.sessionFile, snapshot)).catch(() => undefined);
  }

  /** Espera as gravações de session.json (testes e shutdown). */
  flushSession(): Promise<void> {
    return this.sessionWrites;
  }

  /** Lê a conversa em disco agora (testes). */
  async pollTranscript(): Promise<void> {
    await this.tail?.poll();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** node-pty só é carregado quando um terminal interativo sobe (binário nativo pré-compilado). */
async function loadNodePty(): Promise<PtySpawnFn> {
  const pty = await import("@lydell/node-pty");
  return (file, args, options) => pty.spawn(file, args, options);
}
