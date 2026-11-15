import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_LOG_LIMITS, clampLogText, OFFICE_MCP_SERVER, type TurnUsage, type UsageWindow, ENGINE_FALLBACK_MODELS } from "@cyno/shared";
import { claudeTurnDetail } from "../usage/claude-turn-detail";
import { sanitizeChildEnv } from "./env";
import type { InteractiveCliAdapter } from "./pty-terminal";
import type { AgentFile, CliAdapter, CliEventParser, TerminalEvent, TerminalSpec } from "./types";

/** Ferramentas embutidas liberadas por padrão: só arquivos, dentro da pasta do agente. */
export const DEFAULT_AGENT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

/**
 * Ferramentas de internet do Claude Code (busca na web e leitura de uma página), só com a internet
 * do agente ligada (`spec.access.internet`). O `--restricted` tira o WebFetch a menos que o `--tools`
 * o nomeie (e nomeamos).
 */
export const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

/** Terminal do Claude Code: só com o terminal do agente ligado (`spec.access.terminal`). */
export const CLAUDE_TERMINAL_TOOL = "Bash";

/**
 * Regras de permissão do WebFetch para domínios: `WebFetch(domain:x)` vale só para o domínio exato
 * e `WebFetch(domain:*.x)` para os subdomínios (conferido no Claude Code 2.1.319).
 */
export function webFetchDomainRules(domains: readonly string[]): string[] {
  return domains.flatMap((domain) => [`WebFetch(domain:${domain})`, `WebFetch(domain:*.${domain})`]);
}

/**
 * Ferramentas e regras de permissão de uma subida (`--tools`, `--allowedTools`, `--disallowedTools`):
 * - sempre as do spec (arquivos e, nos agentes de time, a de subagente) e o MCP "office";
 * - internet: WebSearch e WebFetch; com domínios permitidos, o WebFetch só vale para eles (o resto é
 *   negado na hora pelo dontAsk) e os bloqueados vão em --disallowedTools. A busca (WebSearch) não
 *   tem regra por domínio: aí só as instruções;
 * - terminal: Bash liberado; desligado, Bash vai em --disallowedTools;
 * - pastas de trabalho SÓ LEITURA: `Edit(//<pasta>/**)` em --disallowedTools (no Claude Code 2.1.325 só a regra Edit vale
 *   para caminhos e ela cobre Edit, Write e NotebookEdit; `Write(caminho)` é recusado pela CLI). O acesso às pastas em si
 *   vai por --add-dir (veja `claudeFolderArgs`).
 * Sem `spec.access`, nada além de arquivos e do escritório.
 */
export function claudePermissions(spec: Pick<TerminalSpec, "tools" | "access" | "folders">): { tools: string[]; allowed: string[]; disallowed: string[] } {
  const extra: readonly string[] = [...CLAUDE_WEB_TOOLS, CLAUDE_TERMINAL_TOOL];
  const base = spec.tools.filter((tool) => !extra.includes(tool));
  const access = spec.access;
  const tools = [...base];
  const allowed = [...base];
  const disallowed: string[] = [];
  if (access?.internet) {
    tools.push(...CLAUDE_WEB_TOOLS);
    allowed.push("WebSearch", ...(access.allowedDomains.length > 0 ? webFetchDomainRules(access.allowedDomains) : ["WebFetch"]));
    disallowed.push(...webFetchDomainRules(access.blockedDomains));
  }
  if (access?.terminal) {
    tools.push(CLAUDE_TERMINAL_TOOL);
    allowed.push(CLAUDE_TERMINAL_TOOL);
  } else {
    disallowed.push(CLAUDE_TERMINAL_TOOL);
  }
  for (const folder of spec.folders ?? []) if (!folder.write) disallowed.push(claudeReadOnlyRule(folder.path));
  allowed.push(`mcp__${OFFICE_MCP_SERVER}`);
  return { tools, allowed, disallowed };
}

/** Regra de permissão que nega editar/escrever dentro da pasta (`//` = caminho absoluto a partir da raiz do sistema). */
export function claudeReadOnlyRule(folderPath: string): string {
  return `Edit(/${folderPath}/**)`;
}

/** `--add-dir <pasta>` de cada pasta de trabalho (o --restricted prende as ferramentas de arquivo ao cwd e a estas pastas). */
export function claudeFolderArgs(spec: Pick<TerminalSpec, "folders">): string[] {
  return (spec.folders ?? []).flatMap((folder) => ["--add-dir", folder.path]);
}

/**
 * Configurações extras do processo (`--settings`, que vale mesmo com --restricted):
 * - disableAllHooks: nenhum hook roda;
 * - syncClaudeAiPlugins / syncClaudeAiSkills = false: os plugins e skills ativados na conta do
 *   claude.ai (~/.claude/plugins/synced, ~/.claude/skills/synced) não carregam neste processo nem
 *   são baixados (só nesta invocação; nada muda na conta nem nas pastas). Plugins embutidos da
 *   própria CLI carregam de qualquer jeito (não há flag para eles: nem o --safe-mode os tira, e
 *   ele ainda derrubaria os servidores MCP, inclusive o nosso "office").
 */
export const CHILD_SETTINGS = { disableAllHooks: true, syncClaudeAiPlugins: false, syncClaudeAiSkills: false } as const;

/** Ferramentas do Claude Code que abrem um subagente (o nome mudou de Task para Agent). */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/**
 * Ferramenta de subagente do Claude Code 2.1.x ("Agent"; antes "Task"). Os agentes de time a recebem
 * em --tools/--allowedTools: o subagente roda dentro do mesmo processo, com as mesmas ferramentas
 * (nunca mais que o agente: --tools limita a sessão inteira) e o mesmo MCP "office".
 */
export const CLAUDE_SUBAGENT_TOOL = "Agent";

export type ClaudeAdapterOptions = {
  /** Executável (padrão "claude"). Nos testes: o node, com `prefixArgs` = [script da CLI falsa]. */
  command?: string;
  prefixArgs?: string[];
  /** Esforço quando o agente não diz (padrão "low": laboratório gasta pouco da assinatura). */
  defaultEffort?: string;
  /**
   * `--autocompact <tokens|auto>`: janela em que o Claude Code compacta a conversa sozinho (a CLI
   * aceita 100k–1M). Padrão DEFAULT_AUTOCOMPACT; "" = não passa a flag (fica o padrão da CLI).
   */
  autocompact?: string;
  /** Terminal interativo (Maestro): `--restricted` também no TUI (padrão: sim). */
  interactiveRestricted?: boolean;
};

/**
 * Compactação automática no ponto mais alto que o modelo aguenta ("auto": a própria CLI compacta só
 * perto da janela cheia do modelo). O usuário pediu o limite alto: conversa longa sem resumir cedo.
 */
export const DEFAULT_AUTOCOMPACT = "auto";

/**
 * Adaptador do Claude Code (`claude` logado com a assinatura do usuário). Um processo por agente:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *     --restricted --setting-sources project,local
 *     --settings {"disableAllHooks":true,"syncClaudeAiPlugins":false,"syncClaudeAiSkills":false}
 *     --strict-mcp-config --mcp-config <agents/<id>/mcp.json> --disable-slash-commands
 *     --tools Read,Write,Edit,Glob,Grep[,WebSearch,WebFetch][,Bash]
 *     --allowedTools Read,Write,Edit,Glob,Grep[,WebSearch,WebFetch|WebFetch(domain:…)][,Bash],mcp__office
 *     [--disallowedTools Bash,WebFetch(domain:<bloqueado>)…]
 *     --permission-mode dontAsk --permission-prompts none
 *     --append-system-prompt <CLAUDE.md> --system-prompt-snapshot off
 *     --session-id <uuid> | --resume <uuid>
 *     [--model <modelo>] --effort <low…> --autocompact auto
 *     [--forward-subagent-text]                  (só com a ferramenta Agent)
 *
 * Subagentes (agentes de time): a ferramenta `Agent` entra em --tools/--allowedTools; o padrão dos
 * subagentes vem do workspace por env (CLAUDE_CODE_SUBAGENT_MODEL / CLAUDE_CODE_SUBAGENT_EFFORT: valem
 * quando a chamada não diz `model`/`effort`, então o agente ainda pode escolher outro para uma peça);
 * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 deixa o subagente em primeiro plano (a chamada só volta
 * quando ele termina, então o fim do turno espera os subagentes); `--forward-subagent-text` manda o
 * texto do subagente no stream (com parent_tool_use_id), para a thread dele no log.
 *
 * - `-p` + stream-json nos dois sentidos: o processo fica vivo lendo mensagens JSON da entrada
 *   (uma por turno) e escrevendo eventos JSON (init, assistant, user/tool_result, result).
 * Acesso (`spec.access`: o do workspace E o do agente, veja access.ts): internet = WebSearch e
 * WebFetch (com os domínios permitidos/bloqueados); terminal = Bash. Veja claudePermissions.
 *
 * - `--restricted`: tira Bash/WebFetch e afins (o WebFetch volta se --tools o nomear), ignora os arquivos de configuração do usuário, do
 *   projeto e locais (hooks, plugins, permissões do ~/.claude) e prende as ferramentas de arquivo
 *   na pasta do agente. `--setting-sources project,local` reforça (nunca lê o settings do usuário)
 *   e `--settings` (CHILD_SETTINGS) desliga hooks e os plugins/skills sincronizados do claude.ai.
 * - `--strict-mcp-config --mcp-config`: só o nosso servidor MCP "office" (nenhum MCP do usuário).
 * - `--disable-slash-commands`: sem skills e comandos do usuário.
 * - `--tools` + `--allowedTools` + `dontAsk` + `--permission-prompts none`: nada fica esperando um
 *   "permitir?" interativo; o que não está liberado é negado na hora.
 * - Env: sem ANTHROPIC_API_KEY & cia (veja env.ts), CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 e
 *   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (não carrega o CLAUDE.md do usuário nem os de pastas acima;
 *   as instruções do agente vão por --append-system-prompt, o mesmo texto do CLAUDE.md da pasta;
 *   `--system-prompt-snapshot off` faz instruções editadas valerem também numa sessão retomada).
 */
export class ClaudeCliAdapter implements CliAdapter, InteractiveCliAdapter {
  readonly provider = "claude" as const;
  /** O `claude -p` com stream-json aceita mensagens no meio do turno e conta as que faltam (`queued_turn_count`). */
  readonly liveInput = true;
  private readonly command_: string;
  private readonly prefixArgs: string[];
  private readonly defaultEffort: string | undefined;
  private readonly autocompact: string | undefined;
  private readonly interactiveRestricted: boolean;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command_ = options.command ?? "claude";
    this.prefixArgs = options.prefixArgs ?? [];
    this.defaultEffort = options.defaultEffort === undefined ? "low" : options.defaultEffort || undefined;
    this.autocompact = options.autocompact === undefined ? DEFAULT_AUTOCOMPACT : options.autocompact || undefined;
    this.interactiveRestricted = options.interactiveRestricted ?? true;
  }

  /**
   * O `claude` INTERATIVO (TUI) do Maestro, num pseudo-terminal que o usuário vê e usa no navegador:
   *
   *   claude --restricted --setting-sources project,local --settings <CHILD_SETTINGS>
   *     --strict-mcp-config --mcp-config <agents/<id>/mcp.json>
   *     --tools <ferramentas> --allowedTools <ferramentas>,mcp__office [--disallowedTools Bash,…]
 *     (ferramentas e regras: claudePermissions — arquivos, mais internet e terminal se ligados)
   *     --permission-mode dontAsk
   *     --append-system-prompt <CLAUDE.md> --system-prompt-snapshot off
   *     --session-id <uuid> | --resume <uuid>
   *     [--model <modelo>] --effort <…> --autocompact auto
   *     [--remote-control "<Maestro · workspace>"]
   *
   * Igual ao headless no isolamento (mesmo env sem chaves de API, mesmas instruções, só o MCP
   * "office", hooks e plugins/skills sincronizados do claude.ai desligados, settings do usuário
   * ignorados), mas SEM `--disable-slash-commands`: os comandos `/` são o motivo de ter um terminal.
   * Sem `-p`/stream-json: a conversa estruturada vem do arquivo que a CLI grava (claude-transcript.ts).
   * `--permission-prompts` só existe com `-p`; aqui o `dontAsk` nega na hora o que não está liberado.
   */
  interactiveCommand(spec: TerminalSpec, session: { sessionId: string; resume: boolean }, options: { remoteControl?: string } = {}): { command: string; args: string[] } {
    const permissions = claudePermissions(spec);
    const args = [
      ...this.prefixArgs,
      ...(this.interactiveRestricted ? ["--restricted"] : []),
      "--setting-sources",
      "project,local",
      "--settings",
      JSON.stringify(CHILD_SETTINGS),
      "--strict-mcp-config",
      "--mcp-config",
      spec.mcpConfigFile,
      ...claudeFolderArgs(spec),
      "--tools",
      permissions.tools.join(","),
      "--allowedTools",
      permissions.allowed.join(","),
      ...(permissions.disallowed.length > 0 ? ["--disallowedTools", permissions.disallowed.join(",")] : []),
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      spec.systemPrompt,
      "--system-prompt-snapshot",
      "off",
      ...(session.resume ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
    ];
    // Sem modelo no agente: o padrão da plataforma para o motor, nunca o padrão da CLI.
    args.push("--model", spec.model ?? ENGINE_FALLBACK_MODELS.claude.model);
    const effort = spec.effort ?? this.defaultEffort;
    if (effort) args.push("--effort", effort);
    if (this.autocompact) args.push("--autocompact", this.autocompact);
    if (options.remoteControl) args.push("--remote-control", options.remoteControl);
    return { command: this.command_, args };
  }

  command(spec: TerminalSpec, session: { sessionId: string; resume: boolean }): { command: string; args: string[] } {
    const permissions = claudePermissions(spec);
    const args = [
      ...this.prefixArgs,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--setting-sources",
      "project,local",
      "--settings",
      JSON.stringify(CHILD_SETTINGS),
      "--strict-mcp-config",
      "--mcp-config",
      spec.mcpConfigFile,
      "--disable-slash-commands",
      ...claudeFolderArgs(spec),
      "--tools",
      permissions.tools.join(","),
      "--allowedTools",
      permissions.allowed.join(","),
      ...(permissions.disallowed.length > 0 ? ["--disallowedTools", permissions.disallowed.join(",")] : []),
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--append-system-prompt",
      spec.systemPrompt,
      "--system-prompt-snapshot",
      "off",
      ...(session.resume ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
    ];
    // Sem modelo no agente: o padrão da plataforma para o motor, nunca o padrão da CLI.
    args.push("--model", spec.model ?? ENGINE_FALLBACK_MODELS.claude.model);
    const effort = spec.effort ?? this.defaultEffort;
    if (effort) args.push("--effort", effort);
    if (this.autocompact) args.push("--autocompact", this.autocompact);
    if (spec.tools.includes(CLAUDE_SUBAGENT_TOOL)) args.push("--forward-subagent-text");
    return { command: this.command_, args };
  }

  /** CLAUDE.md (as mesmas instruções do --append-system-prompt) e o mcp.json do --mcp-config. */
  agentFiles({ spec, mcpUrl, token }: { spec: TerminalSpec; mcpUrl: string; token: string }): AgentFile[] {
    const mcp = { mcpServers: { [OFFICE_MCP_SERVER]: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
    return [
      { path: path.join(spec.cwd, "CLAUDE.md"), content: `${spec.systemPrompt}\n` },
      { path: spec.mcpConfigFile, content: `${JSON.stringify(mcp, null, 2)}\n`, secret: true },
    ];
  }

  env(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv {
    const subagents = spec.tools.includes(CLAUDE_SUBAGENT_TOOL);
    return sanitizeChildEnv(base, {
      // Subagentes em primeiro plano (o turno só acaba quando eles acabam) e o modelo/esforço padrão deles.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      ...(subagents && spec.subagent?.model ? { CLAUDE_CODE_SUBAGENT_MODEL: spec.subagent.model } : {}),
      ...(subagents && spec.subagent?.effort ? { CLAUDE_CODE_SUBAGENT_EFFORT: spec.subagent.effort } : {}),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      DISABLE_AUTOUPDATER: "1",
      // O git não sobe acima da pasta dos agentes (o agente não vê o repositório do Cyno).
      GIT_CEILING_DIRECTORIES: path.dirname(spec.cwd),
    });
  }

  createParser(spec?: TerminalSpec): CliEventParser {
    return new ClaudeStreamParser(spec?.subagent?.model);
  }

  encodeMessage(text: string, sessionId: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId });
  }

  encodeInterrupt(requestId: string): string {
    return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
  }

  newSessionId(): string {
    return randomUUID();
  }

  isMissingSession(stderr: string): boolean {
    return /no conversation found|session .*not found|could not find session/i.test(stderr);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Texto de um tool_result (string ou blocos [{type:"text", text}]). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : isObject(block) ? `[${String(block.type)}]` : ""))
    .filter(Boolean)
    .join("\n");
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Instante da CLI (segundos ou milissegundos desde 1970, ou texto ISO) em ISO; inválido = undefined. */
function isoTime(value: unknown): string | undefined {
  const n = num(value);
  if (n !== undefined && n > 0) {
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = str(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Uso de 0..1 (aceita porcentagem 0..100 por tolerância); inválido = undefined. */
function utilization(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined || n < 0) return undefined;
  return Math.min(1, n > 1 ? n / 100 : n);
}

const WINDOW_ID = /^[a-z0-9_]{1,40}$/;

function usageWindow(id: string, data: unknown): UsageWindow | undefined {
  if (!WINDOW_ID.test(id) || !isObject(data)) return undefined;
  const used = utilization(data.utilization);
  if (used === undefined) return undefined;
  const resetsAt = isoTime(data.resetsAt ?? data.resets_at);
  const status = str(data.status)?.slice(0, 40);
  return { id, utilization: used, ...(resetsAt ? { resetsAt } : {}), ...(status ? { status } : {}) };
}

/**
 * Lê um `rate_limit_event` do Claude Code: `rate_limit_info.unifiedWindows` (five_hour,
 * seven_day… com utilization 0..1, resetsAt em segundos e status) ou, sem ele, a janela única de
 * `rateLimitType` + `utilization`. Formato desconhecido = null (nunca lança).
 */
export function parseClaudeRateLimit(data: unknown): { windows: UsageWindow[]; status?: string } | null {
  if (!isObject(data)) return null;
  const info = isObject(data.rate_limit_info) ? data.rate_limit_info : undefined;
  if (!info) return null;
  const windows: UsageWindow[] = [];
  const unified = isObject(info.unifiedWindows) ? info.unifiedWindows : isObject(info.unified_windows) ? info.unified_windows : undefined;
  if (unified) {
    for (const [id, value] of Object.entries(unified)) {
      const window = usageWindow(id, value);
      if (window) windows.push(window);
    }
  } else {
    const id = str(info.rateLimitType) ?? str(info.rate_limit_type);
    const window = id ? usageWindow(id, info) : undefined;
    if (window) windows.push(window);
  }
  if (windows.length === 0) return null;
  const status = str(info.status)?.slice(0, 40);
  return { windows, ...(status ? { status } : {}) };
}

const tokens = (value: unknown): number => {
  const n = num(value);
  return n !== undefined && n > 0 ? Math.round(n) : 0;
};

/**
 * Tokens do turno no evento `result` do Claude Code (`usage`: input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens). Sem `usage` (ou sem nenhum número) = undefined.
 */
export function parseClaudeTurnUsage(data: unknown): TurnUsage | undefined {
  if (!isObject(data) || !isObject(data.usage)) return undefined;
  const usage = data.usage;
  const turn: TurnUsage = {
    inputTokens: tokens(usage.input_tokens),
    outputTokens: tokens(usage.output_tokens),
    cacheReadTokens: tokens(usage.cache_read_input_tokens),
    cacheCreationTokens: tokens(usage.cache_creation_input_tokens),
    // Validade do cache gravado, modelos, duração e modo rápido (o histórico de gastos usa).
    ...claudeTurnDetail(data),
  };
  return turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheCreationTokens > 0 ? turn : undefined;
}

const rawLine = (text: string, stream: "stdout" | "stderr" = "stdout"): TerminalEvent => ({
  type: "raw",
  stream,
  text: clampLogText(text, AGENT_LOG_LIMITS.raw),
});

/**
 * Traduz as linhas de `--output-format stream-json` do Claude Code em TerminalEvents:
 * - system/init -> session (id, modelo, ferramentas, MCP) + uma linha raw de resumo;
 * - assistant: blocos text -> text; tool_use -> tool_use (ou subagent_start se for Task/Agent);
 * - user: blocos tool_result -> tool_result (ou subagent_end se fechar um Task/Agent);
 * - mensagens com `parent_tool_use_id` (dentro de um subagente) -> `thread` = esse id;
 * - result -> turn_end (o ProcessTerminal põe a tag), com os tokens do turno (`usage`), se vierem;
 * - rate_limit_event -> usage (uso da assinatura; formato desconhecido é ignorado);
 * - system/thinking_tokens -> nada (contagem de tokens, ruído);
 * - qualquer outra coisa (ou JSON quebrado) -> raw. Nunca lança.
 */
/**
 * Subtipos de `system` que não vão para o log (só ruído no terminal do agente). Os task_* contam o
 * ciclo de vida dos subagentes, que já vem da chamada Agent (início) e do tool_result dela (fim).
 */
const QUIET_SYSTEM_SUBTYPES = new Set(["thinking_tokens", "task_started", "task_updated", "task_progress", "task_notification", "background_tasks_changed"]);

/** Tamanho do prompt de uma chamada ao modelo (`message.usage` de um evento assistant): entrada + cache. */
function promptTokens(usage: unknown): number | undefined {
  if (!isObject(usage)) return undefined;
  const total = tokens(usage.input_tokens) + tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens);
  return total > 0 ? total : undefined;
}

/**
 * Conta de reserva do turno sem `result` (cortado): o MAIOR `message.usage` visto por `message.id`
 * (a CLI repete a mensagem com o `output_tokens` crescendo; somar duas linhas da mesma id contaria
 * 3 + 40 = 43 em vez de 40). A conta vem do Habblaud (`usageByMsg`: acréscimo sobre o maior valor já
 * visto, github.com/marmottajr/habblaud, MIT, Copyright (c) 2026 Márcio Junior); aqui só vale como
 * reserva: com `result`, o `usage` dele é a fonte e esta conta é descartada.
 */
export class PartialTurnTally {
  private readonly byId = new Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>();
  private readonly models = new Set<string>();
  private anonymous = 0;

  add(id: string | undefined, usage: unknown, model?: string): void {
    if (!isObject(usage)) return;
    const next = {
      input: tokens(usage.input_tokens),
      output: tokens(usage.output_tokens),
      cacheRead: tokens(usage.cache_read_input_tokens),
      cacheCreation: tokens(usage.cache_creation_input_tokens),
    };
    if (next.input + next.output + next.cacheRead + next.cacheCreation === 0) return;
    const key = id ?? `sem-id-${(this.anonymous += 1)}`;
    const seen = this.byId.get(key);
    this.byId.set(
      key,
      seen
        ? { input: Math.max(seen.input, next.input), output: Math.max(seen.output, next.output), cacheRead: Math.max(seen.cacheRead, next.cacheRead), cacheCreation: Math.max(seen.cacheCreation, next.cacheCreation) }
        : next,
    );
    if (model && !model.startsWith("<")) this.models.add(model);
  }

  /** O total e zera. Nenhum token = undefined. */
  take(): TurnUsage | undefined {
    const total: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    for (const item of this.byId.values()) {
      total.inputTokens += item.input;
      total.outputTokens += item.output;
      total.cacheReadTokens += item.cacheRead;
      total.cacheCreationTokens += item.cacheCreation;
    }
    const models = [...this.models];
    this.clear();
    if (total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheCreationTokens === 0) return undefined;
    return { ...total, ...(models.length > 0 ? { models } : {}) };
  }

  clear(): void {
    this.byId.clear();
    this.models.clear();
  }
}

export class ClaudeStreamParser implements CliEventParser {
  /** Uso das mensagens do turno em curso (reserva para o turno cortado). */
  private readonly tally = new PartialTurnTally();
  takePartialUsage(): TurnUsage | undefined {
    return this.tally.take();
  }

  /** Chamadas de Task/Agent abertas: id -> rótulo. */
  private readonly subagents = new Map<string, string>();
  /** Assinatura do último `[init]` gravado: a retomada do turno repete o init igual e não vira outra linha. */
  private lastInit: string | undefined;

  /** `subagentModel`: o padrão dos subagentes desta sessão (quando a chamada Agent não diz `model`). */
  constructor(private readonly subagentModel?: string) {}
  /** Prompt da última chamada do agente principal neste turno (o tamanho atual da conversa). */
  private lastPromptTokens: number | undefined;

  parse(line: string): TerminalEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return [rawLine(trimmed)];
    }
    if (!isObject(data)) return [rawLine(trimmed)];
    try {
      return this.event(data, trimmed);
    } catch {
      return [rawLine(trimmed)];
    }
  }

  private event(data: Json, line: string): TerminalEvent[] {
    const thread = str(data.parent_tool_use_id) || undefined;
    switch (data.type) {
      case "system":
        return this.system(data, line);
      case "assistant":
        return this.assistant(data, thread);
      case "user":
        return this.user(data, thread);
      case "result": {
        const isError = data.is_error === true || (typeof data.subtype === "string" && data.subtype !== "success");
        const errors = Array.isArray(data.errors) ? data.errors.filter((e) => typeof e === "string").join("; ") : "";
        const text = str(data.result) ?? (errors || (isError ? `Erro da CLI (${String(data.subtype ?? "desconhecido")})` : ""));
        const usage = parseClaudeTurnUsage(data);
        // O turno fechou com o `result`: a conta de reserva não vale mais (e não vaza para o próximo turno).
        this.tally.clear();
        // Tamanho da conversa: o prompt da última chamada do turno; sem ele, a entrada do turno (superestima).
        const contextTokens = this.lastPromptTokens ?? (usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens || undefined : undefined);
        this.lastPromptTokens = undefined;
        // Mensagens nossas ainda na fila da CLI (notas injetadas no meio do turno): o ProcessTerminal decide se o turno continua.
        const queuedTurns = num(data.queued_turn_count);
        return [{ type: "turn_end", ok: !isError, result: text, ...(usage ? { usage } : {}), ...(contextTokens ? { contextTokens } : {}), ...(queuedTurns !== undefined ? { queuedTurns } : {}) }];
      }
      case "rate_limit_event": {
        // Uso da assinatura: vira estado (usage:updated), nunca linha crua no log.
        const usage = parseClaudeRateLimit(data);
        return usage ? [{ type: "usage", ...usage }] : [];
      }
      case "stream_event":
      case "control_response":
      case "keep_alive":
        return [];
      default:
        return [rawLine(line)];
    }
  }

  private system(data: Json, line: string): TerminalEvent[] {
    // Contagem de tokens do raciocínio (vários por turno): telemetria, não passo de trabalho.
    if (QUIET_SYSTEM_SUBTYPES.has(String(data.subtype))) return [];
    if (data.subtype !== "init") return [rawLine(line)];
    const sessionId = str(data.session_id);
    const tools = Array.isArray(data.tools) ? data.tools.filter((t): t is string => typeof t === "string") : undefined;
    const mcpServers = Array.isArray(data.mcp_servers)
      ? data.mcp_servers.filter(isObject).map((server) => ({ name: String(server.name ?? "?"), status: String(server.status ?? "?") }))
      : undefined;
    const model = str(data.model);
    const apiKeySource = str(data.apiKeySource);
    const events: TerminalEvent[] = [];
    if (sessionId) events.push({ type: "session", sessionId, model, tools, mcpServers, apiKeySource });
    const mcp = mcpServers?.map((server) => `${server.name}: ${server.status}`).join(", ") || "nenhum";
    // Com syncClaudeAiPlugins:false só sobram plugins embutidos da CLI (se houver): mostra os nomes.
    const plugins = Array.isArray(data.plugins)
      ? data.plugins.map((plugin) => (isObject(plugin) ? str(plugin.name) : str(plugin)) ?? "?").slice(0, 8)
      : [];
    // Só grava o resumo quando algo mudou (sessão, modelo, MCP ou ferramentas): cada retomada de turno repete o init.
    const signature = [sessionId, model, mcp, tools?.length, plugins.join(","), apiKeySource].join("|");
    if (signature === this.lastInit) return events;
    this.lastInit = signature;
    events.push(
      rawLine(
        `[init] sessão ${sessionId ?? "?"} · modelo ${model ?? "?"} · ${tools ? `${tools.length} ferramentas` : "ferramentas ?"} · MCP: ${mcp}` +
          (plugins.length > 0 ? ` · plugins: ${plugins.join(", ")}` : "") +
          (apiKeySource ? ` · auth: ${apiKeySource}` : ""),
      ),
    );
    return events;
  }

  private assistant(data: Json, thread: string | undefined): TerminalEvent[] {
    const message = isObject(data.message) ? data.message : undefined;
    if (!thread) this.lastPromptTokens = promptTokens(message?.usage) ?? this.lastPromptTokens;
    this.tally.add(str(message?.id), message?.usage, str(message?.model));
    const content = message?.content;
    if (typeof content === "string") return content.trim() ? [{ type: "text", text: content, ...(thread ? { thread } : {}) }] : [];
    if (!Array.isArray(content)) return [];
    const events: TerminalEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text") {
        const text = str(block.text);
        if (text?.trim()) events.push({ type: "text", text, ...(thread ? { thread } : {}) });
      } else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name) ?? "?";
        if (!id) continue;
        const input = isObject(block.input) ? block.input : undefined;
        if (SUBAGENT_TOOLS.has(name)) {
          const label = str(input?.description) ?? str(input?.subagent_type) ?? "Subagente";
          this.subagents.set(id, label);
          // O agente pode pedir outro modelo para esta peça (`model`); senão vale o padrão dos subagentes.
          const model = str(input?.model) ?? this.subagentModel;
          events.push({ type: "subagent_start", id, label, goal: str(input?.prompt) ?? label, ...(model ? { model } : {}), ...(thread ? { thread } : {}) });
        } else {
          events.push({ type: "tool_use", id, name, ...(input ? { input } : {}), ...(thread ? { thread } : {}) });
        }
      }
    }
    return events;
  }

  private user(data: Json, thread: string | undefined): TerminalEvent[] {
    const message = isObject(data.message) ? data.message : undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const events: TerminalEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      const ok = block.is_error !== true;
      const output = resultText(block.content);
      if (this.subagents.has(id)) {
        this.subagents.delete(id);
        events.push({ type: "subagent_end", id, ok, ...(output ? { result: output } : {}) });
      } else {
        events.push({ type: "tool_result", id, ok, ...(output ? { output } : {}), ...(thread ? { thread } : {}) });
      }
    }
    return events;
  }
}
