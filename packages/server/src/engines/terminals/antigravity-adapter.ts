import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_LOG_LIMITS, clampLogText, OFFICE_MCP_SERVER, type EffectiveFolder, type TurnUsage, ENGINE_FALLBACK_MODELS, modelUsesEffort } from "@cyno/shared";
import { sanitizeChildEnv } from "./env";
import type { AgentFile, CliAdapter, CliEventParser, TerminalAccess, TerminalEvent, TerminalSpec } from "./types";

/**
 * Motor "gemini": o Google Antigravity CLI (`agy`, logado com a conta Google do usuário). Conferido
 * no `agy` 1.5.3 (veja docs/arquitetura.md, "Antigravity"). Um processo por agente, cwd = pasta do agente:
 *
 *   agy --input-format stream-json --output-format stream-json --disable-slash-commands
 *     --settings '<antigravitySessionSettings(cwd, access)>'
 *     [--conversation <id>] [--model <modelo>] [--effort <nível>]
 *
 * - Sem `-p`: com `--input-format stream-json` o agy lê uma mensagem NDJSON por linha da entrada
 *   (`{"event":"user","message":{"content":"…"}}`) e roda um turno para cada; o `-p` é uma flag de
 *   texto e engoliria o argumento seguinte. Fechar a entrada encerra (o turno em curso termina antes).
 * - `--settings` vale só para esta sessão (nunca é gravado no ~/.gemini): veja ANTIGRAVITY_SETTINGS.
 * - MCP: o agy não tem flag de MCP por sessão; ele lê o `.agents/mcp_config.json` do workspace (a
 *   pasta do agente), então o servidor "office" com o token vai lá (nunca no global
 *   ~/.gemini/config/mcp_config.json nem por `agy mcp add`).
 * - Instruções: GEMINI.md na pasta do agente (as regras que o agy carrega sempre; não há flag de
 *   prompt de sistema).
 * - Retomar: `--conversation <id>` com o `conversation_id` do evento init (o agy escolhe o id; o
 *   nosso id inicial é só um marcador). Conversa desconhecida: o agy avisa no stderr e começa outra
 *   (o init novo traz o id novo e o session.json acompanha).
 * - Interromper: não há mensagem de controle (um `control_request` encerra a sessão com código 2),
 *   então o terminal para o processo e a próxima ordem retoma a conversa.
 */
export type AntigravityAdapterOptions = {
  /** Executável (padrão "agy"). Nos testes: o node, com `prefixArgs` = [script da CLI falsa]. */
  command?: string;
  prefixArgs?: string[];
  /** Esforço quando o agente não diz (padrão: nenhum, fica o do modelo, ex.: gemini-3.8-flash-low). */
  defaultEffort?: string;
};

/**
 * Ações que nunca rodam: comando fora do sandbox (`unsandboxed`) e executar/baixar URL
 * (`execute_url`, `download_url`: o navegador embutido e downloads). O agy 1.5.3 não tem como
 * esconder as ferramentas embutidas do modelo (nem flag nem chave de settings): só negar o uso. Por
 * isso as instruções também dizem para nem tentar.
 */
export const ANTIGRAVITY_DENY_ALWAYS = ["unsandboxed(*)", "execute_url(*)", "download_url(*)"] as const;

/** Terminal (`run_command`, no sandbox do agy): liberado só com o terminal do agente ligado. */
export const ANTIGRAVITY_COMMAND = "command(*)";

/**
 * Ler URL (`read_url_content`): liberado só com a internet do agente ligada. Conferido no agy 1.5.3
 * (2026-11-09): a busca na web (`search_web`) NÃO passa por nenhuma categoria de permissão (roda
 * mesmo com tudo negado; `search_web(*)` no deny é ignorado), então desligar a internet no agy só
 * bloqueia ler URL e o resto fica nas instruções.
 */
export const ANTIGRAVITY_READ_URL = "read_url(*)";

/** Lista de negação sem internet nem terminal (a de antes do acesso por workspace). */
export const ANTIGRAVITY_DENY = [ANTIGRAVITY_COMMAND, "unsandboxed(*)", ANTIGRAVITY_READ_URL, "execute_url(*)", "download_url(*)"] as const;

/** Regras `allow`/`deny` extras do acesso (internet: ler URL, com os domínios; terminal: comandos). */
export function antigravityAccessRules(access: TerminalAccess | undefined): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  if (access?.terminal) allow.push(ANTIGRAVITY_COMMAND);
  if (access?.internet) allow.push(...(access.allowedDomains.length > 0 ? access.allowedDomains.map((domain) => `read_url(${domain})`) : [ANTIGRAVITY_READ_URL]));
  const deny = [
    ...(access?.terminal ? [] : [ANTIGRAVITY_COMMAND]),
    "unsandboxed(*)",
    ...(access?.internet ? access.blockedDomains.map((domain) => `read_url(${domain})`) : [ANTIGRAVITY_READ_URL]),
    "execute_url(*)",
    "download_url(*)",
  ];
  return { allow, deny };
}

/**
 * Regras das pastas de trabalho (conferidas no agy 1.5.9, Gemini 3.8 Flash): ler e escrever em cada pasta com
 * `read_file(<pasta>)` e `write_file(<pasta>)`; numa pasta SÓ LEITURA a escrita não é liberada e ainda leva
 * `write_file(<pasta>)` no deny (deny vence tudo). As pastas também entram no workspace do agy por `--add-dir`.
 * Só vale para as ferramentas de arquivo: com o terminal ligado, `command` roda no sandbox do agy e não é travado por pasta.
 */
export function antigravityFolderRules(folders: readonly EffectiveFolder[]): { allow: string[]; deny: string[] } {
  const allow = folders.flatMap((folder) => [`read_file(${folder.path})`, ...(folder.write ? [`write_file(${folder.path})`] : [])]);
  const deny = folders.filter((folder) => !folder.write).map((folder) => `write_file(${folder.path})`);
  return { allow, deny };
}

/**
 * Configuração da sessão (`--settings`, por cima do ~/.gemini/antigravity-cli/settings.json, sem
 * gravar nada lá):
 * - toolPermission "request-review": o que não está liberado precisaria de um "permitir?", que no
 *   modo headless é negado na hora (soft-deny: o turno segue e o result lista em denied_actions);
 * - permissions: libera o MCP do escritório e ler/escrever na pasta do agente, mais o que o acesso
 *   dele permite (ler URL com internet, comandos com terminal; antigravityAccessRules); nega comando
 *   fora do sandbox, executar/baixar URL (navegador) e o que o acesso não permite (deny vence tudo);
 * - allowNonWorkspaceAccess false: nada fora da pasta do agente (o workspace é o cwd);
 * - modelProvider "" e useG1Credits false: só a cota da assinatura (nunca GEMINI_API_KEY nem
 *   créditos de IA pagos quando a cota acaba);
 * - agentMode "" (modo padrão, sem "auto"), artifactReviewPolicy "always-proceed" (não espera
 *   revisão de artefato), enableTerminalSandbox, sem dicas/pesquisas/notificações,
 *   disableSlashCommands e trustedWorkspaces = a pasta do agente.
 */
export function antigravitySessionSettings(cwd: string, access?: TerminalAccess, folders: readonly EffectiveFolder[] = []): Record<string, unknown> {
  const rules = antigravityAccessRules(access);
  const folderRules = antigravityFolderRules(folders);
  return {
    toolPermission: "request-review",
    agentMode: "",
    modelProvider: "",
    useG1Credits: false,
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    artifactReviewPolicy: "always-proceed",
    disableSlashCommands: true,
    notifications: false,
    showTips: false,
    showFeedbackSurvey: false,
    trustedWorkspaces: [cwd],
    permissions: {
      allow: [`mcp(${OFFICE_MCP_SERVER}/*)`, `read_file(${cwd})`, `write_file(${cwd})`, ...folderRules.allow, ...rules.allow],
      deny: [...rules.deny, ...folderRules.deny],
    },
  };
}

/** Onde o agy procura os servidores MCP do workspace (relativo à pasta do agente). */
export const ANTIGRAVITY_MCP_CONFIG = path.join(".agents", "mcp_config.json");

export class AntigravityCliAdapter implements CliAdapter {
  readonly provider = "gemini" as const;
  private readonly command_: string;
  private readonly prefixArgs: string[];
  private readonly defaultEffort: string | undefined;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.command_ = options.command ?? "agy";
    this.prefixArgs = options.prefixArgs ?? [];
    this.defaultEffort = options.defaultEffort || undefined;
  }

  command(spec: TerminalSpec, session: { sessionId: string; resume: boolean }): { command: string; args: string[] } {
    const args = [
      ...this.prefixArgs,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--settings",
      JSON.stringify(antigravitySessionSettings(spec.cwd, spec.access, spec.folders)),
      ...(spec.folders ?? []).flatMap((folder) => ["--add-dir", folder.path]),
      ...(session.resume ? ["--conversation", session.sessionId] : []),
    ];
    // Sem modelo no agente: o padrão da plataforma para o motor, nunca o padrão da CLI.
    args.push("--model", spec.model ?? ENGINE_FALLBACK_MODELS.gemini.model);
    // O esforço só vai quando o modelo o aceita: nos Gemini o nível já está no nome e a CLI recusa `--effort`.
    const effort = spec.effort ?? this.defaultEffort;
    if (effort && modelUsesEffort("gemini", spec.model)) args.push("--effort", effort);
    return { command: this.command_, args };
  }

  /** GEMINI.md (as regras que o agy sempre carrega) e o .agents/mcp_config.json do workspace. */
  agentFiles({ spec, mcpUrl, token }: { spec: TerminalSpec; mcpUrl: string; token: string }): AgentFile[] {
    const mcp = { mcpServers: { [OFFICE_MCP_SERVER]: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
    return [
      { path: path.join(spec.cwd, "GEMINI.md"), content: `${spec.systemPrompt}\n` },
      { path: path.join(spec.cwd, ANTIGRAVITY_MCP_CONFIG), content: `${JSON.stringify(mcp, null, 2)}\n`, secret: true },
    ];
  }

  env(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv {
    // Mantém HOME/DBUS (o login do agy fica no chaveiro do sistema); tira toda chave de API.
    return sanitizeChildEnv(base, { GIT_CEILING_DIRECTORIES: path.dirname(spec.cwd) });
  }

  createParser(spec?: TerminalSpec): CliEventParser {
    return new AntigravityStreamParser(spec?.subagent?.model);
  }

  encodeMessage(text: string): string {
    return JSON.stringify({ event: "user", message: { content: text } });
  }

  newSessionId(): string {
    return randomUUID();
  }

  isMissingSession(stderr: string): boolean {
    return /conversation .*not found/i.test(stderr);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** O `usage` do agy como veio: `{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }`. */
type AgyTokens = { input: number; output: number; thinking: number; cacheRead: number; total: number };

function agyTokens(value: unknown): AgyTokens | undefined {
  if (!isObject(value)) return undefined;
  const tokens = {
    input: count(value.input_tokens),
    output: count(value.output_tokens),
    thinking: count(value.thinking_tokens),
    cacheRead: count(value.cache_read_tokens),
    total: count(value.total_tokens),
  };
  return tokens.input + tokens.output + tokens.thinking + tokens.cacheRead + tokens.total > 0 ? tokens : undefined;
}

const addTokens = (a: AgyTokens, b: AgyTokens): AgyTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  thinking: a.thinking + b.thinking,
  cacheRead: a.cacheRead + b.cacheRead,
  total: a.total + b.total,
});

/**
 * Tokens do agy -> TurnUsage. O raciocínio (`thinking_tokens`) conta como saída. O cache lido
 * (`cache_read_tokens`) vem DENTRO da entrada, como no Gemini (promptTokenCount inclui o cache),
 * e sai dela — a menos que o `total_tokens` mostre que ele veio à parte (total ≥ tudo somado).
 * Nada = undefined.
 */
export function antigravityTurnUsage(value: unknown): TurnUsage | undefined {
  const tokens = agyTokens(value);
  return tokens ? toTurnUsage(tokens) : undefined;
}

function toTurnUsage(tokens: AgyTokens): TurnUsage | undefined {
  const separate = tokens.cacheRead > 0 && tokens.total >= tokens.input + tokens.output + tokens.thinking + tokens.cacheRead;
  const turn: TurnUsage = {
    inputTokens: separate ? tokens.input : Math.max(0, tokens.input - tokens.cacheRead),
    outputTokens: tokens.output + tokens.thinking,
    cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: 0,
  };
  return turn.inputTokens + turn.outputTokens + turn.cacheReadTokens > 0 ? turn : undefined;
}

const rawLine = (text: string, stream: "stdout" | "stderr" = "stdout"): TerminalEvent => ({
  type: "raw",
  stream,
  text: clampLogText(text, AGENT_LOG_LIMITS.raw),
});

/** Passos que não viram nada no log (eco da nossa mensagem, mensagens de sistema, checkpoints). */
const QUIET_STEPS = new Set(["user_input", "system_message", "checkpoint"]);

/** Saída de ferramenta (texto ou JSON) como texto. */
function outputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** `spawn`: um invoke_subagent ainda ACTIVE (o subagente só nasce no DONE, com os dados dele). */
type OpenTool = { id: string; subagent: boolean; spawn?: { params: Json } };

/**
 * Traduz as linhas de `--output-format stream-json` do agy em TerminalEvents:
 * - init -> session (conversation_id, modelo, ferramentas) + uma linha raw de resumo;
 * - step_update agent_response: os `text_delta` do passo se juntam e viram um `text` quando o passo
 *   fica DONE (passos sem texto, só raciocínio/planejamento, não viram nada);
 * - step_update tool: ACTIVE -> tool_use; DONE -> tool_result (erro = tool_info.error). O
 *   `call_mcp_tool` vira `mcp__<servidor>__<ferramenta>` com os argumentos, como no Claude Code;
 * - passo com subagent_info -> subagent_start/subagent_end (e passos de uma conversa filha
 *   conhecida vão para a thread do subagente). No agy 1.5.3 o `invoke_subagent` chega como passo
 *   "tool" ACTIVE (só Role/TypeName) e depois como passo "subagent" DONE com
 *   `subagent_info.subagents[]` (role, initial_prompt, conversation_id): é aí que o subagente começa.
 *   Ele roda em paralelo e avisa o fim com um `system_message` no agente principal (sem conteúdo no
 *   stream): cada system_message fecha o subagente mais antigo ainda aberto;
 * - result -> turn_end (SUCCESS = ok; senão o erro) com os tokens do turno (`usage`), antes uma
 *   linha raw por ação negada (denied_actions: o modo headless não pode pedir permissão);
 * - user_input, system_message, checkpoint -> nada;
 * - qualquer outra coisa (ou JSON quebrado) -> raw. Nunca lança.
 * Tokens (conferido no agy 1.5.3, 2026-11-09): cada passo DONE que chamou o modelo traz o `usage`
 * DAQUELA chamada; o `usage` do `result` é o ACUMULADO do processo (no 2º turno, a soma dos dois).
 * Então o turno = soma dos `usage` dos passos dele; sem nenhum, a diferença do `result` para o
 * anterior. A cota da conta não vem no stream (veja usage/antigravity-poller.ts).
 */
export class AntigravityStreamParser implements CliEventParser {
  private conversationId: string | undefined;
  /** Assinatura do último `[init]` gravado (a retomada do turno repete o init igual). */
  private lastInit: string | undefined;
  /** Texto acumulado de cada passo agent_response ainda ACTIVE: índice -> texto. */
  private readonly texts = new Map<string, string>();
  /** Ferramentas/subagentes já anunciados e ainda abertos: índice do passo -> id. */
  private readonly open = new Map<string, OpenTool>();
  /** Conversa filha (de um subagente) -> id do subagente (a thread). */
  private readonly children = new Map<string, string>();
  /** Subagentes do agy 1.5.3 rodando (criados e ainda sem o system_message de fim), na ordem. */
  private readonly running: string[] = [];
  /** Tokens de cada passo DONE do turno em curso (um por passo, mesmo se o DONE repetir). */
  private readonly stepTokens = new Map<string, AgyTokens>();
  /** O `usage` acumulado do último `result` deste processo. */
  private lastResultTokens: AgyTokens | undefined;

  /** Transcrição de cada subagente (o `log_uri` do agy), lida quando ele termina: id do subagente -> arquivo. */
  private readonly transcripts = new Map<string, string>();

  /**
   * `subagentModel`: o padrão dos subagentes do workspace (quando o invoke_subagent não diz o modelo).
   * `readTranscript`: lê o transcript.jsonl de um subagente (nos testes, falso).
   */
  constructor(
    private readonly subagentModel?: string,
    private readonly readTranscript: (uri: string) => string | undefined = readAgyTranscript,
  ) {}

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
    switch (data.event) {
      case "init":
        return this.init(data);
      case "step_update":
        return isObject(data.step_update) ? this.step(data.step_update, line) : [rawLine(line)];
      case "result":
        return isObject(data.result) ? this.result(data.result) : [rawLine(line)];
      default:
        return [rawLine(line)];
    }
  }

  private init(data: Json): TerminalEvent[] {
    const init = isObject(data.init) ? data.init : {};
    const sessionId = str(data.conversation_id) ?? str(init.conversation_id);
    const tools = Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === "string") : undefined;
    const model = str(init.model);
    const events: TerminalEvent[] = [];
    if (sessionId) {
      this.conversationId = sessionId;
      events.push({ type: "session", sessionId, ...(model ? { model } : {}), ...(tools ? { tools } : {}) });
    }
    const permission = str(init.permission_mode);
    const agent = str(init.agent);
    const signature = [sessionId, model, agent, permission, tools?.length].join("|");
    if (signature === this.lastInit) return events;
    this.lastInit = signature;
    events.push(
      rawLine(
        `[init] conversa ${sessionId ?? "?"} · modelo ${model ?? "padrão da CLI"}` +
          (agent ? ` · agente ${agent}` : "") +
          ` · permissões: ${permission ?? "?"} · ${tools ? `${tools.length} ferramentas` : "ferramentas ?"}`,
      ),
    );
    return events;
  }

  private step(step: Json, line: string): TerminalEvent[] {
    const type = str(step.step_type) ?? "?";
    const index = String(step.step_index ?? "?");
    const done = step.state === "DONE";
    const conversation = str(step.conversation_id);
    const thread = conversation && conversation !== this.conversationId ? this.children.get(conversation) : undefined;
    const key = `${conversation ?? ""}#${index}`;
    if (done) {
      const tokens = agyTokens(step.usage);
      if (tokens) this.stepTokens.set(key, tokens);
    }
    if (isObject(step.subagent_info) && Array.isArray(step.subagent_info.subagents)) return this.spawned(step.subagent_info.subagents, key, thread);
    if (isObject(step.subagent_info)) return this.subagent(step, step.subagent_info, key, done || step.state === "ERROR" || step.state === "CANCELED", thread);
    if (type === "system_message" && !thread && this.running.length > 0) return this.endSubagent(this.running.shift()!, true);
    if (QUIET_STEPS.has(type)) return [];
    if (type === "agent_response") {
      const delta = str(step.text_delta) ?? "";
      const text = (this.texts.get(key) ?? "") + delta;
      if (!done) {
        this.texts.set(key, text);
        return [];
      }
      this.texts.delete(key);
      return text.trim() ? [{ type: "text", text: text.trim(), ...(thread ? { thread } : {}) }] : [];
    }
    // Ferramenta com erro termina em ERROR (com tool_info.error), não em DONE: é fim de passo do mesmo jeito.
    if (type === "tool") return this.tool(step, key, done || step.state === "ERROR" || step.state === "CANCELED", thread);
    // Tipo de passo desconhecido: uma linha crua quando ele termina (o ACTIVE só faria barulho).
    return done ? [rawLine(line)] : [];
  }

  private tool(step: Json, key: string, done: boolean, thread: string | undefined): TerminalEvent[] {
    const info = isObject(step.tool_info) ? step.tool_info : {};
    const events: TerminalEvent[] = [];
    let open = this.open.get(key);
    const toolName = str(info.name) ?? str(step.tool_name) ?? "?";
    if (!open && toolName === "invoke_subagent" && !done) {
      // O subagente só nasce no DONE (passo "subagent", com role e prompt): até lá, nada no log.
      this.open.set(key, { id: this.toolId(key), subagent: true, spawn: { params: isObject(info.parameters) ? info.parameters : {} } });
      return [];
    }
    const error = isObject(info.error) ? info.error : undefined;
    const output = error ? [str(error.type) === "TOOL_ERROR" ? undefined : str(error.type), str(error.message)].filter(Boolean).join(": ") || "Erro na ferramenta" : outputText(info.output);
    if (open?.spawn) {
      // invoke_subagent que terminou como ferramenta comum (ex.: erro): subagente que abre e fecha.
      if (!done) return [];
      this.open.delete(key);
      const label = str(open.spawn.params.Role) ?? "Subagente";
      return [
        { type: "subagent_start", id: open.id, label, goal: label, ...this.modelOf(open.spawn.params), ...(thread ? { thread } : {}) },
        { type: "subagent_end", id: open.id, ok: !error, ...(output ? { result: output } : {}) },
      ];
    }
    if (!open) {
      open = { id: this.toolId(key), subagent: false };
      this.open.set(key, open);
      const { name, input } = toolCall(toolName, info.parameters);
      events.push({ type: "tool_use", id: open.id, name, ...(input ? { input } : {}), ...(thread ? { thread } : {}) });
    }
    if (!done) return events;
    this.open.delete(key);
    events.push({ type: "tool_result", id: open.id, ok: !error, ...(output ? { output } : {}), ...(thread ? { thread } : {}) });
    return events;
  }

  /** Subagentes criados pelo invoke_subagent (agy 1.5.3): começam agora e acabam no system_message de cada um. */
  private spawned(list: unknown[], key: string, thread: string | undefined): TerminalEvent[] {
    const open = this.open.get(key);
    this.open.delete(key);
    const base = open?.id ?? this.toolId(key);
    const params = open?.spawn?.params ?? {};
    const events: TerminalEvent[] = [];
    list.filter(isObject).forEach((sub, index) => {
      const id = index === 0 ? base : `${base}-${index + 1}`;
      const label = str(sub.role) ?? str(sub.name) ?? str(sub.type_name) ?? "Subagente";
      const goal = str(sub.initial_prompt) ?? str(sub.prompt) ?? label;
      events.push({ type: "subagent_start", id, label, goal, ...this.modelOf(params, sub), ...(thread ? { thread } : {}) });
      const child = str(sub.conversation_id);
      if (child) this.children.set(child, id);
      const uri = str(sub.log_uri);
      if (uri) this.transcripts.set(id, uri);
      this.running.push(id);
    });
    return events;
  }

  /** Modelo do subagente: o que o agy informar, o Model pedido no invoke_subagent ou o padrão do workspace. */
  private modelOf(params: Json, info: Json = {}): { model?: string } {
    const model = str(info.model) ?? str(params.Model) ?? str(params.model) ?? this.subagentModel;
    return model ? { model } : {};
  }

  private subagent(step: Json, info: Json, key: string, done: boolean, thread: string | undefined): TerminalEvent[] {
    const events: TerminalEvent[] = [];
    let open = this.open.get(key);
    if (!open) {
      open = { id: this.toolId(key), subagent: true };
      this.open.set(key, open);
      const label = str(info.name) ?? str(info.agent_name) ?? str(info.subagent_name) ?? str(info.description) ?? "Subagente";
      const goal = str(info.prompt) ?? str(info.task) ?? str(info.goal) ?? str(info.description) ?? label;
      // Modelo pedido no invoke_subagent (parâmetro Model), o que o agy informar, ou o padrão do workspace.
      const params = isObject(step.tool_info) && isObject(step.tool_info.parameters) ? step.tool_info.parameters : {};
      const model = str(info.model) ?? str(params.Model) ?? str(params.model) ?? this.subagentModel;
      events.push({ type: "subagent_start", id: open.id, label, goal, ...(model ? { model } : {}), ...(thread ? { thread } : {}) });
    }
    const child = str(info.conversation_id) ?? str(info.child_conversation_id) ?? str(info.cascade_id);
    if (child) this.children.set(child, open.id);
    if (!done) return events;
    this.open.delete(key);
    const toolInfo = isObject(step.tool_info) ? step.tool_info : {};
    const error = isObject(info.error) ? info.error : isObject(toolInfo.error) ? toolInfo.error : undefined;
    const result = error ? str(error.message) : (str(info.result) ?? str(info.response) ?? outputText(toolInfo.output));
    events.push({ type: "subagent_end", id: open.id, ok: !error, ...(result ? { result } : {}) });
    return events;
  }

  /**
   * Fim de um subagente do agy 1.5.x: o stream não traz os passos dele nem o texto do que ele
   * respondeu, só o `log_uri` do transcript. Lê o transcript e traz as ferramentas que ele usou
   * (na thread dele) e a resposta (a mensagem que ele mandou ao agente principal) como resultado.
   */
  private endSubagent(id: string, ok: boolean): TerminalEvent[] {
    const uri = this.transcripts.get(id);
    this.transcripts.delete(id);
    const detail = uri ? subagentDetail(id, this.readTranscript(uri)) : { events: [], result: undefined };
    return [...detail.events, { type: "subagent_end", id, ok, ...(detail.result ? { result: detail.result } : {}) }];
  }

  private result(result: Json): TerminalEvent[] {
    const events: TerminalEvent[] = [];
    // Texto de um passo que nunca chegou a DONE (não deveria acontecer): não se perde.
    for (const text of this.texts.values()) if (text.trim()) events.push({ type: "text", text: text.trim() });
    this.texts.clear();
    // Ferramentas que ficaram abertas (o agy pulou o DONE): fecham sem saída.
    for (const open of this.open.values()) {
      if (open.spawn) continue; // invoke_subagent que nunca chegou a criar o subagente: nada foi anunciado
      events.push(open.subagent ? { type: "subagent_end", id: open.id, ok: false } : { type: "tool_result", id: open.id, ok: false, output: "Sem resposta da ferramenta" });
    }
    this.open.clear();
    // Subagentes que não avisaram o fim antes do fim do turno.
    for (const id of this.running.splice(0)) events.push(...this.endSubagent(id, false));
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions.filter(isObject) : [];
    for (const action of denied) {
      const name = str(action.action) ?? "?";
      const display = str(action.display_name);
      events.push(rawLine(`[negado] ${name}${display ? ` (${display})` : ""}: fora do que o agente pode fazer (sem pedir permissão no modo headless)`, "stderr"));
    }
    const status = str(result.status) ?? "?";
    const ok = status === "SUCCESS";
    const response = str(result.response)?.trim() ?? "";
    const error = isObject(result.error) ? (str(result.error.message) ?? JSON.stringify(result.error)) : str(result.error);
    const text = ok ? response : response || error || `Erro da CLI (${status})`;
    const usage = this.turnTokens(result.usage, result.num_turns);
    events.push({ type: "turn_end", ok, result: text, ...(usage ? { usage } : {}) });
    return events;
  }

  /** Turno cortado: a soma dos passos que já tinham informado o uso (e zera). */
  takePartialUsage(): TurnUsage | undefined {
    const steps = [...this.stepTokens.values()];
    this.stepTokens.clear();
    return steps.length > 0 ? toTurnUsage(steps.reduce(addTokens)) : undefined;
  }

  /**
   * Tokens do turno que acabou: a soma dos passos ou, sem eles, o acumulado menos o do último
   * result. O acumulado segue a CONVERSA (ao retomar com --conversation ele continua somando), então
   * sem result anterior neste processo ele só vale sozinho no 1º turno (`num_turns` 1).
   */
  private turnTokens(resultUsage: unknown, numTurns: unknown): TurnUsage | undefined {
    const cumulative = agyTokens(resultUsage);
    const previous = this.lastResultTokens;
    if (cumulative) this.lastResultTokens = cumulative;
    const steps = [...this.stepTokens.values()];
    this.stepTokens.clear();
    if (steps.length > 0) return toTurnUsage(steps.reduce(addTokens));
    if (!cumulative) return undefined;
    const grew = previous !== undefined && (["input", "output", "thinking", "cacheRead", "total"] as const).every((field) => cumulative[field] >= previous[field]);
    if (!previous) return numTurns === 1 ? toTurnUsage(cumulative) : undefined;
    if (!grew) return undefined;
    return toTurnUsage({
      input: cumulative.input - previous.input,
      output: cumulative.output - previous.output,
      thinking: cumulative.thinking - previous.thinking,
      cacheRead: cumulative.cacheRead - previous.cacheRead,
      total: cumulative.total - previous.total,
    });
  }

  /** Id estável de uma ferramenta/subagente (os passos são numerados por conversa, e seguem ao retomar). */
  private toolId(key: string): string {
    const [conversation = "", index = "?"] = key.split("#");
    return `agy-${conversation.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "x"}-${index.replace(/[^0-9A-Za-z]/g, "")}`;
  }
}

/** Teto de ferramentas de um subagente trazidas do transcript. */
const SUBAGENT_MAX_TOOLS = 40;
const TRANSCRIPT_MAX_BYTES = 2_000_000;

/** Lê o transcript.jsonl de um subagente (só dentro do cache do agy, em ~/.gemini/antigravity-cli/brain). Nunca lança. */
export function readAgyTranscript(uri: string): string | undefined {
  try {
    if (!uri.startsWith("file://")) return undefined;
    const file = decodeURIComponent(new URL(uri).pathname);
    const root = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain") + path.sep;
    if (!file.startsWith(root) || path.basename(file) !== "transcript.jsonl" || file.includes("..")) return undefined;
    if (statSync(file).size > TRANSCRIPT_MAX_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Valor de um argumento do transcript (o agy grava cada um como JSON em texto: `"\"office\""`). */
function decodeArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Do transcript de um subagente: as ferramentas (um passo PLANNER_RESPONSE com `tool_calls`, seguido
 * de um passo GENERIC com a saída de cada uma, na ordem) e a resposta (o `send_message` dele ao
 * agente principal, ou o texto do último passo do modelo).
 */
export function subagentDetail(subagentId: string, transcript: string | undefined): { events: TerminalEvent[]; result: string | undefined } {
  const events: TerminalEvent[] = [];
  if (!transcript) return { events, result: undefined };
  const steps: Json[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) steps.push(parsed);
    } catch {
      // linha quebrada: ignora
    }
  }
  let result: string | undefined;
  let pending: string[] = [];
  const unanswered = new Set<string>();
  let count = 0;
  for (const step of steps) {
    if (step.source !== "MODEL") continue;
    if (step.type === "PLANNER_RESPONSE") {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls.filter(isObject) : [];
      const content = str(step.content)?.trim();
      if (content) result = content;
      pending = [];
      for (const call of calls) {
        const name = str(call.name) ?? "?";
        const args = isObject(call.args) ? Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, decodeArg(value)])) : undefined;
        if (name === "send_message") {
          const message = args && typeof args.Message === "string" ? args.Message.trim() : undefined;
          if (message) result = message;
          pending.push("");
          continue;
        }
        if (count >= SUBAGENT_MAX_TOOLS) {
          pending.push("");
          continue;
        }
        count += 1;
        const id = `${subagentId}-t${count}`;
        pending.push(id);
        const shown = toolCall(name, args);
        unanswered.add(id);
        events.push({ type: "tool_use", id, name: shown.name, ...(shown.input ? { input: shown.input } : {}), thread: subagentId });
      }
    } else if (step.type === "GENERIC" && pending.length > 0) {
      const id = pending.shift()!;
      if (!id) continue;
      const output = (str(step.content) ?? "").split("\n").filter((line) => !/^(Created|Completed) At: /.test(line)).join("\n").trim();
      unanswered.delete(id);
      events.push({ type: "tool_result", id, ok: !/^Encountered error/i.test(output), ...(output ? { output } : {}), thread: subagentId });
    }
  }
  // Ferramenta sem passo de saída no transcript: fecha sem saída.
  for (const id of unanswered) events.push({ type: "tool_result", id, ok: false, output: "Sem saída no transcript do subagente", thread: subagentId });
  return { events, result };
}

/** Nome e entrada de uma ferramenta do agy (call_mcp_tool -> mcp__<servidor>__<ferramenta>). */
function toolCall(name: string, parameters: unknown): { name: string; input?: Record<string, unknown> } {
  const params = isObject(parameters) ? parameters : undefined;
  if (name === "call_mcp_tool" && params) {
    const server = str(params.ServerName) ?? str(params.server_name);
    const tool = str(params.ToolName) ?? str(params.tool_name);
    if (server && tool) {
      const args = isObject(params.Arguments) ? params.Arguments : isObject(params.arguments) ? params.arguments : undefined;
      return { name: `mcp__${server}__${tool}`, ...(args ? { input: args } : {}) };
    }
  }
  return { name, ...(params ? { input: params } : {}) };
}
