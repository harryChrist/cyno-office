import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { maskSecrets, type AgentProvider, type TerminalStatus } from "@cyno/shared";
import { trackTerminalExit, trackTerminalFailure, trackTerminalSpawn } from "../../platform/activity/hooks";
import { writeJsonAtomic } from "../../store/atomic-write";
import { errorMessage, shorten } from "../../util/text";
import { fencedCommand, type FencePolicy } from "./fence";
import type { AgentFile, CliEventParser, SendOptions, SessionInfo, TerminalAgent, TerminalEvent, TerminalListener, TerminalSpec } from "./types";

/**
 * Motores de "um processo por turno" (OpenClaw `agent exec`, Hermes `chat -q`): não há processo vivo lendo
 * mensagens. Cada mensagem da fila sobe um processo novo, que responde e sai. O resto do contrato é o do
 * ProcessTerminal (fila, cancelar, interromper, parar, eventos, sessão salva em session.json).
 */

/** O que o adaptador de um motor de um processo por turno sabe dizer. */
export interface OneShotAdapter {
  readonly provider: AgentProvider;
  /** Dá para continuar uma conversa em outro processo (`--resume`)? Falso = cada turno é uma conversa nova; o terminal repassa o último trecho. */
  readonly resumable: boolean;
  /**
   * Comando de UM turno. `messageFile`: arquivo UTF-8 com a mensagem (evita o limite de argumentos e as aspas).
   * `resumeSessionId`: a conversa a continuar (só se `resumable`).
   */
  command(spec: TerminalSpec, turn: { messageFile: string; resumeSessionId?: string; timeoutSec: number }): { command: string; args: string[] };
  /** Texto final enviado ao programa: as instruções do agente entram aqui nos motores que não têm arquivo de instruções. */
  composeMessage(spec: TerminalSpec, input: { text: string; newSession: boolean; carried?: string }): string;
  /** Arquivos da pasta do agente (instruções, configuração com o MCP "office"). */
  agentFiles(input: { spec: TerminalSpec; mcpUrl: string; token: string }): AgentFile[];
  /** Ambiente do processo (já sem chaves de API). */
  env(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv;
  createParser(spec?: TerminalSpec): OneShotParser;
  /** Pastas do próprio programa (estado, HOME) que precisam existir antes de o processo subir. */
  requiredDirs?(spec: TerminalSpec): string[];
  /** Links simbólicos que o programa precisa dentro das pastas dele (o ambiente Python do Hermes, as credenciais do dono), refeitos a cada turno. */
  links?(spec: TerminalSpec): { path: string; target: string }[];
  newSessionId(): string;
  /** Antes de cada turno, depois das pastas e dos arquivos do agente: o que o programa precisa para não usar estado velho (o gateway do Hermes). */
  beforeTurn?(spec: TerminalSpec): Promise<void>;
  /**
   * Depois de cortar um turno (interromper, parar, tempo máximo) ou ao encerrar o terminal: encerra o que o programa deixou rodando FORA do grupo do
   * processo do turno (o gateway do Hermes continua o agente se só o cliente morre). Falhar aqui nunca impede o corte.
   */
  afterCut?(spec: TerminalSpec): Promise<void>;
  /**
   * Antes de subir o processo do turno: pede uma vaga de execução (o teto de gateways simultâneos do Hermes). Espera na fila se não há; `onWait` conta o motivo
   * (aparece no terminal do agente). Devolve quem libera a vaga no fim do turno, ou `undefined` se o pedido foi cancelado (`signal`) enquanto esperava.
   */
  acquireSlot?(spec: TerminalSpec, input: { signal: AbortSignal; onWait: (reason: string) => void }): Promise<(() => Promise<void> | void) | undefined>;
  /** Linha de stderr que é só aviso de rotina do programa (não vai para o registro do agente como se fosse erro; segue valendo para a mensagem de falha). */
  isQuietStderr?(line: string): boolean;
  /** A mensagem de erro diz que a conversa a retomar não existe mais? (o terminal começa outra no próximo turno) */
  isMissingSession?(text: string): boolean;
  /**
   * A cerca de arquivos deste turno (Landlock): a lista do que o processo e os filhos alcançam, e o `python3` que a monta. `undefined` = sem cerca
   * (desligada pelo dono, ou o computador não tem Landlock). O terminal só embrulha o comando; quem sabe a lista é o adaptador.
   */
  fence?(spec: TerminalSpec): { policy: FencePolicy; python: string } | undefined;
}

/** Parser de um turno: linhas do stdout e, no fim do processo, o que sobrou. */
export interface OneShotParser extends CliEventParser {
  /** O processo saiu: eventos finais (o envelope inteiro do OpenClaw, o turn_end de reserva…). `timedOut`: o tempo máximo estourou. */
  finish(exit: { code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }): TerminalEvent[];
}

/** Cria as pastas que o programa exige já existentes (o OpenClaw recusa um `--state-dir` que não existe). */
export async function ensureAdapterDirs(adapter: Pick<OneShotAdapter, "requiredDirs" | "links">, spec: TerminalSpec): Promise<void> {
  for (const dir of adapter.requiredDirs?.(spec) ?? []) await mkdir(dir, { recursive: true });
  for (const link of adapter.links?.(spec) ?? []) {
    try {
      if ((await readlink(link.path).catch(() => undefined)) === link.target) continue;
      await rm(link.path, { recursive: true, force: true });
      await symlink(link.target, link.path);
    } catch {
      // sem o link o programa só não acha o que o dono ligou (e o turno diz o motivo)
    }
  }
}

/** O `.turn-<id>.txt` (texto inteiro do turno) que sobrou de um turno cortado por queda do servidor (SIGKILL): apagado ao subir o terminal e no começo do turno seguinte. */
export async function removeStaleTurnFiles(cwd: string): Promise<void> {
  try {
    for (const name of await readdir(cwd)) if (/^\.turn-[0-9a-f]{8}\.txt$/.test(name)) await rm(path.join(cwd, name), { force: true });
  } catch {
    // pasta que não existe ainda ou sem permissão: nada a limpar
  }
}

export type OneShotSpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export type OneShotTerminalOptions = {
  adapter: OneShotAdapter;
  spec: TerminalSpec;
  /** Chamado antes de cada turno: grava a pasta do agente e devolve a especificação atualizada. */
  prepare?: () => Promise<TerminalSpec>;
  env?: NodeJS.ProcessEnv;
  /** Tempo máximo de um turno (ms): passado o prazo, SIGTERM e depois SIGKILL na árvore de processos. */
  turnTimeoutMs: number;
  /** Quanto esperar entre o SIGTERM e o SIGKILL. */
  stopGraceMs?: number;
  spawn?: OneShotSpawnFn;
  now?: () => Date;
  /**
   * O terminal é de uma CONVERSA com o dono (o Maestro ou o Cyno), não de uma tarefa: nos motores que não retomam a
   * sessão (OpenClaw) cada turno leva um resumo corrido da conversa inteira (com teto), guardado na pasta do agente,
   * em vez de só o último par.
   */
  conversation?: boolean;
};

type Message = { text: string; tag?: string; fresh?: string };

/** Por que o terminal volta a "stopped" entre turnos (não há processo vivo). */
export const ONE_SHOT_IDLE_REASON = "Um processo por turno: sem processo entre as tarefas";
const CONTEXT_FILE = "turn-context.json";
const CONTEXT_MAX_CHARS = 6000;
/** Resumo corrido de uma conversa (Maestro/Cyno em motor sem retomada): arquivo, teto e tamanho de cada fala. */
const MEMORY_FILE = "conversation-memory.json";
export const CONVERSATION_MEMORY_MAX_CHARS = 8000;
const MEMORY_USER_CHARS = 500;
const MEMORY_ASSISTANT_CHARS = 700;
const MEMORY_CUT = "(… falas mais antigas foram omitidas)";
/** Mensagens que chegam juntas (mesma tag) vão numa só. */
const MERGE_SEPARATOR = "\n\n(Outra mensagem que chegou junto, enquanto o turno anterior rodava:)\n\n";
const STDERR_TAIL = 20;

const defaultSpawn: OneShotSpawnFn = (command, args, options) =>
  // `detached`: o processo vira líder de um grupo, para derrubar a árvore inteira (as ferramentas que ele abriu).
  nodeSpawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true });

/** Manda o sinal ao grupo do processo (a árvore); sem grupo (já saiu), ao processo. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // já saiu
    }
  }
}

/** O turno foi cortado (cancelar, interromper, parar) antes de o processo subir: nada roda. */
class CutBeforeStart extends Error {}

export class OneShotTerminal implements TerminalAgent {
  readonly agentId: string;
  readonly provider: AgentProvider;
  private status_: TerminalStatus = "stopped";
  private error_: string | undefined;
  private readonly queue: Message[] = [];
  private inflight: Message | undefined;
  private child: ChildProcess | undefined;
  private running = false;
  private session: SessionInfo | undefined;
  private sessionLoaded = false;
  private sessionWrites: Promise<void> = Promise.resolve();
  private stopReason: string | undefined;
  private cutting: string | undefined;
  private disposed = false;
  /** O `turn_start` deste turno já saiu? (uma falha antes de subir o processo ainda precisa abrir o turno para fechá-lo) */
  private turnOpened = false;
  private turnDone: Promise<void> = Promise.resolve();
  private killing: Promise<void> | undefined;
  /** O turno espera uma vaga de execução (cancelar/interromper/parar acordam e desistem). */
  private slotWait: AbortController | undefined;
  private readonly listeners = new Set<TerminalListener>();
  private readonly sessionFile: string;
  private readonly spawnFn: OneShotSpawnFn;
  private readonly now: () => Date;

  constructor(private readonly options: OneShotTerminalOptions) {
    this.agentId = options.spec.agentId;
    this.provider = options.adapter.provider;
    this.sessionFile = path.join(options.spec.cwd, "session.json");
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.now = options.now ?? (() => new Date());
  }

  status(): TerminalStatus {
    return this.status_;
  }

  sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  lastError(): string | undefined {
    return this.error_;
  }

  currentSessionKey(): string | undefined {
    return this.session?.started ? this.session.key : undefined;
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

  onEvent(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Não há processo para subir antes da mensagem: o "ligar" só prepara a pasta do agente (e deixa o terminal pronto). */
  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error("Terminal encerrado");
    if (this.options.prepare) this.options.spec = await this.options.prepare();
    await mkdir(this.options.spec.cwd, { recursive: true });
    await removeStaleTurnFiles(this.options.spec.cwd);
    await ensureAdapterDirs(this.options.adapter, this.options.spec);
    if (this.status_ === "stopped" || this.status_ === "error") this.setStatus("idle");
  }

  send(message: string, tag?: string, options?: SendOptions): void {
    if (this.disposed) {
      this.emit({ type: "dropped", tag, reason: "Terminal encerrado" });
      return;
    }
    const fresh = options?.freshSession ? (options.sessionKey ?? tag ?? randomUUID()) : undefined;
    this.queue.push({ text: message, tag, ...(fresh ? { fresh } : {}) });
    void this.pump();
  }

  /** Sem entrada ao vivo: o chamador manda com `send` (vai no próximo turno). */
  inject(): boolean {
    return false;
  }

  cancel(tag: string): string[] {
    const removed: string[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.tag === tag) removed.unshift(this.queue.splice(i, 1)[0]!.text);
    // O turno desta etiqueta ainda se prepara (pastas, configuração, gateway velho): o processo nem sobe.
    if (this.inflight?.tag === tag && !this.child && this.cutting === undefined) {
      this.cutting = "Interrompido";
      this.slotWait?.abort();
    }
    return removed;
  }

  /** Corta o turno em curso (SIGTERM e depois SIGKILL na árvore) e segue a fila. */
  interrupt(): void {
    if (!this.inflight) return;
    this.cutting = "Interrompido";
    // Sem processo ainda (o turno se prepara ou espera vaga): a bandeira basta, o turno confere antes de subir.
    this.slotWait?.abort();
    if (this.child) void this.kill(this.child);
  }

  async stop(reason = "Terminal parado"): Promise<void> {
    this.stopReason = reason;
    const dropped = this.queue.splice(0);
    for (const message of dropped) this.emit({ type: "dropped", tag: message.tag, reason });
    if (this.inflight) {
      this.cutting = reason;
      this.slotWait?.abort();
      if (this.child) await this.kill(this.child);
    }
    await this.turnDone;
    // Mesmo sem turno em curso: o que o programa deixou no ar (o gateway ocioso do Hermes) sai junto.
    await this.afterCut();
    if (this.status_ !== "stopped") this.setStatus("stopped");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop("Terminal encerrado");
    this.listeners.clear();
  }

  // ---------- Um turno ----------

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.turnDone = (async () => {
      try {
        for (let next = this.queue.shift(); next; next = this.queue.shift()) await this.runTurn(this.coalesce(next));
      } finally {
        this.running = false;
        if (!this.disposed && this.status_ !== "stopped") {
          this.stopReason = ONE_SHOT_IDLE_REASON;
          this.setStatus("stopped");
        }
      }
    })();
    await this.turnDone;
  }

  /**
   * O que chegou na fila com a MESMA etiqueta (ex.: dois avisos do mesmo pedido enquanto um turno rodava) vai junto numa
   * só mensagem: um turno só. Quem conta os turnos pendentes (a tarefa, o Maestro) recebe um `turn_start` por mensagem
   * juntada, para a conta fechar. Etiquetas diferentes nunca se juntam (cada uma tem o seu fim de turno).
   */
  private coalesce(first: Message): Message {
    if (first.tag === undefined) return first;
    let text = first.text;
    while (this.queue[0] && this.queue[0].tag === first.tag && this.queue[0].fresh === undefined) {
      text += `${MERGE_SEPARATOR}${this.queue.shift()!.text}`;
      this.emit({ type: "turn_start", tag: first.tag });
    }
    return text === first.text ? first : { ...first, text };
  }

  private async runTurn(message: Message): Promise<void> {
    this.inflight = message;
    this.cutting = undefined;
    this.turnOpened = false;
    this.setStatus("starting");
    const tag = message.tag;
    let spec: TerminalSpec;
    let messageFile: string | undefined;
    let releaseSlot: (() => Promise<void> | void) | undefined;
    try {
      // O cancelamento vale em qualquer fase: depois de cada espera confere a bandeira e o processo nem sobe (revisão 2, M6).
      if (this.options.prepare) this.options.spec = await this.options.prepare();
      this.assertNotCut();
      spec = this.options.spec;
      await mkdir(spec.cwd, { recursive: true });
      await removeStaleTurnFiles(spec.cwd);
      await ensureAdapterDirs(this.options.adapter, spec);
      this.assertNotCut();
      await this.options.adapter.beforeTurn?.(spec);
      this.assertNotCut();
      const session = await this.sessionFor(message);
      const resume = this.options.adapter.resumable && session.started;
      const carried = !resume && !this.isNewConversation(message, session) ? await this.readContext(session.key) : undefined;
      this.assertNotCut();
      const text = this.options.adapter.composeMessage(spec, { text: message.text, newSession: !session.started, ...(carried ? { carried } : {}) });
      messageFile = path.join(spec.cwd, `.turn-${randomUUID().slice(0, 8)}.txt`);
      await writeFile(messageFile, text, { encoding: "utf8", mode: 0o600 });
      this.assertNotCut();
      releaseSlot = await this.waitForSlot(spec, tag);
      this.assertNotCut();
      const timeoutSec = Math.max(1, Math.round(this.options.turnTimeoutMs / 1000) - 5);
      const plain = this.options.adapter.command(spec, { messageFile, ...(resume ? { resumeSessionId: session.sessionId } : {}), timeoutSec });
      const fence = this.options.adapter.fence?.(spec);
      const { command, args } = fence ? fencedCommand(fence.policy, fence.python, plain.command, plain.args) : plain;
      const outcome = await this.exec(spec, command, args, message);
      if (outcome.ok && outcome.sessionId) this.saveSession({ sessionId: outcome.sessionId });
      if (outcome.ok) this.saveSession({ started: true });
      else if (resume && this.options.adapter.isMissingSession?.(outcome.result)) this.saveSession({ sessionId: this.options.adapter.newSessionId(), started: false });
      await this.writeContext(this.session?.key, message.text, outcome.result);
    } catch (error) {
      if (error instanceof CutBeforeStart) {
        // Cortado antes de subir: abre e fecha o turno como um corte comum (quem acompanha só entende `dropped` depois de um `turn_start`).
        if (!this.turnOpened) this.emit({ type: "turn_start", tag });
        this.emit({ type: "dropped", tag, reason: this.cutting ?? "Interrompido" });
        return;
      }
      this.error_ = `Não foi possível iniciar a CLI: ${errorMessage(error)}`;
      this.emit({ type: "raw", stream: "stderr", text: this.error_ });
      trackTerminalFailure(this, "start_failed", { error: errorMessage(error) }, this.options.spec.agentId);
      // Quem acompanha o turno (a tarefa, a conversa do Maestro) só aceita o fim de um turno que abriu.
      if (!this.turnOpened) this.emit({ type: "turn_start", tag });
      this.emit({ type: "turn_end", tag, ok: false, result: this.error_ });
    } finally {
      await this.killing?.catch(() => undefined);
      this.killing = undefined;
      try {
        await releaseSlot?.();
      } catch {
        // devolver a vaga nunca derruba o turno
      }
      if (messageFile) await rm(messageFile, { force: true }).catch(() => undefined);
      this.inflight = undefined;
      this.child = undefined;
    }
  }

  /** Vaga de execução do motor (o teto de gateways do Hermes): espera na fila, dizendo o motivo no terminal do agente. */
  private async waitForSlot(spec: TerminalSpec, tag: string | undefined): Promise<(() => Promise<void> | void) | undefined> {
    if (!this.options.adapter.acquireSlot) return undefined;
    const wait = new AbortController();
    this.slotWait = wait;
    try {
      return await this.options.adapter.acquireSlot(spec, {
        signal: wait.signal,
        onWait: (reason) => {
          // O turno abre já na espera: quem acompanha (a tarefa, o registro do agente) só mostra as linhas de um turno aberto, e o motivo tem de aparecer.
          if (!this.turnOpened) {
            this.turnOpened = true;
            this.emit({ type: "turn_start", tag });
          }
          this.emit({ type: "raw", stream: "stderr", text: reason });
        },
      });
    } finally {
      this.slotWait = undefined;
    }
  }

  private assertNotCut(): void {
    if (this.cutting !== undefined) throw new CutBeforeStart();
  }

  /** Encerra o que o programa deixou fora do grupo do turno (se o adaptador sabe como); falha aqui nunca atrapalha. */
  private async afterCut(): Promise<void> {
    try {
      await this.options.adapter.afterCut?.(this.options.spec);
    } catch {
      // o corte já valeu
    }
  }

  private exec(spec: TerminalSpec, command: string, args: string[], message: Message): Promise<{ ok: boolean; result: string; sessionId?: string }> {
    return new Promise((resolve) => {
      const parser = this.options.adapter.createParser(spec);
      const stderrTail: string[] = [];
      let turnEnd: Extract<TerminalEvent, { type: "turn_end" }> | undefined;
      let sessionId: string | undefined;
      let timedOut = false;
      let settled = false;
      const startedAt = Date.now();
      const emitAll = (events: TerminalEvent[]) => {
        for (const event of events) {
          if (event.type === "session") sessionId = event.sessionId || sessionId;
          if (event.type === "turn_end") {
            // O envelope e o fim do processo podem dizer a mesma coisa duas vezes: vale o primeiro.
            if (turnEnd) continue;
            turnEnd = { ...event, tag: message.tag };
            continue;
          }
          this.emit(event);
        }
      };
      let child: ChildProcess;
      try {
        child = this.spawnFn(command, args, { cwd: spec.cwd, env: this.options.adapter.env(this.options.env ?? process.env, spec) });
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      this.child = child;
      this.error_ = undefined;
      if (!this.turnOpened) {
        this.turnOpened = true;
        this.emit({ type: "turn_start", tag: message.tag });
      }
      this.setStatus("busy");
      trackTerminalSpawn(this, { agentId: spec.agentId, pid: child.pid });
      const timer = setTimeout(() => {
        timedOut = true;
        void this.kill(child);
      }, this.options.turnTimeoutMs);
      timer.unref();
      child.once("error", (error) => {
        stderrTail.push(`erro do processo: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? `comando ${command} não encontrado` : errorMessage(error)}`);
        finish(null, null);
      });
      if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => emitAll(parser.parse(line)));
      if (child.stderr) {
        createInterface({ input: child.stderr }).on("line", (line) => {
          if (!line.trim()) return;
          // Mascarada já na entrada: nem a tela, nem o registro, nem a mensagem de falha levam um segredo do stderr.
          const safe = maskSecrets(line);
          stderrTail.push(safe);
          if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
          if (this.options.adapter.isQuietStderr?.(line)) return;
          this.emit({ type: "raw", stream: "stderr", text: safe });
        });
      }
      child.once("close", (code, signal) => finish(code, signal));
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        trackTerminalExit(this, { agentId: spec.agentId, code, signal, expected: this.cutting !== undefined, reason: this.cutting, ...(this.cutting ? {} : { error: stderrTail.at(-1) }) });
        const stderr = stderrTail.join("\n");
        if (this.cutting) {
          const usage = parser.takePartialUsage?.();
          if (usage) this.emit({ type: "turn_cut", tag: message.tag, usage, reason: this.cutting });
          this.emit({ type: "dropped", tag: message.tag, reason: this.cutting });
          // `stop`/`interrupt` do usuário: quem pediu já sabe (a tarefa falha com o motivo), nada de turn_end.
          resolve({ ok: false, result: this.cutting });
          return;
        }
        emitAll(parser.finish({ code, signal, stderr, timedOut }));
        const end: Extract<TerminalEvent, { type: "turn_end" }> =
          turnEnd ?? {
            type: "turn_end",
            tag: message.tag,
            ok: false,
            result: timedOut
              ? `O turno passou do tempo máximo (${Math.round(this.options.turnTimeoutMs / 60_000)} min) e foi encerrado.`
              : `O motor saiu (código ${code ?? "?"}${signal ? `, sinal ${signal}` : ""}) sem dar resposta${stderr ? `: ${shorten(maskSecrets(stderr.split("\n").at(-1) ?? ""), 300)}` : "."}`,
          };
        if (!end.ok) this.error_ = end.result;
        this.emit({ ...end, usage: end.usage ? { ...end.usage, durationMs: end.usage.durationMs ?? Date.now() - startedAt } : end.usage });
        resolve({ ok: end.ok, result: end.result, ...(sessionId ? { sessionId } : {}) });
      };
    });
  }

  /** Sobe o grupo inteiro: SIGTERM e, se não sair, SIGKILL. */
  private kill(child: ChildProcess): Promise<void> {
    const done = this.doKill(child);
    // O turno só termina depois do corte inteiro (o gateway do Hermes incluso): o turno seguinte não pode cruzar com ele.
    this.killing = done;
    return done;
  }

  private async doKill(child: ChildProcess): Promise<void> {
    const grace = this.options.stopGraceMs ?? 3000;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    killTree(child, "SIGTERM");
    const within = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), grace).unref())]);
    if (!within) {
      killTree(child, "SIGKILL");
      await exited;
    }
    // O gateway do Hermes é de outro grupo e seguiria o agente sozinho: sai junto (revisão 2, G2).
    await this.afterCut();
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

  private async loadSession(): Promise<void> {
    if (this.sessionLoaded) return;
    this.sessionLoaded = true;
    try {
      const data = JSON.parse(await readFile(this.sessionFile, "utf8")) as Partial<SessionInfo>;
      if (data.provider === this.provider && typeof data.sessionId === "string" && data.sessionId) {
        this.session = { provider: this.provider, sessionId: data.sessionId, started: data.started === true, updatedAt: String(data.updatedAt ?? ""), ...(typeof data.key === "string" && data.key ? { key: data.key } : {}) };
      }
    } catch {
      // Sem arquivo (ou quebrado): sessão nova.
    }
  }

  /** A mensagem pede conversa nova (outra chave) ou ainda não há conversa? */
  private isNewConversation(message: Message, session: SessionInfo): boolean {
    return !session.started || (message.fresh !== undefined && session.key !== message.fresh);
  }

  /** A sessão que este turno usa: a atual, ou uma nova (id novo) se a mensagem pede conversa nova de outra chave. */
  private async sessionFor(message: Message): Promise<SessionInfo> {
    await this.loadSession();
    const current = this.session;
    if (!current || (message.fresh !== undefined && current.started && current.key !== message.fresh)) {
      this.saveSession({ sessionId: this.options.adapter.newSessionId(), started: false, key: message.fresh });
    } else if (!current.started) {
      this.saveSession({ sessionId: this.options.adapter.newSessionId(), key: message.fresh ?? current.key });
    } else if (message.fresh && current.key !== message.fresh) {
      this.saveSession({ key: message.fresh });
    }
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
    this.sessionWrites = this.sessionWrites.then(() => writeJsonAtomic(this.sessionFile, snapshot)).catch(() => undefined);
  }

  /** Espera as gravações de session.json (testes e shutdown). */
  flushSession(): Promise<void> {
    return this.sessionWrites;
  }

  // ---------- Contexto repassado (motores que não retomam conversa) ----------

  private async readContext(key: string | undefined): Promise<string | undefined> {
    if (this.options.conversation) return this.readMemory(key);
    try {
      const data = JSON.parse(await readFile(path.join(this.options.spec.cwd, CONTEXT_FILE), "utf8")) as { key?: string; user?: string; assistant?: string };
      if (data.key !== (key ?? "") || !data.user) return undefined;
      return `Mensagem anterior que você recebeu nesta conversa:\n${data.user}\n\nO que você respondeu:\n${data.assistant || "(sem resposta)"}`;
    } catch {
      return undefined;
    }
  }

  private async writeContext(key: string | undefined, user: string, assistant: string): Promise<void> {
    if (this.options.adapter.resumable) return;
    if (this.options.conversation) return this.writeMemory(key, user, assistant);
    try {
      // Atômica (um arquivo pela metade recomeçaria a conversa) e sem segredo: o texto da conversa passa por maskSecrets.
      await writeJsonAtomic(path.join(this.options.spec.cwd, CONTEXT_FILE), { key: key ?? "", user: maskSecrets(shorten(user, CONTEXT_MAX_CHARS)), assistant: maskSecrets(shorten(assistant, CONTEXT_MAX_CHARS)) });
    } catch {
      // Sem o repasse a conversa só perde o contexto do turno anterior.
    }
  }

  // ---------- Resumo corrido da conversa (Maestro e Cyno em motor sem retomada) ----------

  private async loadMemory(): Promise<{ key: string; lines: string[] } | undefined> {
    try {
      const data = JSON.parse(await readFile(path.join(this.options.spec.cwd, MEMORY_FILE), "utf8")) as { key?: string; lines?: unknown };
      return { key: data.key ?? "", lines: Array.isArray(data.lines) ? data.lines.filter((line): line is string => typeof line === "string") : [] };
    } catch {
      return undefined;
    }
  }

  private async readMemory(key: string | undefined): Promise<string | undefined> {
    const memory = await this.loadMemory();
    if (!memory || memory.key !== (key ?? "") || memory.lines.length === 0) return undefined;
    return `Resumo corrido da conversa até aqui (você não lembra dos turnos anteriores: isto é tudo o que há dela; o que não está aqui, consulte pelas ferramentas):\n${memory.lines.join("\n")}`;
  }

  private async writeMemory(key: string | undefined, user: string, assistant: string): Promise<void> {
    try {
      const current = await this.loadMemory();
      const lines = current && current.key === (key ?? "") ? current.lines.filter((line) => line !== MEMORY_CUT) : [];
      // O que o dono disse é o fim da mensagem (antes dela podem vir o contexto de abertura e o resumo do servidor).
      const said = user.split("\n\n---\n\n").at(-1) ?? user;
      lines.push(`- Mensagem: ${maskSecrets(shorten(said.replace(/\s+/g, " "), MEMORY_USER_CHARS))}`, `  Você respondeu: ${maskSecrets(shorten((assistant || "(sem resposta)").replace(/\s+/g, " "), MEMORY_ASSISTANT_CHARS))}`);
      // Teto: sai o que é mais antigo (de duas em duas linhas, uma fala inteira).
      let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
      let cut = false;
      while (total > CONVERSATION_MEMORY_MAX_CHARS && lines.length > 2) {
        total -= lines.shift()!.length + lines.shift()!.length + 2;
        cut = true;
      }
      await writeJsonAtomic(path.join(this.options.spec.cwd, MEMORY_FILE), { key: key ?? "", lines: cut ? [MEMORY_CUT, ...lines] : lines });
    } catch {
      // Sem o resumo a conversa só perde o contexto dos turnos anteriores.
    }
  }
}
