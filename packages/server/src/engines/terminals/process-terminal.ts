import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentProvider, TerminalStatus } from "@cyno/shared";
import type { ToolsWait, ToolsWaitOutcome } from "../../mcp/tokens";
import { trackTerminalExit, trackTerminalFailure, trackTerminalSpawn } from "../../platform/activity/hooks";
import { writeJsonAtomic } from "../../store/atomic-write";
import { errorMessage } from "../../util/text";
import type { CliAdapter, CliEventParser, SendOptions, SessionInfo, TerminalAgent, TerminalEvent, TerminalListener, TerminalSpec, ToolsGate } from "./types";

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export type ProcessTerminalOptions = {
  adapter: CliAdapter;
  spec: TerminalSpec;
  /**
   * Chamado antes de cada subida: grava a pasta do agente (CLAUDE.md, mcp.json) e devolve a
   * especificação atualizada (instruções e modelo novos valem na próxima subida).
   */
  prepare?: () => Promise<TerminalSpec>;
  /** Ambiente base (o adaptador tira as chaves de API). Padrão: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Ocioso por tanto tempo (sem fila) = para o processo; a próxima ordem retoma a sessão. */
  idleMs: number;
  /** Quedas seguidas antes de desistir (status "error" até a próxima ordem). */
  maxRetries: number;
  /** Espera antes de subir de novo depois da queda n (1, 2, …). Padrão: 1 s, 2 s, 4 s… até 30 s. */
  backoffMs?: (attempt: number) => number;
  /** Quanto esperar o processo sair depois de fechar a entrada (e depois do SIGTERM). */
  stopGraceMs?: number;
  spawn?: SpawnFn;
  /** Espera a CLI conectar no MCP do escritório antes da primeira mensagem de cada subida (ausente = não espera; status "starting" enquanto isso). */
  waitForTools?: ToolsGate;
  now?: () => Date;
};

/**
 * `fresh`: a mensagem abre uma conversa nova com a chave `fresh` (veja SendOptions). `adopted`: turno
 * que a CLI começou sozinha com uma nota injetada que ficou para depois (não há texto para reenviar).
 */
type Message = { text: string; tag?: string; resent?: boolean; fresh?: string; adopted?: boolean };

const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
/** Eventos que mostram que a CLI está num turno (os que adotam o turno de uma nota que ficou para depois). */
const ADOPTING_EVENTS = new Set<TerminalEvent["type"]>(["text", "tool_use", "subagent_start", "turn_end"]);
/** Linhas finais da saída de erro guardadas para explicar uma queda. */
const STDERR_TAIL = 20;

/**
 * Terminal de um agente: um processo de CLI de vida longa (ProcessTerminal + o CliAdapter do
 * provedor). Mensagens entram numa fila e vão uma por turno quando o processo está ocioso.
 *
 * Sessão: agents/<id>/session.json guarda o id. A primeira subida usa um id novo (`--session-id`);
 * depois do primeiro turno completo, toda subida retoma (`--resume`), então parar por ociosidade,
 * cair ou reiniciar o server continua a mesma conversa. Se a CLI disser que a sessão não existe,
 * começa outra. Uma mensagem com `freshSession` começa uma conversa nova: se a sessão atual já tem
 * histórico, o processo para (com calma, entre turnos) e sobe com um id novo antes de mandá-la
 * (é assim que cada tarefa de um agente de time começa do zero, sem reenviar as tarefas antigas).
 *
 * Quedas: a mensagem em curso volta para a frente da fila e o processo sobe de novo com espera
 * crescente, até `maxRetries` quedas seguidas (aí: status "error" e as mensagens são descartadas
 * com `dropped`). Uma queda sem trabalho pendente só marca "error"; a próxima ordem sobe de novo.
 */
export class ProcessTerminal implements TerminalAgent {
  readonly agentId: string;
  readonly provider: AgentProvider;
  private status_: TerminalStatus = "stopped";
  private error_: string | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private parser: CliEventParser | undefined;
  private starting: Promise<void> | undefined;
  private readonly queue: Message[] = [];
  private inflight: Message | undefined;
  private session: SessionInfo | undefined;
  private sessionLoaded = false;
  private failures = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  /** O processo atual está sendo parado de propósito (não conta como queda). */
  private stopping: Promise<void> | undefined;
  private disposed = false;
  private stderrTail: string[] = [];
  private sawEvent = false;
  private resumed = false;
  /** Por que o processo está parando (vai no status "stopped"). */
  private stopReason: string | undefined;
  /**
   * Mensagens escritas na CLI neste turno e ainda não consumidas, na ordem: a que abriu o turno e as
   * notas injetadas no meio dele. O `queued_turn_count` de cada `result` diz quantas ainda faltam.
   */
  private written: { injected: boolean }[] = [];
  /** Tag do turno em que houve nota injetada (para adotar o turno que a CLI abrir sozinha com ela). */
  private injectedTag: string | undefined;
  /** A CLI fechou um turno sem dizer `queued_turn_count`: nada de notas ao vivo neste terminal. */
  private liveUnsupported = false;
  /** Esperando a CLI desta subida conectar no MCP (initialize + tools/list): a fila não anda. */
  private toolsWait: ToolsWait | undefined;
  private readonly listeners = new Set<TerminalListener>();
  private readonly sessionFile: string;
  private sessionWrites: Promise<void> = Promise.resolve();
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => Date;

  constructor(private readonly options: ProcessTerminalOptions) {
    this.agentId = options.spec.agentId;
    this.provider = options.adapter.provider;
    this.sessionFile = path.join(options.spec.cwd, "session.json");
    this.env = options.env ?? process.env;
    this.spawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, { ...spawnOptions, stdio: "pipe" }));
    this.now = options.now ?? (() => new Date());
  }

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

  currentSessionKey(): string | undefined {
    return this.session?.started ? this.session.key : undefined;
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
    if (this.child && this.status_ === "idle") this.pump();
    else if (!this.child && !this.retryTimer) void this.ensureRunning().catch(() => undefined);
  }

  inject(message: string): boolean {
    if (!this.child || this.status_ !== "busy" || !this.inflight || this.stopping || this.disposed) return false;
    if (!this.options.adapter.liveInput || this.liveUnsupported) return false;
    this.written.push({ injected: true });
    this.injectedTag = this.inflight.tag;
    this.write(this.options.adapter.encodeMessage(message, this.session?.sessionId ?? ""));
    return true;
  }

  cancel(tag: string): string[] {
    const removed: string[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.tag === tag) removed.unshift(this.queue.splice(i, 1)[0]!.text);
    return removed;
  }

  interrupt(): void {
    if (!this.child || this.status_ !== "busy") return;
    const line = this.options.adapter.encodeInterrupt?.(randomUUID());
    if (line) this.write(line);
    else void this.stop("Interrompido");
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error("Terminal encerrado");
    if (this.stopping) await this.stopping;
    if (this.child) return;
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
    this.cutTurn(reason);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.dropAll(reason);
    if (this.starting) await this.starting.catch(() => undefined);
    const child = this.child;
    if (!child) {
      if (this.status_ !== "stopped") this.setStatus("stopped");
      return;
    }
    if (this.stopping) return this.stopping;
    this.stopping = this.kill(child).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /** Para de vez (agente removido ou server desligando): nada mais sobe. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop("Terminal encerrado");
    // O session.json do primeiro turno ainda pode estar sendo gravado: sem esperar, um desligamento logo depois faria o agente voltar numa conversa nova.
    await this.sessionWrites;
    this.listeners.clear();
  }

  // ---------- Processo ----------

  private async start(): Promise<void> {
    this.stopReason = undefined;
    this.setStatus("starting");
    let tools: ToolsWait | undefined;
    try {
      if (this.options.prepare) this.options.spec = await this.options.prepare();
      await mkdir(this.options.spec.cwd, { recursive: true });
      let session = await this.loadSession();
      // A próxima mensagem abre uma conversa nova: não retoma a antiga.
      if (this.needsFreshSession()) {
        session = this.resetSession();
      }
      const { adapter, spec } = this.options;
      const { command, args } = adapter.command(spec, { sessionId: session.sessionId, resume: session.started });
      this.resumed = session.started;
      this.sawEvent = false;
      this.stderrTail = [];
      this.parser = adapter.createParser(spec);
      // Antes de subir: o `initialize` + `tools/list` desta subida é que libera a primeira mensagem.
      tools = this.options.waitForTools?.();
      const child = this.spawnFn(command, args, { cwd: spec.cwd, env: adapter.env(this.env, spec) });
      this.child = child;
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      trackTerminalSpawn(this, { agentId: spec.agentId, pid: child.pid });
      child.on("error", (error) => this.emit({ type: "raw", stream: "stderr", text: `erro do processo: ${errorMessage(error)}` }));
      child.stdin.on("error", () => undefined);
      createInterface({ input: child.stdout }).on("line", (line) => this.onStdout(child, line));
      createInterface({ input: child.stderr }).on("line", (line) => this.onStderr(line));
      child.once("exit", (code, signal) => this.onExit(child, code, signal));
      if (this.disposed) {
        tools?.cancel();
        await this.kill(child);
        return;
      }
      this.error_ = undefined;
      if (tools) {
        const wait = tools;
        this.toolsWait = wait;
        void wait.done.then((outcome) => this.onTools(child, wait, outcome));
        return;
      }
      this.setStatus("idle");
      this.pump();
    } catch (error) {
      tools?.cancel();
      this.toolsWait = undefined;
      this.child = undefined;
      this.error_ = `Não foi possível iniciar a CLI: ${errorMessage(error)}`;
      this.emit({ type: "raw", stream: "stderr", text: this.error_ });
      trackTerminalFailure(this, "start_failed", { error: errorMessage(error) }, this.options.spec.agentId);
      this.failures += 1;
      this.afterFailure();
      throw error;
    }
  }

  /** A CLI desta subida conectou no MCP (ou o tempo acabou): fica ociosa e a fila anda. */
  private onTools(child: ChildProcessWithoutNullStreams, wait: ToolsWait, outcome: ToolsWaitOutcome): void {
    if (child !== this.child || this.toolsWait !== wait) return;
    this.toolsWait = undefined;
    if (outcome === "timeout") this.emit({ type: "raw", stream: "stderr", text: "A CLI não conectou no MCP do escritório a tempo: a mensagem vai assim mesmo (as ferramentas do escritório podem faltar neste turno)." });
    if (this.status_ === "starting") this.setStatus("idle");
    this.pump();
  }

  private pump(): void {
    if (!this.child || this.status_ !== "idle" || this.toolsWait || this.inflight || this.stopping) return;
    if (this.needsFreshSession()) {
      // Conversa nova com o processo vivo e com histórico: para entre turnos e sobe com um id novo.
      this.resetSession();
      this.stopReason = "Sessão nova";
      this.emit({ type: "raw", stream: "stderr", text: "Sessão nova (a conversa anterior fica salva, mas não é mais enviada)." });
      const child = this.child;
      this.stopping = this.kill(child).finally(() => {
        this.stopping = undefined;
      });
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.armIdle();
      return;
    }
    // Conversa nova sem histórico ainda (ex.: a primeira): fica marcada com a chave de quem a abriu.
    if (next.fresh && this.session && this.session.key !== next.fresh) this.saveSession({ key: next.fresh });
    this.inflight = next;
    this.written = [{ injected: false }];
    this.injectedTag = undefined;
    this.setStatus("busy");
    this.emit({ type: "turn_start", tag: next.tag });
    this.write(this.options.adapter.encodeMessage(next.text, this.session?.sessionId ?? ""));
  }

  private write(line: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${line}\n`);
  }

  private onStdout(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child || !this.parser) return;
    for (const event of this.parser.parse(line)) {
      if (event.type !== "raw") this.sawEvent = true;
      // A CLI abriu sozinha um turno com a nota injetada que ficou para depois do turno anterior: é da mesma tag.
      if (!this.inflight && this.injectedTag !== undefined && this.status_ === "idle" && ADOPTING_EVENTS.has(event.type)) {
        this.inflight = { text: "", tag: this.injectedTag, adopted: true };
        this.written = [{ injected: true }];
        this.injectedTag = undefined;
        this.clearIdle();
        this.setStatus("busy");
        this.emit({ type: "turn_start", tag: this.inflight.tag });
      }
      if (event.type === "session") {
        this.saveSession({ sessionId: event.sessionId });
        this.emit(event);
        if (event.apiKeySource && /ANTHROPIC_API_KEY|apiKeyHelper/i.test(event.apiKeySource)) {
          // Nunca cobrar uma API: se a CLI achou uma chave de API, o terminal para na hora.
          this.error_ = `A CLI ia usar uma chave de API (${event.apiKeySource}); terminal parado (só assinatura).`;
          this.emit({ type: "raw", stream: "stderr", text: this.error_ });
          void this.stop(this.error_).then(() => this.setStatus("error"));
          return;
        }
        continue;
      }
      if (event.type === "turn_end") {
        if (event.queuedTurns === undefined) this.liveUnsupported = true;
        else if (this.inflight) {
          // Sobram na fila da CLI só as `queuedTurns` últimas mensagens: se alguma é nota deste turno, ele continua.
          this.written = event.queuedTurns > 0 ? this.written.slice(-event.queuedTurns) : [];
          if (this.written.length > 0) {
            this.emit({ type: "turn_partial", ...(event.usage ? { usage: event.usage } : {}) });
            continue;
          }
        }
        this.written = [];
        const tag = this.inflight?.tag;
        this.inflight = undefined;
        this.failures = 0;
        if (!this.session?.started) this.saveSession({ started: true });
        this.emit({ ...event, tag });
        if (this.child === child && !this.stopping) {
          this.setStatus("idle");
          this.pump();
        }
        continue;
      }
      this.emit(event);
    }
  }

  private onStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
    this.emit({ type: "raw", stream: "stderr", text: line });
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    const expected = Boolean(this.stopping || this.disposed);
    trackTerminalExit(this, { agentId: this.options.spec.agentId, code, signal, expected, reason: this.stopReason, ...(expected ? {} : { error: this.stderrTail.at(-1) }) });
    this.child = undefined;
    const parser = this.parser;
    this.parser = undefined;
    this.clearIdle();
    this.toolsWait?.cancel();
    this.toolsWait = undefined;
    if (this.stopping || this.disposed) {
      this.setStatus("stopped");
      // Ordens que chegaram enquanto ele parava: sobe de novo (retomando a sessão).
      if (!this.disposed && this.queue.length > 0) queueMicrotask(() => void this.ensureRunning().catch(() => undefined));
      return;
    }
    // Saiu sozinho: queda (ou a sessão a retomar não existe mais).
    const stderr = this.stderrTail.join("\n");
    if (this.resumed && !this.sawEvent && (this.options.adapter.isMissingSession?.(stderr) || code !== 0)) {
      this.session = undefined;
      this.sessionLoaded = true;
      this.emit({ type: "raw", stream: "stderr", text: "Sessão anterior não encontrada: começando uma conversa nova." });
    }
    this.error_ = `A CLI saiu (código ${code ?? "?"}${signal ? `, sinal ${signal}` : ""})${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`;
    this.cutTurn(this.error_, parser);
    if (this.inflight) {
      const { text, tag, resent, adopted } = this.inflight;
      if (!adopted) this.queue.unshift({ tag, resent: true, text: resent ? text : `(Mensagem reenviada: o terminal caiu e voltou.)\n\n${text}` });
      this.inflight = undefined;
    }
    this.written = [];
    this.injectedTag = undefined;
    this.failures += 1;
    this.afterFailure();
  }

  /** Depois de uma queda (ou falha ao subir): tenta de novo com espera, ou desiste. */
  private afterFailure(): void {
    this.setStatus("error");
    if (this.disposed || this.queue.length === 0) return;
    if (this.failures > this.options.maxRetries) {
      trackTerminalFailure(this, "gave_up", { failures: this.failures, error: this.error_ }, this.options.spec.agentId);
      this.dropAll(`O terminal caiu ${this.failures} vezes seguidas: ${this.error_ ?? "erro desconhecido"}`);
      this.failures = 0;
      return;
    }
    const wait = (this.options.backoffMs ?? defaultBackoff)(this.failures);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.disposed && !this.child) void this.ensureRunning().catch(() => undefined);
    }, wait);
    this.retryTimer.unref();
  }

  private async kill(child: ChildProcessWithoutNullStreams): Promise<void> {
    const grace = this.options.stopGraceMs ?? 3000;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    child.stdin.end();
    if (await within(grace)) return;
    child.kill("SIGTERM");
    if (await within(grace)) return;
    child.kill("SIGKILL");
    await exited;
  }

  /**
   * O turno em curso vai ser cortado (parada, queda): o que a CLI já tinha informado de uso vira o
   * evento `turn_cut`, para o gasto parcial entrar no histórico. Pede e zera a conta do parser, então
   * um segundo corte do mesmo turno não conta de novo.
   */
  private cutTurn(reason: string, parser: CliEventParser | undefined = this.parser): void {
    const inflight = this.inflight;
    if (!inflight) return;
    const usage = parser?.takePartialUsage?.();
    if (usage) this.emit({ type: "turn_cut", tag: inflight.tag, usage, reason });
  }

  private dropAll(reason: string): void {
    const dropped = [...(this.inflight ? [this.inflight] : []), ...this.queue.splice(0)];
    this.inflight = undefined;
    for (const message of dropped) this.emit({ type: "dropped", tag: message.tag, reason });
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.options.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.status_ === "idle" && this.queue.length === 0 && !this.inflight) void this.stop("Parado por ociosidade");
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private setStatus(status: TerminalStatus): void {
    if (this.status_ === status) return;
    this.status_ = status;
    const reason = status === "stopped" ? this.stopReason : undefined;
    this.emit({ type: "status", status, ...(status === "error" && this.error_ ? { error: this.error_ } : {}), ...(reason ? { reason } : {}) });
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
    if (!this.session || !this.session.started) {
      // Nunca completou um turno: id novo a cada subida (o antigo pode ter ficado pela metade).
      this.saveSession({ sessionId: this.options.adapter.newSessionId(), started: false });
    }
    return this.session!;
  }

  /**
   * A mensagem da frente da fila pede conversa nova e a sessão atual já tem histórico de OUTRA
   * conversa? (A mesma chave voltando, ex.: a tarefa rodando de novo depois de um reinício do
   * server, continua a conversa dela.)
   */
  private needsFreshSession(): boolean {
    const fresh = this.queue[0]?.fresh;
    return fresh !== undefined && this.session?.started === true && this.session.key !== fresh;
  }

  /** Troca a sessão por uma nova (id novo, ainda sem turno) com a chave da mensagem que a abre. A antiga continua no disco da CLI. */
  private resetSession(): SessionInfo {
    this.saveSession({ sessionId: this.options.adapter.newSessionId(), started: false, key: this.queue[0]?.fresh });
    return this.session!;
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
    this.sessionWrites = this.sessionWrites
      .then(() => writeJsonAtomic(this.sessionFile, snapshot))
      .catch(() => undefined);
  }

  /** Espera as gravações de session.json (testes e shutdown). */
  flushSession(): Promise<void> {
    return this.sessionWrites;
  }
}
