import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ONE_SHOT_ACCOUNT, maskSecrets, OFFICE_MCP_SERVER, splitModelRef, type OneShotAccount, type TurnUsage } from "@cyno/shared";
import { shorten } from "../../util/text";
import { minimalChildEnv } from "./env";
import { detectFence, fencePolicy, hermesInstallWritables, realPathOf, resolveExecutable, type FencePolicy, type FenceSupport } from "./fence";
import type { GatewaySlots } from "./gateway-slots";
import { classifyOpenClawFailure, userNotFoundText, normalizeToolName, openclawQuotaWindow } from "./openclaw-adapter";
import type { OneShotAdapter, OneShotParser } from "./one-shot-terminal";
import type { AgentFile, TerminalEvent, TerminalSpec } from "./types";

/**
 * Hermes Agent (Nous Research), conferido com o programa de verdade (v0.23.1) e um provedor falso local em 13/11/2026.
 * Formato do `hermes chat --query-file … --oneshot -Q --format stream-json`: `hermes_cli/stream_json.py`.
 *
 * O QUE A REALIDADE MOSTROU (e o desenho que isso pede):
 * - O `chat -q` NÃO roda o agente no processo do turno: ele manda a sessão a um GATEWAY (daemon) do HERMES_HOME, que o próprio
 *   turno sobe se não houver (`gateway run --idle-exit`, ~270 MB, sai sozinho depois de `gateway.unmanaged_idle_exit_seconds`).
 *   Quem lê o config.yaml, o MCP e as chaves é o gateway, com o ambiente de QUANDO ELE SUBIU: uma variável de ambiente por turno
 *   (o token do MCP de cada agente, por exemplo) não chega ao agente de um gateway que já estava no ar, e um HERMES_HOME
 *   compartilhado misturaria os agentes. Por isso cada agente tem o SEU HERMES_HOME (`agent-homes/<hash da pasta>`), com um
 *   config.yaml gerado a cada turno (configuração-base do dono + o MCP "office" com o token do agente + as travas abaixo) e o
 *   `installs` (o ambiente Python, ~400 MB) por link simbólico. Chaves e logins do dono entram por link simbólico (`.env`,
 *   `auth.json`) só com a conta "configuração do programa"; com a chave do painel, só por `OPENROUTER_API_KEY` no ambiente.
 * - O Hermes ADOTA logins de outros programas achados no HOME (o `~/.claude/.credentials.json` do Claude Code faz o provedor
 *   Anthropic aparecer). Fechado em duas camadas: HOME próprio e vazio (`userhome/`) e `auth.adopt_external_logins: false`.
 * - `-t` recusa conjunto que não existe (`invalid_params`); o do MCP é `mcp-<servidor>` (`mcp-office`) e só existe com o servidor
 *   conectado. As ferramentas do MCP só aparecem no modelo com `tools.tool_search.enabled: "off"` (senão ficam atrás de
 *   `tool_search`/`tool_describe`/`tool_call`); aí chegam como `mcp__office__<nome>`. As de arquivo: `read_file`, `write_file`,
 *   `patch`, `search_files`.
 * - O id da sessão vem no evento `result.session_id` (`local-<hash>`); o `system init` traz `session_id: ""`. `--resume <id>`
 *   continua a conversa (o mesmo id volta); id que não existe: "No session found matching '…'".
 * - A chave do OpenRouter só pelo ambiente chega ao gateway no momento em que ele sobe (`OPENROUTER_API_KEY` é herdada; uma
 *   variável de nome livre, como `FAKE_KEY`, não). Trocar a chave vale quando o gateway ocioso sair (60 s, definido abaixo).
 * - O `result` traz só tokens (input, output, total, cache_read, cache_write), sem custo.
 */

export type HermesAdapterOptions = {
  /** Executável (nos testes: o node com a CLI falsa). */
  command?: string;
  prefixArgs?: string[];
  /** Pasta própria do Hermes no Cyno: `home/` é onde o dono liga a conta; cada agente usa um HERMES_HOME derivado dele (`agent-homes/…`). */
  homeDir: string;
  /** Modelo padrão da plataforma (id do OpenRouter, Configurar). */
  defaultModel?: string;
  /** A chave do OpenRouter do dono (lida a cada turno; ausente = nenhuma configurada). */
  openrouterKey?: () => string | undefined;
  /** A forma de conta (lida a cada turno). Padrão: a chave do painel, isolado na pasta do Cyno. `program`: a configuração do próprio programa, sem chave injetada. */
  account?: () => OneShotAccount;
  /** O HERMES_HOME pessoal do dono (`~/.hermes`): só usado com `account.location: "personal"`. */
  personalHome?: string;
  /** O teto de gateways simultâneos (compartilhado por todos os agentes do Hermes); ausente = sem teto (testes). */
  slots?: GatewaySlots;
  /** O dono quer a cerca de arquivos (Landlock)? Lida a cada turno. Ausente = sem cerca (os testes). Só vale se o computador tem Landlock (`fenceSupport`). */
  fence?: () => boolean;
  /** O que este computador oferece (padrão: a detecção de verdade, uma vez por processo); injetável nos testes. */
  fenceSupport?: () => FenceSupport;
};

/** O HERMES_HOME do Cyno. */
export function hermesHomeOf(homeDir: string): string {
  return path.join(homeDir, "home");
}

/**
 * O HOME do processo do Hermes: vazio, dentro da pasta do Cyno. O Hermes adota sozinho logins de outros programas achados no
 * HOME (visto de verdade: `~/.claude/.credentials.json` do Claude Code faz o provedor Anthropic aparecer, e há também
 * `~/.codex/auth.json` e `~/.qwen`). Com um HOME próprio e vazio nada disso é achado.
 */
export function hermesUserHome(homeDir: string): string {
  return path.join(homeDir, "userhome");
}

/** O HERMES_HOME de UM agente (veja o comentário do topo): estável para a mesma pasta de trabalho. */
export function hermesAgentHomeOf(homeDir: string, cwd: string): string {
  return path.join(homeDir, "agent-homes", createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16));
}

/** Com a cerca: o temporário e o HOME de CADA agente ficam dentro do HERMES_HOME dele (o `/tmp` e o HOME compartilhado ficam fora da cerca). */
export const hermesAgentTmpOf = (agentHome: string) => path.join(agentHome, "tmp");
export const hermesFencedHomeOf = (agentHome: string) => path.join(agentHome, "userhome");

/**
 * Ambiente do Hermes: MÍNIMO (PATH, idioma, proxy; nenhuma chave de provedor do server nem variável de sessão de outro programa),
 * HERMES_HOME do agente e HOME vazio, e SÓ aqui a chave do OpenRouter do dono (o gateway a herda quando sobe).
 */
export function hermesEnv(base: NodeJS.ProcessEnv, homeDir: string, agentHome: string, openrouterKey?: string, fenced = false): NodeJS.ProcessEnv {
  // Com a cerca o HOME e o TMPDIR são do agente (dentro do HERMES_HOME dele): o único lugar fora da pasta de trabalho onde ele grava.
  const own: Record<string, string> = fenced ? { HOME: hermesFencedHomeOf(agentHome), TMPDIR: hermesAgentTmpOf(agentHome) } : { HOME: hermesUserHome(homeDir) };
  return { ...minimalChildEnv(base, { HERMES_HOME: agentHome, NO_COLOR: "1", ...own }), ...(openrouterKey ? { OPENROUTER_API_KEY: openrouterKey } : {}) };
}

// ---------- config.yaml gerado (texto, sem biblioteca de YAML) ----------

const topKey = (line: string) => /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
const isBlankOrComment = (line: string) => /^\s*(#.*)?$/.test(line);

/** Tira uma seção de primeiro nível (e tudo que está dentro dela). */
export function yamlDropSection(text: string, section: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const key = topKey(line);
    if (key) inside = key[1] === section;
    if (!inside) out.push(line);
  }
  return out.join("\n");
}

/**
 * Garante `section.key` com o corpo dado (linhas já com a profundidade RELATIVA: `[0, "enabled: \"off\""]`): troca o que o dono já tinha
 * nessa chave, mantém o resto da seção e cria a seção se não existe. Seção em estilo inline (`tools: {}`) é substituída.
 */
export function yamlSetNested(text: string, section: string, key: string, body: [number, string][]): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => topKey(line)?.[1] === section);
  const render = (unit: string) => body.map(([depth, content]) => `${unit}${"  ".repeat(depth)}${content}`);
  if (start === -1) return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${section}:\n${render("  ").join("\n")}\n`;
  let end = start + 1;
  while (end < lines.length && (isBlankOrComment(lines[end]!) || /^\s/.test(lines[end]!))) end += 1;
  const rest = (topKey(lines[start]!)?.[2] ?? "").replace(/#.*/, "").trim();
  const children = lines.slice(start + 1, end);
  const unit = rest ? "  " : (/^(\s+)\S/.exec(children.find((line) => !isBlankOrComment(line)) ?? "")?.[1] ?? "  ");
  const kept: string[] = [];
  let skipping = false;
  for (const line of rest ? [] : children) {
    const own = new RegExp(`^${unit}${key}\\s*:`).test(line);
    const deeper = line.startsWith(unit) && /^\s/.test(line.slice(unit.length)) && !/^\S/.test(line);
    if (own) {
      skipping = true;
      continue;
    }
    if (skipping && (deeper || isBlankOrComment(line))) continue;
    skipping = false;
    kept.push(line);
  }
  return [...lines.slice(0, start), `${section}:`, ...render(unit), ...kept, ...lines.slice(end)].join("\n");
}

/**
 * O config.yaml do agente: a configuração-base (a do dono: provedor, modelo, `providers:`) SEM o `mcp_servers` dela (o agente
 * só tem as ferramentas do escritório, nunca as do dono), com as travas do Cyno e o MCP "office" com o token DESTE agente.
 * Travas: `auth.adopt_external_logins: false` (não adotar logins do Claude Code/Codex), `tools.tool_search.enabled: "off"` (as
 * ferramentas do MCP chegam ao modelo com o nome próprio em vez de atrás de tool_search) e `gateway.unmanaged_idle_exit_seconds`
 * (o gateway do agente sai logo depois do último turno: libera memória e deixa uma troca de chave valer), `model_catalog.enabled: false` e
 * `updates.check: false` (sem consultas a hosts da Nous e do GitHub).
 */
export function hermesAgentConfig(base: string, input: { mcpUrl: string; token: string }): string {
  let text = yamlDropSection(base, "mcp_servers");
  text = yamlSetNested(text, "auth", "adopt_external_logins", [[0, "adopt_external_logins: false"]]);
  text = yamlSetNested(text, "tools", "tool_search", [[0, "tool_search:"], [1, 'enabled: "off"']]);
  text = yamlSetNested(text, "gateway", "unmanaged_idle_exit_seconds", [[0, "unmanaged_idle_exit_seconds: 60"]]);
  // Sem consultas externas que não sejam o provedor: o catálogo de modelos (hermes-agent.nousresearch.com e raw.githubusercontent.com)
  // e a checagem de versão (visto com um proxy que recusa tudo: o Hermes tentava esses hosts a cada subida do gateway).
  text = yamlSetNested(text, "model_catalog", "enabled", [[0, "enabled: false"]]);
  text = yamlSetNested(text, "updates", "check", [[0, "check: false"]]);
  if (input.mcpUrl) text = `${text}${text.endsWith("\n") ? "" : "\n"}mcp_servers:\n  ${OFFICE_MCP_SERVER}:\n    url: ${JSON.stringify(input.mcpUrl)}\n    headers:\n      Authorization: ${JSON.stringify(`Bearer ${input.token}`)}\n`;
  return text;
}

/**
 * Conjuntos de ferramentas (`-t`) conforme o acesso: arquivos + o MCP do escritório; terminal e internet só se liberados.
 * Conferido com o Hermes v0.23.1: `-t` recusa um nome de conjunto que não existe (`invalid_params`), e `mcp-office` só existe
 * quando o servidor "office" está no config.yaml, isto é, nos turnos com MCP (`spec.mcp`); o turno de teste do Verificar não tem.
 */
export function hermesToolsets(spec: Pick<TerminalSpec, "access" | "mcp">): string[] {
  return ["file", ...(spec.mcp ? [`mcp-${OFFICE_MCP_SERVER}`] : []), ...(spec.access?.terminal ? ["terminal"] : []), ...(spec.access?.internet ? ["web"] : [])];
}

export class HermesAdapter implements OneShotAdapter {
  readonly provider = "hermes" as const;
  readonly resumable = true;

  constructor(private readonly options: HermesAdapterOptions) {}

  private account(): OneShotAccount {
    return this.options.account?.() ?? DEFAULT_ONE_SHOT_ACCOUNT;
  }

  private personal(): boolean {
    const account = this.account();
    return account.mode === "program" && account.location === "personal";
  }

  command(spec: TerminalSpec, turn: { messageFile: string; resumeSessionId?: string }): { command: string; args: string[] } {
    const chosen = spec.model ?? this.options.defaultModel;
    const program = this.account().mode === "program";
    // Chave do painel: o modelo é do OpenRouter. Configuração do programa: `provedor/modelo` de qualquer provedor (sem modelo, vale o padrão do programa).
    const split = program && chosen ? splitModelRef(chosen) : undefined;
    const model = program ? (split ? split.model : chosen) : chosen?.replace(/^openrouter\//, "");
    return {
      command: this.options.command ?? "hermes",
      args: [
        ...(this.options.prefixArgs ?? []),
        "chat",
        "--query-file",
        turn.messageFile,
        "--oneshot",
        "-Q",
        "--format",
        "stream-json",
        "-t",
        hermesToolsets(spec).join(","),
        // Sem ninguém para aprovar comandos: a política é a dos conjuntos de ferramentas acima.
        "--yolo",
        ...(program ? (split ? ["--provider", split.provider] : []) : ["--provider", "openrouter"]),
        ...(model ? ["-m", model] : []),
        ...(turn.resumeSessionId ? ["--resume", turn.resumeSessionId] : []),
      ],
    };
  }

  composeMessage(_spec: TerminalSpec, input: { text: string }): string {
    // As instruções do agente vão no AGENTS.md da pasta (o Hermes o carrega da pasta de trabalho).
    return input.text;
  }

  /** A pasta onde o dono liga a conta: a pessoal (`~/.hermes`) ou a do Cyno. A configuração dela é LIDA, nunca escrita. */
  private sourceHome(): string {
    return this.personal() && this.options.personalHome ? this.options.personalHome : hermesHomeOf(this.options.homeDir);
  }

  agentHome(spec: TerminalSpec): string {
    return hermesAgentHomeOf(this.options.homeDir, spec.cwd);
  }

  agentFiles({ spec, mcpUrl, token }: { spec: TerminalSpec; mcpUrl: string; token: string }): AgentFile[] {
    const configFile = path.join(this.sourceHome(), "config.yaml");
    const base = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
    return [
      { path: path.join(spec.cwd, "AGENTS.md"), content: `${spec.systemPrompt}\n` },
      // Liga a pasta de motor ao agente (a varredura apaga a pasta cujo agente já não existe).
      { path: path.join(this.agentHome(spec), ".cyno-cwd"), content: `${path.resolve(spec.cwd)}\n`, secret: true },
      // O token do agente vai no arquivo do agente (0600), como o openclaw.json do OpenClaw.
      { path: path.join(this.agentHome(spec), "config.yaml"), content: hermesAgentConfig(base, { mcpUrl, token }), secret: true },
    ];
  }

  env(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv {
    const program = this.account().mode === "program";
    return hermesEnv(base, this.options.homeDir, this.agentHome(spec), program ? undefined : this.options.openrouterKey?.(), this.fenced());
  }

  /** A cerca está valendo (o dono quer E o computador tem Landlock)? */
  private fenced(): boolean {
    return Boolean(this.options.fence?.()) && (this.options.fenceSupport ?? detectFence)().available;
  }

  /**
   * A cerca do agente (veja `fence.ts`): a lista do que pode. Leitura e escrita: a pasta de trabalho, o HERMES_HOME do agente (sessões, estado, o temporário e o
   * HOME dele) e, dentro da instalação do Hermes, só as travas e as pastas `.leases` (o programa as grava em cada execução). Só leitura: a instalação do Hermes
   * (`hermes-agent`, `tools` e `installs` da pasta de origem), o executável, o sistema e, só na conta "configuração do programa", as duas credenciais do dono
   * que o programa precisa ler (`.env` e `auth.json`). Fora: todo o resto do DATA_DIR (chave do OpenRouter, sessões, tokens e pastas dos outros agentes, configuração
   * dos outros motores), o HOME do dono e as outras pastas. O `/proc` só lista (os PIDs): `/proc/<pid>/environ`, onde mora a chave no ambiente do gateway, fica fechado.
   */
  fencePolicy(spec: TerminalSpec): FencePolicy {
    const source = this.sourceHome();
    const installs = path.join(source, "installs");
    // O código (`hermes-agent`, `tools`) mora ao lado de `installs`; se `installs` é um link (como num HERMES_HOME montado à parte), vale a pasta de verdade dele.
    const roots = [...new Set([source, path.dirname(realPathOf(installs))])];
    const writable = hermesInstallWritables(installs);
    const credentials = this.account().mode === "program" ? [".env", "auth.json"].map((name) => path.join(source, name)).filter((file) => existsSync(file)) : [];
    return fencePolicy({
      readOnly: [...roots.flatMap((root) => [path.join(root, "hermes-agent"), path.join(root, "tools")]), installs, ...resolveExecutable(this.options.command ?? "hermes", process.env.PATH), ...credentials],
      readWrite: [spec.cwd, this.agentHome(spec), ...writable.files, ...writable.dirs],
    });
  }

  fence(spec: TerminalSpec): { policy: FencePolicy; python: string } | undefined {
    if (!this.fenced()) return undefined;
    const python = (this.options.fenceSupport ?? detectFence)().python;
    return python ? { policy: this.fencePolicy(spec), python } : undefined;
  }

  /**
   * O gateway do agente (veja o comentário do topo) foi iniciado com o config.yaml e a chave de ANTES: se o token do MCP mudou (o
   * servidor do Cyno reiniciou, o terminal foi recriado) ou a chave do OpenRouter foi trocada, o gateway que ainda estiver no ar
   * (até 60 s depois do último turno) responderia com o estado velho (visto de verdade: a entrega falhou com "MCP call failed"). Então,
   * quando a impressão digital (config + chave + cerca ligada ou não, só o hash) muda, o gateway deste HERMES_HOME é encerrado e o turno sobe um novo.
   */
  async beforeTurn(spec: TerminalSpec): Promise<void> {
    const home = this.agentHome(spec);
    const key = this.account().mode === "program" ? "" : (this.options.openrouterKey?.() ?? "");
    const config = await readFile(path.join(home, "config.yaml"), "utf8").catch(() => "");
    // A cerca entra na impressão digital: o gateway herda (ou não) a cerca de quem o subiu, então ligar ou desligar a opção troca o gateway no turno seguinte.
    const fingerprint = createHash("sha256").update(config).update("\0").update(key).update(this.fenced() ? "\0cerca" : "").digest("hex").slice(0, 24);
    const file = path.join(home, ".cyno-launch");
    const previous = await readFile(file, "utf8").catch(() => "");
    if (previous.trim() === fingerprint) return;
    await stopGateway(home);
    await writeFile(file, `${fingerprint}\n`, { mode: 0o600 });
  }

  /** Uma vaga de gateway: quem passa do teto espera, e o terminal do agente mostra "esperando vaga no Hermes". */
  async acquireSlot(spec: TerminalSpec, input: { signal: AbortSignal; onWait: (reason: string) => void }): Promise<(() => Promise<void>) | undefined> {
    const slots = this.options.slots;
    if (!slots) return undefined;
    const release = await slots.acquire({
      signal: input.signal,
      onWait: ({ inUse, cap, position }) => input.onWait(`Esperando vaga no Hermes: ${inUse} de ${cap} ${cap === 1 ? "gateway em uso" : "gateways em uso"} (${position}º da fila).`),
    });
    if (!release) return undefined;
    const home = this.agentHome(spec);
    return async () => {
      // Quem espera precisa da memória: o gateway deste agente não fica ocioso por 60 s, sai agora (o próximo turno dele sobe outro).
      if (slots.waiting() > 0) await stopGateway(home).catch(() => undefined);
      release();
    };
  }

  /** Depois de cortar um turno (interromper, parar, tempo máximo): o gateway do agente continuaria o trabalho sozinho, então sai também. O turno seguinte sobe um novo. */
  async afterCut(spec: TerminalSpec): Promise<void> {
    await stopGateway(this.agentHome(spec));
  }

  /** O HERMES_HOME do agente e o HOME vazio precisam existir antes do primeiro turno. */
  requiredDirs(spec: TerminalSpec): string[] {
    const home = this.agentHome(spec);
    return this.fenced() ? [home, hermesAgentTmpOf(home), hermesFencedHomeOf(home)] : [home, hermesUserHome(this.options.homeDir)];
  }

  /**
   * Links do HERMES_HOME do agente: o ambiente Python (`installs`, ~400 MB, não se copia) e, só com a conta "configuração do programa",
   * as chaves e logins que o dono ligou (`.env`, `auth.json`). Com a chave do painel nenhuma credencial do dono entra.
   */
  links(spec: TerminalSpec): { path: string; target: string }[] {
    const source = this.sourceHome();
    const home = this.agentHome(spec);
    const names = ["installs", ...(this.account().mode === "program" ? [".env", "auth.json"] : [])];
    return names.filter((name) => existsSync(path.join(source, name))).map((name) => ({ path: path.join(home, name), target: path.join(source, name) }));
  }

  createParser(): OneShotParser {
    return new HermesStreamParser();
  }

  newSessionId(): string {
    return randomUUID();
  }

  /** O Hermes repete o id da sessão em stderr no fim de cada turno (`Session: …` e `session_id: …`): rotina, não erro. */
  isQuietStderr(line: string): boolean {
    return /^(Session|session_id):\s/.test(line);
  }

  isMissingSession(text: string): boolean {
    // Só a mensagem exata que o programa de verdade dá (visto): "No session found matching 'x'. Use 'hermes sessions list'…". Qualquer outro
    // texto com "session" (um erro de rede, um aviso do modelo) NÃO zera a sessão: a conversa seguiria sem o resumo.
    return /(?:^|\n)\s*No session found matching '/.test(text);
  }
}

/** Os processos (menos este) cujo ambiente tem `HERMES_HOME=<pasta>` e a pasta passa no teste: é assim que se acha o gateway e o que ele abriu, pelo CAMINHO, nunca pelo nome do processo. */
async function processesOfHermesHome(match: (home: string) => boolean): Promise<number[]> {
  const found: number[] = [];
  const names = await readdir("/proc").then(
    (entries) => entries.filter((name) => /^\d+$/.test(name)),
    () => undefined,
  );
  if (!names) return found;
  for (const name of names) {
    const pid = Number(name);
    if (pid <= 1 || pid === process.pid) continue;
    try {
      const entry = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").find((item) => item.startsWith("HERMES_HOME="));
      if (entry && match(entry.slice("HERMES_HOME=".length))) found.push(pid);
    } catch {
      // processo de outro usuário ou que já saiu
    }
  }
  return found;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Manda o sinal ao processo e ao grupo dele (o gateway é destacado: líder do próprio grupo, com as ferramentas que abriu). */
function signalHermes(pid: number, signal: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      // sem grupo ou já saiu
    }
  }
}

async function stopMatching(match: (home: string) => boolean, graceMs: number): Promise<void> {
  const pids = await processesOfHermesHome(match);
  if (pids.length === 0) return;
  for (const pid of pids) signalHermes(pid, "SIGTERM");
  // Espera sair (o gateway publica "draining" e fecha o banco); passado o prazo, SIGKILL no que ficou.
  for (let waited = 0; waited < graceMs && pids.some(alive); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of pids) if (alive(pid)) signalHermes(pid, "SIGKILL");
}

/** Encerra o gateway (daemon) do HERMES_HOME dado e o que ele abriu, se houver no ar (identificado pelo HERMES_HOME do processo). */
export async function stopGateway(home: string, graceMs = 5000): Promise<void> {
  await stopMatching((candidate) => candidate === home, graceMs);
}

/** Encerra todos os gateways das pastas `agent-homes/` de um Hermes do Cyno (no início do servidor, para os que sobraram de uma queda, e no fechamento). */
export async function stopAllGateways(homeDir: string, graceMs = 5000): Promise<void> {
  // Sem pasta de agentes não há gateway nenhum: nem varre o /proc.
  if (!existsSync(path.join(homeDir, "agent-homes"))) return;
  const prefix = path.join(homeDir, "agent-homes") + path.sep;
  await stopMatching((candidate) => candidate.startsWith(prefix), graceMs);
}

// ---------- Parser do --format stream-json ----------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Linhas do `hermes chat -q … --format stream-json` (stream_json.py): `{type:"system",subtype:"init",model,session_id}`,
 * `{type:"text",text}` (pedaços), `{type:"tool_use",name,tool_call_id?,input?}`, `{type:"tool_result",name,tool_call_id?,
 * output,duration_ms,is_error}` e UM `{type:"result",session_id,exit_code,text,tokens{input,output,total,cache_read,
 * cache_write},duration_ms,error?}`. Os pedaços de texto são juntados e saem inteiros antes da próxima ferramenta e
 * no fim do turno (um `text` por pedaço encheria o registro).
 */
export class HermesStreamParser implements OneShotParser {
  private pending = "";
  private toolIndex = 0;
  private openTools: string[] = [];
  private ended = false;
  private tokens: TurnUsage | undefined;

  constructor(private readonly now: () => Date = () => new Date()) {}

  takePartialUsage(): TurnUsage | undefined {
    return undefined;
  }

  parse(line: string): TerminalEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObject(data)) return [];
    switch (data.type) {
      case "system":
        return data.subtype === "init" && str(data.session_id) ? [{ type: "session", sessionId: str(data.session_id)!, ...(str(data.model) ? { model: str(data.model)! } : {}) }] : [];
      case "text":
        if (typeof data.text === "string") this.pending += data.text;
        return [];
      case "tool_use": {
        const id = str(data.tool_call_id) ?? `hm-${this.toolIndex++}`;
        const name = normalizeToolName(str(data.name) ?? "unknown");
        this.openTools.push(id);
        return [...this.flushText(), { type: "tool_use", id, name, ...(isObject(data.input) ? { input: data.input } : {}) }];
      }
      case "tool_result": {
        const id = str(data.tool_call_id) ?? this.openTools.shift() ?? `hm-${this.toolIndex++}`;
        this.openTools = this.openTools.filter((open) => open !== id);
        return [{ type: "tool_result", id, ok: data.is_error !== true, ...(typeof data.output === "string" && data.output ? { output: data.output } : {}) }];
      }
      case "result":
        return this.result(data);
      default:
        return [];
    }
  }

  private flushText(): TerminalEvent[] {
    if (!this.pending.trim()) {
      this.pending = "";
      return [];
    }
    const text = this.pending;
    this.pending = "";
    return [{ type: "text", text }];
  }

  private result(data: Json): TerminalEvent[] {
    this.ended = true;
    const events = this.flushText();
    const sessionId = str(data.session_id);
    if (sessionId) events.push({ type: "session", sessionId });
    const raw = isObject(data.tokens) ? data.tokens : undefined;
    const usage: TurnUsage | undefined = raw
      ? { inputTokens: num(raw.input), outputTokens: num(raw.output), cacheReadTokens: num(raw.cache_read), cacheCreationTokens: num(raw.cache_write), ...(num(data.duration_ms) ? { durationMs: num(data.duration_ms) } : {}) }
      : undefined;
    const text = str(data.text) ?? "";
    const error = str(data.error);
    const exitCode = typeof data.exit_code === "number" ? data.exit_code : 0;
    if (exitCode === 0 && !error) {
      events.push({ type: "turn_end", ok: true, result: text, ...(usage ? { usage } : {}) });
      return events;
    }
    // Só o erro estruturado classifica; `text` é a resposta do modelo (uma palavra como "quota" nela não bloqueia o motor).
    const message = error ?? text;
    const failure = classifyOpenClawFailure(error ?? "");
    if (failure === "no_quota") events.push({ type: "usage", windows: [openclawQuotaWindow(this.now())], status: "rejected" });
    events.push({ type: "turn_end", ok: false, result: hermesFailureText(failure, message || `O Hermes terminou com código ${exitCode}.`), ...(usage ? { usage } : {}) });
    return events;
  }

  finish(exit: { stderr: string; timedOut: boolean }): TerminalEvent[] {
    if (this.ended) return [];
    // Saiu sem o `result` (erro antes de montar o agente, argumento recusado…): o que o stderr disser, em português simples.
    const events = this.flushText();
    if (exit.timedOut) return events;
    const last = exit.stderr.split("\n").filter(Boolean).at(-1) ?? "";
    const failure = classifyOpenClawFailure(last);
    if (failure === "other" && !last.trim()) return events;
    events.push({ type: "turn_end", ok: false, result: hermesFailureText(failure, last) });
    return events;
  }
}

export function hermesFailureText(failure: ReturnType<typeof classifyOpenClawFailure>, original: string): string {
  switch (failure) {
    case "no_account":
      if (/user not found/i.test(original)) return userNotFoundText("Hermes", original);
      return `O Hermes não conseguiu entrar na conta: a chave não está configurada ou foi recusada, ou o provedor do modelo não está ligado no programa. Confira em Configurações › Motores › Hermes (passo "Conta" e "Verificar"). Detalhe do programa: ${shorten(maskSecrets(original), 200)}`;
    case "no_quota":
      return `O OpenRouter está limitando o Hermes agora (sem saldo, ou o limite diário do modelo gratuito acabou). Detalhe do programa: ${shorten(maskSecrets(original), 200)}`;
    case "timeout":
      return `O turno do Hermes passou do tempo máximo. ${shorten(maskSecrets(original), 200)}`.trim();
    default:
      return shorten(maskSecrets(original) || "O Hermes falhou sem dizer o motivo.", 400);
  }
}
