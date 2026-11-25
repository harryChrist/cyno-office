import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_LABELS,
  ENGINE_TEST_FRESH_MS,
  engineBlock,
  freebuffBlock,
  type EngineCatalogId,
  type EngineInstallJob,
  type OneShotEngineId,
  type EnginePathSource,
  type EngineState,
  type EngineStatus,
  type EngineTestResult,
  type SubscriptionUsage,
  type SupportedEngineId,
} from "@cyno/shared";
import { ANTIGRAVITY_STALE_REASONS } from "../usage/antigravity-poller";
import type { FreebuffService } from "../freebuff/service";
import { executableCandidates, isWindows, pathDelimiter, readPathEnv } from "../../platform/os";
import type { EngineBinaries, EngineProbe } from "./engines";

/**
 * Estado de cada motor que o Cyno conhece (tela Motores), detectado por código:
 * - Claude Code e Antigravity: caminho (escolhido na tela, CLAUDE_BIN/AGY_BIN ou o PATH), `--version`,
 *   login (Claude: `claude auth status`, que só lê; Antigravity: o que o poller de uso já descobriu),
 *   cota (o uso da conta) e o último "Testar";
 * - Freebuff, OpenClaw e Hermes ("em breve"): só achar o executável. Versão: o OpenClaw responde
 *   `--version` sem efeito colateral; o Freebuff NUNCA roda (o lançador baixa um binário de 50 MB e
 *   grava em ~/.config/manicode), então a versão vem do package.json do pacote npm; o Hermes não
 *   roda nada (nenhum comando de versão foi confirmado como seguro).
 */

type Described = { label: string; blurb: string; loginCommand: string };

const DESCRIBED: Record<EngineCatalogId, Described> = {
  claude: { label: ENGINE_LABELS.claude, blurb: "A CLI do Claude Code, na sua assinatura. É o motor do Maestro e dos agentes.", loginCommand: "claude" },
  gemini: { label: ENGINE_LABELS.gemini, blurb: "A CLI do Google Antigravity (agy), com os modelos Gemini da sua assinatura.", loginCommand: "agy" },
  freebuff: { label: "Freebuff", blurb: "Terminal de IA gratuito, pago por anúncios (CodebuffAI). Só para agentes de time (nunca o Maestro nem o Cyno). A cota é em HORAS ABERTAS: a hora começa na primeira mensagem do agente e o terminal fica vivo até ela acabar.", loginCommand: "freebuff login" },
  openclaw: { label: "OpenClaw", blurb: "Assistente pessoal de código aberto; o Cyno usaria só o modo de um turno (agent exec), sem daemon.", loginCommand: "openclaw onboard" },
  hermes: { label: "Hermes", blurb: "Agente de terminal da Nous Research, com perfis e MCP; o modelo vem da conta que você ligar.", loginCommand: "hermes setup" },
};

const SOON_NOTICE = "O suporte chega numa próxima entrega: por enquanto o Cyno só detecta, não usa este motor nos agentes.";

/** Quanto tempo o `--version` e o `auth status` podem demorar. */
const PROBE_TIMEOUT_MS = 8000;

export type EngineStatusDeps = {
  /** Comandos em uso (já com o caminho escolhido na tela, se houver). */
  binaries: EngineBinaries;
  /** Nome-padrão de cada comando ("claude", "agy"): diferente disso = veio de CLAUDE_BIN/AGY_BIN. */
  defaultCommands: Record<SupportedEngineId, string>;
  /** Caminhos escolhidos na tela. */
  configured: Partial<Record<SupportedEngineId, string>>;
  /** O PATH em que procurar (padrão: o do processo). */
  pathEnv?: string;
  homeDir: string;
  probe: EngineProbe;
  usage: () => readonly SubscriptionUsage[];
  /** Último teste de cada motor. */
  tests: () => Partial<Record<EngineCatalogId, EngineTestResult>>;
  now: () => number;
  /** Freebuff: as horas abertas, o modelo da plataforma e a pasta de dados dele (ausente = ele aparece só como detectado). */
  freebuff?: { service: FreebuffService; manicodeDir: string; command: string };
  /** OpenClaw e Hermes: o estado de cada um (ausente = só detectados, "em breve", como antes). */
  oneShot?: (id: OneShotEngineId) => Promise<EngineStatus>;
  /** Instalação privada de `claude`/`gemini` em andamento ou concluída. */
  installJob?: (id: SupportedEngineId) => EngineInstallJob | undefined;
  /** Quando verdadeiro, motores `claude`/`gemini` não instalados expõem `installable: true`. */
  installable?: boolean;
};

async function isExecutable(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, isWindows(platform) ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type FindExecutableOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

/**
 * Acha o executável como o shell acharia (sem rodar nada): o PATH e ~/.local/bin. Devolve o caminho completo.
 * No Windows considera `PATHEXT` (`.exe`, `.cmd`, `.bat`…) e o separador `;`.
 */
export async function findExecutable(
  command: string,
  pathEnv: string,
  homeDir: string,
  options: FindExecutableOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const hasSep = command.includes("/") || (isWindows(platform) && command.includes("\\"));
  if (hasSep) {
    for (const candidate of executableCandidates(command, env, platform)) {
      if (await isExecutable(candidate, platform)) return path.resolve(candidate);
    }
    return undefined;
  }
  const delimiter = pathDelimiter(platform);
  const dirs = [...pathEnv.split(delimiter).filter(Boolean), path.join(homeDir, ".local", "bin")];
  const names = executableCandidates(command, env, platform);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** Versão do pacote npm de um executável instalado com `npm install -g` (lê o package.json, nunca roda o programa). */
export async function npmPackageVersion(executable: string, packageName: string): Promise<string | undefined> {
  try {
    let dir = path.dirname(await realpath(executable));
    for (let depth = 0; depth < 4; depth += 1) {
      try {
        const info = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (info.name === packageName && typeof info.version === "string") return info.version.slice(0, 40);
      } catch {
        // sem package.json aqui: sobe uma pasta
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // link quebrado
  }
  return undefined;
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]?.trim().slice(0, 80) || undefined;

/** `claude auth status` imprime JSON com `loggedIn`: só esse campo é lido (nada de e-mail ou plano). */
export function parseLoggedIn(stdout: string): boolean | undefined {
  try {
    const value = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function pickState(input: { installed: boolean; loggedIn?: boolean; quota: boolean; testedOk: boolean }): EngineState {
  if (!input.installed) return "not_installed";
  if (input.loggedIn === false) return "no_login";
  if (input.quota) return "no_quota";
  return input.testedOk ? "working" : "installed";
}

async function detectSupported(id: SupportedEngineId, deps: EngineStatusDeps): Promise<EngineStatus> {
  const bin = deps.binaries[id === "claude" ? "claude" : "gemini"];
  const pathEnv = deps.pathEnv ?? readPathEnv(process.env);
  const configuredPath = deps.configured[id];
  const found = await findExecutable(bin.command, pathEnv, deps.homeDir);
  const run = (args: string[]) => deps.probe(bin.command, [...(bin.prefixArgs ?? []), ...args], PROBE_TIMEOUT_MS);
  const version = found ? await run(["--version"]) : undefined;
  const installed = Boolean(found && version?.ok);
  const source: EnginePathSource = configuredPath !== undefined && configuredPath === bin.command ? "config" : bin.command !== deps.defaultCommands[id] ? "env" : "path";
  let loggedIn: boolean | undefined;
  if (installed && id === "claude" && !bin.prefixArgs?.length) {
    const auth = await run(["auth", "status"]);
    if (auth.stdout) loggedIn = parseLoggedIn(auth.stdout);
  }
  const usage = deps.usage().find((candidate) => candidate.provider === id && !candidate.accountId);
  if (installed && id === "gemini" && usage?.stale?.reason === ANTIGRAVITY_STALE_REASONS.login) loggedIn = false;
  const block = installed ? engineBlock(id, { usage: deps.usage(), now: deps.now() }) : undefined;
  const lastTest = deps.tests()[id];
  const testedOk = Boolean(lastTest?.ok && deps.now() - Date.parse(lastTest.at) < ENGINE_TEST_FRESH_MS);
  const described = DESCRIBED[id];
  const installJob = deps.installJob?.(id);
  return {
    id,
    label: described.label,
    blurb: described.blurb,
    supported: true,
    state: pickState({ installed, ...(loggedIn !== undefined ? { loggedIn } : {}), quota: block?.reason === "quota", testedOk }),
    ...(installed && version && firstLine(version.stdout) ? { version: firstLine(version.stdout)! } : {}),
    ...(found ? { path: found } : {}),
    pathSource: source,
    ...(configuredPath !== undefined ? { configuredPath } : {}),
    loginCommand: described.loginCommand,
    ...(block?.reason === "quota" && block.resetsAt ? { resetsAt: block.resetsAt } : {}),
    ...(lastTest ? { lastTest } : {}),
    ...(!installed && deps.installable ? { installable: true } : {}),
    ...(installJob ? { installJob } : {}),
    ...(!installed && version && !version.ok ? { notice: version.error ?? "não respondeu ao --version" } : {}),
  };
}

/**
 * Freebuff: o executável (achado sem rodar: o lançador baixa um binário de 50 MB na primeira execução), a
 * versão do pacote npm, o login (só se o arquivo de credenciais EXISTE: o conteúdo nunca é lido), o saldo de
 * horas do dia, o modelo da plataforma e as horas abertas.
 */
async function detectFreebuff(deps: EngineStatusDeps): Promise<EngineStatus> {
  const described = DESCRIBED.freebuff;
  const pathEnv = deps.pathEnv ?? readPathEnv(process.env);
  const freebuff = deps.freebuff;
  const found = await findExecutable(freebuff?.command ?? "freebuff", pathEnv, deps.homeDir);
  const version = found ? await npmPackageVersion(found, "freebuff") : undefined;
  const loggedIn = freebuff ? await stat(path.join(freebuff.manicodeDir, "credentials.json")).then(() => true, () => false) : undefined;
  const now = deps.now();
  const service = freebuff?.service;
  const detail = service?.detail();
  const quota = detail ? freebuffBlock({ ...detail, sessions: [] }, undefined, now)?.reason === "quota" : false;
  const resetsAt = quota ? detail?.hours.resetsAt : undefined;
  const lastTest = service?.lastTest();
  const testedOk = Boolean(lastTest?.ok && now - Date.parse(lastTest.at) < ENGINE_TEST_FRESH_MS);
  const installed = found !== undefined;
  const { models, readAt } = service?.models() ?? { models: [] };
  const settings = service?.settings();
  const chosen = settings ? models.find((model) => model.name === settings.model) : undefined;
  return {
    id: "freebuff",
    label: described.label,
    blurb: described.blurb,
    supported: freebuff !== undefined,
    state: pickState({ installed, ...(loggedIn === false ? { loggedIn: false } : {}), quota, testedOk }),
    ...(version ? { version } : {}),
    ...(found ? { path: found, pathSource: "path" as const } : {}),
    loginCommand: described.loginCommand,
    ...(resetsAt ? { resetsAt } : {}),
    ...(lastTest ? { lastTest } : {}),
    ...(freebuff === undefined ? { notice: SOON_NOTICE } : {}),
    ...(detail && settings
      ? {
          freebuff: {
            settings,
            ...(models.length > 0 ? { modelFound: chosen !== undefined } : {}),
            ...(chosen ? { multiplier: chosen.multiplier } : { multiplier: detail.settings.multiplier ?? 1 }),
            models,
            ...(readAt ? { modelsReadAt: readAt } : {}),
            hours: detail.hours,
            sessions: detail.sessions,
          },
        }
      : {}),
  };
}

async function detectSoon(id: Exclude<EngineCatalogId, SupportedEngineId | "freebuff">, deps: EngineStatusDeps): Promise<EngineStatus> {
  const pathEnv = deps.pathEnv ?? readPathEnv(process.env);
  const described = DESCRIBED[id];
  const found = await findExecutable(id, pathEnv, deps.homeDir);
  let version: string | undefined;
  if (found && id === "openclaw") {
    // O OpenClaw só imprime a versão (o ~/.openclaw já existia); é o único dos três com comando de versão confirmado como seguro.
    const result = await deps.probe(found, ["--version"], PROBE_TIMEOUT_MS);
    if (result.ok) version = firstLine(result.stdout);
  }
  return {
    id,
    label: described.label,
    blurb: described.blurb,
    supported: false,
    state: found ? "installed" : "not_installed",
    ...(version ? { version } : {}),
    ...(found ? { path: found } : {}),
    ...(found ? { pathSource: "path" as const } : {}),
    loginCommand: described.loginCommand,
    notice: SOON_NOTICE,
  };
}

/** O estado de todos os motores conhecidos, na ordem da tela. */
export async function detectEngineStatuses(deps: EngineStatusDeps): Promise<EngineStatus[]> {
  return Promise.all([
    detectSupported("claude", deps),
    detectSupported("gemini", deps),
    detectFreebuff(deps),
    deps.oneShot ? deps.oneShot("openclaw") : detectSoon("openclaw", deps),
    deps.oneShot ? deps.oneShot("hermes") : detectSoon("hermes", deps),
  ]);
}
