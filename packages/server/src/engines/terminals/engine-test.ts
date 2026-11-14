import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineTestResult, SupportedEngineId, TurnUsage } from "@cyno/shared";
import { errorMessage, shorten } from "../../util/text";
import { AntigravityCliAdapter } from "./antigravity-adapter";
import { ClaudeCliAdapter } from "./claude-adapter";
import type { CliAdapter, TerminalSpec } from "./types";

/**
 * "Testar" da tela Motores: um pedido mínimo ao motor ("responda só: ok"), no mesmo comando que o
 * adaptador usa para os agentes (mesma CLI, mesmas travas, sem chave de API), numa pasta temporária
 * vazia e SEM o MCP do escritório. Gasta algumas centenas de tokens da assinatura. O resultado diz o
 * que a CLI respondeu, quanto demorou e, se falhou, uma mensagem clara.
 */

export const ENGINE_TEST_MESSAGE = "Responda só com a palavra: ok";
/** Modelo e esforço mais baratos de cada motor para o teste. */
export const ENGINE_TEST_MODELS: Record<SupportedEngineId, { model: string; effort?: "low" }> = {
  claude: { model: "haiku", effort: "low" },
  gemini: { model: "gemini-3.8-flash-low" },
};
export const ENGINE_TEST_TIMEOUT_MS = 90_000;
/** Intervalo mínimo entre dois testes do mesmo motor. */
export const ENGINE_TEST_MIN_GAP_MS = 20_000;

export type EngineTestOptions = {
  engine: SupportedEngineId;
  /** Executável e argumentos fixos (nos testes: o node com a CLI falsa). */
  command: string;
  prefixArgs?: string[];
  /** Pasta onde criar a pasta temporária do teste (ex.: DATA_DIR/platform/engine-tests). */
  workDir: string;
  /** O pedido (padrão: ENGINE_TEST_MESSAGE; os testes mandam diretivas da CLI falsa). */
  message?: string;
  model?: string;
  timeoutMs?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** O teste gastou tokens da assinatura: quem chama registra no histórico de uso (com a marca de teste). */
  onUsage?: (spent: { usage: TurnUsage; model: string; durationMs: number }) => void;
};

function adapterFor(options: EngineTestOptions): CliAdapter {
  const common = { command: options.command, ...(options.prefixArgs ? { prefixArgs: options.prefixArgs } : {}) };
  return options.engine === "claude" ? new ClaudeCliAdapter({ ...common, defaultEffort: "low", autocompact: "" }) : new AntigravityCliAdapter(common);
}

/** Texto curto do erro da CLI para o dono ("login expirado", "limite", "não achei o comando"…). */
export function describeTestFailure(raw: string, engine: SupportedEngineId): string {
  const text = raw.trim();
  if (/ENOENT|not found|não encontrado/i.test(text)) return "Não achei o executável. Confira o caminho em Configurar.";
  if (/not logged|log ?in|sign ?in|authenticat|unauthori[sz]ed|credential|expired/i.test(text)) {
    return `Sem login ou login expirado. Rode \`${engine === "claude" ? "claude" : "agy"}\` no terminal e entre de novo.`;
  }
  if (/rate.?limit|quota|usage limit|hit your limit|limit reached|429|exhausted/i.test(text)) return "A cota da assinatura acabou por agora. Tente de novo quando renovar.";
  return text ? shorten(text, 300) : "O motor não respondeu.";
}

/**
 * Roda o teste. Nunca lança: qualquer falha vira `{ ok: false, error }`. A pasta temporária some no fim.
 */
export async function runEngineTest(options: EngineTestOptions): Promise<EngineTestResult> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const defaults = ENGINE_TEST_MODELS[options.engine];
  const model = options.model ?? defaults.model;
  const finish = (partial: { ok: boolean; text?: string; error?: string; tokens?: number }): EngineTestResult => ({
    ok: partial.ok,
    ms: Date.now() - started,
    at: now().toISOString(),
    model,
    ...(partial.text ? { text: partial.text } : {}),
    ...(partial.error ? { error: partial.error } : {}),
    ...(partial.tokens ? { tokens: partial.tokens } : {}),
  });
  const cwd = path.join(options.workDir, `${options.engine}-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(cwd, { recursive: true });
    const mcpConfigFile = path.join(cwd, "mcp.json");
    await writeFile(mcpConfigFile, `${JSON.stringify({ mcpServers: {} })}\n`);
    const adapter = adapterFor(options);
    const spec: TerminalSpec = {
      agentId: "engine-test",
      cwd,
      systemPrompt: "Você faz um teste de conexão. Responda em uma palavra.",
      mcpConfigFile,
      model,
      ...(defaults.effort ? { effort: defaults.effort } : {}),
      tools: [],
    };
    const sessionId = adapter.newSessionId();
    const { command, args } = adapter.command(spec, { sessionId, resume: false });
    return await new Promise<EngineTestResult>((resolve) => {
      let done = false;
      let stderr = "";
      let answer = "";
      let buffer = "";
      const parser = adapter.createParser(spec);
      const child = spawn(command, args, { cwd, env: adapter.env(options.env ?? process.env, spec), stdio: ["pipe", "pipe", "pipe"] });
      const settle = (result: EngineTestResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdin.end();
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        child.kill("SIGTERM");
        resolve(result);
      };
      const timer = setTimeout(() => settle(finish({ ok: false, error: `Sem resposta em ${Math.round((options.timeoutMs ?? ENGINE_TEST_TIMEOUT_MS) / 1000)} s (tempo esgotado).` })), options.timeoutMs ?? ENGINE_TEST_TIMEOUT_MS);
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        for (const event of parser.parse(line)) {
          if (event.type === "text") answer += event.text;
          if (event.type === "turn_end") {
            if (event.usage) {
              try {
                options.onUsage?.({ usage: event.usage, model, durationMs: Date.now() - started });
              } catch {
                // Registrar o gasto nunca muda o resultado do teste.
              }
            }
            const tokens = event.usage ? event.usage.inputTokens + event.usage.outputTokens + event.usage.cacheCreationTokens : undefined;
            const text = shorten(event.result || answer, 120);
            if (event.ok) settle(finish({ ok: true, text, ...(tokens ? { tokens } : {}) }));
            else settle(finish({ ok: false, error: describeTestFailure(event.result || stderr, options.engine), ...(tokens ? { tokens } : {}) }));
          }
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          handleLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.on("error", (error) => settle(finish({ ok: false, error: describeTestFailure((error as NodeJS.ErrnoException).code === "ENOENT" ? "ENOENT" : errorMessage(error), options.engine) })));
      child.on("close", (code) => settle(finish({ ok: false, error: describeTestFailure(stderr || `O motor saiu (código ${code ?? "?"}) sem responder.`, options.engine) })));
      child.stdin.on("error", () => undefined);
      child.stdin.write(`${adapter.encodeMessage(options.message ?? ENGINE_TEST_MESSAGE, sessionId)}\n`);
    });
  } catch (error) {
    return finish({ ok: false, error: describeTestFailure(errorMessage(error), options.engine) });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Um teste por vez (em todo o servidor) e um intervalo mínimo entre dois testes do mesmo motor.
 * `tests` guarda o último resultado de cada motor (grava em disco quem chamar `onResult`).
 */
export class EngineTester {
  private running: SupportedEngineId | undefined;
  private readonly lastAt = new Map<SupportedEngineId, number>();

  constructor(
    private readonly run: (engine: SupportedEngineId) => Promise<EngineTestResult>,
    private readonly onResult: (engine: SupportedEngineId, result: EngineTestResult) => void | Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly minGapMs = ENGINE_TEST_MIN_GAP_MS,
  ) {}

  /** Roda o teste; devolve `{ blocked }` se já há um teste rodando ou se foi cedo demais. */
  async test(engine: SupportedEngineId): Promise<{ result: EngineTestResult } | { blocked: "busy" | "too_soon"; message: string; retryAfterMs?: number }> {
    if (this.running) return { blocked: "busy", message: `Já há um teste em andamento (${this.running === "claude" ? "Claude Code" : "Antigravity"}). Espere terminar.` };
    const last = this.lastAt.get(engine);
    if (last !== undefined && this.now() - last < this.minGapMs) {
      const retryAfterMs = this.minGapMs - (this.now() - last);
      return { blocked: "too_soon", message: `Testou há pouco. Espere ${Math.ceil(retryAfterMs / 1000)} s para testar de novo.`, retryAfterMs };
    }
    this.running = engine;
    this.lastAt.set(engine, this.now());
    try {
      const result = await this.run(engine);
      await this.onResult(engine, result);
      return { result };
    } finally {
      this.running = undefined;
    }
  }
}
