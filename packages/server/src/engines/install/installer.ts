import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineInstallJob, InstallableEngineId } from "@cyno/shared";
import { detachedSpawnOptions, isProcessAlive, killProcessTree } from "../../platform/os";
import { sanitizeChildEnv } from "../terminals/env";
import { errorMessage } from "../../util/text";
import type { InstallRecipe } from "./recipes";

export type InstallFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type EngineInstallerOptions = {
  now: () => Date;
  /** Baixar um arquivo (nos testes: sem rede). */
  fetch?: InstallFetch;
  /** Tempo máximo de um passo de `run` (ms). Padrão: 20 min. */
  stepTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Arquivo de trava entre reinícios (`{ pid, childPid?, at }`): uma instalação que o servidor anterior deixou rodando (ele caiu) ainda
   * conta como em andamento enquanto o processo dele ou o filho dela existirem. Ausente = só a trava em memória.
   */
  lockFile?: string;
  /** A instalação mudou de estado (a tela refaz o estado; a Atividade registra o fim). */
  onChange?: (job: EngineInstallJob) => void;
};

const LOG_LINES = 200;

const alive = (pid: number | undefined): boolean => isProcessAlive(pid);

/** Encerra a árvore do filho (grupo no Linux; taskkill /T /F no Windows). */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  killProcessTree(child.pid, signal);
}

/**
 * Instalador dos motores: um por vez em todo o servidor. Roda os passos da receita sem shell, guarda as últimas
 * linhas de saída e o resultado. Só é chamado depois da confirmação do dono (a rota exige `confirm: true`).
 */
export class EngineInstaller {
  private job: EngineInstallJob | undefined;
  private running: Promise<void> | undefined;
  private counter = 0;
  private child: ChildProcess | undefined;
  private closed = false;

  constructor(private readonly options: EngineInstallerOptions) {}

  current(): EngineInstallJob | undefined {
    return this.job ? { ...this.job, log: [...this.job.log] } : undefined;
  }

  /** Começa a instalação (devolve o job na hora; a instalação segue em segundo plano). Lança se já há uma. */
  start(engine: InstallableEngineId, recipe: InstallRecipe): EngineInstallJob {
    if (this.closed) throw new Error("O servidor está fechando.");
    if (recipe.unavailableReason) throw new Error(recipe.unavailableReason);
    if (this.running) throw new Error("Já há uma instalação em andamento. Espere terminar.");
    if (this.otherInstallRunning()) throw new Error("Já há uma instalação em andamento (iniciada antes de o servidor reiniciar). Espere terminar.");
    const job: EngineInstallJob = { id: `inst-${++this.counter}-${Date.now().toString(36)}`, engine, status: "running", startedAt: this.options.now().toISOString(), log: [] };
    this.job = job;
    this.writeLock();
    this.running = this.run(job, recipe).finally(() => {
      this.running = undefined;
      this.removeLock();
    });
    return { ...job, log: [] };
  }

  /** Espera a instalação em andamento (testes e shutdown). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Fechamento do servidor: encerra o grupo de processos da instalação (SIGTERM e depois SIGKILL) e solta a trava. */
  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child) {
      killGroup(child, "SIGTERM");
      const killer = setTimeout(() => killGroup(child, "SIGKILL"), 3000);
      killer.unref();
      await this.running?.catch(() => undefined);
      clearTimeout(killer);
    }
    this.removeLock();
  }

  /** A trava de um servidor anterior (ou de outro processo) ainda vale? O pid dele ou o filho da instalação ainda existe. */
  private otherInstallRunning(): boolean {
    const file = this.options.lockFile;
    if (!file) return false;
    try {
      const lock = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; childPid?: unknown };
      if (lock.pid === process.pid) return false;
      return alive(typeof lock.pid === "number" ? lock.pid : undefined) || alive(typeof lock.childPid === "number" ? lock.childPid : undefined);
    } catch {
      return false;
    }
  }

  private writeLock(childPid?: number): void {
    const file = this.options.lockFile;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, ...(childPid ? { childPid } : {}), at: this.options.now().toISOString() })}\n`, { mode: 0o600 });
    } catch {
      // sem a trava só vale a de memória
    }
  }

  private removeLock(): void {
    const file = this.options.lockFile;
    if (!file) return;
    try {
      const lock = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      if (lock.pid === process.pid) rmSync(file, { force: true });
    } catch {
      // já não existe
    }
  }

  private note(job: EngineInstallJob, line: string): void {
    const text = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"), "").trimEnd();
    if (!text) return;
    job.log.push(text.slice(0, 400));
    if (job.log.length > LOG_LINES) job.log.shift();
  }

  private async run(job: EngineInstallJob, recipe: InstallRecipe): Promise<void> {
    try {
      for (const step of recipe.steps) {
        this.note(job, `> ${step.label}`);
        this.options.onChange?.(job);
        if (step.kind === "download") await this.download(job, step.url, step.to, step.mode);
        else await this.exec(job, step.command, step.args, step.cwd, step.env);
      }
      job.status = "done";
      this.note(job, "Instalação concluída.");
    } catch (error) {
      job.status = "failed";
      job.error = errorMessage(error);
      this.note(job, `Falhou: ${job.error}`);
    }
    job.finishedAt = this.options.now().toISOString();
    this.options.onChange?.(job);
  }

  private async download(job: EngineInstallJob, url: string, to: string, mode = 0o600): Promise<void> {
    const run = this.options.fetch ?? ((target) => fetch(target));
    const response = await run(url);
    if (!response.ok) throw new Error(`O download de ${url} respondeu ${response.status}.`);
    const text = await response.text();
    if (!text.trim()) throw new Error(`O arquivo baixado de ${url} veio vazio.`);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, text, { mode });
    await chmod(to, mode);
    this.note(job, `Baixado: ${to} (${text.length} bytes)`);
  }

  private async exec(job: EngineInstallJob, command: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
    if (cwd) await mkdir(cwd, { recursive: true });
    if (env?.HOME) await mkdir(env.HOME, { recursive: true });
    if (env?.USERPROFILE && env.USERPROFILE !== env.HOME) await mkdir(env.USERPROFILE, { recursive: true });
    return new Promise((resolve, reject) => {
      // Grupo próprio no Linux; no Windows usa windowsHide sem detached e encerra pela árvore.
      const child = spawn(command, args, { ...(cwd ? { cwd } : {}), env: { ...sanitizeChildEnv(this.options.env ?? process.env), ...env }, stdio: ["ignore", "pipe", "pipe"], ...detachedSpawnOptions() });
      this.child = child;
      this.writeLock(child.pid);
      const timer = setTimeout(() => {
        killGroup(child, "SIGTERM");
        setTimeout(() => killGroup(child, "SIGKILL"), 3000).unref();
        reject(new Error("A instalação passou do tempo máximo e foi encerrada."));
      }, this.options.stepTimeoutMs ?? 20 * 60_000);
      timer.unref();
      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) this.note(job, line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (error) => {
        clearTimeout(timer);
        this.child = undefined;
        reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`Comando ${command} não encontrado.`) : error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.child = undefined;
        if (code === 0) resolve();
        else reject(new Error(`O comando terminou com código ${code ?? "?"}.`));
      });
    });
  }
}
