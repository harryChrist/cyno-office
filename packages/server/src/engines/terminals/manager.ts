import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentEngine,
  defaultMaestroSessionName,
  effectiveAccess,
  effectiveFolders,
  ENGINE_LABELS,
  workspaceAccess,
  IMPLEMENTED_CLI_ENGINES,
  isCliEngine,
  isMaestroAgent,
  subagentChoiceFor,
  type Agent,
  type AgentEngine,
  type AgentProvider,
  type AgentTerminalInfo,
  type ModelDefaults,
  type OfficeState,
  type ServerEvent,
  type EffectiveFolder,
  type WorkFolder,
  type WorkspaceAccess,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { bindTerminal, noteMcpHandshakeTimeout } from "../../platform/activity/hooks";
import type { McpTokens } from "../../mcp/tokens";
import type { DataPaths } from "../../store/paths";
import { AgentUsageLedger } from "../usage/agent-usage";
import type { SubscriptionUsageTracker } from "../usage/subscription-usage";
import { errorMessage } from "../../util/text";
import { AntigravityCliAdapter, type AntigravityAdapterOptions } from "./antigravity-adapter";
import { CLAUDE_SUBAGENT_TOOL, ClaudeCliAdapter, DEFAULT_AGENT_TOOLS, type ClaudeAdapterOptions } from "./claude-adapter";
import { ProcessTerminal, type SpawnFn } from "./process-terminal";
import { freebuffAdapter, freebuffEnv } from "../freebuff/adapter";
import { freebuffFolderName } from "../freebuff/files";
import type { FreebuffRuntime } from "../freebuff/runtime";
import { FreebuffTerminal } from "../freebuff/terminal";
import { PtyTerminal, type PtySpawnFn } from "./pty-terminal";
import { removeAgentEngineData } from "./engine-homes";
import { HermesAdapter, type HermesAdapterOptions } from "./hermes-adapter";
import { OpenClawAdapter, type OpenClawAdapterOptions } from "./openclaw-adapter";
import { OneShotTerminal, type OneShotAdapter, type OneShotSpawnFn } from "./one-shot-terminal";
import { agentPrompt } from "./prompts";
import { materializeAgentSkills, withSkillsIndex, type AgentSkill } from "../../library/skills/agent-skills";
import type { CliAdapter, TerminalAccess, TerminalAgent, TerminalEvent, TerminalSpec, ToolsGate } from "./types";

/** Configuração dos terminais de CLI (igual para todos os workspaces). */
export type TerminalsConfig = {
  /** URL do servidor MCP "office" (sempre 127.0.0.1), ex.: http://127.0.0.1:3001/mcp. */
  mcpUrl: string;
  /** Ocioso por tanto tempo = processo parado (a próxima ordem retoma a sessão). Padrão: 15 min. */
  idleMs: number;
  /** Quedas seguidas antes de desistir. */
  maxRetries: number;
  /**
   * Antes da primeira mensagem de cada subida de uma CLI do Claude Code, espera ela conectar no MCP do
   * escritório (initialize + tools/list) por no máximo isto (ms); depois manda assim mesmo, com um
   * aviso no log. Ausente ou 0 = não espera (testes com CLIs falsas que não conectam). O index.ts liga
   * com DEFAULT_MCP_READY_TIMEOUT_MS.
   */
  mcpReadyTimeoutMs?: number;
  claude: ClaudeAdapterOptions;
  /** Motor "gemini": Google Antigravity CLI (`agy`). */
  gemini?: AntigravityAdapterOptions;
  /** Motor "freebuff": as horas abertas, o executável e a pasta de dados dele (ausente = o motor não sobe). */
  freebuff?: FreebuffRuntime;
  /** Motor "openclaw": só `openclaw agent exec`, um processo por turno (ausente = o motor não sobe). */
  openclaw?: OneShotEngineConfig<OpenClawAdapterOptions>;
  /** Motor "hermes": `hermes chat --oneshot`, um processo por turno (ausente = o motor não sobe). */
  hermes?: OneShotEngineConfig<HermesAdapterOptions>;
  /** Lê a configuração base do OpenClaw do Cyno (o provedor e o modelo escolhidos ao ligar a conta). */
  openclawBase?: () => Record<string, unknown>;
  /** Ferramentas embutidas liberadas (padrão: Read, Write, Edit, Glob, Grep). */
  tools?: string[];
  /** Conversa do Maestro de CLI acima disto (tokens) é renovada com um resumo (padrão MAESTRO_ROTATE_TOKENS; 0 = nunca). */
  maestroRotateTokens?: number;
  /** Ambiente base dos processos (padrão: process.env; as chaves de API sempre saem). */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  backoffMs?: (attempt: number) => number;
  stopGraceMs?: number;
  /**
   * Maestro de Claude Code no terminal INTERATIVO (o `claude` de verdade num pseudo-terminal, visível
   * e usável no painel, com comandos `/` e Remote Control). Ausente ou `enabled: false` = o Maestro
   * roda headless como os outros agentes (os testes antigos e o motor "gemini" ficam assim).
   */
  maestroPty?: MaestroPtyConfig;
};

export type MaestroPtyConfig = {
  enabled: boolean;
  /** `--remote-control "<Maestro · workspace>"` (padrão: ligado). */
  remoteControl?: boolean;
  /** Pasta de projetos do Claude Code (`~/.claude/projects`): a conversa estruturada vem de lá. */
  projectsDir: string;
  spawn?: PtySpawnFn;
  pollMs?: number;
  readyTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  submitDelayMs?: number;
  stableMs?: number;
};

/** Configuração de um motor de um processo por turno: o adaptador mais o tempo máximo de um turno e o spawn (testes). */
export type OneShotEngineConfig<Options> = Options & { turnTimeoutMs?: number; spawn?: OneShotSpawnFn; stopGraceMs?: number };

/** Tempo máximo de um turno dos motores de um processo por turno (padrão: 15 min). */
export const DEFAULT_ONE_SHOT_TURN_MS = 15 * 60_000;

/** Teto da espera pela conexão MCP de uma CLI recém-subida (veja `mcpReadyTimeoutMs`). */
export const DEFAULT_MCP_READY_TIMEOUT_MS = 30_000;

export const DEFAULT_TERMINALS_CONFIG: TerminalsConfig = {
  mcpUrl: "http://127.0.0.1:3001/mcp",
  idleMs: 15 * 60_000,
  maxRetries: 3,
  claude: {},
};

export type TerminalManagerDeps = {
  workspaceId: string;
  workspaceName: () => string;
  /** Tipos de aprovação do workspace (id e nome): o agente escolhe um deles em `request_approval`. */
  approvalTypes?: () => { id: string; name: string }[];
  paths: Pick<DataPaths, "agentDir">;
  state: { read(): OfficeState };
  publish: (event: ServerEvent) => void;
  tokens: McpTokens;
  /** Uso da assinatura (global): os eventos `usage` dos terminais vão para lá. */
  usage?: Pick<SubscriptionUsageTracker, "report">;
  /** Padrão dos subagentes do workspace (`subagentes`), lido a cada subida do processo. */
  subagentDefaults?: () => ModelDefaults["subagentes"] | undefined;
  /** "Manter o Maestro sempre rodando" do workspace (padrão: sim). Só vale para o terminal interativo. */
  maestroKeepAlive?: () => boolean;
  /** Nome da sessão do Remote Control do Maestro (padrão: "Maestro · <workspace>"). Lido a cada subida e a cada troca. */
  maestroSessionName?: () => string;
  /** Acesso dos agentes do workspace (lido a cada subida; ausente = os padrões). */
  access?: () => WorkspaceAccess;
  /** Pastas de trabalho do workspace (lidas a cada subida; ausente = nenhuma). Cada agente recebe as dele (`effectiveFolders`). */
  folders?: () => readonly WorkFolder[];
  /** O agente tem o navegador compartilhado (ferramentas `browser_*`)? Entra nas instruções. */
  browserFor?: (agent: Agent) => boolean;
  /**
   * As instruções de cada subida (padrão: `agentPrompt`, as do Maestro e dos agentes de time). O Cyno,
   * que não é de nenhum workspace, passa as dele.
   */
  promptFor?: (agent: Agent, state: OfficeState) => string;
  /**
   * As skills da Biblioteca entregues ao agente (lidas a cada subida): são copiadas para
   * `<pasta do agente>/skills/` e entram como índice no fim das instruções. Ausente = nenhuma.
   */
  skillsFor?: (agentId: string) => AgentSkill[];
  /**
   * Os agentes de time usam os subagentes internos da CLI (padrão: sim; o Maestro nunca). O Cyno
   * passa `false`: sem subagente embutido.
   */
  subagents?: boolean;
  /** `"platform"`: os tokens MCP deste gerenciador valem para as ferramentas da plataforma (Cyno), não as de um workspace. */
  scope?: "platform";
  /** Cada evento dos terminais (o histórico de gastos grava os turnos daqui; veja usage/usage-history.ts). */
  onTerminalEvent?: (agentId: string, provider: AgentProvider, event: TerminalEvent) => void;
  config: TerminalsConfig;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now: () => Date;
};

type Entry = {
  terminal: ProcessTerminal | PtyTerminal | FreebuffTerminal | OneShotTerminal;
  engine: AgentEngine;
  token: string;
  info: AgentTerminalInfo;
  /** Modelo/esforço/internet com que o processo subiu da última vez (para reiniciar quando mudarem). */
  runConfig?: string;
  /** Reinício pendente (troca de modelo/esforço/internet com o agente ocupado): checado até ficar livre. */
  restartTimer?: ReturnType<typeof setInterval>;
};

/** Acesso de uma subida: o do workspace E o do agente, com os domínios da política. */
export function terminalAccess(workspace: WorkspaceAccess, agent: Agent): TerminalAccess {
  const { internet, browser, terminal } = effectiveAccess(workspace, agent);
  return {
    internet,
    browser,
    terminal,
    allowedDomains: [...workspace.allowedDomains],
    blockedDomains: [...workspace.blockedDomains],
    allowLocalNetwork: workspace.allowLocalNetwork,
  };
}

/** Assinatura do que só vale numa subida nova do processo: modelo, esforço e o acesso (internet, terminal, domínios…). */
export function runConfigOf(agent: Agent, workspace: WorkspaceAccess, folders: readonly WorkFolder[] = []): string {
  return JSON.stringify([agent.model ?? "", agent.effort ?? "", terminalAccess(workspace, agent), effectiveFolders(folders, agent).map((folder) => [folder.path, folder.write])]);
}

/**
 * Terminais de CLI de um workspace: um ProcessTerminal por agente com motor de CLI, criado na
 * primeira vez que alguém fala com ele. Cada subida regrava a pasta do agente com os arquivos que a
 * CLI lê (Claude Code: CLAUDE.md + mcp.json; Antigravity: GEMINI.md + .agents/mcp_config.json; com
 * as instruções e o token do servidor "office") e cada mudança de estado sai como evento agent:terminal.
 */
export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  /** Agentes que já subiram alguma vez (session.json na pasta, ou subiram neste processo). */
  private readonly started = new Set<string>();
  /** Turnos que cada agente terminou, com os tokens que a CLI relatou (o uso estimado por agente). */
  readonly agentUsage: AgentUsageLedger;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.agentUsage = new AgentUsageLedger(deps.now);
  }

  /** O terminal do agente (cria se preciso). 404 sem agente; 409 se o motor é o simulado; 422 se ainda não tem adaptador. */
  get(agentId: string): TerminalAgent {
    if (this.closed) throw new HttpError(409, "Os terminais deste workspace foram encerrados");
    const agent = this.agent(agentId);
    const engine = agentEngine(agent);
    const existing = this.entries.get(agentId);
    if (existing && existing.engine === engine) return existing.terminal;
    if (existing) void this.dispose(agentId);
    if (!isCliEngine(engine)) throw new HttpError(409, `O agente ${agent.name} é simulado (motor "mock"), não tem terminal`);
    const freebuff = engine === "freebuff" ? this.freebuffRuntime() : undefined;
    const oneShot = this.oneShotAdapter(engine);
    const cliAdapter = freebuff || oneShot ? undefined : this.adapter(engine);
    const adapter: Pick<CliAdapter, "provider" | "agentFiles"> = oneShot ?? (freebuff ? freebuffAdapter(freebuff.tokenInUrl === true) : cliAdapter!);
    const token = this.deps.tokens.issue({ workspaceId: this.deps.workspaceId, agentId, ...(this.deps.scope ? { scope: this.deps.scope } : {}) });
    const agentDir = this.deps.paths.agentDir(agentId);
    // O Freebuff guarda os chats pelo ÚLTIMO trecho do caminho: a pasta de trabalho dele leva um nome único (workspace + agente + resumo).
    const folderName = freebuff ? freebuffFolderName(this.deps.workspaceId, agentId) : undefined;
    const cwd = folderName ? path.join(agentDir, folderName) : agentDir;
    const spec: TerminalSpec = {
      agentId,
      cwd,
      systemPrompt: "",
      mcpConfigFile: path.join(cwd, "mcp.json"),
      tools: this.deps.config.tools ?? DEFAULT_AGENT_TOOLS,
    };
    const pty = freebuff || oneShot ? undefined : this.usesPty(agent);
    // Por ora só no Maestro (PTY): no `claude -p` dos times não foi medido se a CLI conecta no MCP antes
    // de ler a primeira mensagem; se não conectar, cada subida esperaria o teto inteiro.
    const waitForTools = pty && adapter instanceof ClaudeCliAdapter ? this.toolsGate(agentId, token) : undefined;
    const oneShotConfig = engine === "openclaw" ? this.deps.config.openclaw : engine === "hermes" ? this.deps.config.hermes : undefined;
    const terminal: ProcessTerminal | PtyTerminal | FreebuffTerminal | OneShotTerminal = oneShot
      ? new OneShotTerminal({
          adapter: oneShot,
          spec,
          prepare: () => this.prepare(adapter, agentId, spec, token),
          env: this.deps.config.env,
          turnTimeoutMs: oneShotConfig?.turnTimeoutMs ?? DEFAULT_ONE_SHOT_TURN_MS,
          // O Maestro e o Cyno são conversa: sem retomada (OpenClaw), cada turno leva um resumo corrido da conversa.
          conversation: this.deps.scope === "platform" || isMaestroAgent(this.deps.state.read(), agent),
          ...((oneShotConfig?.stopGraceMs ?? this.deps.config.stopGraceMs) !== undefined ? { stopGraceMs: oneShotConfig?.stopGraceMs ?? this.deps.config.stopGraceMs } : {}),
          ...(oneShotConfig?.spawn ? { spawn: oneShotConfig.spawn } : {}),
          now: this.deps.now,
        })
      : freebuff && folderName
      ? new FreebuffTerminal({
          spec,
          stateDir: agentDir,
          prepare: () => this.prepare(adapter, agentId, spec, token),
          service: freebuff.service,
          workspaceId: this.deps.workspaceId,
          agentName: () => this.deps.state.read().agents.find((candidate) => candidate.id === agentId)?.name,
          folderName,
          command: { command: freebuff.command, ...(freebuff.prefixArgs ? { prefixArgs: freebuff.prefixArgs } : {}) },
          env: freebuffEnv,
          ...(freebuff.env ? { baseEnv: freebuff.env } : {}),
          manicodeDir: freebuff.manicodeDir,
          idleMs: this.deps.config.idleMs,
          maxRetries: this.deps.config.maxRetries,
          backoffMs: this.deps.config.backoffMs,
          stopGraceMs: this.deps.config.stopGraceMs,
          ...(freebuff.spawn ? { spawn: freebuff.spawn } : {}),
          ...(freebuff.pollMs ? { pollMs: freebuff.pollMs } : {}),
          ...(freebuff.readyTimeoutMs ? { readyTimeoutMs: freebuff.readyTimeoutMs } : {}),
          ...(freebuff.deliveryTimeoutMs ? { deliveryTimeoutMs: freebuff.deliveryTimeoutMs } : {}),
          ...(freebuff.submitDelayMs ? { submitDelayMs: freebuff.submitDelayMs } : {}),
          ...(freebuff.hangMs ? { hangMs: freebuff.hangMs } : {}),
          ...(freebuff.settleMs ? { settleMs: freebuff.settleMs } : {}),
          ...(freebuff.settleCatalogMs ? { settleCatalogMs: freebuff.settleCatalogMs } : {}),
          ...(freebuff.stableMs ? { stableMs: freebuff.stableMs } : {}),
          now: this.deps.now,
        })
      : pty && adapter instanceof ClaudeCliAdapter
      ? new PtyTerminal({
          adapter,
          spec,
          prepare: () => this.prepare(adapter, agentId, spec, token),
          env: this.deps.config.env,
          projectsDir: pty.projectsDir,
          keepAlive: () => this.deps.maestroKeepAlive?.() ?? true,
          idleMs: this.deps.config.idleMs,
          maxRetries: this.deps.config.maxRetries,
          backoffMs: this.deps.config.backoffMs,
          stopGraceMs: this.deps.config.stopGraceMs,
          remoteControlName: () => (pty.remoteControl === false ? undefined : (this.deps.maestroSessionName?.() ?? remoteControlName(this.deps.workspaceName()))),
          spawn: pty.spawn,
          pollMs: pty.pollMs,
          readyTimeoutMs: pty.readyTimeoutMs,
          deliveryTimeoutMs: pty.deliveryTimeoutMs,
          submitDelayMs: pty.submitDelayMs,
          stableMs: pty.stableMs,
          ...(waitForTools ? { waitForTools } : {}),
          now: this.deps.now,
        })
      : new ProcessTerminal({
          adapter: cliAdapter!,
          spec,
          prepare: () => this.prepare(adapter, agentId, spec, token),
          env: this.deps.config.env,
          idleMs: this.deps.config.idleMs,
          maxRetries: this.deps.config.maxRetries,
          backoffMs: this.deps.config.backoffMs,
          stopGraceMs: this.deps.config.stopGraceMs,
          spawn: this.deps.config.spawn,
          ...(waitForTools ? { waitForTools } : {}),
          now: this.deps.now,
        });
    bindTerminal(terminal, { workspaceId: this.deps.workspaceId, agentId, engine, agentName: () => this.deps.state.read().agents.find((agent) => agent.id === agentId)?.name });
    const entry: Entry = {
      terminal,
      engine,
      token,
      info: {
        agentId,
        engine,
        status: "stopped",
        ...(terminal instanceof PtyTerminal ? { mode: "pty" as const } : {}),
        ...(this.everStarted(agentId) ? { everStarted: true, stoppedReason: this.lastStop(agentId) } : {}),
        updatedAt: this.deps.now().toISOString(),
      },
    };
    terminal.onEvent((event) => {
      this.deps.onTerminalEvent?.(agentId, adapter.provider, event);
      if (event.type === "status") {
        if (event.status !== "stopped") this.started.add(agentId);
        this.rememberStop(agentId, event.status, event.reason);
        this.update(entry, {
          status: event.status,
          ...(event.error ? { error: event.error } : {}),
          ...(event.status === "stopped" && event.reason ? { stoppedReason: event.reason } : {}),
          ...(this.started.has(agentId) ? { everStarted: true } : {}),
        });
        if (event.status !== "error") this.deps.log.info({ agentId, status: event.status }, "terminal do agente");
        else this.deps.log.warn({ agentId, error: event.error }, "terminal do agente caiu");
      } else if (event.type === "session" && event.sessionId !== entry.info.sessionId) {
        this.update(entry, { sessionId: event.sessionId });
      } else if (event.type === "turn_end" || event.type === "turn_partial" || event.type === "turn_cut") {
        // O "Por agente" do uso (web) soma o turno ao vivo: nada de consultar a rota em intervalo.
        this.deps.publish({ type: "usage:agents", turn: this.agentUsage.record(agentId, adapter.provider, event.usage, event.type === "turn_end" ? 1 : 0) });
      } else if (event.type === "usage") {
        this.deps.usage?.report(adapter.provider, { windows: event.windows, ...(event.status ? { status: event.status } : {}) });
      } else if (event.type === "remote") {
        this.update(entry, { remote: event.remote });
      }
    });
    this.entries.set(agentId, entry);
    return terminal;
  }

  /**
   * Espera da conexão MCP de cada subida (só Claude Code: o Antigravity não foi medido e fica sem).
   * Sem `mcpReadyTimeoutMs`, nada (a primeira mensagem vai assim que a CLI está de pé).
   */
  private toolsGate(agentId: string, token: string): ToolsGate | undefined {
    const timeoutMs = this.deps.config.mcpReadyTimeoutMs ?? 0;
    if (timeoutMs <= 0) return undefined;
    return () => {
      const since = Date.now();
      const wait = this.deps.tokens.waitForTools(token, timeoutMs);
      void wait.done.then((outcome) => {
        if (outcome === "ready") this.deps.log.info({ agentId, waitedMs: Date.now() - since }, "CLI conectada no MCP do escritório: a fila do terminal anda");
        else if (outcome === "timeout") {
          this.deps.log.warn({ agentId, timeoutMs }, "a CLI não conectou no MCP do escritório a tempo: a primeira mensagem vai assim mesmo");
          noteMcpHandshakeTimeout(this.deps.workspaceId, agentId, this.deps.state.read().agents.find((agent) => agent.id === agentId)?.name, timeoutMs);
        }
      });
      return wait;
    };
  }

  find(agentId: string): TerminalAgent | undefined {
    return this.entries.get(agentId)?.terminal;
  }

  /** Estado do terminal de cada agente com motor de CLI (os que nunca subiram aparecem "stopped"). */
  snapshot(): Record<string, AgentTerminalInfo> {
    const out: Record<string, AgentTerminalInfo> = {};
    for (const agent of this.deps.state.read().agents) {
      const engine = agentEngine(agent);
      if (!isCliEngine(engine)) continue;
      const entry = this.entries.get(agent.id);
      out[agent.id] =
        entry && entry.engine === engine
          ? { ...entry.info }
          : {
              agentId: agent.id,
              engine,
              status: "stopped",
              ...(this.usesPty(agent) ? { mode: "pty" as const } : {}),
              ...(this.everStarted(agent.id) ? { everStarted: true, stoppedReason: this.lastStop(agent.id) } : {}),
              updatedAt: this.deps.now().toISOString(),
            };
    }
    return out;
  }

  info(agentId: string): AgentTerminalInfo {
    const info = this.snapshot()[agentId];
    if (!info) throw new HttpError(409, "O agente não tem terminal (motor \"mock\")");
    return info;
  }

  /** Sobe o terminal (POST …/terminal/start). */
  async start(agentId: string): Promise<AgentTerminalInfo> {
    const terminal = this.get(agentId);
    try {
      await terminal.ensureRunning();
    } catch (error) {
      throw new HttpError(422, `Não foi possível ligar o terminal: ${errorMessage(error)}`);
    }
    return this.info(agentId);
  }

  /**
   * Para o processo (POST …/terminal/stop); a sessão continua salva para a próxima ordem. No meio de
   * um turno, só com `force` (o turno é cortado e a tarefa em curso falha): senão 409.
   */
  async stop(agentId: string, options: { force?: boolean } = {}): Promise<AgentTerminalInfo> {
    const agent = this.agent(agentId);
    const terminal = this.entries.get(agentId)?.terminal;
    if (terminal?.status() === "busy" && !options.force) {
      throw new HttpError(409, `${agent.name} está no meio de um turno: desligar agora corta o trabalho em curso. Confirme para desligar assim mesmo.`);
    }
    await terminal?.stop(STOP_REASONS.user);
    return this.info(agentId);
  }

  /** Conversa direta com o usuário em curso (o balão de fala no escritório). Só agentes de CLI com terminal. */
  setChatting(agentId: string, chatting: boolean): void {
    const entry = this.entries.get(agentId);
    if (!entry || (entry.info.chatting ?? false) === chatting) return;
    this.update(entry, chatting ? { chatting: true } : { chatting: false });
  }

  /**
   * Por que o terminal parou da última vez, para mostrar depois de um reinício do server: o que ficou
   * em terminal-stop.json (por você, por ociosidade) ou, se ele estava no ar quando o server caiu ou
   * desligou, "Servidor reiniciado".
   */
  private lastStop(agentId: string): string {
    try {
      const data = JSON.parse(readFileSync(path.join(this.deps.paths.agentDir(agentId), STOP_FILE), "utf8")) as { reason?: unknown };
      if (typeof data.reason === "string" && data.reason) return data.reason;
    } catch {
      // Sem arquivo (terminal de antes disto) ou quebrado: o server reiniciou com ele parado ou no ar.
    }
    return STOP_REASONS.restart;
  }

  /** Guarda o motivo da parada (usuário, ociosidade) ou que o terminal está no ar; o descarte no shutdown não conta. */
  private rememberStop(agentId: string, status: string, reason: string | undefined): void {
    if (status === "error") return;
    if (status === "stopped" && (!reason || reason === STOP_REASONS.disposed)) return;
    const content = status === "stopped" ? { reason, at: this.deps.now().toISOString() } : { running: true, at: this.deps.now().toISOString() };
    const dir = this.deps.paths.agentDir(agentId);
    void mkdir(dir, { recursive: true })
      .then(() => writeFile(path.join(dir, STOP_FILE), `${JSON.stringify(content)}\n`))
      .catch((error: unknown) => this.deps.log.warn({ err: error, agentId }, "não foi possível guardar o motivo da parada do terminal"));
  }

  /** Já subiu alguma vez? (session.json na pasta do agente; uma vez sim, fica guardado) */
  private everStarted(agentId: string): boolean {
    if (this.started.has(agentId)) return true;
    try {
      if (existsSync(path.join(this.deps.paths.agentDir(agentId), "session.json"))) this.started.add(agentId);
    } catch {
      // Pasta inválida: conta como nunca iniciado.
    }
    return this.started.has(agentId);
  }

  /** O terminal interativo do Maestro (cria se preciso); undefined se o Maestro não roda num (simulado, outro motor, desligado). */
  maestroPty(): PtyTerminal | undefined {
    if (this.closed) return undefined;
    const state = this.deps.state.read();
    const maestro = state.agents.find((agent) => isMaestroAgent(state, agent));
    if (!maestro || !this.usesPty(maestro)) return undefined;
    const terminal = this.get(maestro.id);
    return terminal instanceof PtyTerminal ? terminal : undefined;
  }

  /**
   * Boot (e "Manter o Maestro sempre rodando" ligado): sobe o terminal interativo do Maestro já,
   * retomando a mesma conversa (session.json) e o Remote Control. Desligado: volta a contar a ociosidade.
   */
  refreshMaestro(): void {
    const keepAlive = this.deps.maestroKeepAlive?.() ?? true;
    const terminal = keepAlive ? this.maestroPty() : this.findMaestroPty();
    if (!terminal) return;
    terminal.refreshPolicy();
  }

  /**
   * O nome da sessão do Remote Control mudou: o terminal vivo do Maestro recebe `/rename <nome>`
   * assim que estiver livre (sem reiniciar); parado, ele já sobe com o nome novo.
   */
  renameMaestroSession(): void {
    this.findMaestroPty()?.renameRemote();
  }

  private findMaestroPty(): PtyTerminal | undefined {
    for (const entry of this.entries.values()) if (entry.terminal instanceof PtyTerminal) return entry.terminal;
    return undefined;
  }

  /** O agente roda no terminal interativo? (o Maestro de Claude Code, com o modo ligado) */
  private usesPty(agent: Agent): MaestroPtyConfig | undefined {
    const pty = this.deps.config.maestroPty;
    if (!pty?.enabled || agentEngine(agent) !== "claude") return undefined;
    return isMaestroAgent(this.deps.state.read(), agent) ? pty : undefined;
  }

  /**
   * O agente mudou: motor diferente (ou simulado) = o terminal antigo sai. Modelo/esforço/internet diferentes
   * do processo vivo = ele reinicia quando estiver livre (o Maestro de terminal interativo, que fica
   * sempre ligado, senão nunca pegaria a troca; os outros já sobem de novo a cada tarefa).
   */
  sync(agent: Agent): void {
    const entry = this.entries.get(agent.id);
    if (!entry) return;
    if (entry.engine !== agentEngine(agent)) {
      void this.dispose(agent.id);
      return;
    }
    if (entry.runConfig !== undefined && entry.runConfig !== runConfigOf(agent, this.workspaceAccess(), this.workspaceFolders())) this.restartWhenFree(entry);
  }

  /** O acesso do workspace mudou: cada terminal vivo cuja configuração mudou reinicia quando estiver livre. */
  syncAll(): void {
    for (const agent of this.deps.state.read().agents) this.sync(agent);
  }

  private workspaceAccess(): WorkspaceAccess {
    return workspaceAccess(this.deps.access?.());
  }

  private workspaceFolders(): readonly WorkFolder[] {
    return this.deps.folders?.() ?? [];
  }

  /** Pastas que já foram avisadas como sumidas (agente + caminho): o aviso sai uma vez, não a cada subida. */
  private readonly missingWarned = new Set<string>();

  /**
   * As pastas de trabalho desta subida: as do workspace E do agente que ainda existem no disco. Uma que sumiu (apagada,
   * desmontada) é pulada e vira um aviso visível (`system:warning`); a subida do agente nunca quebra por isso.
   */
  private async usableFolders(agent: Agent): Promise<EffectiveFolder[]> {
    const usable: EffectiveFolder[] = [];
    for (const folder of effectiveFolders(this.workspaceFolders(), agent)) {
      const info = await stat(folder.path).catch(() => undefined);
      if (info?.isDirectory()) {
        usable.push(folder);
        continue;
      }
      const key = `${agent.id}\0${folder.path}`;
      if (this.missingWarned.has(key)) continue;
      this.missingWarned.add(key);
      this.deps.publish({ type: "system:warning", message: `A pasta de trabalho "${folder.name}" (${folder.path}) não existe mais no computador. ${agent.name} sobe sem ela. Confira em Configurações, Pastas de trabalho.`, at: this.deps.now().toISOString() });
    }
    return usable;
  }

  private restartWhenFree(entry: Entry): void {
    if (entry.restartTimer) return;
    const attempt = (): boolean => {
      if (this.entries.get(entry.info.agentId) !== entry) return true;
      const status = entry.terminal.status();
      if (status === "busy" || status === "starting") return false;
      if (status !== "stopped") {
        entry.runConfig = undefined;
        const pty = entry.terminal instanceof PtyTerminal;
        void entry.terminal
          .stop("Configuração trocada (modelo, esforço ou acesso)")
          .then(() => {
            if (pty) this.refreshMaestro();
          })
          .catch((error: unknown) => this.deps.log.error({ err: error, agentId: entry.info.agentId }, "falha ao reiniciar o terminal"));
      }
      return true;
    };
    if (attempt()) return;
    entry.restartTimer = setInterval(() => {
      if (!attempt()) return;
      clearInterval(entry.restartTimer);
      entry.restartTimer = undefined;
    }, 3000);
    entry.restartTimer.unref?.();
  }

  /** Descarta o terminal (agente removido ou motor trocado): para o processo e revoga o token. */
  /** Apaga as pastas de motor deste agente (HERMES_HOME e configuração do OpenClaw, com o token do MCP): agente removido ou que trocou de motor. */
  async removeEngineData(agentId: string): Promise<void> {
    let cwd: string;
    try {
      cwd = this.deps.paths.agentDir(agentId);
    } catch {
      return;
    }
    await removeAgentEngineData({ hermes: this.deps.config.hermes?.homeDir, openclaw: this.deps.config.openclaw?.homeDir }, cwd);
  }

  async dispose(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    if (entry.restartTimer) clearInterval(entry.restartTimer);
    this.entries.delete(agentId);
    this.deps.tokens.revoke(entry.token);
    await entry.terminal.dispose().catch((error: unknown) => this.deps.log.error({ err: error, agentId }, "falha ao parar o terminal"));
  }

  /** Shutdown: para todos os processos (com calma) e revoga os tokens. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((agentId) => this.dispose(agentId)));
  }

  // ---------- Infra ----------

  private agent(agentId: string): Agent {
    const agent = this.deps.state.read().agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new HttpError(404, `Agente "${agentId}" não encontrado`);
    return agent;
  }

  private freebuffRuntime(): FreebuffRuntime {
    const runtime = this.deps.config.freebuff;
    if (!runtime) throw new HttpError(422, 'O motor "freebuff" não está configurado neste servidor');
    return runtime;
  }

  /**
   * Boot: as horas do Freebuff ainda abertas (gravadas em engine-sessions.json) deste workspace voltam a ter
   * processo, com `--continue <id>` na mesma conversa e na mesma hora (abrir e olhar não gasta nada).
   */
  resumeHours(): void {
    const freebuff = this.deps.config.freebuff;
    if (!freebuff || this.closed) return;
    for (const session of freebuff.service.sessions()) {
      if (session.workspaceId !== this.deps.workspaceId) continue;
      const agent = this.deps.state.read().agents.find((candidate) => candidate.id === session.agentId);
      if (!agent || agentEngine(agent) !== "freebuff") continue;
      try {
        void this.get(agent.id).ensureRunning().catch((error: unknown) => this.deps.log.warn({ err: error, agentId: agent.id }, "não foi possível reassumir a hora do Freebuff"));
      } catch (error) {
        this.deps.log.warn({ err: error, agentId: agent.id }, "não foi possível reassumir a hora do Freebuff");
      }
    }
  }

  /** OpenClaw e Hermes: o adaptador de um processo por turno (o resto dos motores devolve undefined). */
  private oneShotAdapter(engine: Exclude<AgentEngine, "mock">): (OneShotAdapter & Pick<CliAdapter, "provider" | "agentFiles">) | undefined {
    if (engine !== "openclaw" && engine !== "hermes") return undefined;
    const config = engine === "openclaw" ? this.deps.config.openclaw : this.deps.config.hermes;
    if (!config) throw new HttpError(422, `O motor "${engine}" não está configurado neste servidor`);
    return engine === "openclaw" ? new OpenClawAdapter(config as OpenClawAdapterOptions, this.deps.config.openclawBase) : new HermesAdapter(config as HermesAdapterOptions);
  }

  private adapter(engine: Exclude<AgentEngine, "mock">): CliAdapter {
    if (!(IMPLEMENTED_CLI_ENGINES as readonly string[]).includes(engine)) {
      const ready = IMPLEMENTED_CLI_ENGINES.map((id) => `"${id}"`).join(", ");
      throw new HttpError(422, `O motor "${engine}" (${ENGINE_LABELS[engine]}) ainda não tem adaptador de CLI (por enquanto: ${ready})`);
    }
    return engine === "gemini" ? new AntigravityCliAdapter(this.deps.config.gemini) : new ClaudeCliAdapter(this.deps.config.claude);
  }

  /** Grava a pasta do agente antes de cada subida e devolve a especificação atual. */
  private async prepare(adapter: Pick<CliAdapter, "provider" | "agentFiles">, agentId: string, base: TerminalSpec, token: string): Promise<TerminalSpec> {
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Agente "${agentId}" não existe mais`);
    // Agentes de time usam os subagentes internos da CLI (o Maestro não: ele delega aos times).
    const subagents = !isMaestroAgent(state, agent) && this.deps.subagents !== false;
    const subagent = subagents ? subagentChoiceFor(this.deps.subagentDefaults?.(), agentEngine(agent)) : undefined;
    const tools = subagents && adapter.provider === "claude" && !base.tools.includes(CLAUDE_SUBAGENT_TOOL) ? [...base.tools, CLAUDE_SUBAGENT_TOOL] : base.tools;
    const entry = this.entries.get(agentId);
    const access = this.workspaceAccess();
    const folders = await this.usableFolders(agent);
    const basePrompt = this.deps.promptFor
      ? this.deps.promptFor(agent, state)
      : agentPrompt(agent, state, this.deps.workspaceName(), subagent, { access, workspaceId: this.deps.workspaceId, browser: this.deps.browserFor?.(agent) === true, approvalTypes: this.deps.approvalTypes?.(), folders });
    // Skills da Biblioteca: cópia na pasta do agente + uma linha de índice no fim das instruções.
    const skills = this.deps.skillsFor?.(agentId) ?? [];
    const systemPrompt = withSkillsIndex(basePrompt, skills);
    if (entry) entry.runConfig = runConfigOf(agent, access, this.workspaceFolders());
    const spec: TerminalSpec = {
      ...base,
      tools,
      systemPrompt,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      access: terminalAccess(access, agent),
      ...(folders.length > 0 ? { folders } : {}),
      ...(subagent ? { subagent } : {}),
      mcp: { url: this.deps.config.mcpUrl, token },
    };
    await mkdir(base.cwd, { recursive: true });
    if (this.deps.skillsFor) await materializeAgentSkills(base.cwd, skills);
    for (const file of adapter.agentFiles({ spec, mcpUrl: this.deps.config.mcpUrl, token })) {
      await mkdir(path.dirname(file.path), { recursive: true });
      if (!file.secret) {
        await writeFile(file.path, file.content, "utf8");
        continue;
      }
      await writeFile(file.path, file.content, { encoding: "utf8", mode: 0o600 });
      await chmod(file.path, 0o600);
    }
    return spec;
  }

  private update(entry: Entry, change: Partial<AgentTerminalInfo>): void {
    if (this.entries.get(entry.info.agentId) !== entry) return;
    entry.info = { ...entry.info, ...change, updatedAt: this.deps.now().toISOString() };
    if (change.status && change.status !== "error") delete entry.info.error;
    if (change.status && (change.status !== "stopped" || !change.stoppedReason)) delete entry.info.stoppedReason;
    if (change.chatting === false) delete entry.info.chatting;
    this.deps.publish({ type: "agent:terminal", terminal: { ...entry.info } });
  }
}

/** Arquivo (na pasta do agente) com o motivo da última parada do terminal (ou que ele estava no ar). */
const STOP_FILE = "terminal-stop.json";

/** Motivos de parada mostrados no estado do terminal ("Desligado · <motivo>: sobe sozinho…"). */
export const STOP_REASONS = { user: "Parado por você", idle: "Parado por ociosidade", restart: "Servidor reiniciado", disposed: "Terminal encerrado" } as const;

/** Nome padrão da sessão do Remote Control do Maestro (o que aparece no app do Claude e em claude.ai/code). */
export function remoteControlName(workspaceName: string): string {
  return defaultMaestroSessionName(workspaceName);
}
