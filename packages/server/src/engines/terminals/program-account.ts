import { readFileSync } from "node:fs";
import path from "node:path";
import {
  maskSecrets,
  type OneShotAccount,
  type OneShotEngineId,
  type ProgramAccountInfo,
  type ProgramModelsResponse,
  type ProgramProvider,
  type ProgramProviderKind,
  type ProgramSetupInfo,
} from "@cyno/shared";
import { shorten } from "../../util/text";
import { hermesHomeOf } from "./hermes-adapter";
import { openclawPaths } from "./openclaw-adapter";
import type { EngineProbe } from "./engines";

/**
 * "A configuração do próprio programa" (OpenClaw e Hermes): o Cyno não decide como o programa se autentica. Aqui
 * só há três coisas, todas sem segredo:
 *  1. de onde o programa lê a configuração (a pasta pessoal do dono ou a pasta isolada do Cyno);
 *  2. os comandos de ESTADO do próprio programa (somente leitura) e a leitura do resultado, que guarda só o nome do
 *     provedor, o tipo e quantos perfis, e passa todo texto por `maskSecrets`;
 *  3. os comandos exatos, em texto copiável, para o dono configurar o programa pelo terminal dele.
 * O Cyno nunca roda `configure`, `onboard`, `models auth`, `setup`, `auth add` nem lê arquivos de credenciais.
 */

/** As pastas de configuração de cada motor: a pessoal do dono e a isolada do Cyno. */
export function programDirs(engine: OneShotEngineId, input: { engineRoot: string; homeDir: string }): { personal: string; cyno: string } {
  return engine === "openclaw" ? { personal: path.join(input.homeDir, ".openclaw"), cyno: input.engineRoot } : { personal: path.join(input.homeDir, ".hermes"), cyno: hermesHomeOf(input.engineRoot) };
}

/** Variáveis de ambiente que apontam o programa para a pasta do Cyno (na pessoal não há nenhuma: o programa usa a dele). */
export function programEnv(engine: OneShotEngineId, location: OneShotAccount["location"], engineRoot: string): Record<string, string> {
  if (location === "personal") return { NO_COLOR: "1", ...(engine === "openclaw" ? { OPENCLAW_HIDE_BANNER: "1" } : {}) };
  if (engine === "hermes") return { HERMES_HOME: hermesHomeOf(engineRoot), NO_COLOR: "1" };
  const paths = openclawPaths(engineRoot);
  return { HOME: paths.home, OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.baseConfig, OPENCLAW_HIDE_BANNER: "1", NO_COLOR: "1" };
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Os comandos do dono, já com as variáveis da pasta do Cyno na frente (só `NOME='valor' comando`, sem exportar nada no terminal dele). */
export function programSetup(engine: OneShotEngineId, account: OneShotAccount, input: { engineRoot: string; homeDir: string }): ProgramSetupInfo {
  const dirs = programDirs(engine, input);
  const onCyno = account.location === "cyno";
  const env = onCyno ? Object.entries(programEnv(engine, "cyno", input.engineRoot)).filter(([name]) => name !== "NO_COLOR" && name !== "OPENCLAW_HIDE_BANNER") : [];
  const prefix = env.length > 0 ? `${env.map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ")} ` : "";
  const commands =
    engine === "openclaw"
      ? [`${prefix}openclaw configure`, `${prefix}openclaw models auth login --provider <provedor>`, `${prefix}openclaw models status`]
      : [`${prefix}hermes setup`, `${prefix}hermes auth add <provedor>`, `${prefix}hermes model`];
  const label = engine === "openclaw" ? "OpenClaw" : "Hermes";
  const writes =
    account.mode === "openrouter"
      ? [`Pasta isolada do Cyno (${dirs.cyno}): a chave do OpenRouter vai só por variável de ambiente em cada turno; nada na sua pasta pessoal.`]
      : engine === "openclaw"
        ? [
            onCyno ? `Na pasta do Cyno (${dirs.cyno}): o estado e a configuração isolados do ${label}, onde o ${label} guarda o que você ligar.` : `Na sua pasta pessoal (${dirs.personal}): nada. O ${label} lê a configuração e as contas que você já ligou.`,
            "Em cada agente: o openclaw.json do agente (numa pasta de configuração própria, fora da pasta de trabalho), passado por --config, com o servidor MCP \"office\" e a política de ferramentas.",
            "Nenhuma chave é injetada no ambiente; as chaves de API do próprio servidor do Cyno continuam sendo tiradas do processo.",
          ]
        : [
            onCyno ? `Na pasta do Cyno (${dirs.cyno}): onde o ${label} guarda o que você ligar (config.yaml, chaves, logins).` : `Na sua pasta pessoal (${dirs.personal}): nada. O Cyno só LÊ o config.yaml dela, e as chaves e logins que você ligou entram por link.`,
            "Em cada agente: o AGENTS.md da pasta do agente (as instruções) e um HERMES_HOME próprio (agent-homes/…) com um config.yaml gerado: a sua configuração, sem os seus servidores MCP, mais o MCP \"office\" com o token do agente e a trava que impede o Hermes de adotar logins de outros programas (Claude Code, Codex).",
            "O HOME do processo é uma pasta vazia do Cyno e nenhuma chave do servidor passa para o programa (só PATH, idioma e proxy).",
          ];
  return { dir: onCyno ? dirs.cyno : dirs.personal, commands, personalDir: dirs.personal, cynoDir: dirs.cyno, writes };
}

// ---------- Leitura do que o programa disse ----------

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "lm-studio", "llamacpp", "llama.cpp", "vllm", "local", "jan", "koboldcpp"]);
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** O primeiro objeto JSON do texto (pode haver linhas de aviso antes dele). */
export function parseJsonLoose(text: string): unknown {
  for (const match of text.matchAll(/^[[{]/gm)) {
    try {
      return JSON.parse(text.slice(match.index));
    } catch {
      // tenta o próximo começo de linha
    }
  }
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

type ParsedStatus = { providers: ProgramProvider[]; defaultModel?: string; missing?: string[] };

/**
 * `openclaw models status --json` (conferido com o OpenClaw 2026.11.3): `auth.providers[]` com `profiles{count,oauth,
 * token,apiKey}` e `effective.kind`, `auth.providersWithOAuth[]`, `auth.missingProvidersInUse[]` e `resolvedDefault`.
 * Só o nome, o tipo e a contagem saem daqui: os rótulos e caminhos do JSON (que podem trazer pedaços de chave) são ignorados.
 */
export function parseOpenClawStatus(json: unknown): ParsedStatus | undefined {
  if (!isObject(json)) return undefined;
  const auth = isObject(json.auth) ? json.auth : undefined;
  if (!auth) return undefined;
  const byName = new Map<string, ProgramProvider>();
  const add = (provider: string, kind: ProgramProviderKind, profiles?: number) => {
    if (!PROVIDER_NAME.test(provider)) return;
    const current = byName.get(provider);
    const rank = (value: ProgramProviderKind) => ({ oauth: 4, token: 3, api_key: 2, local: 1, unknown: 0 })[value];
    const next: ProgramProvider = { provider, kind: !current || rank(kind) > rank(current.kind) ? kind : current.kind, ...(profiles || current?.profiles ? { profiles: Math.max(profiles ?? 0, current?.profiles ?? 0) } : {}) };
    byName.set(provider, next);
  };
  for (const entry of Array.isArray(auth.providers) ? auth.providers : []) {
    if (!isObject(entry) || typeof entry.provider !== "string") continue;
    const profiles = isObject(entry.profiles) ? entry.profiles : {};
    const effective = isObject(entry.effective) ? entry.effective : {};
    const total = count(profiles.count);
    const kind: ProgramProviderKind =
      count(profiles.oauth) > 0 ? "oauth" : count(profiles.token) > 0 ? "token" : count(profiles.apiKey) > 0 ? "api_key" : effective.kind === "env" ? "api_key" : LOCAL_PROVIDERS.has(entry.provider.toLowerCase()) ? "local" : effective.kind === "missing" ? "unknown" : "unknown";
    // Um provedor sem perfil e sem credencial efetiva não está ligado.
    if (total === 0 && effective.kind === "missing") continue;
    add(entry.provider, kind, total || undefined);
  }
  for (const provider of Array.isArray(auth.providersWithOAuth) ? auth.providersWithOAuth : []) if (typeof provider === "string") add(provider, "oauth");
  const missing = (Array.isArray(auth.missingProvidersInUse) ? auth.missingProvidersInUse : []).filter((item): item is string => typeof item === "string" && PROVIDER_NAME.test(item) && !byName.has(item));
  const defaultModel = [json.resolvedDefault, json.defaultModel].find((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 80);
  return { providers: [...byName.values()], ...(defaultModel ? { defaultModel: maskSecrets(defaultModel) } : {}), ...(missing.length > 0 ? { missing } : {}) };
}

/**
 * `hermes auth list` (conferido com o Hermes v0.23.1: `openai-api (1 credentials):` e uma linha por credencial; sem credencial a saída é vazia): por
 * provedor, `nome (N credentials):` e uma linha por credencial com o tipo (`api_key`, `oauth`…). Só o nome, o tipo e a
 * contagem saem; o texto passa por `maskSecrets` antes de ser lido.
 */
export function parseHermesAuthList(text: string): ParsedStatus {
  const providers: ProgramProvider[] = [];
  let current: { provider: string; profiles: number; kinds: Set<ProgramProviderKind> } | undefined;
  const flush = () => {
    if (!current) return;
    const kinds = current.kinds;
    const kind: ProgramProviderKind = kinds.has("oauth") ? "oauth" : kinds.has("token") ? "token" : kinds.has("api_key") ? "api_key" : LOCAL_PROVIDERS.has(current.provider.toLowerCase()) ? "local" : "unknown";
    providers.push({ provider: current.provider, kind, profiles: current.profiles });
    current = undefined;
  };
  for (const raw of maskSecrets(text).split(/\r?\n/)) {
    const header = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+\((\d+)\s+credentials?\):/.exec(raw);
    if (header) {
      flush();
      if (PROVIDER_NAME.test(header[1]!)) current = { provider: header[1]!, profiles: Number(header[2]), kinds: new Set() };
      continue;
    }
    if (!current) continue;
    const row = /^\s+#\d+\s+.*?\s(oauth|api[_-]?key|token|bearer)\b/i.exec(raw);
    if (row) {
      const type = row[1]!.toLowerCase();
      current.kinds.add(type === "oauth" ? "oauth" : type === "token" || type === "bearer" ? "token" : "api_key");
    } else if (raw.trim() === "") flush();
  }
  flush();
  return { providers };
}

/** `openclaw models list --all --json`: `models[]` com a referência `provedor/modelo` (o formato de uma lista não vazia não foi visto). */
export function parseOpenClawModels(json: unknown): { id: string; label?: string }[] {
  if (!isObject(json) || !Array.isArray(json.models)) return [];
  const out: { id: string; label?: string }[] = [];
  const seen = new Set<string>();
  for (const entry of json.models) {
    if (!isObject(entry)) continue;
    const raw = [entry.key, entry.ref, entry.id, entry.model].find((value): value is string => typeof value === "string" && value.length > 0);
    if (!raw) continue;
    const id = raw.includes("/") ? raw : typeof entry.provider === "string" ? `${entry.provider}/${raw}` : raw;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9~][A-Za-z0-9._:/@+[\]-]*$/.test(id) || id.length > 80 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name !== id ? maskSecrets(shorten(entry.name, 80)) : undefined;
    out.push({ id, ...(name ? { label: name } : {}) });
  }
  return out;
}

/**
 * Os NOMES dos provedores que o `config.yaml` do Hermes liga sem passar pelo `hermes auth` (conferido com o Hermes
 * v0.23.1: `hermes auth list` só mostra o conjunto de credenciais, não um `providers:` do config.yaml nem um `model.provider:
 * custom`). Só nomes: valores (chaves, URLs) nunca são lidos daqui.
 */
export function parseHermesConfigProviders(text: string): string[] {
  const names: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const top = /^([A-Za-z_][\w-]*)\s*:/.exec(raw);
    if (top) {
      section = top[1]!;
      continue;
    }
    if (section === "providers") {
      const entry = /^ {1,4}([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*(?:#.*)?$/.exec(raw);
      if (entry && PROVIDER_NAME.test(entry[1]!)) names.push(entry[1]!);
    } else if (section === "model") {
      const provider = /^\s+provider\s*:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*(?:#.*)?$/.exec(raw);
      if (provider && PROVIDER_NAME.test(provider[1]!)) names.push(provider[1]!);
    } else if (section === "custom_providers") {
      const entry = /^\s*-?\s*name\s*:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*(?:#.*)?$/.exec(raw);
      if (entry && PROVIDER_NAME.test(entry[1]!)) names.push(entry[1]!);
    }
  }
  return [...new Set(names)];
}

export type ProgramReaderTarget = { engine: OneShotEngineId; executable: string; prefixArgs?: string[]; engineRoot: string; location: OneShotAccount["location"]; /** Hermes: o config.yaml de onde ler os NOMES de provedores. */ configFile?: string };

const STATE_TIMEOUT_MS = 30_000;

/** Roda os comandos de ESTADO (somente leitura) do programa e devolve só o que a tela pode mostrar. */
export class ProgramAccountReader {
  constructor(
    private readonly probe: EngineProbe,
    private readonly now: () => Date,
  ) {}

  /** O comando de estado, como a tela o mostra. */
  commandOf(engine: OneShotEngineId): string {
    return engine === "openclaw" ? "openclaw models status --json" : "hermes auth list";
  }

  async detect(target: ProgramReaderTarget): Promise<ProgramAccountInfo> {
    const base = { at: this.now().toISOString(), location: target.location, verified: true, command: this.commandOf(target.engine) };
    const args = [...(target.prefixArgs ?? []), ...(target.engine === "openclaw" ? ["models", "status", "--json"] : ["auth", "list"])];
    const result = await this.probe(target.executable, args, STATE_TIMEOUT_MS, programEnv(target.engine, target.location, target.engineRoot));
    if (!result.ok) return { ...base, ok: false, providers: [], error: maskSecrets(shorten(result.error ?? "o comando de estado não respondeu", 300)) };
    const parsed = target.engine === "openclaw" ? parseOpenClawStatus(parseJsonLoose(result.stdout)) : parseHermesAuthList(result.stdout);
    if (!parsed) return { ...base, ok: false, providers: [], error: "O comando de estado respondeu num formato que o Cyno não reconhece." };
    if (target.engine === "hermes" && target.configFile) {
      try {
        const known = new Set(parsed.providers.map((item) => item.provider));
        for (const name of parseHermesConfigProviders(readFileSync(target.configFile, "utf8"))) if (!known.has(name)) parsed.providers.push({ provider: name, kind: LOCAL_PROVIDERS.has(name.toLowerCase()) ? "local" : "unknown" });
      } catch {
        // sem config.yaml: só o que o `auth list` disse
      }
    }
    return { ...base, ok: true, providers: parsed.providers, ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel } : {}), ...(parsed.missing ? { missing: parsed.missing } : {}) };
  }

  /** Os modelos que o programa lista (OpenClaw: `models list --all --json`; Hermes: não há lista, só digitação livre). */
  async models(target: ProgramReaderTarget): Promise<ProgramModelsResponse> {
    const readAt = this.now().toISOString();
    if (target.engine === "hermes") return { models: [], source: "none", readAt, note: "O Hermes não tem uma lista de modelos para ler sem abrir o programa interativo (`hermes model`): digite o modelo como provedor/modelo." };
    const result = await this.probe(target.executable, [...(target.prefixArgs ?? []), "models", "list", "--all", "--json"], STATE_TIMEOUT_MS, programEnv("openclaw", target.location, target.engineRoot));
    if (!result.ok) return { models: [], source: "none", readAt, note: maskSecrets(shorten(result.error ?? "o programa não respondeu", 200)) };
    const models = parseOpenClawModels(parseJsonLoose(result.stdout));
    return models.length > 0 ? { models, source: "program", readAt } : { models: [], source: "none", readAt, note: "O OpenClaw não listou modelos (sem provedor ligado, ou a lista local está vazia): digite o modelo como provedor/modelo." };
  }
}
