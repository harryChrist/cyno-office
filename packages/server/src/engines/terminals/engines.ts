import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { ENGINE_LABELS, type EngineInfo, type EngineModel, type FreebuffModel, type SupportedEngineId } from "@cyno/shared";
import { executableCandidates, isWindows, readPathEnv } from "../../platform/os";
import { errorMessage } from "../../util/text";
import { privateBinaryCandidates } from "../install/recipes";
import { sanitizeChildEnv } from "./env";
import { findExecutable, npmPackageVersion } from "./engine-status";

/**
 * Motores disponíveis neste server (GET /api/engines): o simulado sempre; o Claude Code e o
 * Antigravity se o binário responder `--version`. A lista de modelos do Antigravity vem de
 * `agy models` (uma vez, guardada); a do Claude Code são apelidos (o campo aceita texto livre).
 * Nada roda no boot: a primeira chamada detecta e guarda (`refresh` detecta de novo).
 */

/** Roda um comando curto e devolve a saída (nunca lança). */
export type EngineProbe = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ ok: boolean; stdout: string; error?: string; timedOut?: boolean }>;

export type EngineBinary = { command: string; prefixArgs?: string[] | undefined };

export type EngineBinaries = {
  claude: EngineBinary;
  gemini: EngineBinary;
};

function isExecutableSync(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, isWindows(platform) ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Cópia privada instalada pelo Cyno em `DATA_DIR/platform/engines/<motor>/`, se existir e for executável. */
export function findPrivateEngineBinary(
  dataDir: string,
  engine: SupportedEngineId,
  candidates?: readonly string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  for (const candidate of candidates ?? privateBinaryCandidates(dataDir, engine, platform)) {
    for (const variant of executableCandidates(candidate, env, platform)) {
      if (isExecutableSync(variant, platform)) return variant;
    }
  }
  return undefined;
}

/**
 * Ponto único de resolução do binário de `claude` e `gemini` (usado por detecção de versão,
 * adaptadores, poller de cota e login):
 * 1. caminho explicitamente salvo na tela (`configured`), se houver;
 * 2. cópia privada instalada pelo Cyno (`DATA_DIR/platform/engines/<motor>/`), se existir;
 * 3. comando base (variável de ambiente `CLAUDE_BIN`/`AGY_BIN` ou padrão da máquina).
 */
export function resolveEngineBinary(
  engine: SupportedEngineId,
  options: { dataDir: string; base: EngineBinary; configured?: string; privateCandidates?: readonly string[]; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
): EngineBinary {
  if (options.configured) return { command: options.configured };
  const privateBin = findPrivateEngineBinary(options.dataDir, engine, options.privateCandidates, {
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  if (privateBin) return { command: privateBin };
  return options.base;
}

/** Apelidos do Claude Code para o seletor (o campo aceita qualquer modelo/alias da CLI). */
export const CLAUDE_MODEL_ALIASES: EngineModel[] = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
];

const VERSION_TIMEOUT_MS = 5000;
const MODELS_TIMEOUT_MS = 30_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

export const defaultProbe: EngineProbe = (command, args, timeoutMs, env) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: sanitizeChildEnv(process.env, env), maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) resolve({ ok: false, stdout: String(stdout ?? ""), error: (error as NodeJS.ErrnoException).code === "ENOENT" ? `comando ${command} não encontrado` : errorMessage(error), ...((error as { killed?: boolean }).killed === true ? { timedOut: true } : {}) });
      else resolve({ ok: true, stdout: String(stdout) });
    });
  });

/** Linhas "id<TAB>nome" de `agy models` (a primeira, "Fetching available models...", sai). */
export function parseAgyModels(stdout: string): EngineModel[] {
  const models: EngineModel[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const [id = "", ...rest] = line.trim().split(/\t+|\s{2,}/);
    if (!MODEL_ID.test(id) || id.length > 100 || seen.has(id) || /^fetching$/i.test(id)) continue;
    if (!/[-.]/.test(id) && rest.length === 0) continue; // palavra solta (mensagem), não modelo
    seen.add(id);
    const label = rest.join(" ").trim();
    models.push({ id, ...(label ? { label } : {}) });
  }
  return models;
}

/** Primeira linha da saída de `--version` (ex.: "2.1.319 (Claude Code)", "1.5.3"). */
function versionOf(stdout: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim();
  return line ? line.slice(0, 80) : undefined;
}

/** Como achar o Freebuff sem rodá-lo (o lançador baixa um binário de 50 MB na primeira execução): o executável e o package.json do pacote npm. */
export type FreebuffDetect = { command: string; homeDir: string; pathEnv?: string; models: () => readonly FreebuffModel[] };

/** OpenClaw e Hermes: o que o seletor de motor precisa (instalado? versão? modelos do OpenRouter com o preço). */
export type OneShotDetect = (engine: "openclaw" | "hermes") => Promise<{ available: boolean; fenced?: boolean; version?: string; reason?: string; models: EngineModel[] }>;

export async function detectEngines(binaries: EngineBinaries, probe: EngineProbe = defaultProbe, freebuff?: FreebuffDetect, oneShot?: OneShotDetect): Promise<EngineInfo[]> {
  const run = (bin: { command: string; prefixArgs?: string[] }, args: string[], timeoutMs: number) => probe(bin.command, [...(bin.prefixArgs ?? []), ...args], timeoutMs);
  const [claude, agy] = await Promise.all([run(binaries.claude, ["--version"], VERSION_TIMEOUT_MS), run(binaries.gemini, ["--version"], VERSION_TIMEOUT_MS)]);
  const agyModels = agy.ok ? await run(binaries.gemini, ["models"], MODELS_TIMEOUT_MS) : undefined;
  const version = (result: { ok: boolean; stdout: string }) => (result.ok ? versionOf(result.stdout) : undefined);
  const claudeVersion = version(claude);
  const agyVersion = version(agy);
  const freebuffInfo: EngineInfo[] = [];
  if (freebuff) {
    const found = await findExecutable(freebuff.command, freebuff.pathEnv ?? readPathEnv(process.env), freebuff.homeDir);
    const freebuffVersion = found ? await npmPackageVersion(found, "freebuff") : undefined;
    freebuffInfo.push({
      engine: "freebuff",
      label: ENGINE_LABELS.freebuff,
      available: found !== undefined,
      ...(freebuffVersion ? { version: freebuffVersion } : {}),
      ...(found ? {} : { reason: `comando ${freebuff.command} não encontrado` }),
      // A lista vem da tela do `/model` (cache); o modelo é um só para a plataforma (Configurações › Motores).
      models: freebuff.models().map((model) => ({ id: model.name, label: `${model.name} · ${model.multiplier}x` })),
      freeModel: false,
    });
  }
  const oneShotInfo: EngineInfo[] = [];
  if (oneShot) {
    for (const engine of ["openclaw", "hermes"] as const) {
      const found = await oneShot(engine);
      oneShotInfo.push({
        engine,
        label: ENGINE_LABELS[engine],
        available: found.available,
        ...(found.version ? { version: found.version } : {}),
        ...(found.available ? {} : { reason: found.reason ?? `comando ${engine} não encontrado` }),
        models: found.models,
        ...(found.fenced ? { fenced: true } : {}),
        // O modelo é um id do OpenRouter (a lista é uma sugestão; o campo aceita qualquer id).
        freeModel: true,
      });
    }
  }
  return [
    { engine: "mock", label: ENGINE_LABELS.mock, available: true, models: [], freeModel: false },
    {
      engine: "claude",
      label: ENGINE_LABELS.claude,
      available: claude.ok,
      ...(claudeVersion ? { version: claudeVersion } : {}),
      ...(claude.ok ? {} : { reason: claude.error ?? "não respondeu" }),
      models: CLAUDE_MODEL_ALIASES,
      freeModel: true,
    },
    {
      engine: "gemini",
      label: ENGINE_LABELS.gemini,
      available: agy.ok,
      ...(agyVersion ? { version: agyVersion } : {}),
      ...(agy.ok ? {} : { reason: agy.error ?? "não respondeu" }),
      models: agyModels?.ok ? parseAgyModels(agyModels.stdout) : [],
      freeModel: false,
    },
    ...freebuffInfo,
    ...oneShotInfo,
  ];
}

/** Guarda a detecção (uma por server); `refresh` detecta de novo. */
export class EngineCatalog {
  private cached: Promise<EngineInfo[]> | undefined;
  private last: EngineInfo[] | undefined;

  constructor(private readonly detect: () => Promise<EngineInfo[]>) {}

  list(refresh = false): Promise<EngineInfo[]> {
    if (!this.cached || refresh) {
      const pending = this.detect().then(
        (engines) => {
          if (this.cached === pending) this.last = engines;
          return engines;
        },
        (error: unknown) => {
          if (this.cached === pending) this.cached = undefined;
          throw error;
        },
      );
      this.cached = pending;
    }
    return this.cached;
  }

  /** Última detecção concluída (sem detecção ainda = undefined; não dispara uma). */
  known(): EngineInfo[] | undefined {
    return this.last;
  }
}
