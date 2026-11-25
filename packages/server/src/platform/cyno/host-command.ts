import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { HOST_COMMAND_LIMITS } from "@cyno/shared";
import { sanitizeChildEnv } from "../../engines/terminals/env";
import { errorMessage } from "../../util/text";

/** Comandos que elevam privilégio: o Cyno nunca os roda (o dono roda sozinho, com o comando mostrado no chat). */
const ELEVATORS = new Set(["sudo", "su", "doas", "pkexec", "sudoedit", "run0"]);
/** Programas que recebem outro comando (ou um programa inteiro) como argumento: o texto também é conferido. */
const WRAPPERS = new Set(["bash", "bash.exe", "sh", "zsh", "dash", "fish", "ksh", "powershell", "pwsh", "cmd", "wsl", "env", "xargs", "nohup", "timeout", "nice", "setsid", "exec", "time", "watch"]);

export type HostCommandInput = { command: string; args: string[]; cwd?: string };

export type HostCommandResult = {
  ok: boolean;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  /** Saída (stdout + stderr) cortada em `HOST_COMMAND_LIMITS.outputChars`. */
  output: string;
  truncated: boolean;
  durationMs: number;
};

/** Motivo (em inglês, para o Cyno) se o comando não pode nem ser proposto; undefined se pode. */
export function refuseHostCommand(input: HostCommandInput): string | undefined {
  if (!input.command.trim()) return "Refused: the command is empty.";
  const normalizeName = (raw: string) => (raw.split(/[\\/]/).pop() ?? raw).toLowerCase();
  const isWrapper = (candidate: string) => WRAPPERS.has(candidate) || WRAPPERS.has(candidate.replace(/\.exe$/i, ""));
  const isElevator = (candidate: string) => ELEVATORS.has(candidate) || ELEVATORS.has(candidate.replace(/\.exe$/i, ""));
  const name = normalizeName(input.command.trim());
  const words = [input.command, ...input.args].flatMap((text) => text.split(/[\s;&|()`$<>"']+/)).map(normalizeName);
  if (isElevator(name) || (isWrapper(name) && words.some(isElevator))) {
    return "Refused: the Cyno never runs commands with sudo or other privilege elevation. Show the exact command to the owner in the chat (in a code block) and tell them to run it themselves in a terminal, then continue when they say it is done.";
  }
  return undefined;
}

/**
 * Roda UM comando nesta máquina, sem shell (`execFile` com a lista de argumentos), com tempo limite e a
 * saída cortada. Chamado só pela rota do dono depois do OK (nunca pelo MCP). O ambiente passa por
 * `sanitizeChildEnv` (sem chaves de API). Cada execução vai para `host-commands.jsonl`.
 */
export class HostCommandRunner {
  constructor(private readonly options: { workDir: string; logFile: string; env?: NodeJS.ProcessEnv; now: () => Date }) {}

  /** A pasta onde o comando roda: a de trabalho da plataforma, ou a pedida (caminho absoluto, mostrado no cartão). */
  cwdOf(requested: string | undefined): string {
    const wanted = requested?.trim();
    return wanted ? path.resolve(wanted) : this.options.workDir;
  }

  async run(input: HostCommandInput & { timeoutSec?: number; requestedBy?: string }): Promise<HostCommandResult> {
    const refusal = refuseHostCommand(input);
    if (refusal) throw new Error(refusal);
    const cwd = this.cwdOf(input.cwd);
    await mkdir(this.options.workDir, { recursive: true });
    const timeoutMs = Math.min(input.timeoutSec ?? HOST_COMMAND_LIMITS.timeoutDefaultSec, HOST_COMMAND_LIMITS.timeoutMaxSec) * 1000;
    const started = Date.now();
    const result = await new Promise<HostCommandResult>((resolve) => {
      execFile(
        input.command,
        input.args,
        { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: sanitizeChildEnv(this.options.env ?? process.env), windowsHide: true },
        (error, stdout, stderr) => {
          const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
          const raw = `${stdout}${stderr}`.replace(/\r\n/g, "\n");
          const timedOut = failure !== null && failure.killed === true && failure.signal === "SIGKILL";
          const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : null;
          // Não achou o programa / pasta inválida: a saída é o erro do sistema.
          const full = raw || (failure !== null && typeof failure.code === "string" ? errorMessage(failure) : "");
          const truncated = full.length > HOST_COMMAND_LIMITS.outputChars;
          resolve({
            ok: failure === null,
            exitCode: code,
            ...(failure?.signal ? { signal: failure.signal } : {}),
            timedOut,
            output: truncated ? `${full.slice(0, HOST_COMMAND_LIMITS.outputChars)}\n[output cut at ${HOST_COMMAND_LIMITS.outputChars} characters]` : full,
            truncated,
            durationMs: Date.now() - started,
          });
        },
      );
    });
    await this.record(input, cwd, result);
    return result;
  }

  private async record(input: HostCommandInput & { requestedBy?: string }, cwd: string, result: HostCommandResult): Promise<void> {
    try {
      await mkdir(path.dirname(this.options.logFile), { recursive: true });
      await appendFile(this.options.logFile, `${JSON.stringify({ at: this.options.now().toISOString(), command: input.command, args: input.args, cwd, ...result, ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}) })}\n`, "utf8");
    } catch {
      // O registro é melhor-esforço: a execução já aconteceu.
    }
  }
}

/** O comando como uma linha legível ("ls -la /tmp"), para o resumo do cartão (argumentos com espaço entre aspas). */
export function commandLine(command: string, args: readonly string[]): string {
  const quote = (text: string) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);
  return [command, ...args].map(quote).join(" ");
}
