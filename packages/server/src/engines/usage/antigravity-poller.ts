import { execFile } from "node:child_process";
import os from "node:os";
import type { UsageWindow } from "@cyno/shared";
import { sanitizeChildEnv } from "../terminals/env";
import { parseAntigravityUsage } from "./antigravity-usage";
import { StaleError, UsagePoller, type UsagePollerOptions } from "./usage-poller";

export const DEFAULT_ANTIGRAVITY_POLL_MS = 5 * 60_000;

/** Motivos (pt-BR) de o uso da conta Google estar velho. */
export const ANTIGRAVITY_STALE_REASONS = {
  missing: "Antigravity CLI (agy) não encontrado neste computador",
  login: "Login do Antigravity expirado — abra o agy para entrar de novo",
  timeout: "O Antigravity demorou demais para responder",
  failed: "O Antigravity não informou a cota",
  unknownFormat: "Formato da cota do Antigravity mudou (não reconhecido)",
} as const;

/** Roda a CLI e devolve a saída (stdout); erro = rejeita com { code, killed, stdout, stderr }. */
export type RunCli = (command: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd: string }) => Promise<string>;

export type AntigravityUsagePollerOptions = UsagePollerOptions & {
  /** Executável (padrão "agy"); nos testes, o node com `prefixArgs` = [script falso]. */
  command?: string;
  prefixArgs?: string[];
  /** Tempo máximo da consulta (ms). Padrão: 30 s. */
  timeoutMs?: number;
  run?: RunCli;
};

type CliFailure = { code?: unknown; killed?: boolean; signal?: unknown; stdout?: unknown; stderr?: unknown };

const defaultRun: RunCli = (command, args, { timeoutMs, env, cwd }) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, env, cwd, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  });

const LOGIN_TEXT = /not logged|log ?in|sign ?in|authenticat|unauthori[sz]ed|credential/i;

/**
 * Consulta a cota da CONTA Google no Antigravity rodando `agy -p /usage --output-format json`: o
 * comando de barra é respondido sem turno de modelo (num_turns 0, sem conversa, sem gastar cota) e
 * o agy usa o próprio login (nada de token aqui; o server nunca lê nem guarda credencial do agy).
 * Ambiente sem chaves de API (sanitizeChildEnv), cwd neutro (pasta temporária do sistema) e nada
 * gravado no ~/.gemini além do que o agy já grava sozinho (log). Mesmo intervalo/backoff do Claude.
 */
export class AntigravityUsagePoller extends UsagePoller {
  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly timeoutMs: number;
  private readonly run: RunCli;

  constructor(options: AntigravityUsagePollerOptions) {
    super("gemini", options, { intervalMs: DEFAULT_ANTIGRAVITY_POLL_MS, fallbackReason: ANTIGRAVITY_STALE_REASONS.failed });
    this.command = options.command ?? "agy";
    this.prefixArgs = options.prefixArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.run = options.run ?? defaultRun;
  }

  protected async fetchWindows(): Promise<UsageWindow[]> {
    let stdout: string;
    try {
      stdout = await this.run(this.command, [...this.prefixArgs, "-p", "/usage", "--output-format", "json"], {
        timeoutMs: this.timeoutMs,
        env: sanitizeChildEnv(process.env),
        cwd: os.tmpdir(),
      });
    } catch (error) {
      throw new StaleError(failureReason(error as CliFailure));
    }
    let data: unknown;
    try {
      data = JSON.parse(lastJsonLine(stdout));
    } catch {
      throw new StaleError(LOGIN_TEXT.test(stdout) ? ANTIGRAVITY_STALE_REASONS.login : ANTIGRAVITY_STALE_REASONS.unknownFormat);
    }
    const status = typeof data === "object" && data !== null ? (data as { status?: unknown }).status : undefined;
    if (typeof status === "string" && status !== "SUCCESS") {
      const text = JSON.stringify(data);
      throw new StaleError(LOGIN_TEXT.test(text) ? ANTIGRAVITY_STALE_REASONS.login : ANTIGRAVITY_STALE_REASONS.failed);
    }
    const windows = parseAntigravityUsage(data);
    if (!windows) throw new StaleError(ANTIGRAVITY_STALE_REASONS.unknownFormat);
    return windows;
  }
}

/** A última linha que parece JSON (o agy pode escrever avisos antes). */
function lastJsonLine(stdout: string): string {
  const lines = stdout.split("\n").map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i]!.startsWith("{")) return lines[i]!;
  return stdout.trim();
}

function failureReason(error: CliFailure): string {
  if (error.code === "ENOENT") return ANTIGRAVITY_STALE_REASONS.missing;
  if (error.killed || error.signal === "SIGTERM") return ANTIGRAVITY_STALE_REASONS.timeout;
  const text = `${typeof error.stderr === "string" ? error.stderr : ""}\n${typeof error.stdout === "string" ? error.stdout : ""}`;
  return LOGIN_TEXT.test(text) ? ANTIGRAVITY_STALE_REASONS.login : ANTIGRAVITY_STALE_REASONS.failed;
}
