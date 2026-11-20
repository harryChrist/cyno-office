import { spawn as spawnPipes } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { maskSecrets, plainScriptOutput, SCRIPT_LIMITS, SCRIPT_STATUSES, type ScriptOutputResponse, type ScriptRun, type ScriptsState, type ScriptStopper, type ServerEvent } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { minimalChildEnv, sanitizeChildEnv } from "../../engines/terminals/env";
import { fencedCommand } from "../../engines/terminals/fence";
import type { ScriptAgentContext } from "../../engines/terminals/manager";
import { HttpError } from "../../platform/http/errors";
import { writeJsonAtomic } from "../../store/atomic-write";

/*
 * Scripts dos agentes: o SERVIDOR roda o comando demorado a pedido do agente (ferramenta MCP `start_script`), grava a saída inteira em
 * `<workspace>/scripts/<id>/output.log` (bytes como saíram, segredos mascarados) e mostra ao vivo na interface, com botão de parar.
 * O script tem o MESMO poder do terminal do agente, nunca mais: só roda se o terminal dele está ligado, na pasta dele ou numa pasta de
 * trabalho dele, com o ambiente sem segredos e, nos motores cercados (OpenClaw, Hermes), dentro da mesma cerca de arquivos.
 */

/** Tamanho fixo do terminal do script (colunas x linhas). */
export const SCRIPT_PTY_SIZE = { cols: 120, rows: 40 } as const;

/** Um processo de script em andamento (PTY ou pipes). `killGroup` manda o sinal ao grupo de processos inteiro. */
export type ScriptProcess = {
  readonly pid: number;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { code: number | null }) => void): void;
  killGroup(signal: NodeJS.Signals): void;
};

export type ScriptSpawnFn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ScriptProcess> | ScriptProcess;

function killGroupOf(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // já saiu
    }
  }
}

/** Processo sob um pseudo-terminal (saída ao vivo, sem buffer do programa). O node-pty cria a sessão: o pid é o líder do grupo. */
async function spawnPty(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ScriptProcess> {
  const pty = await import("@lydell/node-pty");
  const child = pty.spawn(file, args, { cwd: options.cwd, env: { TERM: "xterm-256color", ...options.env } as Record<string, string>, cols: SCRIPT_PTY_SIZE.cols, rows: SCRIPT_PTY_SIZE.rows, name: "xterm-256color" });
  return {
    pid: child.pid,
    onData: (listener) => void child.onData(listener),
    onExit: (listener) => void child.onExit((event) => listener({ code: event.signal ? null : event.exitCode })),
    killGroup: (signal) => killGroupOf(child.pid, signal),
  };
}

/** Plano B sem PTY: stdout e stderr juntos, na ordem em que chegam, em processo próprio (grupo próprio). */
export function spawnWithPipes(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ScriptProcess {
  const child = spawnPipes(file, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid === undefined) throw new Error("could not start the process");
  const pid = child.pid;
  const listeners: ((chunk: string) => void)[] = [];
  for (const stream of [child.stdout!, child.stderr!]) {
    const decoder = new StringDecoder("utf8");
    stream.on("data", (buffer: Buffer) => {
      const text = decoder.write(buffer);
      if (text) for (const listener of listeners) listener(text);
    });
    stream.on("end", () => {
      const rest = decoder.end();
      if (rest) for (const listener of listeners) listener(rest);
    });
  }
  return {
    pid,
    onData: (listener) => void listeners.push(listener),
    onExit: (listener) => void child.once("close", (code) => listener({ code })),
    killGroup: (signal) => killGroupOf(pid, signal),
  };
}

/** Padrão: PTY; se não der para criar, pipes. */
export const defaultScriptSpawn: ScriptSpawnFn = async (file, args, options) => {
  try {
    return await spawnPty(file, args, options);
  } catch {
    return spawnWithPipes(file, args, options);
  }
};

export type ScriptsServiceOptions = {
  /** Pasta dos scripts do workspace (`<workspace>/scripts`). */
  dir: string;
  publish: (event: ServerEvent) => void;
  /** O que o serviço precisa saber do agente (pasta, pastas de trabalho, terminal ligado, cerca). */
  agent: (agentId: string) => Promise<ScriptAgentContext | undefined>;
  /** Ambiente base do servidor (padrão: process.env); nunca chega ao script sem passar pelo filtro de segredos. */
  env?: () => NodeJS.ProcessEnv;
  spawn?: ScriptSpawnFn;
  /** Tolerância entre o SIGTERM e o SIGKILL (padrão 5 s). */
  graceMs?: number;
  /** Quanto esperar a saída que ainda chega depois do fim do processo (padrão 60 ms). */
  drainMs?: number;
  /** Uma linha incompleta fica retida até tanto tempo sem novidade (padrão 250 ms), para um segredo não ser cortado no meio. */
  flushMs?: number;
  /** No máximo uma publicação por script neste intervalo enquanto a saída corre (padrão 1 s). */
  publishMs?: number;
  /** Limites (os testes diminuem). */
  limits?: Partial<{ outputBytes: number; runningPerAgent: number; keepFinished: number; finishedTtlMs: number }>;
  /** De quanto em quanto tempo a faxina dos terminados vencidos roda (padrão: SCRIPT_LIMITS.sweepMinutes). */
  sweepMs?: number;
  log: Pick<FastifyBaseLogger, "warn" | "info">;
  now: () => Date;
};

type EndReason = { kind: "stopped"; by: ScriptStopper } | { kind: "timeout" };

type Live = {
  run: ScriptRun;
  proc: ScriptProcess;
  endReason?: EndReason;
  /** Texto (já mascarado) ainda não gravado: a linha incompleta. */
  pending: string;
  /** A saída passou do limite: o resto é descartado. */
  truncated: boolean;
  writeChain: Promise<void>;
  fd: Awaited<ReturnType<typeof open>> | undefined;
  flushTimer?: NodeJS.Timeout;
  publishTimer?: NodeJS.Timeout;
  lastPublish: number;
  deadlineTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  waiters: Set<() => void>;
  finished: Promise<void>;
  finish: () => void;
  ended: boolean;
};

const META = "meta.json";
const OUTPUT = "output.log";
const PID_FILE = "pid";
const COUNTER = "counter.json";
const ID_PATTERN = /^s(\d{1,7})$/;

/** Fim de uma sequência UTF-8 que ficou pela metade: quantos bytes do fim do buffer não formam um caractere completo. */
function incompleteTail(buffer: Buffer): number {
  const max = Math.min(3, buffer.length);
  for (let back = 1; back <= max; back += 1) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Marca que todo script leva no ambiente. Serve para reconhecer, depois de uma queda do servidor, que o processo de
 * um PID guardado ainda é aquele script (e não um PID reaproveitado). O nome do programa não serve: o `bash -c` de
 * um comando simples vira o próprio programa (`node`, `sleep`), mas o ambiente passa adiante.
 */
const SCRIPT_MARK_ENV = "CYNO_SCRIPT";
const scriptMark = (run: Pick<ScriptRun, "id" | "startedAt">): string => `${run.id}@${run.startedAt}`;

/** O processo `pid` ainda existe e é o script com esta marca? (reinício do servidor: não matar um PID reaproveitado). */
function looksLikeOurScript(pid: number, mark: string): boolean {
  try {
    process.kill(-pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${SCRIPT_MARK_ENV}=${mark}`);
  } catch {
    return process.platform !== "linux";
  }
}

export class ScriptsService {
  private readonly runs = new Map<string, ScriptRun>();
  private readonly live = new Map<string, Live>();
  private counter = 0;
  private readonly limits: { outputBytes: number; runningPerAgent: number; keepFinished: number; finishedTtlMs: number };
  private closed = false;
  private readonly sweepTimer: NodeJS.Timeout;
  /** Agentes com um script ainda subindo (contam no limite do agente, para duas chamadas ao mesmo tempo não passarem do teto). */
  private readonly starting: string[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ScriptsServiceOptions) {
    this.limits = {
      outputBytes: options.limits?.outputBytes ?? SCRIPT_LIMITS.outputBytes,
      runningPerAgent: options.limits?.runningPerAgent ?? SCRIPT_LIMITS.runningPerAgent,
      keepFinished: options.limits?.keepFinished ?? SCRIPT_LIMITS.keepFinished,
      finishedTtlMs: options.limits?.finishedTtlMs ?? SCRIPT_LIMITS.finishedTtlMinutes * 60_000,
    };
    this.restore();
    this.sweepTimer = setInterval(() => void this.prune(), options.sweepMs ?? SCRIPT_LIMITS.sweepMinutes * 60_000);
    this.sweepTimer.unref();
  }

  // ---------------------------------------------------------------- leitura

  /** Os que rodam primeiro e os terminados, do mais novo para o mais velho. */
  list(): ScriptRun[] {
    const stamp = (run: ScriptRun) => Date.parse(run.status === "running" ? run.startedAt : (run.endedAt ?? run.startedAt));
    return [...this.runs.values()].map((run) => ({ ...run })).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || stamp(b) - stamp(a) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  }

  state(): ScriptsState {
    return { runs: this.list() };
  }

  find(id: string): ScriptRun | undefined {
    const run = this.runs.get(id);
    return run ? { ...run } : undefined;
  }

  get(id: string): ScriptRun {
    const run = this.find(id);
    if (!run) throw new HttpError(404, `Script ${id} não encontrado`);
    return run;
  }

  /** Um pedaço da saída bruta a partir do byte `from` (no máximo SCRIPT_LIMITS.readBytes), sem cortar um caractere UTF-8 ao meio. */
  async readOutput(id: string, from = 0): Promise<ScriptOutputResponse> {
    this.get(id);
    await this.live.get(id)?.writeChain;
    const file = this.outputFile(id);
    const size = await stat(file).then((info) => info.size).catch(() => 0);
    let start = Math.min(Math.max(0, Math.floor(from)), size);
    let data = "";
    let next = start;
    if (size > start) {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(Math.min(SCRIPT_LIMITS.readBytes, size - start));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        let chunk = buffer.subarray(0, bytesRead);
        // Começou no meio de um caractere: pula os bytes de continuação.
        let skip = 0;
        while (skip < chunk.length && skip < 3 && (chunk[skip]! & 0xc0) === 0x80) skip += 1;
        if (skip > 0) {
          start += skip;
          chunk = chunk.subarray(skip);
        }
        chunk = chunk.subarray(0, chunk.length - incompleteTail(chunk));
        data = chunk.toString("utf8");
        next = start + chunk.length;
      } finally {
        await handle.close();
      }
    }
    const run = this.runs.get(id)!;
    return { id, from: start, next, size, data, done: run.status !== "running" && next >= size };
  }

  /** A saída inteira sem cores nem barras de progresso (para baixar). */
  async plainOutput(id: string): Promise<string> {
    this.get(id);
    await this.live.get(id)?.writeChain;
    return plainScriptOutput(await readFile(this.outputFile(id), "utf8").catch(() => ""));
  }

  /** O fim da saída (texto simples), até `chars` caracteres, começando numa linha inteira quando o corte caiu no meio de uma. */
  async plainTail(id: string, chars: number): Promise<string> {
    this.get(id);
    await this.live.get(id)?.writeChain;
    const file = this.outputFile(id);
    const size = await stat(file).then((info) => info.size).catch(() => 0);
    if (size === 0) return "";
    // Sequências de cor e `\r` de barras de progresso incham o bruto: lê bastante mais que o pedido.
    const want = Math.min(size, Math.max(chars * 6, 64 * 1024));
    const handle = await open(file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buffer, 0, want, size - want);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    let plain = plainScriptOutput(text);
    if (want < size) plain = plain.slice(plain.indexOf("\n") + 1);
    plain = plain.replace(/\n+$/, "");
    return plain.length > chars ? plain.slice(plain.length - chars) : plain;
  }

  /**
   * Espera o script terminar ou o tempo acabar; devolve o estado de agora. Saída nova NÃO acorda a espera: num script que
   * imprime sem parar, o agente voltaria a cada poucos segundos e gastaria um turno de ferramenta por linha.
   */
  async wait(id: string, seconds: number): Promise<ScriptRun> {
    this.get(id);
    const live = this.live.get(id);
    if (!live || live.ended) return this.get(id);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(limitTimer);
        live.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (live.ended) done();
      };
      const limitTimer = setTimeout(done, Math.max(0, seconds) * 1000);
      live.waiters.add(check);
      check();
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- começar

  async start(input: { agentId: string; taskId?: string; title: string; command: string; cwd?: string; timeoutMinutes?: number }): Promise<ScriptRun> {
    if (this.closed) throw new HttpError(409, "The server is shutting down; scripts cannot start now");
    const command = input.command.trim();
    const title = input.title.trim();
    if (!command) throw new HttpError(422, "The command is empty");
    if (command.length > SCRIPT_LIMITS.command) throw new HttpError(422, `The command is too long (max ${SCRIPT_LIMITS.command} characters). Put it in a script file in your folder and run that.`);
    if (!title) throw new HttpError(422, "Give the script a short title");
    if (title.length > SCRIPT_LIMITS.title) throw new HttpError(422, `The title is too long (max ${SCRIPT_LIMITS.title} characters)`);
    const minutes = Math.min(SCRIPT_LIMITS.maxTimeoutMinutes, Math.max(1, input.timeoutMinutes ?? SCRIPT_LIMITS.defaultTimeoutMinutes));

    const context = await this.options.agent(input.agentId);
    if (!context) throw new HttpError(404, "Agent not found");
    if (!context.terminal) throw new HttpError(403, "Your terminal access is off, so you cannot run scripts. Use request_help with kind \"access\" if you need it.");
    const owners = [...[...this.live.values()].filter((live) => !live.ended).map((live) => live.run.agentId), ...this.starting];
    if (owners.filter((owner) => owner === input.agentId).length >= this.limits.runningPerAgent) {
      throw new HttpError(429, `You already have ${this.limits.runningPerAgent} scripts running. Wait for one to finish (check_script) or stop one (stop_script).`);
    }

    const cwd = this.resolveCwd(context, input.cwd);
    this.starting.push(input.agentId);
    try {
      return await this.launch(input, context, cwd, command, title, minutes);
    } finally {
      this.starting.splice(this.starting.indexOf(input.agentId), 1);
    }
  }

  private async launch(input: { agentId: string; taskId?: string }, context: ScriptAgentContext, cwd: string, command: string, title: string, minutes: number): Promise<ScriptRun> {

    const id = this.nextId();
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true });
    const now = this.options.now();
    const run: ScriptRun = {
      id,
      agentId: input.agentId,
      agentName: context.agentName,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      title: maskSecrets(title),
      command: maskSecrets(command),
      cwd,
      status: "running",
      startedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      bytes: 0,
      truncated: false,
      fenced: context.fence !== undefined,
    };

    let proc: ScriptProcess;
    try {
      const launch = await this.launchSpec(context, command, scriptMark(run));
      proc = await (this.options.spawn ?? defaultScriptSpawn)(launch.file, launch.args, { cwd, env: launch.env });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw new HttpError(500, `Could not start the script: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const live: Live = { run, proc, pending: "", truncated: false, writeChain: Promise.resolve(), fd: undefined, lastPublish: 0, waiters: new Set(), finished, finish, ended: false };
    this.runs.set(id, run);
    this.live.set(id, live);
    writeFileSync(path.join(dir, PID_FILE), String(proc.pid), "utf8");
    writeFileSync(this.outputFile(id), "");
    live.writeChain = open(this.outputFile(id), "a").then(
      (fd) => void (live.fd = fd),
      (error: unknown) => this.options.log.warn({ err: error, id }, "não foi possível abrir a saída do script"),
    );
    writeFileSync(path.join(dir, META), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    this.publishNow(live);

    live.deadlineTimer = setTimeout(() => this.terminate(live, { kind: "timeout" }), minutes * 60_000);
    live.deadlineTimer.unref();
    proc.onData((chunk) => this.onData(live, chunk));
    proc.onExit(({ code }) => void this.onExit(live, code));
    return { ...run };
  }

  // ---------------------------------------------------------------- parar

  /** Para o script (SIGTERM no grupo, SIGKILL depois da tolerância) e devolve o estado final. Já terminado: devolve como está. */
  async stop(id: string, by: ScriptStopper): Promise<ScriptRun> {
    this.get(id);
    const live = this.live.get(id);
    if (live && !live.ended) {
      this.terminate(live, { kind: "stopped", by });
      await live.finished;
    }
    return this.get(id);
  }

  /** A tarefa que lançou os scripts terminou (ou foi cancelada): eles não sobrevivem a ela. */
  async stopForTask(taskId: string): Promise<void> {
    await this.stopWhere((run) => run.taskId === taskId, "task");
  }

  /** O agente foi removido. */
  async stopForAgent(agentId: string): Promise<void> {
    await this.stopWhere((run) => run.agentId === agentId, "server");
  }

  /** Desligamento do servidor ou do workspace. */
  async stopAll(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweepTimer);
    await this.stopWhere(() => true, "server");
  }

  private async stopWhere(match: (run: ScriptRun) => boolean, by: ScriptStopper): Promise<void> {
    const targets = [...this.live.values()].filter((live) => !live.ended && match(live.run));
    for (const live of targets) this.terminate(live, { kind: "stopped", by });
    await Promise.all(targets.map((live) => live.finished));
  }

  private terminate(live: Live, reason: EndReason): void {
    if (live.ended || live.endReason) return;
    live.endReason = reason;
    live.proc.killGroup("SIGTERM");
    live.killTimer = setTimeout(() => live.proc.killGroup("SIGKILL"), this.options.graceMs ?? 5000);
  }

  // ---------------------------------------------------------------- saída

  private onData(live: Live, chunk: string): void {
    if (live.ended || live.truncated) return;
    live.pending += chunk;
    const cut = live.pending.lastIndexOf("\n");
    if (cut >= 0) {
      const complete = live.pending.slice(0, cut + 1);
      live.pending = live.pending.slice(cut + 1);
      this.write(live, complete);
    }
    if (live.pending.length > 8192) {
      this.write(live, live.pending);
      live.pending = "";
    }
    if (live.flushTimer) clearTimeout(live.flushTimer);
    if (live.pending) {
      live.flushTimer = setTimeout(() => this.flushPending(live), this.options.flushMs ?? 250);
    }
  }

  private flushPending(live: Live): void {
    if (live.flushTimer) clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
    if (!live.pending) return;
    const text = live.pending;
    live.pending = "";
    this.write(live, text);
  }

  /** Mascara, respeita o limite e grava (em fila: a ordem dos pedaços é a da chegada). */
  private write(live: Live, raw: string): void {
    if (live.truncated) return;
    const masked = maskSecrets(raw);
    let buffer = Buffer.from(masked, "utf8");
    const room = this.limits.outputBytes - live.run.bytes;
    let notice = "";
    if (buffer.length > room) {
      let cut = Math.max(0, room);
      while (cut > 0 && cut < buffer.length && (buffer[cut]! & 0xc0) === 0x80) cut -= 1;
      buffer = buffer.subarray(0, cut);
      live.truncated = true;
      live.run.truncated = true;
      notice = `\n[Cyno] A saída passou do limite de ${Math.round(this.limits.outputBytes / 1024 / 1024)} MB: o resto não está sendo gravado. O script continua rodando.\n`;
    }
    const noticeBuffer = notice ? Buffer.from(notice, "utf8") : undefined;
    const total = buffer.length + (noticeBuffer?.length ?? 0);
    if (total === 0) return;
    live.run.bytes += total;
    const visible = plainScriptOutput(buffer.toString("utf8"));
    const lastLine = visible
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (lastLine) live.run.lastLine = lastLine.length > SCRIPT_LIMITS.lastLine ? `${lastLine.slice(0, SCRIPT_LIMITS.lastLine - 1)}…` : lastLine;
    const data = noticeBuffer ? Buffer.concat([buffer, noticeBuffer]) : buffer;
    live.writeChain = live.writeChain.then(async () => {
      try {
        await live.fd?.write(data);
      } catch (error) {
        this.options.log.warn({ err: error, id: live.run.id }, "não foi possível gravar a saída do script");
      }
    });
    this.touch(live);
    for (const wake of [...live.waiters]) wake();
  }

  // ---------------------------------------------------------------- fim

  private async onExit(live: Live, code: number | null): Promise<void> {
    if (live.ended) return;
    // A saída que ainda estava a caminho chega logo depois do evento de saída.
    await new Promise((resolve) => setTimeout(resolve, this.options.drainMs ?? 60));
    if (live.ended) return;
    live.ended = true;
    if (live.killTimer) clearTimeout(live.killTimer);
    if (live.deadlineTimer) clearTimeout(live.deadlineTimer);
    if (live.flushTimer) clearTimeout(live.flushTimer);
    if (live.publishTimer) clearTimeout(live.publishTimer);
    // O que sobrou do grupo (filhos que ficaram) sai junto com o script.
    live.proc.killGroup("SIGKILL");
    if (live.pending) {
      const text = live.pending;
      live.pending = "";
      this.write(live, text);
    }
    await live.writeChain;
    await live.fd?.close().catch(() => undefined);
    live.fd = undefined;
    const run = live.run;
    const reason = live.endReason;
    run.endedAt = this.options.now().toISOString();
    run.exitCode = code;
    if (reason?.kind === "timeout") run.status = "timeout";
    else if (reason?.kind === "stopped") {
      run.status = "stopped";
      run.stoppedBy = reason.by;
    } else run.status = code === 0 ? "done" : "failed";
    rmSync(path.join(this.dirOf(run.id), PID_FILE), { force: true });
    await this.persist(run);
    this.live.delete(run.id);
    this.options.publish({ type: "script:updated", run: { ...run } });
    for (const wake of [...live.waiters]) wake();
    live.finish();
    void this.prune();
  }

  // ---------------------------------------------------------------- publicação

  private publishNow(live: Live): void {
    if (live.publishTimer) clearTimeout(live.publishTimer);
    live.publishTimer = undefined;
    live.lastPublish = Date.now();
    this.options.publish({ type: "script:updated", run: { ...live.run } });
  }

  /** Mudou a saída: publica no máximo uma vez por `publishMs`. */
  private touch(live: Live): void {
    if (live.publishTimer || live.ended) return;
    const wait = Math.max(0, (this.options.publishMs ?? 1000) - (Date.now() - live.lastPublish));
    if (wait === 0) {
      this.publishNow(live);
      this.persist(live.run);
      return;
    }
    live.publishTimer = setTimeout(() => {
      live.publishTimer = undefined;
      if (live.ended) return;
      this.publishNow(live);
      this.persist(live.run);
    }, wait);
  }

  // ---------------------------------------------------------------- disco

  private dirOf(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`id de script inválido: "${id}"`);
    return path.join(this.options.dir, id);
  }

  private outputFile(id: string): string {
    return path.join(this.dirOf(id), OUTPUT);
  }

  /** Grava o meta.json (em fila, para uma gravação velha nunca passar por cima de uma nova). */
  private persist(run: ScriptRun): Promise<void> {
    const snapshot = { ...run };
    this.persistChain = this.persistChain.then(() =>
      writeJsonAtomic(path.join(this.dirOf(snapshot.id), META), snapshot).catch((error: unknown) => this.options.log.warn({ err: error, id: snapshot.id }, "não foi possível gravar o estado do script")),
    );
    return this.persistChain;
  }

  private nextId(): string {
    this.counter += 1;
    try {
      mkdirSync(this.options.dir, { recursive: true });
      writeFileSync(path.join(this.options.dir, COUNTER), JSON.stringify({ next: this.counter }), "utf8");
    } catch (error) {
      this.options.log.warn({ err: error }, "não foi possível gravar o contador dos scripts");
    }
    return `s${this.counter}`;
  }

  /** Ao abrir: lê o que tem em disco; o que ficou "rodando" é de um servidor que caiu: vira `lost` (e o grupo, se vivo, é morto). */
  private restore(): void {
    let max = 0;
    try {
      max = Number((JSON.parse(readFileSync(path.join(this.options.dir, COUNTER), "utf8")) as { next?: unknown }).next) || 0;
    } catch {
      // sem contador ainda
    }
    let names: string[];
    try {
      names = readdirSync(this.options.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const match = ID_PATTERN.exec(name);
      if (!match) continue;
      max = Math.max(max, Number(match[1]));
      const dir = path.join(this.options.dir, name);
      let run: ScriptRun;
      try {
        run = JSON.parse(readFileSync(path.join(dir, META), "utf8")) as ScriptRun;
        if (run.id !== name || !(SCRIPT_STATUSES as readonly string[]).includes(run.status)) throw new Error("meta inválido");
      } catch {
        continue;
      }
      if (run.status === "running") {
        try {
          const pid = Number(readFileSync(path.join(dir, PID_FILE), "utf8"));
          if (Number.isInteger(pid) && pid > 1 && looksLikeOurScript(pid, scriptMark(run))) killGroupOf(pid, "SIGKILL");
        } catch {
          // sem pid
        }
        rmSync(path.join(dir, PID_FILE), { force: true });
        run.status = "lost";
        run.endedAt = this.options.now().toISOString();
        try {
          run.bytes = statSync(path.join(dir, OUTPUT)).size;
        } catch {
          // sem saída
        }
        try {
          writeFileSync(path.join(dir, META), `${JSON.stringify(run, null, 2)}\n`, "utf8");
        } catch (error) {
          this.options.log.warn({ err: error, id: run.id }, "não foi possível marcar o script como interrompido");
        }
      }
      this.runs.set(run.id, run);
    }
    this.counter = max;
    void this.prune();
  }

  /**
   * Um terminado fica `finishedTtlMs` na lista (registro do que rodou) e depois sai, com a pasta e a saída. Além
   * disso, só os `keepFinished` terminados mais novos ficam.
   */
  private async prune(): Promise<void> {
    const endOf = (run: ScriptRun) => Date.parse(run.endedAt ?? run.startedAt);
    const finished = [...this.runs.values()].filter((run) => run.status !== "running").sort((a, b) => endOf(b) - endOf(a) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
    const expiredBefore = this.options.now().getTime() - this.limits.finishedTtlMs;
    const leaving = finished.filter((run, index) => index >= this.limits.keepFinished || endOf(run) <= expiredBefore);
    for (const run of leaving) {
      this.runs.delete(run.id);
      await rm(this.dirOf(run.id), { recursive: true, force: true }).catch(() => undefined);
      this.options.publish({ type: "script:removed", id: run.id });
    }
  }

  // ---------------------------------------------------------------- ambiente

  /** A pasta pedida (ou a do agente), resolvida pelo caminho real: tem de ficar dentro da pasta do agente ou de uma pasta de trabalho dele. */
  private resolveCwd(context: ScriptAgentContext, requested: string | undefined): string {
    mkdirSync(context.cwd, { recursive: true });
    const roots = [context.cwd, ...context.folders.map((folder) => folder.path)].flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    const base = realpathSync(context.cwd);
    let target: string;
    try {
      target = realpathSync(requested?.trim() ? path.resolve(base, requested.trim()) : base);
    } catch {
      throw new HttpError(422, `The folder "${requested}" does not exist`);
    }
    if (!statSync(target).isDirectory()) throw new HttpError(422, `"${requested}" is not a folder`);
    if (!roots.some((root) => isInside(root, target))) throw new HttpError(403, "That folder is outside your folder and your work folders. Scripts run only where your own terminal can.");
    return target;
  }

  /** Programa, argumentos e ambiente: ambiente sem segredos; nos motores cercados, o mínimo e o comando dentro da mesma cerca do agente. */
  private async launchSpec(context: ScriptAgentContext, command: string, mark: string): Promise<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const base = this.options.env?.() ?? process.env;
    const bash = existsSync("/bin/bash") ? "/bin/bash" : "bash";
    if (context.fence) {
      const tmp = path.join(context.cwd, "tmp");
      await mkdir(tmp, { recursive: true });
      const env = minimalChildEnv(base, { HOME: context.cwd, TMPDIR: tmp, PYTHONUNBUFFERED: "1", [SCRIPT_MARK_ENV]: mark });
      const fenced = fencedCommand(context.fence.policy, context.fence.python, bash, ["-c", command]);
      return { file: fenced.command, args: fenced.args, env };
    }
    return { file: bash, args: ["-c", command], env: sanitizeChildEnv(base, { PYTHONUNBUFFERED: "1", [SCRIPT_MARK_ENV]: mark }) };
  }
}
