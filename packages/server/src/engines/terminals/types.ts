import type { ToolsWait } from "../../mcp/tokens";
import type { AgentEffort, EffectiveAccess, EffectiveFolder, WorkspaceAccess, AgentProvider, RemoteControlInfo, SubagentChoice, TerminalStatus, TurnUsage, UsageWindow } from "@cyno/shared";

/**
 * Evento neutro de provedor que um terminal emite (o adaptador de cada CLI traduz as linhas do
 * processo nisto; veja terminalLogBridge para o caminho até o log de trabalho).
 * `thread`: o evento veio de um subagente (id da chamada que o criou; ausente = o próprio agente).
 */
export type TerminalEvent =
  /** `reason`: por que parou (só em "stopped": "Parado por ociosidade", "Parado pelo usuário"…). */
  | { type: "status"; status: TerminalStatus; error?: string; reason?: string }
  /** Sessão da CLI conhecida (init): id, modelo, ferramentas e servidores MCP. */
  | { type: "session"; sessionId: string; model?: string; tools?: string[]; mcpServers?: { name: string; status: string }[]; apiKeySource?: string }
  /**
   * Começou o turno `tag` (uma mensagem nossa foi escrita no processo). No terminal interativo do
   * Maestro um turno também pode vir de alguém digitando nele (ou pelo Remote Control): aí não há
   * `tag` e `prompt` traz o que foi pedido.
   */
  | { type: "turn_start"; tag?: string; prompt?: string }
  | { type: "text"; text: string; thread?: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown>; thread?: string }
  | { type: "tool_result"; id: string; ok: boolean; output?: string; thread?: string }
  /** `model`: o modelo com que o subagente roda (o que o agente pediu ou o padrão dos subagentes), se souber. */
  | { type: "subagent_start"; id: string; label: string; goal: string; model?: string; thread?: string }
  | { type: "subagent_end"; id: string; ok: boolean; result?: string }
  /**
   * Fim do turno `tag` (o evento final da CLI): texto final, se deu erro e os tokens do turno (se a CLI disser).
   * `contextTokens`: tamanho estimado da conversa no fim do turno (prompt da última chamada ao modelo: entrada + cache).
   */
  | { type: "turn_end"; tag?: string; ok: boolean; result: string; usage?: TurnUsage; contextTokens?: number; queuedTurns?: number }
  /**
   * Um `result` da CLI que NÃO fecha o turno nosso: uma nota injetada no meio do turno ainda está na
   * fila da CLI (`queued_turn_count` > 0) e vira a continuação do mesmo turno. Só conta os tokens.
   */
  | { type: "turn_partial"; usage?: TurnUsage }
  /**
   * O turno `tag` foi CORTADO (cancelado, terminal parado ou caído) sem o evento final da CLI: os
   * tokens que ela já tinha informado até o corte (J2-09). O histórico grava como gasto parcial.
   */
  | { type: "turn_cut"; tag?: string; usage: TurnUsage; reason: string }
  /** Uma mensagem nossa foi descartada sem resposta (terminal parado ou desistiu de subir). */
  | { type: "dropped"; tag?: string; reason: string }
  | { type: "raw"; stream: "stdout" | "stderr"; text: string }
  /** Uso da assinatura informado pela CLI (no Claude Code, rate_limit_event). Não vira log. */
  | { type: "usage"; windows: UsageWindow[]; status?: string }
  /** Remote Control do terminal interativo mudou (subiu, caiu, ganhou o link). Não vira log. */
  | { type: "remote"; remote: RemoteControlInfo };

export type TerminalListener = (event: TerminalEvent) => void;

/**
 * Espera a CLI que vai subir agora conectar no MCP do escritório (initialize + tools/list), com um
 * teto. O terminal chama logo antes de cada subida e só manda a primeira mensagem quando `done`
 * resolve: mandada antes, ela iria sem as ferramentas do escritório (e com outro prefixo de prompt,
 * sem o cache). "timeout" = manda assim mesmo.
 */
export type ToolsGate = () => ToolsWait;

/**
 * `freshSession`: esta mensagem começa uma conversa nova da CLI (sessão nova; o processo sobe de novo
 * se a sessão atual já tem histórico). As mensagens seguintes sem a opção continuam nessa conversa.
 * `sessionKey` (padrão: a tag): se a sessão atual foi aberta com a mesma chave, ela continua (ex.: a
 * mesma tarefa rodando de novo depois de um reinício do server).
 */
export type SendOptions = { freshSession?: boolean; sessionKey?: string };

/**
 * Terminal de um agente: um processo de CLI de assinatura, de vida longa, esperando ordens.
 * Contrato: `send` nunca bloqueia (as mensagens entram numa fila e vão uma por turno, quando o
 * processo está ocioso; se ele está parado, sobe sozinho retomando a sessão salva).
 */
export interface TerminalAgent {
  readonly agentId: string;
  readonly provider: AgentProvider;
  status(): TerminalStatus;
  sessionId(): string | undefined;
  lastError(): string | undefined;
  /** Chave da conversa atual da CLI, se ela já tem histórico (o id da tarefa, "conversa"…). */
  currentSessionKey?(): string | undefined;
  /**
   * A conversa que a próxima mensagem continua já tem histórico (completou um turno)? Lê o
   * session.json se o processo ainda não subiu. false = a próxima mensagem abre uma conversa nova.
   */
  hasHistory?(): Promise<boolean>;
  /** Sobe o processo (retomando a sessão) se ele não estiver vivo. */
  ensureRunning(): Promise<void>;
  /** Põe uma mensagem do "usuário" na fila da sessão viva. `tag` volta em turn_start/turn_end/dropped. */
  send(message: string, tag?: string, options?: SendOptions): void;
  /**
   * Nota no meio do turno: escreve a mensagem já, enquanto a CLI trabalha (ela entra no turno em curso
   * ou logo depois dele, na mesma tag). Devolve false se não deu (terminal não está ocupado ou a CLI
   * não aceita entrada ao vivo): aí quem chamou manda com `send` (vai no próximo limite de turno).
   */
  inject?(message: string): boolean;
  /** Tira da fila as mensagens ainda não enviadas com esta `tag` (devolve o texto delas, na ordem). */
  cancel(tag: string): string[];
  /** Interrompe o turno em curso (sem matar o processo, se a CLI souber). */
  interrupt(): void;
  /** Para com calma (fecha a entrada), depois SIGTERM e por fim SIGKILL. A sessão continua salva. */
  stop(reason?: string): Promise<void>;
  onEvent(listener: TerminalListener): () => void;
}

/** O que o adaptador precisa saber para subir o processo de um agente. */
export type TerminalSpec = {
  agentId: string;
  /** Pasta do agente (cwd do processo): data/workspaces/<ws>/agents/<agentId>/. */
  cwd: string;
  /** Instruções do agente (papel, time, ferramentas, protocolo), também gravadas na pasta (CLAUDE.md, GEMINI.md…). */
  systemPrompt: string;
  /** Arquivo com a configuração MCP no formato do Claude Code (servidor "office" com o token do agente). */
  mcpConfigFile: string;
  model?: string;
  effort?: AgentEffort;
  /** Ferramentas embutidas liberadas (padrão: Read, Write, Edit, Glob, Grep; agentes de time ganham também a de subagente). */
  tools: string[];
  /**
   * Acesso desta subida (o do workspace E o do agente). Ausente = nada além de arquivos e do
   * escritório. Claude Code: internet = WebSearch/WebFetch, terminal = Bash; Antigravity: internet =
   * ler URL (`read_url`), terminal = `command`. O navegador embutido das CLIs nunca.
   */
  access?: TerminalAccess;
  /**
   * Pastas de trabalho desta subida (as do workspace E do agente que existem no disco; veja `effectiveFolders`
   * em shared). O cwd continua sendo a pasta do agente: estas são pastas EXTRAS que o motor libera (ou só
   * descreve nas instruções, onde não consegue limitar). Ausente = nenhuma.
   */
  folders?: EffectiveFolder[];
  /**
   * Padrão dos subagentes internos da CLI (do workspace do agente, `subagentes`): no Claude Code vai
   * em CLAUDE_CODE_SUBAGENT_MODEL/EFFORT; no Antigravity, nas instruções (o agy não tem flag para isso).
   */
  subagent?: SubagentChoice;
  /** URL e token do servidor MCP "office" desta subida (os motores de um processo por turno passam o token por ambiente). */
  mcp?: { url: string; token: string };
};

/** Acesso efetivo de um agente numa subida, com os domínios da política do workspace. */
export type TerminalAccess = EffectiveAccess & Pick<WorkspaceAccess, "allowedDomains" | "blockedDomains" | "allowLocalNetwork">;

/** Um arquivo da pasta do agente que a CLI lê (instruções, configuração MCP). `secret`: modo 0600. */
export type AgentFile = { path: string; content: string; secret?: boolean };

/**
 * Sessão salva em agents/<id>/session.json. `started`: já completou um turno (pode retomar).
 * `key`: quem abriu esta conversa (ex.: o id da tarefa); a mesma chave voltando continua nela.
 */
export type SessionInfo = { provider: AgentProvider; sessionId: string; started: boolean; updatedAt: string; key?: string };

/** Parser de linhas de saída de uma CLI (guarda estado: ex.: quais chamadas são subagentes). */
export interface CliEventParser {
  parse(line: string): TerminalEvent[];
  /**
   * Os tokens que a CLI informou no turno em curso (sem o evento final) e zera a conta: é o que sobra
   * quando o turno é cortado. Sem nada informado = undefined.
   */
  takePartialUsage?(): TurnUsage | undefined;
}

/**
 * O que muda de uma CLI para outra. O ProcessTerminal cuida do resto (processo, fila, ociosidade,
 * quedas, sessão salva).
 */
export interface CliAdapter {
  readonly provider: AgentProvider;
  /** Comando e argumentos (sem shell). `resume`: retomar a sessão `sessionId` em vez de criar. */
  command(spec: TerminalSpec, session: { sessionId: string; resume: boolean }): { command: string; args: string[] };
  /**
   * Arquivos que o TerminalManager grava na pasta do agente antes de cada subida (as instruções e
   * o servidor MCP "office" com o token do agente, cada CLI no seu formato e lugar).
   */
  agentFiles(input: { spec: TerminalSpec; mcpUrl: string; token: string }): AgentFile[];
  /** Ambiente do processo (já sem chaves de API). */
  env(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv;
  /** Parser das linhas do processo (`spec`: a especificação desta subida, ex.: o modelo padrão dos subagentes). */
  createParser(spec?: TerminalSpec): CliEventParser;
  /** Linha (sem o \n) com uma mensagem do usuário para a entrada do processo. */
  encodeMessage(text: string, sessionId: string): string;
  /**
   * A CLI aceita mensagens no meio de um turno (stream-json com fila de comandos) e diz no fim de cada
   * turno quantas ainda faltam (`queued_turn_count`)? Só então o ProcessTerminal injeta notas ao vivo.
   */
  readonly liveInput?: boolean;
  /** Linha para interromper o turno em curso, se a CLI tiver; senão o terminal para o processo. */
  encodeInterrupt?(requestId: string): string;
  newSessionId(): string;
  /** A saída de erro diz que a sessão a retomar não existe? */
  isMissingSession?(stderr: string): boolean;
}
