import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOGIN_DETACH_GRACE_MS,
  LOGIN_IDLE_TIMEOUT_MS,
  LOGIN_MAX_LIFETIME_MS,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_REPLAY_BYTES,
  LOGIN_SUCCESS_GRACE_MS,
  LoginSessionBusyError,
  LoginSessionManager,
  type LoginClock,
} from "./login-session";
import type { PtyProcess, PtySpawnFn } from "./pty-terminal";

/** Relógio virtual determinístico para testar todos os timeouts sem sleeps reais. */
class VirtualClock implements LoginClock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; interval?: number; fn: () => void }>();

  now = (): number => this.time;

  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  setInterval = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, interval: ms, fn });
    return id;
  };

  clearInterval = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, entry] of this.timers) {
        if (entry.at <= target && entry.at < nextAt) {
          nextAt = entry.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const entry = this.timers.get(nextId)!;
      this.time = entry.at;
      if (entry.interval !== undefined) {
        entry.at += entry.interval;
      } else {
        this.timers.delete(nextId);
      }
      entry.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
  }
}

type FakePtyRecord = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  writes: string[];
  resizes: { cols: number; rows: number }[];
  killed: boolean;
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
};

function createFakeSpawn(): { spawn: PtySpawnFn; spawned: FakePtyRecord[] } {
  const spawned: FakePtyRecord[] = [];
  const spawn: PtySpawnFn = (file, args, options) => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
    let exited = false;
    const emitExit = (code: number) => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener({ exitCode: code });
    };
    const record: FakePtyRecord = {
      file,
      args,
      cwd: options.cwd,
      env: options.env,
      writes: [],
      resizes: [],
      killed: false,
      emitData: (data) => {
        for (const listener of dataListeners) listener(data);
      },
      emitExit,
    };
    spawned.push(record);
    const pty: PtyProcess = {
      pid: 10_000 + spawned.length,
      onData(listener) {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
      write(data) {
        record.writes.push(data);
      },
      resize(cols, rows) {
        record.resizes.push({ cols, rows });
      },
      kill() {
        record.killed = true;
        emitExit(143);
      },
    };
    return pty;
  };
  return { spawn, spawned };
}

describe("LoginSession e LoginSessionManager (PTY avulso com spawn falso)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });
  const temp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyno-login-session-"));
    dirs.push(dir);
    return dir;
  };

  it("roda só o comando de login (nunca shell), sanitiza env com TERM=xterm-256color, faz replay (~64 KiB) e resize", async () => {
    const dataDir = await temp();
    const profileDir = path.join(dataDir, "perfil");
    const clock = new VirtualClock();
    const { spawn, spawned } = createFakeSpawn();
    const activity: { action: string; summary: string; data?: Record<string, unknown> }[] = [];

    const manager = new LoginSessionManager({
      dataDir,
      spawn,
      clock,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/original",
        ANTHROPIC_API_KEY: "sk-ant-segredo",
        GEMINI_API_KEY: "gemini-segredo",
        CLAUDECODE: "1",
      },
      record: (action, summary, data) => activity.push({ action, summary, data }),
    });

    const { session } = await manager.openOrReconnect({
      engine: "claude",
      accountId: "trabalho",
      label: "Trabalho",
      binary: { command: "/opt/claude" },
      cwd: profileDir,
      profileEnv: { CLAUDE_CONFIG_DIR: profileDir },
      checkLogin: async () => false,
    });
    const detach = session.attach();

    expect(spawned).toHaveLength(1);
    const proc = spawned[0]!;
    expect(proc.file).toBe("/opt/claude");
    expect(proc.args).toEqual(["auth", "login"]);
    expect(proc.cwd).toBe(profileDir);
    expect(proc.env.TERM).toBe("xterm-256color");
    expect(proc.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(proc.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(proc.env.GEMINI_API_KEY).toBeUndefined();
    expect(proc.env.CLAUDECODE).toBeUndefined();

    // Replay: mantém só os últimos ~64 KiB.
    const bigChunk = `https://claude.ai/oauth?code_challenge=SEGREDO_URL\n${"a".repeat(LOGIN_REPLAY_BYTES + 1024)}FIM`;
    proc.emitData(bigChunk);
    expect(Buffer.byteLength(session.replay(), "utf8")).toBeLessThanOrEqual(LOGIN_REPLAY_BYTES);
    expect(session.replay().endsWith("FIM")).toBe(true);

    // Write e resize.
    session.write("CODIGO-COLADO-123\r");
    session.resize(132, 40);
    expect(proc.writes).toEqual(["CODIGO-COLADO-123\r"]);
    expect(proc.resizes).toEqual([{ cols: 132, rows: 40 }]);

    // Atividade registra só abertura (nunca link nem código).
    expect(activity).toHaveLength(1);
    expect(activity[0]!.action).toBe("conta_motor_login_aberto");
    expect(activity[0]!.summary).toContain("Claude Code");
    expect(activity[0]!.summary).toContain("Trabalho");
    expect(JSON.stringify(activity)).not.toContain("SEGREDO_URL");
    expect(JSON.stringify(activity)).not.toContain("CODIGO-COLADO-123");

    detach();
    manager.close();
  });

  it("permite só UMA sessão por vez no servidor (segunda recebe 409 em pt-BR) e reconecta na mesma dentro de 60 s", async () => {
    const dataDir = await temp();
    const clock = new VirtualClock();
    const { spawn, spawned } = createFakeSpawn();
    const manager = new LoginSessionManager({ dataDir, spawn, clock });

    const first = await manager.openOrReconnect({
      engine: "gemini",
      accountId: "padrao",
      label: "Padrão",
      binary: { command: "/opt/agy" },
      checkLogin: async () => false,
    });
    expect(spawned[0]!.args).toEqual([]);
    const detachFirst = first.session.attach();

    // Segunda tentativa simultânea (mesma ou outra conta) -> 409 em pt-BR.
    await expect(
      manager.openOrReconnect({
        engine: "claude",
        accountId: "outra",
        label: "Outra",
        binary: { command: "/opt/claude" },
        checkLogin: async () => false,
      }),
    ).rejects.toThrow(LoginSessionBusyError);

    // Fecha o socket: continua vivo por 60 s e aceita reconexão da mesma conta.
    detachFirst();
    await clock.advance(LOGIN_DETACH_GRACE_MS - 5_000);
    expect(first.session.alive()).toBe(true);

    // Outra conta ainda recebe 409 durante a janela de reconexão.
    await expect(
      manager.openOrReconnect({
        engine: "claude",
        accountId: "outra",
        label: "Outra",
        binary: { command: "/opt/claude" },
        checkLogin: async () => false,
      }),
    ).rejects.toThrow(LoginSessionBusyError);

    // Mesma conta reconecta sem criar novo PTY e cancela o prazo de morte.
    const reconnected = await manager.openOrReconnect({
      engine: "gemini",
      accountId: "padrao",
      label: "Padrão",
      binary: { command: "/opt/agy" },
      checkLogin: async () => false,
    });
    expect(reconnected.reconnected).toBe(true);
    expect(reconnected.session).toBe(first.session);
    expect(spawned).toHaveLength(1);
    const detachSecond = reconnected.session.attach();

    // Desconecta de novo e espera 60 s -> morre.
    detachSecond();
    await clock.advance(LOGIN_DETACH_GRACE_MS);
    expect(first.session.alive()).toBe(false);
    expect(spawned[0]!.killed).toBe(true);
    expect(manager.current()).toBeUndefined();
  });

  it("timeouts com relógio injetado: encerra em 10 min de inatividade e no máximo em 30 min de vida", async () => {
    const dataDir = await temp();
    const clock = new VirtualClock();
    const { spawn, spawned } = createFakeSpawn();
    const manager = new LoginSessionManager({ dataDir, spawn, clock });

    // Teste de inatividade (10 min).
    const idleRun = await manager.openOrReconnect({
      engine: "claude",
      accountId: "a",
      label: "Conta A",
      binary: { command: "/opt/claude" },
      checkLogin: async () => false,
    });
    const detachA = idleRun.session.attach();
    await clock.advance(LOGIN_IDLE_TIMEOUT_MS - 1_000);
    expect(idleRun.session.alive()).toBe(true);
    // Entrada zera o prazo de inatividade.
    idleRun.session.write("x");
    await clock.advance(LOGIN_IDLE_TIMEOUT_MS - 1_000);
    expect(idleRun.session.alive()).toBe(true);
    await clock.advance(1_000);
    expect(idleRun.session.alive()).toBe(false);
    expect(spawned[0]!.killed).toBe(true);
    detachA();

    // Teste de vida máxima (30 min mesmo com atividade constante).
    const maxRun = await manager.openOrReconnect({
      engine: "gemini",
      accountId: "b",
      label: "Conta B",
      binary: { command: "/opt/agy" },
      checkLogin: async () => false,
    });
    const detachB = maxRun.session.attach();
    for (let step = 0; step < 5; step += 1) {
      await clock.advance(5 * 60_000);
      maxRun.session.write("ping");
    }
    expect(maxRun.session.alive()).toBe(true);
    await clock.advance(5 * 60_000);
    expect(maxRun.session.alive()).toBe(false);
    expect(spawned[1]!.killed).toBe(true);
    expect(LOGIN_MAX_LIFETIME_MS).toBe(30 * 60_000);
    detachB();
  });

  it("detecta login feito no poll de 2 s, manda login=true, registra na Atividade e encerra 3 s depois", async () => {
    const dataDir = await temp();
    const clock = new VirtualClock();
    const { spawn, spawned } = createFakeSpawn();
    const activity: { action: string; summary: string }[] = [];
    const manager = new LoginSessionManager({
      dataDir,
      spawn,
      clock,
      record: (action, summary) => activity.push({ action, summary }),
    });

    let logged = false;
    const { session } = await manager.openOrReconnect({
      engine: "gemini",
      accountId: "google-1",
      label: "Google 1",
      binary: { command: "/opt/agy" },
      checkLogin: async () => logged,
    });
    const detach = session.attach();

    const loginEvents: boolean[] = [];
    const exitEvents: (number | null)[] = [];
    session.onLogin((value) => loginEvents.push(value));
    session.onExit((code) => exitEvents.push(code));

    spawned[0]!.emitData("https://accounts.google.com/?code_challenge=SIGILOSO\n");
    await clock.advance(LOGIN_POLL_INTERVAL_MS);
    expect(loginEvents).toEqual([]);

    // O usuário cola o código e o arquivo de token aparece.
    logged = true;
    await clock.advance(LOGIN_POLL_INTERVAL_MS);
    expect(loginEvents).toEqual([true]);
    expect(session.alive()).toBe(true);
    expect(activity.map((a) => a.action)).toEqual(["conta_motor_login_aberto", "conta_motor_login_concluido"]);
    expect(JSON.stringify(activity)).not.toContain("SIGILOSO");

    // 2 s depois ainda está vivo; aos 3 s encerra.
    await clock.advance(LOGIN_SUCCESS_GRACE_MS - 1_000);
    expect(session.alive()).toBe(true);
    await clock.advance(1_000);
    expect(session.alive()).toBe(false);
    expect(exitEvents).toHaveLength(1);
    detach();
  });
});
