import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineTestResult, FreebuffSettings } from "@cyno/shared";
import { errorMessage, shorten } from "../../util/text";
import type { TerminalEvent, TerminalSpec } from "../terminals/types";
import { freebuffEnv } from "./adapter";
import type { FreebuffRuntime } from "./runtime";
import { FreebuffService } from "./service";
import { FreebuffTerminal } from "./terminal";

/**
 * "Testar" do Freebuff (tela Motores): o mesmo terminal dos agentes (mesma TUI, o modelo da plataforma, o
 * pedido como texto, o fim do turno pelo registro) numa pasta temporária, SEM o MCP do escritório. Abre uma
 * hora do Freebuff (gasta o multiplicador do modelo em horas do dia): por isso só roda com a confirmação do
 * dono. Uma pergunta mínima ("responda só: ok"); o processo fecha no fim (a hora fica aberta até acabar).
 */

export const FREEBUFF_TEST_MESSAGE = "Responda só com a palavra: ok";
export const FREEBUFF_TEST_FOLDER = "cyno-engine-test";
export const FREEBUFF_TEST_TIMEOUT_MS = 180_000;

export type FreebuffTestOptions = {
  runtime: FreebuffRuntime;
  /** Onde criar a pasta temporária (ex.: DATA_DIR/platform/freebuff). */
  workDir: string;
  settings: FreebuffSettings;
  now?: () => Date;
  timeoutMs?: number;
  message?: string;
};

export type FreebuffTestOutcome = { result: EngineTestResult; spentHours: number };

export async function runFreebuffTest(options: FreebuffTestOptions): Promise<FreebuffTestOutcome> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const model = `${options.settings.model} · ${options.settings.effort}`;
  const finish = (partial: { ok: boolean; text?: string; error?: string }, spentHours = 0): FreebuffTestOutcome => ({
    result: { ok: partial.ok, ms: Date.now() - started, at: now().toISOString(), model, ...(partial.text ? { text: partial.text } : {}), ...(partial.error ? { error: partial.error } : {}) },
    spentHours,
  });
  const cwd = path.join(options.workDir, FREEBUFF_TEST_FOLDER);
  const stateDir = path.join(options.workDir, `${FREEBUFF_TEST_FOLDER}-state`);
  // Um serviço só do teste (a hora dele não conta como a de um agente: nenhum agente a usa).
  const service = await FreebuffService.open(undefined, { now });
  await service.setSettings(options.settings);
  const known = options.runtime.service.models().models;
  if (known.length > 0) await service.setModels(known);
  const spec: TerminalSpec = { agentId: "engine-test", cwd, systemPrompt: "Você faz um teste de conexão. Responda em uma palavra.", mcpConfigFile: path.join(cwd, "mcp.json"), tools: [] };
  const terminal = new FreebuffTerminal({
    spec,
    stateDir,
    prepare: async () => {
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, "AGENTS.md"), `${spec.systemPrompt}\n`);
      return spec;
    },
    service,
    workspaceId: "platform",
    agentName: () => "Teste",
    folderName: FREEBUFF_TEST_FOLDER,
    command: { command: options.runtime.command, ...(options.runtime.prefixArgs ? { prefixArgs: options.runtime.prefixArgs } : {}) },
    env: freebuffEnv,
    ...(options.runtime.env ? { baseEnv: options.runtime.env } : {}),
    manicodeDir: options.runtime.manicodeDir,
    idleMs: 0,
    maxRetries: 1,
    ...(options.runtime.spawn ? { spawn: options.runtime.spawn } : {}),
    ...(options.runtime.pollMs ? { pollMs: options.runtime.pollMs } : {}),
    ...(options.runtime.readyTimeoutMs ? { readyTimeoutMs: options.runtime.readyTimeoutMs } : {}),
    ...(options.runtime.deliveryTimeoutMs ? { deliveryTimeoutMs: options.runtime.deliveryTimeoutMs } : {}),
    ...(options.runtime.submitDelayMs ? { submitDelayMs: options.runtime.submitDelayMs } : {}),
    ...(options.runtime.settleMs ? { settleMs: options.runtime.settleMs } : {}),
    ...(options.runtime.settleCatalogMs ? { settleCatalogMs: options.runtime.settleCatalogMs } : {}),
    now,
  });
  try {
    const outcome = await new Promise<{ ok: boolean; text?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: `Sem resposta em ${Math.round((options.timeoutMs ?? FREEBUFF_TEST_TIMEOUT_MS) / 1000)} s (tempo esgotado).` }), options.timeoutMs ?? FREEBUFF_TEST_TIMEOUT_MS);
      timer.unref();
      terminal.onEvent((event: TerminalEvent) => {
        if (event.type === "turn_end") {
          clearTimeout(timer);
          resolve(event.ok ? { ok: true, text: shorten(event.result || "(sem texto)", 120) } : { ok: false, error: shorten(event.result, 300) });
        } else if (event.type === "dropped") {
          clearTimeout(timer);
          resolve({ ok: false, error: shorten(event.reason, 300) });
        }
      });
      terminal.send(options.message ?? FREEBUFF_TEST_MESSAGE, "engine-test");
    });
    const spent = service.sessionOf({ workspaceId: "platform", agentId: "engine-test" })?.multiplier ?? 0;
    return finish(outcome, spent);
  } catch (error) {
    return finish({ ok: false, error: errorMessage(error) });
  } finally {
    await terminal.dispose().catch(() => undefined);
    service.close();
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
