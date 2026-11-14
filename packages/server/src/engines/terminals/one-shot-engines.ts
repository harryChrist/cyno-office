import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_LABELS,
  ENGINE_TEST_FRESH_MS,
  engineBlock,
  MANAGEMENT_KEY_FIX,
  MANAGEMENT_KEY_NOTICE,
  normalizeOpenRouterModelId,
  normalizeProgramModelRef,
  PROGRAM_PROVIDER_KIND_LABELS,
  splitModelRef,
  type OneShotAccount,
  type OneShotAccountBody,
  type ProgramAccountInfo,
  type ProgramModelsResponse,
  type EngineCheck,
  type EngineChoices,
  type EngineInstallJob,
  type EngineInstallPlan,
  type EngineStatus,
  type EngineStep,
  type EngineFence,
  type EngineTestResult,
  type EngineVerifyResult,
  type ModelPrice,
  type OneShotEngineId,
  type OpenRouterModelsResponse,
  type SubscriptionUsage,
  type TurnUsage,
} from "@cyno/shared";
import { removeAgentEngineData } from "./engine-homes";
import { EngineInstaller } from "../install/installer";
import { engineDirs, hermesRecipe, openclawRecipe, type InstallRecipe } from "../install/recipes";
import type { EngineSettingsStore } from "../../platform/models/engine-settings";
import { checkOpenRouterKey, fetchOpenRouterModels, type OpenRouterClientOptions, type OpenRouterModelsCache } from "../../platform/openrouter/client";
import type { OpenRouterKeyStore } from "../../platform/openrouter/key-store";
import { errorMessage, shorten } from "../../util/text";
import { findExecutable } from "./engine-status";
import { detectFence, type FenceSupport } from "./fence";
import type { EngineProbe } from "./engines";
import { HermesAdapter, hermesHomeOf, type HermesAdapterOptions } from "./hermes-adapter";
import { ensureAdapterDirs, OneShotTerminal, type OneShotAdapter } from "./one-shot-terminal";
import { ProgramAccountReader, programSetup, type ProgramReaderTarget } from "./program-account";
import { OpenClawAdapter, readOpenclawBase, type OpenClawAdapterOptions } from "./openclaw-adapter";
import type { TerminalEvent, TerminalSpec } from "./types";

/**
 * Tudo que a tela Motores sabe do OpenClaw e do Hermes: o estado detectado, o passo a passo (Instalar, Chave do
 * OpenRouter, Modelo, Verificar), a lista de modelos do OpenRouter, o "Verificar" (checagens + um turno de teste de
 * verdade, com a confirmação do dono) e a instalação (plano, confirmação, saída).
 *
 * A conta tem duas formas (passo "Conta"): a chave do OpenRouter que o dono põe no painel (só vai por ambiente aos dois
 * processos e nunca sai por rota, log ou evento) ou a configuração do próprio programa (a pessoal do dono ou a pasta
 * isolada do Cyno), que o Cyno só DETECTA pelos comandos de estado do programa, sem ler segredo. O Cyno nunca faz login.
 */

export const ONE_SHOT_TEST_MESSAGE = "Responda só com a palavra: ok";
export const ONE_SHOT_TEST_TIMEOUT_MS = 150_000;
const VERSION_TIMEOUT_MS = 10_000;
/** A segunda tentativa do `--version` que passou do tempo (a primeira num HERMES_HOME novo prepara o ambiente). */
const VERSION_WARMUP_TIMEOUT_MS = 180_000;
/** O que cada motor pede no mínimo (OpenClaw: a versão com que o formato foi conferido). */
const MIN_VERSION: Partial<Record<OneShotEngineId, string>> = { openclaw: "2026.11.3", hermes: "0.23.1" };

const BLURBS: Record<OneShotEngineId, string> = {
  openclaw: "Assistente pessoal de código aberto; o Cyno usa só o modo de um turno (agent exec), sem daemon, canais nem Gateway. A conta é a chave do OpenRouter, ou a configuração do próprio programa (assinatura, chave de qualquer provedor, modelo local). Serve a qualquer papel.",
  hermes: "Agente de terminal da Nous Research (Hermes Agent), com MCP; um processo por turno. A conta é a chave do OpenRouter, ou a configuração do próprio programa (assinatura, chave de qualquer provedor, modelo local). Serve a qualquer papel.",
};

const UNVERIFIED_BASE: Record<OneShotEngineId, string[]> = {
  openclaw: [
    "Provado com o OpenClaw de verdade (2026.11.3) contra um provedor falso local, sem conta: o envelope de um turno que dá certo, o de tempo estourado, as ferramentas negadas por política (por grupos), o MCP \"office\" chamado de verdade (`office__submit_result`), turno de teste, tarefa de agente, tempo estourado, interrupção e o Maestro em dois turnos.",
    "Alcance dos arquivos, provado com o programa: as ferramentas de arquivo (`read`, `write`, `edit`) só valem dentro da pasta do agente (`tools.fs.workspaceOnly`, ligado pelo Cyno): caminho fora da pasta, `..`, link simbólico para fora e `/proc/self/environ` são recusados, e o arquivo de configuração do agente (com o token do MCP) fica fora da pasta de trabalho. Com o acesso a terminal ligado, o `exec` do programa não tem essa trava (vale o que vale para qualquer motor com terminal).",
    "Interromper e o tempo máximo, provados: o processo e o que ele abriu saem, e o provedor não recebe mais requisições depois do corte.",
    "Não provado: a autenticação de verdade no OpenRouter (o Verificar com a sua chave confirma) e o comportamento de um modelo real; a retomada de conversa do OpenClaw (o Cyno repassa um resumo, não retoma).",
  ],
  hermes: [
    "Provado com o Hermes de verdade (v0.23.1) contra um provedor falso local, sem conta: o stream-json (ferramentas, texto, tokens), o id da sessão e o --resume, as ferramentas de arquivo e do MCP \"office\" (`mcp__office__*`), a restrição de ferramentas por conjunto (-t), tempo estourado, interrupção, o Maestro em dois turnos e que o Hermes não adota logins de outros programas do HOME (travado: HOME vazio e adopt_external_logins: false).",
    "Interromper, parar e o tempo máximo, provados: o gateway é um processo à parte e continuava o agente (requisições ao provedor seguiam chegando depois do corte); agora o Cyno encerra o gateway do agente junto, no corte e no fechamento do servidor, e o turno seguinte sobe um novo.",
    "Não provado: a autenticação de verdade no OpenRouter e o comportamento de um modelo real; que a chave só pelo ambiente chega ao OpenRouter de verdade (o código do Hermes semeia o `OPENROUTER_API_KEY` do ambiente para o host openrouter.ai, mas só um modelo real confirma); o custo (o stream-json traz só tokens). O Hermes roda o agente num gateway que o próprio turno sobe (~270 MB, sai 60 s depois do último turno): trocar a chave vale a partir do próximo gateway.",
  ],
};

const HERMES_UNCONFINED = "NÃO CONFINADO, provado com o programa: as ferramentas de arquivo do Hermes (`read_file`, `write_file`, `patch`, `search_files`) leem e gravam fora da pasta do agente (caminho absoluto, `..` e link simbólico passam), então um agente com elas alcança os arquivos do usuário do servidor, inclusive a chave do OpenRouter guardada pelo Cyno e o `config.yaml` com o token de MCP. O programa não tem opção que prenda os arquivos a uma pasta; ele só recusa as próprias credenciais (`.env`, `auth.json` do HERMES_HOME) e `/proc/*/environ`. Use em workspaces de confiança.";

const HERMES_FENCED = "Cerca de arquivos (Landlock), provada com o Hermes de verdade e arquivos-isca: com ela, as ferramentas de arquivo do Hermes só alcançam a pasta de trabalho do agente, o HERMES_HOME dele (estado, sessões, `tmp/` e o HOME dele) e, só leitura, a instalação do programa; caminho absoluto, `..`, link simbólico (de arquivo e de pasta), a isca da chave do OpenRouter, o token de outro agente, `/proc/self/environ` e `/proc/<pid do gateway>/environ` são recusados, e gravar fora também. O que continua alcançável: o token de MCP do próprio agente (o `config.yaml` do HERMES_HOME dele), a lista de números de processo (`/proc` só lista; o conteúdo de `/proc/<pid>/` fica fechado), a pasta `pm-runtime` da instalação (~3 MB que o programa regrava) e, com a configuração do próprio programa, o `.env` e o `auth.json` que você ligou no Hermes. Com o terminal ligado, os comandos do agente herdam a cerca (provado: `cat` fora da pasta, em `/proc/self/environ` e no `environ` de todos os processos dão \"Permission denied\", enquanto sem a cerca o `cat` do ambiente do gateway devolvia a chave; o shell do Hermes nem recebe a chave no ambiente dele). A cerca é de arquivos: a internet segue a permissão do workspace.";

const OPENCLAW_FENCED = "Cerca de arquivos (Landlock), provada com o OpenClaw de verdade e arquivos-isca, além do confinamento do próprio programa: o processo só alcança a pasta de trabalho, o estado e o HOME isolados do OpenClaw no Cyno (as sessões são compartilhadas entre os agentes dele) e o temporário do agente; a configuração do agente (token de MCP) é só leitura. Sem cerca, por desenho: na configuração do programa em `~/.openclaw` (pasta pessoal do dono) e nos agentes com o acesso a terminal ligado (provado: com a cerca fechada o `exec` do programa derruba o turno, porque precisa ler o `/proc` dos processos que abre para encerrá-los; abrir isso abriria o `environ` de todos os processos do usuário). Nesses casos valem só a trava de pasta do programa (`tools.fs.workspaceOnly`) e a sua escolha de ligar o terminal.";

/** O que foi provado e o que não foi, conforme a cerca (a linha "NÃO CONFINADO" do Hermes só vale sem ela). */
function unverifiedFor(engine: OneShotEngineId, fenced: boolean): string[] {
  const lines = [...UNVERIFIED_BASE[engine]];
  if (engine === "hermes") lines.splice(1, 0, fenced ? HERMES_FENCED : HERMES_UNCONFINED);
  else if (fenced) lines.splice(2, 0, OPENCLAW_FENCED);
  return lines;
}

export type TurnRunner = (input: { engine: OneShotEngineId; model: string; effort?: EngineChoices["effort"] }) => Promise<{ result: EngineTestResult; usage?: TurnUsage }>;

export type OneShotEnginesDeps = {
  dataDir: string;
  /** A pasta do usuário (onde o instalador publica o comando). */
  homeDir: string;
  pathEnv?: string;
  now: () => Date;
  settings: EngineSettingsStore;
  key: OpenRouterKeyStore;
  models: OpenRouterModelsCache;
  /** O comando de cada motor agora (o da configuração dos terminais). */
  command: (engine: OneShotEngineId) => { command: string; prefixArgs?: string[] | undefined };
  /** O motor passou a ser achado em outro caminho (depois de instalar): atualiza o comando dos terminais. */
  setCommand: (engine: OneShotEngineId, command: string | undefined) => void;
  /** Aplica o modelo/esforço padrão escolhidos aos terminais. */
  applyChoices: (engine: OneShotEngineId, choices: EngineChoices) => void;
  probe: EngineProbe;
  openrouter?: OpenRouterClientOptions;
  usage: () => readonly SubscriptionUsage[];
  /** O servidor MCP "office" responde? */
  mcpCheck?: () => Promise<{ ok: boolean; detail?: string }>;
  installer: EngineInstaller;
  /** Receitas de instalação (nos testes: receitas falsas, sem rede). */
  recipe?: (engine: OneShotEngineId) => InstallRecipe;
  /** O turno de teste (padrão: roda o programa de verdade num terminal temporário). */
  turn?: TurnRunner;
  /** O que este computador oferece de cerca de arquivos (padrão: a detecção de verdade); injetável nos testes. */
  fenceSupport?: () => FenceSupport;
  /** O que o turno de teste gastou entra no histórico (marcado como teste). */
  recordTestUsage?: (spent: { engine: OneShotEngineId; model: string; usage: TurnUsage; durationMs: number }) => void;
  /** Registro na Atividade (instalação confirmada, chave trocada…). */
  record?: (action: string, summary: string, data?: Record<string, unknown>) => void;
  /** Só testes: onde a execução do turno de teste real acha as CLIs falsas. */
  adapterOptions?: { openclaw?: Partial<OpenClawAdapterOptions>; hermes?: Partial<HermesAdapterOptions> };
  turnTimeoutMs?: number;
  /** Hermes: o teto de gateways, os em uso e os turnos esperando vaga. */
  gateways?: () => { max: number; inUse: number; waiting: number };
};

const dotted = (version: string) => (/\d+(?:\.\d+)+/.exec(version)?.[0] ?? "").split(".").map(Number);
function versionAtLeast(version: string, minimum: string): boolean {
  const have = dotted(version);
  const need = dotted(minimum);
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const usd = (value: number) => `US$ ${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`.replace(".", ",");
const priceText = (price: ModelPrice | undefined) => (!price ? "preço desconhecido" : price.free ? "gratuito" : `US$ ${price.promptPerM ?? "?"}/M de entrada · US$ ${price.completionPerM ?? "?"}/M de saída`.replaceAll(".", ","));

/** Quanto tempo a leitura do que o programa tem ligado vale antes de o estado pedir de novo. */
const PROGRAM_FRESH_MS = 60_000;

export class OneShotEngines {
  private readonly reader: ProgramAccountReader;
  /** O que o programa disse da última vez (sem segredo), por motor; vale para a forma de conta e o local de quando foi lida. */
  private readonly detected = new Map<OneShotEngineId, ProgramAccountInfo>();

  constructor(private readonly deps: OneShotEnginesDeps) {
    this.reader = new ProgramAccountReader(deps.probe, deps.now);
  }

  private engineRoot(engine: OneShotEngineId): string {
    return engineDirs(this.deps.dataDir, engine).root;
  }

  private async readerTarget(engine: OneShotEngineId, account: OneShotAccount): Promise<ProgramReaderTarget | undefined> {
    const executable = await this.locate(engine);
    if (!executable) return undefined;
    const bin = this.deps.command(engine);
    return { engine, executable, ...(bin.prefixArgs ? { prefixArgs: bin.prefixArgs } : {}), engineRoot: this.engineRoot(engine), location: account.location, ...(engine === "hermes" ? { configFile: path.join(account.location === "personal" ? path.join(this.deps.homeDir, ".hermes") : hermesHomeOf(this.engineRoot(engine)), "config.yaml") } : {}) };
  }

  /** A cerca de arquivos do motor: a opção da tela, o que o computador oferece e o que vale de verdade. */
  private fenceStatus(engine: OneShotEngineId, account: OneShotAccount): EngineFence {
    const support = (this.deps.fenceSupport ?? detectFence)();
    const enabled = this.deps.settings.fence(engine);
    // OpenClaw na pasta pessoal do dono (HOME dele): a lista teria de abrir a pasta pessoal inteira, então não há cerca ali.
    const personalOpenclaw = engine === "openclaw" && account.mode === "program" && account.location === "personal";
    const active = enabled && support.available && !personalOpenclaw;
    const reason = !support.available ? support.reason : personalOpenclaw ? "Na pasta pessoal do OpenClaw (~/.openclaw) o programa roda sem cerca; ele já prende as ferramentas de arquivo à pasta do agente." : undefined;
    return { enabled, available: support.available, active, ...(support.available ? { abi: support.abi } : {}), ...(reason && !active ? { reason } : {}) };
  }

  /** Lê de novo, com o comando de ESTADO do programa (somente leitura), o que está ligado. Só o nome, o tipo e a contagem ficam. */
  async detectProgram(engine: OneShotEngineId): Promise<ProgramAccountInfo> {
    const account = this.deps.settings.account(engine);
    const target = await this.readerTarget(engine, account);
    const info: ProgramAccountInfo = target
      ? await this.reader.detect(target)
      : { at: this.deps.now().toISOString(), location: account.location, ok: false, providers: [], error: "O programa não está instalado.", verified: true, command: this.reader.commandOf(engine) };
    this.detected.set(engine, info);
    return info;
  }

  /** A leitura guardada, ou uma nova se ela é velha ou foi de outro local. */
  private async programInfo(engine: OneShotEngineId, account: OneShotAccount): Promise<ProgramAccountInfo> {
    const cached = this.detected.get(engine);
    if (cached && cached.location === account.location && this.deps.now().getTime() - Date.parse(cached.at) < PROGRAM_FRESH_MS) return cached;
    return this.detectProgram(engine);
  }

  /** Os modelos que o próprio programa lista (OpenClaw), ou nada (Hermes: digitação livre). */
  async programModels(engine: OneShotEngineId): Promise<ProgramModelsResponse> {
    const account = this.deps.settings.account(engine);
    const target = await this.readerTarget(engine, account);
    if (!target) return { models: [], source: "none", readAt: this.deps.now().toISOString(), note: "O programa não está instalado." };
    return this.reader.models(target);
  }

  /** O passo "Conta": a forma (chave do painel ou configuração do programa) e o local. Zera o Verificar (a conta mudou). */
  async setAccount(engine: OneShotEngineId, change: OneShotAccountBody): Promise<OneShotAccount> {
    const current = this.deps.settings.account(engine);
    const next: OneShotAccount = { mode: change.mode ?? current.mode, location: change.location ?? current.location };
    // A chave do painel só existe na pasta isolada do Cyno.
    if (next.mode === "openrouter") next.location = "cyno";
    if (next.mode === current.mode && next.location === current.location) return next;
    await this.deps.settings.setAccount(engine, next);
    await this.deps.settings.clearVerify(engine);
    this.detected.delete(engine);
    this.deps.record?.("motor_conta_trocada", `${ENGINE_LABELS[engine]}: conta ${next.mode === "openrouter" ? "pela chave do OpenRouter" : `pela configuração do programa (${next.location === "personal" ? "pasta pessoal" : "pasta do Cyno"})`}`, { engine, ...next });
    return next;
  }

  recipeOf(engine: OneShotEngineId): InstallRecipe {
    if (this.deps.recipe) return this.deps.recipe(engine);
    const dirs = engineDirs(this.deps.dataDir, engine);
    return engine === "hermes" ? hermesRecipe(dirs, this.deps.homeDir) : openclawRecipe(dirs);
  }

  /** O executável: o comando em uso, o PATH, ~/.local/bin e os lugares da instalação do Cyno. */
  private async locate(engine: OneShotEngineId): Promise<string | undefined> {
    const bin = this.deps.command(engine);
    const pathEnv = this.deps.pathEnv ?? process.env.PATH ?? "";
    const direct = await findExecutable(bin.command, pathEnv, this.deps.homeDir);
    if (direct) return direct;
    for (const candidate of this.recipeOf(engine).binaryCandidates) {
      const found = await findExecutable(candidate, pathEnv, this.deps.homeDir);
      if (found) return found;
    }
    return undefined;
  }

  private versionEnv(engine: OneShotEngineId): Record<string, string> {
    const dirs = engineDirs(this.deps.dataDir, engine);
    if (engine === "hermes") return { HERMES_HOME: dirs.home, NO_COLOR: "1" };
    return { HOME: path.join(dirs.root, "home"), OPENCLAW_STATE_DIR: path.join(dirs.root, "state"), OPENCLAW_CONFIG_PATH: path.join(dirs.root, "openclaw.json"), NO_COLOR: "1" };
  }

  /** O `--version` demorado (o primeiro numa pasta nova): roda uma vez em segundo plano, com mais tempo; `undefined` enquanto não acabou. */
  private readonly warming = new Map<OneShotEngineId, { done: boolean; version?: string }>();

  private async version(engine: OneShotEngineId, executable: string): Promise<{ ok: boolean; version?: string; error?: string; preparing?: boolean }> {
    const prefix = this.deps.command(engine).prefixArgs ?? [];
    const result = await this.deps.probe(executable, [...prefix, "--version"], VERSION_TIMEOUT_MS, this.versionEnv(engine));
    if (!result.ok && result.timedOut) {
      // O programa existe e só demorou (o primeiro `hermes --version` numa pasta nova prepara o ambiente, passa de 10 s): não é "não instalado".
      // Mostra "instalado, preparando…" e tenta de novo com mais tempo, em segundo plano; a consulta seguinte já acha a versão.
      const state = this.warming.get(engine);
      if (state?.done && state.version) return { ok: true, version: state.version };
      if (!state || state.done) {
        const entry: { done: boolean; version?: string } = { done: false };
        this.warming.set(engine, entry);
        void this.deps.probe(executable, [...prefix, "--version"], VERSION_WARMUP_TIMEOUT_MS, this.versionEnv(engine)).then(
          (late) => {
            entry.done = true;
            const line = late.ok ? late.stdout.trim().split(/\r?\n/)[0]?.trim().replace(/^(?:openclaw|hermes(?: agent)?)\s+/i, "").slice(0, 80) : undefined;
            if (line) entry.version = line;
          },
          () => {
            entry.done = true;
          },
        );
      }
      return { ok: true, preparing: true };
    }
    if (!result.ok) return { ok: false, error: result.error ?? "não respondeu ao --version" };
    // "OpenClaw 2026.11.3 (847611d)": a tela já diz o nome do motor, então fica só a versão.
    const line = result.stdout.trim().split(/\r?\n/)[0]?.trim().replace(/^(?:openclaw|hermes(?: agent)?)\s+/i, "").slice(0, 80);
    return line ? { ok: true, version: line } : { ok: false, error: "o --version veio vazio" };
  }

  private priceOf(model: string | undefined): ModelPrice | undefined {
    return model ? this.deps.models.find(model.replace(/^openrouter\//, ""))?.price : undefined;
  }

  // ---------- Estado ----------

  async status(engine: OneShotEngineId): Promise<EngineStatus> {
    const { settings, key, now } = this.deps;
    const found = await this.locate(engine);
    // Achado fora do comando em uso (ex.: instalado pelo Cyno, ou depois de reiniciar o servidor): os agentes passam a usar este.
    if (found && !settings.paths()[engine] && this.deps.command(engine).command !== found) this.deps.setCommand(engine, found);
    const version = found ? await this.version(engine, found) : undefined;
    const installed = Boolean(found && version?.ok);
    const keyInfo = key.info();
    const account = settings.account(engine);
    const program = installed && account.mode === "program" ? await this.programInfo(engine, account) : undefined;
    const programLinked = Boolean(program?.ok && program.providers.length > 0);
    const choices = settings.choices(engine);
    const verify = settings.verify(engine);
    const verifyFresh = Boolean(verify?.ok && verify.turn?.ok && now().getTime() - Date.parse(verify.at) < ENGINE_TEST_FRESH_MS);
    const block = installed ? engineBlock(engine, { usage: this.deps.usage(), now: now().getTime() }) : undefined;
    const loggedIn = account.mode === "openrouter" ? keyInfo.configured : program === undefined || !program.ok || programLinked;
    const state: EngineStatus["state"] = !installed ? "not_installed" : !loggedIn ? "no_login" : block?.reason === "quota" ? "no_quota" : verifyFresh ? "working" : "installed";
    const job = this.deps.installer.current();
    const installJob = job?.engine === engine ? job : undefined;
    const cached = this.deps.models.read();
    const spent = settings.spent(engine);
    const modelPrice = this.priceOf(choices.model);
    const steps = this.steps({ installed, installJob, account, keyConfigured: keyInfo.configured, program, verify, verifyFresh, model: choices.model, version: version?.version, found });
    const setupRoot = { engineRoot: this.engineRoot(engine), homeDir: this.deps.homeDir };
    const fence = this.fenceStatus(engine, account);
    return {
      id: engine,
      label: ENGINE_LABELS[engine],
      blurb: BLURBS[engine],
      supported: true,
      state,
      ...(installed && version?.version ? { version: version.version } : {}),
      ...(engine === "hermes" && this.deps.gateways ? { gateways: this.deps.gateways() } : {}),
      ...(installed && version?.preparing ? { notice: "Instalado, preparando: o programa está montando a pasta dele pela primeira vez (pode levar um minuto). Consulte de novo em instantes." } : {}),
      ...(found ? { path: found, pathSource: "path" as const } : {}),
      ...(settings.paths()[engine] !== undefined ? { configuredPath: settings.paths()[engine]! } : {}),
      ...(block?.reason === "quota" && block.resetsAt ? { resetsAt: block.resetsAt } : {}),
      ...(verify?.turn ? { lastTest: verify.turn } : {}),
      ...(found && version && !version.ok ? { notice: `Achei ${found}, mas ele não respondeu ao --version: ${version.error}` } : {}),
      openrouterKey: keyInfo,
      account,
      fence,
      ...(program ? { program } : {}),
      programSetup: programSetup(engine, account, setupRoot),
      choices,
      ...(cached ? { models: cached.models.map((model) => ({ id: model.id, label: `${model.name} · ${priceText(model.price)}` })), modelsReadAt: cached.readAt } : {}),
      ...(modelPrice ? { modelPrice } : {}),
      ...(spent ? { spent } : {}),
      steps,
      ...(verify ? { verify } : {}),
      ...(!installed ? { installable: true } : {}),
      ...(installJob ? { installJob } : {}),
      unverified: unverifiedFor(engine, fence.active),
    };
  }

  private steps(input: { installed: boolean; installJob: EngineInstallJob | undefined; account: OneShotAccount; keyConfigured: boolean; program: ProgramAccountInfo | undefined; verify: EngineVerifyResult | undefined; verifyFresh: boolean; model: string | undefined; version: string | undefined; found: string | undefined }): EngineStep[] {
    const failed = (id: string) => input.verify?.checks.find((check) => check.id === id)?.ok === false;
    const list: { id: EngineStep["id"]; label: string; done: boolean; error: boolean; detail?: string }[] = [
      {
        id: "install",
        label: input.installed ? "Instalado" : "Instalar",
        done: input.installed,
        error: input.installJob?.status === "failed",
        ...(input.installed ? { detail: [input.version, input.found].filter(Boolean).join(" · ") } : input.installJob?.status === "failed" ? { detail: input.installJob.error ?? "A instalação falhou" } : input.installJob?.status === "running" ? { detail: "Instalando…" } : {}),
      },
      this.accountStep(input, failed),
      { id: "model", label: "Modelo", done: Boolean(input.model) || Boolean(input.account.mode === "program" && input.program?.defaultModel), error: Boolean(input.model) && failed("model"), ...(input.model ? { detail: input.model } : input.account.mode === "program" && input.program?.defaultModel ? { detail: `padrão do programa: ${input.program.defaultModel}` } : {}) },
      { id: "verify", label: "Verificar", done: input.verifyFresh, error: Boolean(input.verify) && !input.verify!.ok && !input.verify!.pendingTurn && !input.verifyFresh },
    ];
    let currentSet = false;
    return list.map((step) => {
      const state: EngineStep["state"] = step.error ? "error" : step.done ? "done" : !currentSet ? "current" : "todo";
      if (state === "current" || state === "error") currentSet = true;
      return { id: step.id, label: step.label, state, ...(step.detail ? { detail: step.detail } : {}) };
    });
  }

  /** O passo "Conta": a chave do painel, ou os provedores que o programa diz ter ligados. */
  private accountStep(input: { account: OneShotAccount; keyConfigured: boolean; program: ProgramAccountInfo | undefined }, failed: (id: string) => boolean): { id: EngineStep["id"]; label: string; done: boolean; error: boolean; detail?: string } {
    if (input.account.mode === "openrouter") {
      return { id: "key", label: "Conta", done: input.keyConfigured, error: input.keyConfigured && failed("account"), ...(input.keyConfigured ? (failed("account") ? { detail: "A chave foi recusada ou deu erro: veja o Verificar" } : { detail: "Chave do OpenRouter" }) : {}) };
    }
    const place = input.account.location === "personal" ? "pasta pessoal" : "pasta do Cyno";
    const providers = input.program?.providers ?? [];
    const linked = Boolean(input.program?.ok && providers.length > 0);
    return {
      id: "key",
      label: "Conta",
      done: linked,
      error: linked && failed("account"),
      detail: linked ? `Configuração do programa (${place}): ${providers.map((provider) => provider.provider).join(", ")}` : input.program && !input.program.ok ? `Não consegui ler o estado do programa (${place})` : `Configuração do programa (${place}): nenhum provedor ligado`,
    };
  }

  // ---------- Modelos e escolhas ----------

  /** Consulta a chave que o dono acabou de colar: o aviso da chave de gerenciamento (ou nada). Falha de rede = sem aviso (o Verificar confere depois). */
  async keyWarning(secret: string): Promise<string | undefined> {
    const status = await checkOpenRouterKey(secret, this.deps.openrouter);
    return status.ok && status.management ? `${MANAGEMENT_KEY_NOTICE} ${MANAGEMENT_KEY_FIX}` : undefined;
  }

  async refreshModels(): Promise<OpenRouterModelsResponse> {
    const models = await fetchOpenRouterModels(this.deps.openrouter);
    const readAt = this.deps.now().toISOString();
    return this.deps.models.write(models, readAt);
  }

  async setChoices(engine: OneShotEngineId, change: { model?: string | null; effort?: EngineChoices["effort"] | null; provider?: string | null }): Promise<EngineChoices> {
    const current = this.deps.settings.choices(engine);
    const next: EngineChoices = { ...current };
    if (change.model !== undefined) {
      if (change.model && this.deps.settings.account(engine).mode === "program") {
        // Configuração do programa: `provedor/modelo` de qualquer provedor (openrouter/…, openai/…, ollama/…). Quem confere é o Verificar.
        const ref = normalizeProgramModelRef(change.model);
        if (!ref) throw new Error(`"${change.model}" não parece uma referência de modelo: o formato é provedor/modelo (ex.: openai/gpt-5, ollama/llama3.2:3b, openrouter/deepseek/deepseek-v4-flash).`);
        next.model = ref;
        delete next.unlisted;
      } else if (change.model) {
        // Aceita colar o id do site (com ou sem `openrouter/`); só o formato é exigido: o id pode ser novo e ainda não estar
        // na lista guardada. O que não está nela fica marcado como "não conferido" até o "Verificar".
        const id = normalizeOpenRouterModelId(change.model);
        if (!id) throw new Error(`"${change.model}" não parece um id do OpenRouter: o formato é provedor/modelo (ex.: deepseek/deepseek-v4-flash), com :sufixo opcional.`);
        next.model = id;
        if (this.deps.models.find(id)) delete next.unlisted;
        else next.unlisted = true;
      } else {
        delete next.model;
        delete next.unlisted;
      }
    }
    if (change.effort !== undefined) {
      if (change.effort) next.effort = change.effort;
      else delete next.effort;
    }
    if (engine === "hermes") delete next.effort;
    delete next.provider;
    await this.deps.settings.setChoices(engine, next);
    this.deps.applyChoices(engine, next);
    return next;
  }

  /** O "Verificar" achou o modelo na lista: some a marca de "não conferido". */
  private async markListed(engine: OneShotEngineId): Promise<void> {
    const next = { ...this.deps.settings.choices(engine) };
    delete next.unlisted;
    await this.deps.settings.setChoices(engine, next);
    this.deps.applyChoices(engine, next);
  }

  // ---------- Instalar ----------

  installPlan(engine: OneShotEngineId): EngineInstallPlan {
    return this.recipeOf(engine).plan;
  }

  /** Começa a instalação (só chamada depois do `confirm: true`). A Atividade registra o pedido e o fim. */
  startInstall(engine: OneShotEngineId): EngineInstallJob {
    const recipe = this.recipeOf(engine);
    this.deps.record?.("motor_instalacao_confirmada", `Você confirmou instalar o ${ENGINE_LABELS[engine]}`, { engine, command: recipe.plan.command, destination: recipe.plan.destination });
    return this.deps.installer.start(engine, recipe);
  }

  /** Depois de uma instalação: procura o executável e passa o comando novo aos terminais. */
  async afterInstall(engine: OneShotEngineId): Promise<void> {
    const found = await this.locate(engine);
    if (found) this.deps.setCommand(engine, found);
    const job = this.deps.installer.current();
    this.deps.record?.(job?.status === "done" && found ? "motor_instalado" : "motor_instalacao_falhou", job?.status === "done" && found ? `${ENGINE_LABELS[engine]} instalado` : `A instalação do ${ENGINE_LABELS[engine]} não terminou`, { engine, ...(job?.error ? { error: job.error } : {}), ...(found ? { path: found } : {}) });
  }

  // ---------- Verificar ----------

  async verify(engine: OneShotEngineId, options: { confirm?: boolean } = {}): Promise<EngineVerifyResult> {
    const { settings, key, now } = this.deps;
    const checks: EngineCheck[] = [];
    const add = (check: EngineCheck) => {
      checks.push(check);
      return check.ok === true;
    };
    const found = await this.locate(engine);
    const version = found ? await this.version(engine, found) : undefined;
    const exeOk = add({
      id: "exe",
      label: "O programa existe e responde à versão",
      ok: Boolean(found && version?.ok),
      ...(found && version?.ok ? { detail: `${version.version} · ${found}` } : { detail: found ? `Achei ${found}, mas: ${version?.error}` : "Não achei o executável.", fix: found ? "Reinstale pelo passo 1, ou aponte o caminho certo em Configurar." : "Rode o passo 1 (Instalar)." }),
    });
    const minimum = MIN_VERSION[engine];
    add(
      !exeOk
        ? { id: "version", label: "A versão é suportada", ok: null }
        : !minimum
          ? { id: "version", label: "A versão é suportada", ok: true, detail: "O Cyno não exige uma versão mínima deste programa." }
          : versionAtLeast(version!.version ?? "", minimum)
            ? { id: "version", label: "A versão é suportada", ok: true, detail: `${version!.version} (mínimo ${minimum})` }
            : { id: "version", label: "A versão é suportada", ok: false, detail: `${version!.version} é mais antiga que ${minimum}`, fix: "Atualize o programa (npm install -g openclaw@latest)." },
    );
    const account = settings.account(engine);
    const program = account.mode === "program" ? await this.detectProgram(engine) : undefined;
    // A conta: a chave do painel (aceita e que não seja de gerenciamento) OU pelo menos um provedor ligado no programa.
    const accountLabel = account.mode === "openrouter" ? "Há uma conta ligada: a chave do OpenRouter está configurada e é aceita" : "Há uma conta ligada: o programa tem pelo menos um provedor";
    let accountOk = false;
    if (account.mode === "openrouter") {
      const secret = key.get();
      if (!secret) add({ id: "account", label: accountLabel, ok: false, detail: "Nenhuma chave configurada.", fix: 'Cole a chave no passo "Conta" (openrouter.ai › Keys), ou escolha a configuração do próprio programa.' });
      else {
        const status = await checkOpenRouterKey(secret, this.deps.openrouter);
        accountOk = add(
          status.ok && status.management
            ? { id: "account", label: accountLabel, ok: false, detail: MANAGEMENT_KEY_NOTICE, fix: MANAGEMENT_KEY_FIX }
            : status.ok
              ? { id: "account", label: accountLabel, ok: true, detail: status.limit === null ? `Aceita. Sem limite de crédito na chave; usado até agora ${usd(status.usage ?? 0)}.` : `Aceita. Saldo da chave: ${usd(status.remaining ?? 0)} de ${usd(status.limit)}.` }
              : { id: "account", label: accountLabel, ok: false, detail: status.error, fix: status.rejected ? 'Gere outra chave em openrouter.ai › Keys e use "Trocar".' : "Confira a conexão com a internet e tente de novo." },
        );
      }
    } else if (program) {
      const place = account.location === "personal" ? "da sua pasta pessoal" : "da pasta do Cyno";
      const setup = programSetup(engine, account, { engineRoot: this.engineRoot(engine), homeDir: this.deps.homeDir });
      accountOk = add(
        !program.ok
          ? { id: "account", label: accountLabel, ok: false, detail: `Não consegui ler o estado do programa (${program.command}): ${program.error ?? "sem resposta"}`, fix: "Confira se o programa está instalado e roda no terminal." }
          : program.providers.length > 0
            ? { id: "account", label: accountLabel, ok: true, detail: `${program.providers.map((provider) => `${provider.provider} (${PROGRAM_PROVIDER_KIND_LABELS[provider.kind]})`).join(", ")} — configuração ${place}.${program.verified ? "" : " Leitura não verificada com o programa de verdade."}` }
            : { id: "account", label: accountLabel, ok: false, detail: `O programa não tem nenhum provedor ligado na configuração ${place}.`, fix: `Ligue um no seu terminal: ${setup.commands[0]}` },
      );
    }
    // O modelo: o escolhido existe e é de um provedor ligado (OpenRouter: existe na lista; programa: o provedor dele está ligado).
    const model = settings.choices(engine).model;
    let modelOk = false;
    const openrouterId = account.mode === "openrouter" ? model : model && splitModelRef(model)?.provider === "openrouter" ? model.slice("openrouter/".length) : undefined;
    if (account.mode === "program") {
      const ref = model ?? program?.defaultModel;
      const split = ref ? splitModelRef(ref) : undefined;
      const linked = new Set((program?.providers ?? []).map((provider) => provider.provider));
      if (!ref) add({ id: "model", label: "O modelo escolhido é de um provedor ligado", ok: false, detail: "Nenhum modelo escolhido e o programa não tem modelo padrão.", fix: "Escolha um modelo no passo Modelo (provedor/modelo)." });
      else if (!split) add({ id: "model", label: "O modelo escolhido é de um provedor ligado", ok: false, detail: `"${ref}" não está no formato provedor/modelo.`, fix: "Use provedor/modelo, como openai/gpt-5 ou ollama/llama3.2:3b." });
      else if (!program?.ok) add({ id: "model", label: "O modelo escolhido é de um provedor ligado", ok: null, detail: "Falta ler o estado do programa (veja a checagem da conta)." });
      else {
        modelOk = add(
          linked.has(split.provider) || split.provider === "ollama" || split.provider === "lmstudio"
            ? { id: "model", label: "O modelo escolhido é de um provedor ligado", ok: true, detail: `${ref}${model ? "" : " (o modelo padrão do programa)"} — provedor ${split.provider} ligado.` }
            : { id: "model", label: "O modelo escolhido é de um provedor ligado", ok: false, detail: `${ref}: o provedor "${split.provider}" não está entre os ligados (${[...linked].join(", ") || "nenhum"}).`, fix: "Escolha um modelo de um provedor ligado, ou ligue este no terminal." },
        );
      }
    } else if (!model) add({ id: "model", label: "O modelo escolhido existe no OpenRouter", ok: false, detail: "Nenhum modelo escolhido.", fix: "Escolha um modelo no passo 3 (sugestão: um gratuito, com o sufixo :free)." });
    else if (openrouterId) {
      let listed = this.deps.models.read();
      if (!listed) {
        try {
          listed = await this.refreshModels();
        } catch (error) {
          add({ id: "model", label: "O modelo escolhido existe no OpenRouter", ok: null, detail: `Não consegui ler a lista de modelos: ${errorMessage(error)}`, fix: 'Use "Atualizar modelos" com a internet funcionando.' });
        }
      }
      if (listed) {
        let entry = listed.models.find((candidate) => candidate.id === openrouterId);
        // Fora da lista guardada: lê de novo antes de concluir que não existe (o id pode ser recente).
        if (!entry) {
          try {
            listed = await this.refreshModels();
            entry = listed.models.find((candidate) => candidate.id === openrouterId);
          } catch {
            // segue com a lista que havia
          }
        }
        if (entry && settings.choices(engine).unlisted) await this.markListed(engine);
        modelOk = add(
          entry
            ? { id: "model", label: "O modelo escolhido existe no OpenRouter", ok: true, detail: `${model} · ${priceText(entry.price)}${entry.tools === false ? " · atenção: o OpenRouter diz que este modelo não aceita ferramentas (os agentes do Cyno usam)" : ""}` }
            : { id: "model", label: "O modelo escolhido existe no OpenRouter", ok: false, detail: `${model} não está na lista atual do OpenRouter (lida agora, ${listed.models.length} modelos).`, fix: "Confira o id em openrouter.ai/models (botão de copiar ao lado do nome) e escolha-o de novo, ou escolha um da lista." },
        );
      }
    }
    // O MCP "office" do Cyno responde (é por ele que o agente recebe e entrega o trabalho).
    const mcp = this.deps.mcpCheck ? await this.deps.mcpCheck() : { ok: false, detail: "A checagem do MCP não está disponível neste servidor." };
    const mcpOk = add({ id: "mcp", label: 'O servidor MCP "office" do Cyno responde', ok: mcp.ok, ...(mcp.detail ? { detail: mcp.detail } : {}), ...(mcp.ok ? {} : { fix: "Reinicie o servidor do Cyno e tente de novo." }) });
    const ready = exeOk && accountOk && modelOk && mcpOk;
    const price = this.priceOf(openrouterId);
    let turn: EngineTestResult | undefined;
    let pendingTurn: EngineVerifyResult["pendingTurn"];
    if (!ready) add({ id: "turn", label: 'Um turno de teste de verdade ("responda só: ok")', ok: null, detail: "Falta resolver as checagens acima." });
    else if (options.confirm !== true) {
      const turnModel = model ?? program?.defaultModel ?? "";
      pendingTurn = { model: turnModel, ...(price ? { price } : {}), notice: this.turnNotice(turnModel, price, account, program) };
      add({ id: "turn", label: 'Um turno de teste de verdade ("responda só: ok")', ok: null, detail: pendingTurn.notice, fix: "Confirme para rodar o turno de teste." });
    } else {
      const turnModel = model ?? program?.defaultModel ?? "";
      const outcome = await (this.deps.turn ?? ((input) => this.realTurn(input)))({ engine, model: turnModel, ...(settings.choices(engine).effort ? { effort: settings.choices(engine).effort } : {}) });
      turn = outcome.result;
      await settings.setTest(engine, turn);
      if (outcome.usage) {
        const cost = outcome.usage.reportedCostUsd;
        if (cost && cost > 0) await settings.noteSpent(engine, cost, turn.at);
        this.deps.recordTestUsage?.({ engine, model: turnModel, usage: outcome.usage, durationMs: turn.ms });
      }
      add(turn.ok ? { id: "turn", label: 'Um turno de teste de verdade ("responda só: ok")', ok: true, detail: `Respondeu "${turn.text ?? ""}" em ${(turn.ms / 1000).toFixed(1)} s${turn.tokens ? ` · ${turn.tokens} tokens` : ""}${outcome.usage?.reportedCostUsd ? ` · custo ${usd(outcome.usage.reportedCostUsd)}` : ""}` } : { id: "turn", label: 'Um turno de teste de verdade ("responda só: ok")', ok: false, detail: turn.error ?? "O turno falhou.", fix: "Leia o detalhe acima; se for a chave ou o saldo, corrija e rode o Verificar de novo." });
    }
    const result: EngineVerifyResult = { at: now().toISOString(), ok: checks.every((check) => check.ok === true), checks, ...(turn ? { turn } : {}), ...(pendingTurn ? { pendingTurn } : {}) };
    await settings.setVerify(engine, result);
    return result;
  }

  /** O aviso antes do turno de teste, dizendo de onde o custo sai (saldo do OpenRouter, assinatura, chave de outro provedor, local). */
  private turnNotice(model: string, price: ModelPrice | undefined, account: OneShotAccount, program: ProgramAccountInfo | undefined): string {
    const split = splitModelRef(model);
    if (account.mode === "program" && !(split?.provider === "openrouter" && price)) {
      const provider = split ? program?.providers.find((candidate) => candidate.provider === split.provider) : undefined;
      const kind = provider?.kind ?? (split && ["ollama", "lmstudio"].includes(split.provider) ? "local" : "unknown");
      const from =
        kind === "oauth"
          ? `sai da sua assinatura no provedor ${split?.provider ?? "do modelo"} (gasta da cota dela)`
          : kind === "api_key" || kind === "token"
            ? `cobra da chave de API do provedor ${split?.provider ?? "do modelo"} que está no programa (o Cyno não conhece o preço)`
            : kind === "local"
              ? "roda no seu computador (sem cobrança de API; usa a máquina)"
              : "sai da conta que o programa tiver para esse provedor (o Cyno não sabe o tipo)";
      return `O turno de teste usa o modelo ${model || "padrão do programa"}: ${from}.`;
    }
    const where = account.mode === "program" ? "da chave do OpenRouter guardada no programa" : "do seu saldo do OpenRouter";
    if (price?.free) return `O turno de teste usa o modelo ${model}, que é gratuito: custo zero (vale o limite de pedidos por dia do OpenRouter para modelos gratuitos).`;
    if (price && price.promptPerM !== undefined && price.completionPerM !== undefined) {
      // Teto folgado de um turno mínimo (instruções do agente incluídas): 3 mil tokens de entrada e 300 de saída.
      const ceiling = (3000 * price.promptPerM + 300 * price.completionPerM) / 1_000_000;
      return `O turno de teste usa o modelo ${model} (${priceText(price)}). Um turno mínimo costuma ficar abaixo de ${usd(Math.max(ceiling, 0.0001))}, e cobra ${where}.`;
    }
    return `O turno de teste usa o modelo ${model}; o preço dele não está na lista lida. Pode cobrar ${where}.`;
  }

  /** O turno de teste de verdade: o mesmo comando dos agentes, numa pasta temporária vazia e sem as ferramentas do escritório. */
  private async realTurn(input: { engine: OneShotEngineId; model: string; effort?: EngineChoices["effort"] }): Promise<{ result: EngineTestResult; usage?: TurnUsage }> {
    const started = Date.now();
    const finish = (partial: Omit<EngineTestResult, "ms" | "at" | "model">): EngineTestResult => ({ ...partial, ms: Date.now() - started, at: this.deps.now().toISOString(), model: input.model });
    // Pasta fixa por motor: o HERMES_HOME do agente de teste deriva dela e assim é sempre o mesmo (não acumula uma pasta por Verificar).
    const cwd = path.join(this.deps.dataDir, "platform", "engine-tests", input.engine);
    try {
      await mkdir(cwd, { recursive: true });
      const bin = this.deps.command(input.engine);
      const common = { command: bin.command, ...(bin.prefixArgs ? { prefixArgs: bin.prefixArgs } : {}), homeDir: engineDirs(this.deps.dataDir, input.engine).root, defaultModel: input.model, openrouterKey: () => this.deps.key.get(), account: () => this.deps.settings.account(input.engine), fence: () => this.deps.settings.fence(input.engine) };
      const adapter: OneShotAdapter = input.engine === "openclaw" ? new OpenClawAdapter({ ...common, ...(input.effort ? { defaultEffort: input.effort } : {}), ...this.deps.adapterOptions?.openclaw }, () => readOpenclawBase(common.homeDir)) : new HermesAdapter({ ...common, personalHome: path.join(this.deps.homeDir, ".hermes"), ...this.deps.adapterOptions?.hermes });
      const spec: TerminalSpec = { agentId: "engine-test", cwd, systemPrompt: "Você faz um teste de conexão. Responda em uma palavra.", mcpConfigFile: path.join(cwd, "mcp.json"), model: input.model, tools: [], ...(input.effort && input.engine === "openclaw" ? { effort: input.effort } : {}) };
      await ensureAdapterDirs(adapter, spec);
      // Sem MCP: só a política de ferramentas (OpenClaw) e o AGENTS.md e o HERMES_HOME do agente de teste (Hermes).
      let files: ReturnType<OneShotAdapter["agentFiles"]> = [];
      try {
        files = adapter.agentFiles({ spec, mcpUrl: "", token: "" });
      } catch {
        // Só o bloco do MCP no config.yaml pode falhar aqui, e o teste não usa o MCP.
      }
      for (const file of files) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content, { encoding: "utf8", mode: file.secret ? 0o600 : 0o666 });
      }
      const terminal = new OneShotTerminal({ adapter, spec, env: process.env, turnTimeoutMs: this.deps.turnTimeoutMs ?? ONE_SHOT_TEST_TIMEOUT_MS });
      const outcome = await new Promise<{ result: EngineTestResult; usage?: TurnUsage }>((resolve) => {
        let answer = "";
        terminal.onEvent((event: TerminalEvent) => {
          if (event.type === "text") answer += event.text;
          if (event.type === "turn_end") {
            const text = shorten(event.result || answer, 120);
            const tokens = event.usage ? event.usage.inputTokens + event.usage.outputTokens + event.usage.cacheCreationTokens : undefined;
            resolve({
              result: event.ok && text ? finish({ ok: true, text, ...(tokens ? { tokens } : {}) }) : finish({ ok: false, error: event.ok ? "O motor respondeu sem texto." : event.result, ...(tokens ? { tokens } : {}) }),
              ...(event.usage ? { usage: event.usage } : {}),
            });
          }
        });
        terminal.send(ONE_SHOT_TEST_MESSAGE, "engine-test", { freshSession: true });
      });
      await terminal.dispose();
      return outcome;
    } catch (error) {
      return { result: finish({ ok: false, error: errorMessage(error) }) };
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      // O agente de teste não fica com pasta de motor (nem gateway) no disco.
      await removeAgentEngineData({ [input.engine]: engineDirs(this.deps.dataDir, input.engine).root }, cwd);
    }
  }
}
