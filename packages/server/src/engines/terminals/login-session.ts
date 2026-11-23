import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ENGINE_LABELS, PTY_SIZE_LIMITS, type AccountEngine } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { sanitizeChildEnv } from "./env";
import type { EngineBinary } from "./engines";
import { loadNodePty, type PtyProcess, type PtySpawnFn } from "./pty-terminal";

/** Buffer de replay da sessão de login (~64 KiB, sempre respeitando fronteiras UTF-8). */
export const LOGIN_REPLAY_BYTES = 64 * 1024;
/** Encerra a sessão de login após 10 min sem entrada nem saída. */
export const LOGIN_IDLE_TIMEOUT_MS = 10 * 60_000;
/** Vida máxima absoluta de uma sessão de login (30 min). */
export const LOGIN_MAX_LIFETIME_MS = 30 * 60_000;
/** Intervalo de conferência do estado de login durante a sessão (2 s). */
export const LOGIN_POLL_INTERVAL_MS = 2_000;
/** Espera após detectar login concluído antes de encerrar o PTY (3 s). */
export const LOGIN_SUCCESS_GRACE_MS = 3_000;
/** Espera após o fechamento do WebSocket antes de encerrar o PTY (60 s para reconexão). */
export const LOGIN_DETACH_GRACE_MS = 60_000;

export const DEFAULT_LOGIN_PTY_SIZE = { cols: 100, rows: 30 } as const;

export type TimerHandle = unknown;

/** Relógio e temporizadores injetáveis (nos testes, relógio virtual determinístico). */
export type LoginClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
};

export const realLoginClock: LoginClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** Erro 409 quando já existe outra sessão de login ativa no servidor. */
export class LoginSessionBusyError extends HttpError {
  constructor(engine: AccountEngine, label: string) {
    super(409, `Já há uma sessão de login aberta para ${ENGINE_LABELS[engine]} / ${label}. Feche ou aguarde ela terminar.`);
  }
}

/**
 * Comando exato de login do motor (NUNCA abre shell):
 * - Claude Code: `<binário> auth login`
 * - Antigravity: `<binário>` sem argumentos (o login acontece na subida)
 */
export function loginCommandFor(engine: AccountEngine, bin: EngineBinary): { command: string; args: string[] } {
  const prefix = bin.prefixArgs ?? [];
  if (engine === "claude") return { command: bin.command, args: [...prefix, "auth", "login"] };
  return { command: bin.command, args: [...prefix] };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export type LoginSessionOptions = {
  engine: AccountEngine;
  accountId: string;
  label: string;
  binary: EngineBinary;
  /** Pasta de trabalho do PTY (pasta do perfil da conta ou pasta temporária do Cyno para `padrao`). */
  cwd: string;
  /** Variáveis de isolamento da conta (`profileEnv(conta)`); ausente para `padrao`. */
  profileEnv?: Record<string, string>;
  /** Ambiente base (padrão: `process.env`; passa sempre por `sanitizeChildEnv`). */
  env?: NodeJS.ProcessEnv;
  /** Verifica se o login desta conta foi concluído (mesma checagem de `AccountLoginChecker`). */
  checkLogin: () => Promise<boolean>;
  /** Chamado uma única vez quando o login for detectado como concluído. */
  onLoginDetected?: () => void;
  /** Chamado quando a sessão encerrar definitivamente (para o gerenciador liberar a vaga). */
  onDone?: () => void;
  spawn?: PtySpawnFn;
  clock?: LoginClock;
  replayBytes?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  pollIntervalMs?: number;
  successGraceMs?: number;
  detachGraceMs?: number;
};

/**
 * PTY mínimo e avulso para o login de uma conta de motor (`claude auth login` ou `agy`).
 * NUNCA registra em log nem na Atividade o conteúdo do terminal (contém URL com `code_challenge`
 * e o código colado pelo dono).
 */
export class LoginSession {
  readonly engine: AccountEngine;
  readonly accountId: string;
  readonly label: string;

  private readonly clock: LoginClock;
  private readonly replayBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly pollIntervalMs: number;
  private readonly successGraceMs: number;
  private readonly detachGraceMs: number;
  private readonly checkLogin: () => Promise<boolean>;
  private readonly onLoginDetected?: () => void;
  private readonly onDone?: () => void;

  private readonly pty: PtyProcess;
  private readonly dataDisposer: { dispose(): void };
  private readonly exitDisposer: { dispose(): void };

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly loginListeners = new Set<(loggedIn: boolean) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();

  private replayBuffer = "";
  private exited = false;
  private killing = false;
  private detectedLoggedIn = false;
  private checkingLogin = false;
  private clients = 0;

  private idleTimer: TimerHandle | undefined;
  private maxLifetimeTimer: TimerHandle | undefined;
  private pollTimer: TimerHandle | undefined;
  private successTimer: TimerHandle | undefined;
  private detachTimer: TimerHandle | undefined;

  private constructor(options: LoginSessionOptions, pty: PtyProcess) {
    this.engine = options.engine;
    this.accountId = options.accountId;
    this.label = options.label;
    this.clock = options.clock ?? realLoginClock;
    this.replayBytes = options.replayBytes ?? LOGIN_REPLAY_BYTES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? LOGIN_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? LOGIN_MAX_LIFETIME_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS;
    this.successGraceMs = options.successGraceMs ?? LOGIN_SUCCESS_GRACE_MS;
    this.detachGraceMs = options.detachGraceMs ?? LOGIN_DETACH_GRACE_MS;
    this.checkLogin = options.checkLogin;
    this.onLoginDetected = options.onLoginDetected;
    this.onDone = options.onDone;
    this.pty = pty;

    this.dataDisposer = this.pty.onData((chunk) => {
      if (this.exited) return;
      this.resetIdleTimer();
      this.appendReplay(chunk);
      for (const listener of this.dataListeners) listener(chunk);
    });

    this.exitDisposer = this.pty.onExit(({ exitCode }) => {
      void this.handlePtyExit(typeof exitCode === "number" ? exitCode : null);
    });

    this.resetIdleTimer();
    this.maxLifetimeTimer = this.clock.setTimeout(() => this.kill(), this.maxLifetimeMs);
    this.pollTimer = this.clock.setInterval(() => {
      void this.pollLogin();
    }, this.pollIntervalMs);
  }

  /** Cria e inicia o PTY de login (nunca abre shell; ambiente sanitizado com `TERM=xterm-256color`). */
  static async start(options: LoginSessionOptions): Promise<LoginSession> {
    await mkdir(options.cwd, { recursive: true, mode: 0o700 });
    const spawnFn = options.spawn ?? (await loadNodePty());
    const { command, args } = loginCommandFor(options.engine, options.binary);
    const env = sanitizeChildEnv(options.env ?? process.env, {
      ...(options.profileEnv ?? {}),
      TERM: "xterm-256color",
    });
    const pty = spawnFn(command, args, {
      cwd: options.cwd,
      env,
      cols: DEFAULT_LOGIN_PTY_SIZE.cols,
      rows: DEFAULT_LOGIN_PTY_SIZE.rows,
      name: "xterm-256color",
    });
    return new LoginSession(options, pty);
  }

  /** Buffer recente da saída do terminal (até ~64 KiB) para reconexão. */
  replay(): string {
    return this.replayBuffer;
  }

  /** Envia teclas/colagem ao PTY e reinicia o temporizador de inatividade. */
  write(data: string): void {
    if (this.exited) return;
    this.resetIdleTimer();
    this.pty.write(data);
  }

  /** Redimensiona o PTY dentro dos limites seguros. */
  resize(cols: number, rows: number): void {
    if (this.exited) return;
    const safeCols = clamp(cols, PTY_SIZE_LIMITS.minCols, PTY_SIZE_LIMITS.maxCols);
    const safeRows = clamp(rows, PTY_SIZE_LIMITS.minRows, PTY_SIZE_LIMITS.maxRows);
    this.pty.resize(safeCols, safeRows);
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onLogin(listener: (loggedIn: boolean) => void): () => void {
    this.loginListeners.add(listener);
    return () => {
      this.loginListeners.delete(listener);
    };
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** Registra um WebSocket conectado (cancela o prazo de 60 s de desconexão); devolve a função de desconectar. */
  attach(): () => void {
    this.clients += 1;
    if (this.detachTimer !== undefined) {
      this.clock.clearTimeout(this.detachTimer);
      this.detachTimer = undefined;
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.clients = Math.max(0, this.clients - 1);
      if (this.clients === 0 && !this.exited && !this.killing) {
        this.detachTimer = this.clock.setTimeout(() => {
          this.detachTimer = undefined;
          if (this.clients === 0) this.kill();
        }, this.detachGraceMs);
      }
    };
  }

  clientCount(): number {
    return this.clients;
  }

  alive(): boolean {
    return !this.exited;
  }

  loggedIn(): boolean {
    return this.detectedLoggedIn;
  }

  /** Encerra o processo do PTY e limpa todos os temporizadores. */
  kill(): void {
    if (this.exited || this.killing) return;
    this.killing = true;
    this.clearTimers();
    try {
      this.pty.kill("SIGTERM");
    } catch {
      // processo já saiu
      this.finish(null);
    }
  }

  private appendReplay(chunk: string): void {
    this.replayBuffer += chunk;
    if (Buffer.byteLength(this.replayBuffer, "utf8") <= this.replayBytes) return;
    const buf = Buffer.from(this.replayBuffer, "utf8");
    const sliced = buf.subarray(buf.length - this.replayBytes);
    let start = 0;
    while (start < sliced.length && (sliced[start]! & 0xc0) === 0x80) start += 1;
    this.replayBuffer = sliced.subarray(start).toString("utf8");
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== undefined) this.clock.clearTimeout(this.idleTimer);
    if (this.exited || this.killing) return;
    this.idleTimer = this.clock.setTimeout(() => this.kill(), this.idleTimeoutMs);
  }

  private async pollLogin(): Promise<void> {
    if (this.exited || this.detectedLoggedIn || this.checkingLogin) return;
    this.checkingLogin = true;
    try {
      const ok = await this.checkLogin().catch(() => false);
      if (ok && !this.exited && !this.detectedLoggedIn) {
        this.markLoggedIn();
      }
    } finally {
      this.checkingLogin = false;
    }
  }

  private markLoggedIn(): void {
    if (this.detectedLoggedIn) return;
    this.detectedLoggedIn = true;
    if (this.pollTimer !== undefined) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.onLoginDetected?.();
    for (const listener of this.loginListeners) listener(true);
    if (!this.exited && !this.killing) {
      this.successTimer = this.clock.setTimeout(() => {
        this.successTimer = undefined;
        this.kill();
      }, this.successGraceMs);
    }
  }

  private async handlePtyExit(code: number | null): Promise<void> {
    if (this.exited) return;
    // Se a CLI saiu com código 0 logo após gravar o token (antes do próximo poll de 2 s), confere uma última vez.
    if (code === 0 && !this.detectedLoggedIn && !this.killing) {
      const ok = await this.checkLogin().catch(() => false);
      if (ok && !this.exited && !this.detectedLoggedIn) {
        this.markLoggedIn();
      }
    }
    this.finish(code);
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.clearTimers();
    this.dataDisposer.dispose();
    this.exitDisposer.dispose();
    this.onDone?.();
    for (const listener of this.exitListeners) listener(code);
  }

  private clearTimers(): void {
    if (this.idleTimer !== undefined) {
      this.clock.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.maxLifetimeTimer !== undefined) {
      this.clock.clearTimeout(this.maxLifetimeTimer);
      this.maxLifetimeTimer = undefined;
    }
    if (this.pollTimer !== undefined) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.successTimer !== undefined) {
      this.clock.clearTimeout(this.successTimer);
      this.successTimer = undefined;
    }
    if (this.detachTimer !== undefined) {
      this.clock.clearTimeout(this.detachTimer);
      this.detachTimer = undefined;
    }
  }
}

export type LoginSessionManagerOptions = {
  /** Pasta base de dados do Cyno (`DATA_DIR`, usada para a pasta temporária da conta `padrao`). */
  dataDir: string;
  spawn?: PtySpawnFn;
  clock?: LoginClock;
  env?: NodeJS.ProcessEnv;
  replayBytes?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  pollIntervalMs?: number;
  successGraceMs?: number;
  detachGraceMs?: number;
  /** Registra na Atividade SÓ abertura e conclusão do login (nunca conteúdo do terminal). */
  record?: (action: string, summary: string, data?: Record<string, unknown>) => void;
};

export type OpenLoginSessionInput = {
  engine: AccountEngine;
  accountId: string;
  label: string;
  binary: EngineBinary;
  cwd?: string;
  profileEnv?: Record<string, string>;
  checkLogin: () => Promise<boolean>;
  onLoginDetected?: () => void;
};

/**
 * Garante no máximo UMA sessão de login aberta em todo o servidor:
 * - Reconexão à mesma conta enquanto o socket anterior fechou há menos de 60 s reaproveita a sessão e o replay;
 * - Qualquer segunda tentativa simultânea (ou de outra conta) falha com `LoginSessionBusyError` (409 em pt-BR).
 */
export class LoginSessionManager {
  private active: LoginSession | undefined;
  private starting = false;

  constructor(private readonly options: LoginSessionManagerOptions) {}

  current(): LoginSession | undefined {
    return this.active?.alive() ? this.active : undefined;
  }

  /** Verifica se é possível abrir ou reconectar para `(engine, accountId)`; lança 409 se ocupado. */
  assertAvailable(engine: AccountEngine, accountId: string): void {
    if (this.starting) {
      const current = this.active;
      throw new LoginSessionBusyError(current?.engine ?? engine, current?.label ?? "outra conta");
    }
    const current = this.current();
    if (!current) return;
    if (current.engine === engine && current.accountId === accountId && current.clientCount() === 0) return;
    throw new LoginSessionBusyError(current.engine, current.label);
  }

  /** Abre uma nova sessão de login ou reconecta à sessão existente da mesma conta (se desconectada). */
  async openOrReconnect(input: OpenLoginSessionInput): Promise<{ session: LoginSession; reconnected: boolean }> {
    this.assertAvailable(input.engine, input.accountId);
    const existing = this.current();
    if (existing && existing.engine === input.engine && existing.accountId === input.accountId && existing.clientCount() === 0) {
      return { session: existing, reconnected: true };
    }

    this.starting = true;
    try {
      const cwd = input.cwd ?? path.join(this.options.dataDir, "platform", "engines", "login-tmp");
      const session = await LoginSession.start({
        engine: input.engine,
        accountId: input.accountId,
        label: input.label,
        binary: input.binary,
        cwd,
        ...(input.profileEnv ? { profileEnv: input.profileEnv } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        checkLogin: input.checkLogin,
        onLoginDetected: () => {
          input.onLoginDetected?.();
          this.options.record?.(
            "conta_motor_login_concluido",
            `Login concluído para ${ENGINE_LABELS[input.engine]} / ${input.label}`,
            { engine: input.engine, accountId: input.accountId, label: input.label },
          );
        },
        onDone: () => {
          if (this.active === session) this.active = undefined;
        },
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(this.options.clock ? { clock: this.options.clock } : {}),
        ...(this.options.replayBytes !== undefined ? { replayBytes: this.options.replayBytes } : {}),
        ...(this.options.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.options.idleTimeoutMs } : {}),
        ...(this.options.maxLifetimeMs !== undefined ? { maxLifetimeMs: this.options.maxLifetimeMs } : {}),
        ...(this.options.pollIntervalMs !== undefined ? { pollIntervalMs: this.options.pollIntervalMs } : {}),
        ...(this.options.successGraceMs !== undefined ? { successGraceMs: this.options.successGraceMs } : {}),
        ...(this.options.detachGraceMs !== undefined ? { detachGraceMs: this.options.detachGraceMs } : {}),
      });
      this.active = session;
      this.options.record?.(
        "conta_motor_login_aberto",
        `O dono abriu o login de ${ENGINE_LABELS[input.engine]} / ${input.label}`,
        { engine: input.engine, accountId: input.accountId, label: input.label },
      );
      return { session, reconnected: false };
    } finally {
      this.starting = false;
    }
  }

  /** Encerra qualquer sessão ativa no fechamento do servidor. */
  close(): void {
    const current = this.active;
    this.active = undefined;
    current?.kill();
  }
}
