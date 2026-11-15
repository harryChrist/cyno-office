import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ONE_SHOT_ACCOUNT, maskSecrets, OFFICE_MCP_SERVER, type AgentEffort, type OneShotAccount, type TurnUsage, type UsageWindow } from "@cyno/shared";
import { shorten } from "../../util/text";
import { minimalChildEnv, sanitizeChildEnv } from "./env";
import { detectFence, enclosingNodeModules, fencePolicy, readOnlyFolders, realPathOf, resolveExecutable, writableFolders, type FencePolicy, type FenceSupport } from "./fence";
import type { OneShotAdapter, OneShotParser } from "./one-shot-terminal";
import type { AgentFile, TerminalEvent, TerminalSpec } from "./types";

/**
 * OpenClaw (OpenClaw Foundation, 2026.11.3): só o `openclaw agent exec`, um turno isolado e sem
 * Gateway. Nunca: `onboard`, `configure`, daemon, canais, celular. Formato conferido com o programa de
 * verdade em 12/11 (`agent exec --help`, o envelope do erro "sem conta", `mcp show` sobre a configuração
 * gerada) e com a documentação (docs.openclaw.ai/cli/agent) para o envelope de sucesso.
 *
 * Isolamento: o estado (sessões) e o HOME do processo ficam numa pasta própria do Cyno
 * (`<DATA_DIR>/platform/engines/openclaw/`), nunca o ~/.openclaw do dono (nada é gravado lá e o programa não
 * descobre os logins do Claude/Codex no HOME dele). O modelo vem do OpenRouter: a chave que o dono põe no painel
 * vai por `OPENROUTER_API_KEY` (conferido no programa: `models status` mostra "env: OPENROUTER_API_KEY") e o
 * modelo vai como `openrouter/<id>`. Nunca `models auth`, `onboard` ou `configure`.
 */

export type OpenClawAdapterOptions = {
  /** Executável (nos testes: o node com a CLI falsa). */
  command?: string;
  prefixArgs?: string[];
  /** Pasta própria do OpenClaw no Cyno (HOME do processo, estado e a configuração base). */
  homeDir: string;
  /** Modelo padrão da plataforma (Configurar), usado quando o agente não escolheu. */
  defaultModel?: string;
  defaultEffort?: AgentEffort;
  /** A chave do OpenRouter do dono (lida a cada turno; ausente = nenhuma configurada). */
  openrouterKey?: () => string | undefined;
  /** O programa relatou custo em dólar num turno de agente (entra no total mostrado na tela Motores). */
  onCost?: (usd: number) => void;
  /**
   * A forma de conta (lida a cada turno). `openrouter` (padrão): a chave do painel, isolado na pasta do Cyno.
   * `program`: a configuração do próprio programa, sem chave nenhuma injetada; `location: "personal"` usa o ~/.openclaw do dono.
   */
  account?: () => OneShotAccount;
  /** O dono quer a cerca de arquivos (Landlock)? Lida a cada turno. Ausente = sem cerca (os testes). Só vale se o computador tem Landlock (`fenceSupport`). */
  fence?: () => boolean;
  /** O que este computador oferece (padrão: a detecção de verdade, uma vez por processo); injetável nos testes. */
  fenceSupport?: () => FenceSupport;
};

/** O que `OPENCLAW_*`/HOME valem para o OpenClaw do Cyno (turnos, detecção e o comando de login do dono). */
export function openclawPaths(homeDir: string): { home: string; stateDir: string; baseConfig: string } {
  return { home: path.join(homeDir, "home"), stateDir: path.join(homeDir, "state"), baseConfig: path.join(homeDir, "openclaw.json") };
}

/**
 * O arquivo de configuração de UM agente: numa pasta de configuração própria (`agent-configs/<hash da pasta de trabalho>`), FORA da pasta de
 * trabalho dele, para que o token do MCP não fique ao alcance das ferramentas de arquivo (que valem só na pasta de trabalho).
 */
export function openclawAgentConfigPath(homeDir: string, cwd: string): string {
  return path.join(homeDir, "agent-configs", createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16), "openclaw.json");
}

/** Arquivos de `/proc/<pid do próprio processo>` que o OpenClaw lê (visto com o programa: sem o `stat` o turno cai em "uv_resident_set_memory: EACCES"). Nunca o `environ`. */
const OPENCLAW_PROC_FILES = ["stat", "statm", "status"];

/** Com a cerca: o temporário de CADA agente (fora da pasta de trabalho, fora da pasta de configuração, que fica só para leitura). */
export function openclawAgentTmpOf(homeDir: string, cwd: string): string {
  return path.join(homeDir, "tmp", path.basename(path.dirname(openclawAgentConfigPath(homeDir, cwd))));
}

/** A configuração base do OpenClaw do Cyno (provedores e modelos que o dono ligou); vazia se não existe ou não é JSON. */
export function readOpenclawBase(homeDir: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(openclawPaths(homeDir).baseConfig, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Ambiente do OpenClaw do Cyno: mínimo (sem as chaves de API do servidor); HOME e estado na pasta própria; e SÓ aqui a chave do
 * OpenRouter do dono (o `sanitizeChildEnv` a tira dos outros motores).
 */
export function openclawEnv(base: NodeJS.ProcessEnv, homeDir: string, openrouterKey?: string, tmpDir?: string): NodeJS.ProcessEnv {
  // `tmpDir` só vem com a cerca. Com ela o programa NÃO se reinicia sozinho (`OPENCLAW_NO_RESPAWN`, achado no código dele): o processo do turno fica sendo o do lançador (o PID
  // não muda no `exec`), e só assim dá para liberar o `/proc/<pid>/stat` dele (o Node mede a memória por ali) sem abrir o `/proc` de todo mundo.
  const paths = openclawPaths(homeDir);
  // Ambiente mínimo: o OpenClaw adota sozinho qualquer chave de provedor que ache no ambiente (com `--no-auth-env-only`), então nada do
  // ambiente do server passa além do necessário para rodar (PATH, idioma, proxy).
  return { ...minimalChildEnv(base, { HOME: paths.home, OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.baseConfig, OPENCLAW_HIDE_BANNER: "1", NO_COLOR: "1", ...(tmpDir ? { TMPDIR: tmpDir, OPENCLAW_NO_RESPAWN: "1" } : {}) }), ...(openrouterKey ? { OPENROUTER_API_KEY: openrouterKey } : {}) };
}

/** O id do OpenRouter vira a referência `provedor/modelo` do OpenClaw. */
export function openclawModelRef(model: string): string {
  return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
}

/**
 * Nome de ferramenta como o resto do Cyno espera: as do servidor "office" viram `mcp__office__<nome>` (o jeito do
 * Claude Code), qualquer que seja o enfeite do programa (`mcp.office.x`, `mcp_office_x`, `office__x`).
 */
export function normalizeToolName(name: string): string {
  const match = /^(?:mcp[._-]+)?office[._-]+(.+)$/.exec(name);
  return match ? `mcp__office__${match[1]}` : name;
}

/**
 * Política de ferramentas (`tools.deny`), conferida com o OpenClaw 2026.11.3 de verdade (a lista de ferramentas que o
 * programa manda ao modelo, gravada pelo provedor falso): grupos em vez de nomes soltos, porque o programa traz dezenas
 * de ferramentas além de `exec` (`terminal`, `portal`, `dashboard`, `sessions_spawn`, `subagents`, `image_generate`…).
 * Sempre fora: `group:ui` (browser, terminal, canvas, portal…), `group:automation` (cron, gateway, plugins…),
 * `group:messaging` (message), `group:nodes`, `group:sessions` (subagentes, envio a outras conversas), `group:media`
 * e `group:agents` (metas, ask_user do programa: o Cyno tem o seu `office__ask_user`), mais `secrets` (a ferramenta de segredos do programa, que aparece junto de `exec`). Com o acesso a terminal desligado
 * sai também `group:runtime` (exec, process, code_execution) e, sem internet, `group:web` (web_search, web_fetch, x_search).
 * Ficam: read, write, edit, apply_patch, ls, memory_*, intent e as ferramentas `office__*` do MCP.
 */
export function openclawDeniedTools(spec: Pick<TerminalSpec, "access">): string[] {
  const denied = ["group:ui", "group:automation", "group:messaging", "group:nodes", "group:sessions", "group:media", "group:agents", "secrets"];
  if (!spec.access?.terminal) denied.push("group:runtime");
  if (!spec.access?.internet) denied.push("group:web");
  return denied;
}

/** A configuração do agente: a base do Cyno (sem o que o dono não escolheu) + o MCP "office" + a política de ferramentas. */
export function openclawAgentConfig(base: Record<string, unknown>, input: { mcpUrl: string; token: string; denied: string[]; /** Arquivos só dentro da pasta de trabalho (padrão: sim). Falso só quando a cerca (Landlock) já prende o agente às pastas de trabalho. */ workspaceOnly?: boolean }): Record<string, unknown> {
  // `toolSearch: false`: sem isso o programa esconde as ferramentas do MCP atrás de tool_search/dispatch_action (visto de verdade:
  // só 10 ferramentas chegam ao modelo e `office__submit_result` não aparece), e o agente teria de procurar para entregar a tarefa.
  const tools = (base.tools ?? {}) as { deny?: unknown; fs?: Record<string, unknown>; exec?: Record<string, unknown> & { applyPatch?: Record<string, unknown> } };
  const deny = [...new Set([...(Array.isArray(tools.deny) ? tools.deny.filter((item): item is string => typeof item === "string") : []), ...input.denied])];
  // Alcance dos arquivos (revisão 2, G1): `read`/`write`/`edit`/`apply_patch` só dentro da pasta de trabalho (`--cwd`). O `agent exec` já faz isso por
  // padrão quando a configuração não diz nada (provado com o programa: caminho absoluto, `..`, /proc/self/environ e links para fora são recusados),
  // mas aqui fica EXPLÍCITO e vence qualquer `tools.fs` da configuração do dono. Pastas de trabalho: o `workspaceOnly` não tem como apontar pastas extras, então só
  // sai (false) quando a cerca de arquivos está valendo e lista as pastas (a cerca passa a ser o limite); sem a cerca, o agente fica preso à pasta dele e as pastas de trabalho não abrem.
  const only = input.workspaceOnly !== false;
  const confined = { ...tools, toolSearch: false, deny, fs: { ...(tools.fs ?? {}), workspaceOnly: only }, exec: { ...(tools.exec ?? {}), applyPatch: { ...(tools.exec?.applyPatch ?? {}), workspaceOnly: only } } };
  if (!input.mcpUrl) return { ...base, tools: confined };
  const mcp = (base.mcp ?? {}) as { servers?: Record<string, unknown> };
  return {
    ...base,
    mcp: { ...mcp, servers: { ...(mcp.servers ?? {}), [OFFICE_MCP_SERVER]: { url: input.mcpUrl, transport: "streamable-http", headers: { Authorization: `Bearer ${input.token}` } } } },
    tools: confined,
  };
}

/** Ambiente do OpenClaw com a configuração do próprio programa: sem chave nenhuma do Cyno e sem as chaves de API do servidor; na pasta pessoal do dono, sem trocar HOME nem estado. */
export function openclawProgramEnv(base: NodeJS.ProcessEnv, homeDir: string, location: OneShotAccount["location"], tmpDir?: string): NodeJS.ProcessEnv {
  if (location === "cyno") return openclawEnv(base, homeDir, undefined, tmpDir);
  return sanitizeChildEnv(base, { OPENCLAW_HIDE_BANNER: "1", NO_COLOR: "1" });
}

export class OpenClawAdapter implements OneShotAdapter {
  readonly provider = "openclaw" as const;
  /** `agent exec` não documenta como retomar uma conversa: cada turno é novo e o Cyno repassa o último trecho. */
  readonly resumable = false;
  /** Lê a configuração base do Cyno (para herdar o modelo escolhido ao ligar a conta); injetável nos testes. */
  constructor(
    private readonly options: OpenClawAdapterOptions,
    private readonly readBase: () => Record<string, unknown> = () => ({}),
  ) {}

  private account(): OneShotAccount {
    return this.options.account?.() ?? DEFAULT_ONE_SHOT_ACCOUNT;
  }

  command(spec: TerminalSpec, turn: { messageFile: string; timeoutSec: number }): { command: string; args: string[] } {
    const paths = openclawPaths(this.options.homeDir);
    const account = this.account();
    const program = account.mode === "program";
    const chosen = spec.model ?? this.options.defaultModel;
    // Com a chave do painel o id é do OpenRouter (vira openrouter/<id>); com a configuração do programa é `provedor/modelo` de qualquer provedor, como veio.
    const model = chosen ? (program ? chosen : openclawModelRef(chosen)) : undefined;
    const thinking = spec.effort ?? this.options.defaultEffort;
    return {
      command: this.options.command ?? "openclaw",
      args: [
        ...(this.options.prefixArgs ?? []),
        "agent",
        "exec",
        "--message-file",
        turn.messageFile,
        "--cwd",
        spec.cwd,
        "--config",
        openclawAgentConfigPath(this.options.homeDir, spec.cwd),
        // Na pasta pessoal do dono o programa usa o estado dele (nada do Cyno é trocado).
        ...(program && account.location === "personal" ? [] : ["--state-dir", paths.stateDir]),
        // Com a configuração do programa as credenciais são as que ele guardou (assinatura, perfis de chave), não só as do ambiente.
        ...(program ? ["--no-auth-env-only"] : []),
        "--timeout",
        String(turn.timeoutSec),
        "--json",
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
      ],
    };
  }

  composeMessage(spec: TerminalSpec, input: { text: string; carried?: string }): string {
    // Sem arquivo de instruções confirmado: o papel e o protocolo do agente vão no começo de cada turno.
    return [spec.systemPrompt.trim(), input.carried, input.text].filter((part): part is string => Boolean(part)).join("\n\n---\n\n");
  }

  agentFiles({ spec, mcpUrl, token }: { spec: TerminalSpec; mcpUrl: string; token: string }): AgentFile[] {
    // Na pasta pessoal do dono o Cyno não lê a configuração dela: o arquivo do agente leva só o MCP "office" e a política de ferramentas.
    const account = this.account();
    const base = account.mode === "program" && account.location === "personal" ? {} : this.readBase();
    const config = openclawAgentConfig(base, { mcpUrl, token, denied: openclawDeniedTools(spec), workspaceOnly: !((spec.folders?.length ?? 0) > 0 && this.fenced(spec)) });
    const file = openclawAgentConfigPath(this.options.homeDir, spec.cwd);
    return [
      { path: file, content: `${JSON.stringify(config, null, 2)}\n`, secret: true },
      // Liga a pasta de configuração ao agente (a varredura apaga a pasta cujo agente já não existe).
      { path: path.join(path.dirname(file), ".cyno-cwd"), content: `${path.resolve(spec.cwd)}\n`, secret: true },
    ];
  }

  env(base: NodeJS.ProcessEnv, spec?: TerminalSpec): NodeJS.ProcessEnv {
    const account = this.account();
    const tmp = spec && this.fenced(spec) ? openclawAgentTmpOf(this.options.homeDir, spec.cwd) : undefined;
    if (account.mode === "program") return openclawProgramEnv(base, this.options.homeDir, account.location, tmp);
    return openclawEnv(base, this.options.homeDir, this.options.openrouterKey?.(), tmp);
  }

  /**
   * A cerca vale (o dono quer, o computador tem Landlock) E o programa roda na pasta do Cyno? Na pasta pessoal do dono (`~/.openclaw`, HOME dele) a lista
   * teria de abrir a pasta pessoal inteira: não há cerca ali (o OpenClaw já prende as ferramentas de arquivo à pasta pelo `tools.fs.workspaceOnly`).
   */
  private fenced(spec?: TerminalSpec): boolean {
    const account = this.account();
    if (account.mode === "program" && account.location === "personal") return false;
    // Com o acesso a terminal ligado o `exec` do OpenClaw precisa ler `/proc/<pid>/stat` e `/proc/<pid>/task/*/children` dos processos que abre para encerrá-los (PIDs que não dá
    // para prever), e liberar isso abriria o `/proc` de todos os processos do usuário (o `environ` deles): visto com o programa, a cerca fechada derruba o turno com "Agent exec
    // cleanup failed". Então, com terminal, o OpenClaw roda SEM cerca (ela vale nos turnos sem terminal, onde o `tools.fs.workspaceOnly` do programa já confina os arquivos).
    if (spec?.access?.terminal) return false;
    return Boolean(this.options.fence?.()) && (this.options.fenceSupport ?? detectFence)().available;
  }

  /**
   * A cerca do agente (veja `fence.ts`): a lista do que pode. Leitura e escrita: a pasta de trabalho, o estado e o HOME isolados do OpenClaw no Cyno (as sessões; são
   * compartilhados entre os agentes do OpenClaw, como já eram) e o temporário do agente. Só leitura: a pasta de configuração DO AGENTE (o `openclaw.json`, com o token
   * do MCP dele), a instalação do programa (a pasta `node_modules` onde ele está e o Node) e o sistema. Fora: o resto do DATA_DIR (chave do OpenRouter, sessões do dono,
   * outros agentes, outros motores), o HOME do dono e as outras pastas; o `/proc` só lista.
   */
  fencePolicy(spec: TerminalSpec): FencePolicy {
    const paths = openclawPaths(this.options.homeDir);
    const exe = resolveExecutable(this.options.command ?? "openclaw", process.env.PATH);
    const node = resolveExecutable("node", process.env.PATH).map((file) => realPathOf(file));
    // Um Node fora do sistema (nvm, volta): a pasta dele (`<prefixo>/bin/node` -> `<prefixo>`).
    const nodePrefix = node.filter((file) => !file.startsWith("/usr/")).map((file) => path.dirname(path.dirname(file)));
    return fencePolicy({
      // `/proc/{pid}`: o PID do lançador não muda no `exec`, então estes arquivos do PRÓPRIO processo (o Node lê o `stat` dele para medir a memória) entram um a um; o `environ` não.
      readOnly: [path.dirname(openclawAgentConfigPath(this.options.homeDir, spec.cwd)), ...readOnlyFolders(spec), ...exe, ...(exe.map((file) => enclosingNodeModules(file)).filter((dir): dir is string => Boolean(dir))), ...node, ...nodePrefix, ...OPENCLAW_PROC_FILES.map((name) => `/proc/{pid}/${name}`)],
      readWrite: [spec.cwd, paths.home, paths.stateDir, openclawAgentTmpOf(this.options.homeDir, spec.cwd), ...writableFolders(spec)],
    });
  }

  fence(spec: TerminalSpec): { policy: FencePolicy; python: string } | undefined {
    if (!this.fenced(spec)) return undefined;
    const python = (this.options.fenceSupport ?? detectFence)().python;
    return python ? { policy: this.fencePolicy(spec), python } : undefined;
  }

  createParser(): OneShotParser {
    return new OpenClawEnvelopeParser(undefined, this.options.onCost);
  }

  /** O `agent exec` recusa um `--state-dir` que não existe; o HOME próprio também precisa estar lá. */
  requiredDirs(spec?: TerminalSpec): string[] {
    const account = this.account();
    // Na pasta pessoal do dono o Cyno não cria nada.
    if (account.mode === "program" && account.location === "personal") return [];
    const paths = openclawPaths(this.options.homeDir);
    return [paths.home, paths.stateDir, ...(spec && this.fenced(spec) ? [openclawAgentTmpOf(this.options.homeDir, spec.cwd)] : [])];
  }

  /** Avisos de rotina que o OpenClaw escreve em stderr a cada turno (vistos de verdade): fim de execução e fechamento do banco de estado. */
  isQuietStderr(line: string): boolean {
    return /^\[agents\/agent-command\] \[agent\] run \S+ ended with stopReason=stop\b/.test(line) || /^\[state\/agent-db\] agent database clean-close receipt: written$/.test(line);
  }

  newSessionId(): string {
    return randomUUID();
  }
}

// ---------- Parser do envelope ----------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** Classe do erro do envelope: o `error.kind` do OpenClaw só diz "exception" (visto), então o texto é que decide. */
export type OpenClawFailure = "no_account" | "no_quota" | "timeout" | "other";

export function classifyOpenClawFailure(message: string, status?: string): OpenClawFailure {
  if (status === "timeout" || /timed? ?out|deadline/i.test(message)) return "timeout";
  if (/authentication source|couldn'?t sign in|sign in again|no (?:[\w-]+ ){0,2}(?:api )?(?:key|credentials?)|missing (?:api )?(?:key|credentials?)|hermes (?:setup|auth add)|not (?:logged|signed)|unauthori[sz]ed|\b401\b|auth.*(?:missing|expired)|credentials? (?:not|missing)/i.test(message)) return "no_account";
  if (/rate.?limit|quota|usage limit|exhausted|\b429\b|insufficient|billing|credit|overloaded/i.test(message)) return "no_quota";
  return "other";
}

/** O 401 "User not found" do OpenRouter: a chave é de gerenciamento (não roda modelos) ou foi apagada. */
export function userNotFoundText(engine: string, original: string): string {
  return `O OpenRouter respondeu "User not found" ao ${engine}: a chave colada é de gerenciamento (serve para administrar outras chaves, não roda modelos) ou foi apagada. No openrouter.ai, em Keys, crie uma chave de API comum e troque a chave em Configurações › Motores › ${engine}. Detalhe do programa: ${shorten(maskSecrets(original), 200)}`;
}

/** Mensagem útil para o dono, por classe de erro (o texto original vai junto). */
export function openclawFailureText(failure: OpenClawFailure, original: string): string {
  switch (failure) {
    case "no_account":
      if (/user not found/i.test(original)) return userNotFoundText("OpenClaw", original);
      return `O OpenClaw não conseguiu entrar na conta: a chave não está configurada ou foi recusada, ou o provedor do modelo não está ligado no programa. Confira em Configurações › Motores › OpenClaw (passo "Conta" e "Verificar"). Detalhe do programa: ${shorten(maskSecrets(original), 200)}`;
    case "no_quota":
      return `O OpenRouter está limitando o OpenClaw agora (sem saldo, ou o limite diário do modelo gratuito acabou). Detalhe do programa: ${shorten(maskSecrets(original), 200)}`;
    case "timeout":
      // O texto do programa manda "aumentar agents.defaults.timeoutSeconds": o prazo aqui é o do Cyno, então esse conselho não vale.
      return "O turno do OpenClaw passou do tempo máximo e foi encerrado.";
    default:
      return shorten(maskSecrets(original) || "O OpenClaw falhou sem dizer o motivo.", 400);
  }
}

/** Aviso de cota para o resto do sistema (o agente espera, como nos outros motores). */
export function openclawQuotaWindow(now: Date, holdMs = 30 * 60_000): UsageWindow {
  return { id: "provider_limit", utilization: 1, status: "rejected", label: "Limite do provedor", resetsAt: new Date(now.getTime() + holdMs).toISOString() };
}

/**
 * O `--json` do `agent exec` é UM envelope (impresso inteiro, possivelmente em várias linhas) no fim do turno:
 * as linhas são juntadas e o envelope lido ao sair. Não há fluxo (sem frase de atividade ao vivo): as
 * chamadas de ferramenta chegam todas de uma vez, pelo `toolSummary`.
 */
export class OpenClawEnvelopeParser implements OneShotParser {
  private lines: string[] = [];

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly onCost?: (usd: number) => void,
  ) {}

  parse(line: string): TerminalEvent[] {
    this.lines.push(line);
    return [];
  }

  takePartialUsage(): TurnUsage | undefined {
    return undefined;
  }

  finish(exit: { code: number | null; stderr: string; timedOut: boolean }): TerminalEvent[] {
    const envelope = this.envelope();
    if (!envelope) {
      if (exit.timedOut) return [{ type: "turn_end", ok: false, result: openclawFailureText("timeout", "") }];
      return []; // o terminal monta o erro com o fim do stderr
    }
    const events: TerminalEvent[] = [];
    const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : undefined;
    const model = [envelope.provider, envelope.model].filter((part): part is string => typeof part === "string" && part !== "").join("/");
    if (sessionId) events.push({ type: "session", sessionId, ...(model ? { model } : {}) });
    const status = typeof envelope.status === "string" ? envelope.status : undefined;
    const final = typeof envelope.final === "string" ? envelope.final : "";
    const usage = this.usage(envelope, model);
    if (usage?.reportedCostUsd) {
      try {
        this.onCost?.(usage.reportedCostUsd);
      } catch {
        // contar o custo nunca derruba o turno
      }
    }
    if (envelope.ok === true && status !== "error" && status !== "timeout") {
      const summary = isObject(envelope.toolSummary) ? envelope.toolSummary : undefined;
      const tools = Array.isArray(summary?.tools) ? summary.tools.filter((tool): tool is string => typeof tool === "string") : [];
      // `toolSummary.unresolvedError.toolName` (visto de verdade): a ferramenta cuja última chamada falhou.
      const failed = isObject(summary?.unresolvedError) && typeof summary.unresolvedError.toolName === "string" ? summary.unresolvedError.toolName : undefined;
      tools.forEach((name, index) => {
        events.push({ type: "tool_use", id: `oc-${index}`, name: normalizeToolName(name) });
        events.push({ type: "tool_result", id: `oc-${index}`, ok: name !== failed });
      });
      if (final) events.push({ type: "text", text: final });
      events.push({ type: "turn_end", ok: true, result: final, ...(usage ? { usage } : {}) });
      return events;
    }
    const error = isObject(envelope.error) ? envelope.error : undefined;
    // Quem decide a classe é só o erro ESTRUTURADO do programa (e a última linha do stderr): o texto da resposta do modelo (`final`) nunca,
    // porque uma resposta normal que fale de "quota" ou "credit" bloquearia o motor inteiro por 30 minutos.
    const structured = typeof error?.message === "string" ? error.message : "";
    const stderrLine = exit.stderr.split("\n").filter(Boolean).at(-1) ?? "";
    const failure = classifyOpenClawFailure(structured || stderrLine, status);
    const message = structured || final || stderrLine;
    if (failure === "no_quota") events.push({ type: "usage", windows: [openclawQuotaWindow(this.now())], status: "rejected" });
    events.push({ type: "turn_end", ok: false, result: openclawFailureText(failure, message), ...(usage ? { usage } : {}) });
    return events;
  }

  private usage(envelope: Json, model: string): TurnUsage | undefined {
    const raw = isObject(envelope.usage) ? envelope.usage : undefined;
    // Visto no programa de verdade: o custo vem em `usage.cost.total` (zero quando o modelo é local ou sem preço).
    const rawCost = isObject(raw?.cost) ? raw.cost.total : envelope.costUsd;
    const cost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : undefined;
    if (!raw && cost === undefined) return undefined;
    const input = num(raw?.input);
    const output = num(raw?.output);
    const total = num(raw?.total);
    return {
      inputTokens: input || (total && !output ? total : 0),
      outputTokens: output,
      cacheReadTokens: num(raw?.cacheRead),
      cacheCreationTokens: num(raw?.cacheWrite),
      ...(model ? { models: [model] } : {}),
      ...(cost !== undefined ? { reportedCostUsd: cost } : {}),
    };
  }

  /** O envelope é o objeto JSON do stdout (pode haver linhas de aviso antes dele). */
  private envelope(): Json | undefined {
    const text = this.lines.join("\n");
    for (const match of text.matchAll(/^\{/gm)) {
      try {
        const value = JSON.parse(text.slice(match.index)) as unknown;
        if (isObject(value) && ("ok" in value || "status" in value)) return value;
      } catch {
        // tenta o próximo "{" no começo de linha
      }
    }
    return undefined;
  }
}
