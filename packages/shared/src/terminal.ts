import { z } from "zod";

/**
 * Agentes reais como "terminais": cada agente com motor de CLI (Claude Code e Google Antigravity
 * agora; depois Codex e OpenCode) é um processo de CLI de ASSINATURA, de vida longa, rodando em
 * segundo plano na pasta dele (data/workspaces/<ws>/agents/<id>/). Nada de API paga nem chave de
 * API: o server tira ANTHROPIC_API_KEY e afins do ambiente do processo. Os agentes conversam com o
 * escritório pelo servidor MCP "office" do próprio server.
 */

/** Motor do agente: "mock" (simulado, o padrão) ou uma CLI de assinatura. */
export const AGENT_ENGINES = ["mock", "claude", "codex", "gemini", "opencode", "freebuff", "openclaw", "hermes"] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];

/** Motores que já têm adaptador de CLI (os outros falham com uma mensagem clara). */
export const IMPLEMENTED_CLI_ENGINES = ["claude", "gemini", "freebuff", "openclaw", "hermes"] as const satisfies readonly AgentEngine[];

/** Os três papéis que rodam num motor de CLI: o Maestro de um workspace, o Cyno (a plataforma) e os agentes de time. */
export type EngineRole = "maestro" | "cyno" | "agent";

/**
 * O que muda de um motor para outro em cada papel, em uma linha (nada é proibido: o seletor só avisa).
 * Vazio = nada a avisar (Claude Code e Antigravity).
 */
export function engineRoleNote(engine: AgentEngine | undefined, role: EngineRole): string | undefined {
  const conversation = role === "maestro" || role === "cyno";
  const who = role === "cyno" ? "O Cyno" : "O Maestro";
  switch (engine) {
    case "freebuff":
      return conversation
        ? `${who} acordado segura uma hora aberta do Freebuff (conta no teto de horas abertas ao mesmo tempo); as mensagens novas entram na mesma sessão.`
        : "Cobrado por hora aberta: o agente abre a hora na primeira tarefa e ela conta no teto de horas abertas ao mesmo tempo.";
    case "openclaw":
      return conversation
        ? `Um processo por turno, sem atividade ao vivo. ${who} lembra por resumo: cada turno leva um resumo corrido da conversa.`
        : "Um processo por turno, sem atividade ao vivo na tela do agente.";
    case "hermes":
      return conversation
        ? `Um processo por turno que retoma a sessão salva; o que chega durante um turno vai junto no seguinte. Testado com o programa de verdade (sem modelo real).`
        : "Um processo por turno que retoma a sessão salva. Testado com o programa de verdade (sem modelo real).";
    default:
      return undefined;
  }
}

/** Nome de cada motor na interface ("gemini" roda no Google Antigravity CLI, `agy`). */
export const ENGINE_LABELS: Record<AgentEngine, string> = {
  mock: "Simulado",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Antigravity",
  opencode: "OpenCode",
  freebuff: "Freebuff",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

/** Um modelo que a CLI aceita em `--model` (`label`: nome bonito, se a CLI disser). */
export type EngineModel = { id: string; label?: string };

/**
 * Motor disponível neste server (GET /api/engines). `available`: o binário da CLI existe e
 * respondeu `--version` (o simulado está sempre disponível). `models`: sugestões para o seletor de
 * modelo (no Antigravity, a lista de `agy models`; no Claude Code, alguns apelidos).
 */
export type EngineInfo = {
  engine: AgentEngine;
  label: string;
  available: boolean;
  version?: string;
  /** Por que não está disponível (ex.: "comando agy não encontrado"). */
  reason?: string;
  models: EngineModel[];
  /** O modelo é texto livre (além das sugestões)? */
  freeModel: boolean;
  /** OpenClaw e Hermes: a cerca de arquivos (Landlock) está valendo para os agentes deste motor? */
  fenced?: boolean;
};

export type EnginesResponse = {
  engines: EngineInfo[];
  /** Modo simulado ligado no servidor (AGENT_RUNNER=mock, só testes): libera o motor "mock" e os marcadores [aprovar]/[falhar]/[plano]. Ausente = desligado. */
  simulated?: boolean;
};

/**
 * Esforço de raciocínio (`--effort` no Claude Code e no Antigravity). Ausente = o padrão do server
 * (low no Claude Code; no Antigravity, o da CLI, já que o modelo carrega o nível: gemini-3.8-flash-low…).
 */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export const TERMINAL_STATUSES = ["stopped", "starting", "idle", "busy", "error"] as const;
/**
 * stopped: sem processo (nunca ligou, parado por ociosidade ou à mão; a sessão continua salva);
 * starting: subindo; idle: vivo esperando ordens; busy: trabalhando num turno;
 * error: caiu (tentando de novo com espera crescente) ou desistiu depois de muitas quedas.
 */
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Estado do terminal de um agente (evento agent:terminal e office:snapshot). */
export type AgentTerminalInfo = {
  agentId: string;
  engine: AgentEngine;
  status: TerminalStatus;
  /** Sessão da CLI (retomada com --resume depois de parar, cair ou reiniciar o server). */
  sessionId?: string;
  /** Último erro (quedas, falha ao subir). */
  error?: string;
  /**
   * Como o processo roda: "headless" (`claude -p` com stream-json, o padrão dos agentes) ou "pty"
   * (o Maestro de Claude Code: o `claude` interativo num pseudo-terminal, visível e usável no painel).
   */
  mode?: TerminalMode;
  /** Remote Control do Claude Code (só no modo "pty"): a mesma sessão no app do Claude e em claude.ai/code. */
  remote?: RemoteControlInfo;
  /** Já subiu alguma vez (tem session.json na pasta ou subiu neste processo)? Falso = "criado, nunca iniciado". */
  everStarted?: boolean;
  /** Por que parou (só com status "stopped"): "Parado por ociosidade", "Parado pelo usuário"… */
  stoppedReason?: string;
  /** Está num turno de conversa direta com o usuário (fora de uma tarefa): o balão de fala no escritório. */
  chatting?: boolean;
  updatedAt: string;
};

export type TerminalMode = "headless" | "pty";

/**
 * Remote Control do terminal do Maestro: `active` quando a CLI disse que a ponte está no ar;
 * `name` é o nome da sessão (o que aparece no app do Claude); `url`, o link que a CLI mostrou.
 */
/**
 * Remote Control da sessão do Maestro: ligado agora, o nome da sessão (o que aparece no app do
 * Claude e em claude.ai/code), o link e, quando o nome foi trocado com o Maestro ocupado, o nome
 * novo que entra (`/rename`) assim que ele ficar livre.
 */
export type RemoteControlInfo = { active: boolean; name?: string; url?: string; pendingName?: string };

/** O agente roda numa CLI (qualquer motor que não seja o simulado)? */
export function isCliEngine(engine: AgentEngine | undefined): engine is Exclude<AgentEngine, "mock"> {
  return engine !== undefined && engine !== "mock";
}

/** Motor efetivo do agente (ausente = "mock", compatível com office.json antigos). */
export function agentEngine(agent: { engine?: AgentEngine }): AgentEngine {
  return agent.engine ?? "mock";
}

/** Nome do servidor MCP do escritório na configuração das CLIs (ferramentas `mcp__office__*`). */
export const OFFICE_MCP_SERVER = "office";
/** Caminho HTTP do servidor MCP no backend (só 127.0.0.1, com token por agente). */
export const OFFICE_MCP_PATH = "/mcp";

/** Principais ferramentas MCP do Maestro (gerente do workspace). O contrato MCP é todo em inglês. */
export const MAESTRO_TOOLS = ["get_team", "open_request", "delegate_task", "get_task", "complete_request", "request_approval", "ask_user", "create_project"] as const;
/** Principais ferramentas MCP dos agentes de time. */
export const WORKER_TOOLS = ["get_task", "submit_result", "report_progress", "request_approval", "ask_user", "request_help"] as const;

/**
 * Nomes antigos (pt-BR) das ferramentas MCP do escritório -> o nome novo. Uma sessão retomada pode
 * ainda chamar o nome antigo: o servidor responde com erro apontando o novo (sem alias), e o log
 * antigo continua com rótulo certo na interface.
 */
export const LEGACY_OFFICE_TOOL_NAMES: Readonly<Record<string, string>> = {
  ver_equipe: "get_team",
  abrir_pedido: "open_request",
  delegar: "delegate_task",
  ver_tarefa: "get_task",
  concluir_pedido: "complete_request",
  pedir_aprovacao: "request_approval",
  pedir_informacoes: "ask_user",
  pedir_informacao: "ask_user",
  planejar_pedido: "create_project",
  adicionar_tarefas: "add_project_tasks",
  decidir_tarefa: "resolve_task",
  ver_plano: "get_project",
  entregar: "submit_result",
  progresso: "report_progress",
  pedir_ajuda: "request_help",
  definir_tipo_aprovacao: "set_approval_type",
  listar_tamanhos_e_tipos: "list_room_options",
  criar_sala: "create_room",
  criar_time: "create_team",
  criar_agente: "create_agent",
  definir_lider: "set_team_lead",
  definir_modelo: "set_agent_model",
  buscar_notas: "search_notes",
  ler_nota: "read_note",
  salvar_nota: "save_note",
};

// ---------- Terminal do Maestro no navegador (WebSocket) ----------

/** WebSocket do terminal do Maestro (o `claude` interativo dele, ao vivo): `/api/w/<ws>/maestro/terminal`. */
export function maestroTerminalPath(workspaceId: string): string {
  return `/api/w/${encodeURIComponent(workspaceId)}/maestro/terminal`;
}

/** Fecha o socket do terminal: o Maestro deste workspace não roda num terminal interativo (simulado ou outro motor). */
export const WS_CLOSE_NO_MAESTRO_TERMINAL = 4409;

/** Tamanho de tela aceito do navegador (colunas × linhas). */
export const PTY_SIZE_LIMITS = { minCols: 20, maxCols: 500, minRows: 5, maxRows: 200 } as const;

/**
 * Mensagens do server para o navegador (JSON):
 * - hello: estado atual, tamanho da tela e Remote Control (chega primeiro, depois o `replay`);
 * - replay: o fim recente da saída (para desenhar a tela de quem acabou de conectar);
 * - out: um pedaço novo da saída do terminal;
 * - status/remote: mudanças de estado e do Remote Control;
 * - exit: o processo saiu (o server sobe de novo sozinho, se for o caso).
 */
export type MaestroTerminalServerMessage =
  | { t: "hello"; status: TerminalStatus; cols: number; rows: number; remote?: RemoteControlInfo; error?: string }
  | { t: "replay"; d: string }
  | { t: "out"; d: string }
  | { t: "status"; status: TerminalStatus; error?: string }
  | { t: "remote"; remote: RemoteControlInfo }
  | { t: "exit"; code: number | null };

/**
 * Mensagens do navegador para o server: `in` (teclas e coladas, do jeito que o xterm manda),
 * `resize` (a tela do navegador mudou) e `start` (ligar o terminal, se estiver parado).
 */
export const maestroTerminalClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("in"), d: z.string().max(64_000) }),
  z.object({
    t: z.literal("resize"),
    cols: z.number().int().min(PTY_SIZE_LIMITS.minCols).max(PTY_SIZE_LIMITS.maxCols),
    rows: z.number().int().min(PTY_SIZE_LIMITS.minRows).max(PTY_SIZE_LIMITS.maxRows),
  }),
  z.object({ t: z.literal("start") }),
]);
export type MaestroTerminalClientMessage = z.infer<typeof maestroTerminalClientMessageSchema>;

// ---------- Estado do terminal na interface (escritório, lista de agentes, painel) ----------

/**
 * Estado do terminal de um agente como o usuário vê:
 * - novo: criado, nunca iniciado (nunca teve processo nem sessão);
 * - iniciando: o processo está subindo;
 * - ligado: processo no ar (ocioso ou trabalhando);
 * - desligado: parado (por ociosidade ou à mão); sobe sozinho na próxima tarefa;
 * - erro: não subiu ou caiu (com o motivo);
 * - sem_cota: o motor está sem cota da assinatura (ou fora do ar), com a hora em que volta;
 * - simulado: agente simulado (sem processo: sempre pronto).
 */
export const TERMINAL_STATE_KEYS = ["novo", "iniciando", "ligado", "desligado", "erro", "sem_cota", "simulado"] as const;
export type TerminalStateKey = (typeof TERMINAL_STATE_KEYS)[number];

export type TerminalStateView = {
  key: TerminalStateKey;
  emoji: string;
  /** Rótulo curto ("Ligado", "Sem cota · volta às 14:30"). */
  label: string;
  /** Explicação de uma linha (motivo do erro, por que parou, o que acontece depois). */
  detail?: string;
  /** Dá para pedir "Ligar" (ou "Tentar de novo")? */
  canStart: boolean;
  /** Dá para pedir "Desligar"? */
  canStop: boolean;
  /** Desligar agora interrompe um turno em curso (pede confirmação). */
  midTurn: boolean;
};

export const TERMINAL_STATE_EMOJI: Record<TerminalStateKey, string> = {
  novo: "🆕",
  iniciando: "⏳",
  ligado: "🟢",
  desligado: "💤",
  erro: "🔴",
  sem_cota: "🚫",
  simulado: "🧪",
};

/**
 * Motivo legível de um erro de terminal: "comando agy não encontrado", "login expirado" ou a última
 * linha útil da mensagem (sem o prefixo técnico). Vazio = "erro desconhecido".
 */
export function friendlyTerminalError(error: string | undefined): string {
  const text = (error ?? "").trim();
  if (!text) return "erro desconhecido";
  const missing = /spawn (\S+) ENOENT/.exec(text) ?? /(\S+): (?:command )?not found/i.exec(text);
  if (missing) return `comando ${missing[1]!.split("/").pop()!} não encontrado`;
  if (/not logged in|please (?:run )?\/?login|login expired|oauth.*expired|token.*expired|invalid api key|authentication|unauthori[sz]ed|\b401\b/i.test(text)) return "login expirado (entre de novo na CLI)";
  if (/chave de API/i.test(text)) return text.slice(0, 160);
  const last = text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? text;
  const clean = last.replace(/^Não foi possível iniciar a CLI:\s*/i, "").replace(/^A CLI saiu \([^)]*\):\s*/, "");
  return (clean || last).slice(0, 160);
}

/**
 * Estado do terminal de um agente para a interface (função pura). `info` ausente num agente de CLI =
 * nunca subiu neste server. `block`: o motor está indisponível (cota ou CLI ausente), com o rótulo
 * pronto ("sem cota · volta às 14:30").
 */
export function terminalStateView(engine: AgentEngine, info: AgentTerminalInfo | undefined, block?: { label: string; reason?: string } | null): TerminalStateView {
  const view = (key: TerminalStateKey, label: string, detail: string | undefined, flags: Partial<Pick<TerminalStateView, "canStart" | "canStop" | "midTurn">> = {}): TerminalStateView => ({
    key,
    emoji: TERMINAL_STATE_EMOJI[key],
    label,
    ...(detail ? { detail } : {}),
    canStart: flags.canStart ?? false,
    canStop: flags.canStop ?? false,
    midTurn: flags.midTurn ?? false,
  });
  if (!isCliEngine(engine)) return view("simulado", "Simulado", "Agente simulado: sem processo, sempre pronto");
  const status = info?.status ?? "stopped";
  const running = status === "idle" || status === "busy";
  if (block && !running && status !== "starting") {
    const label = block.label ? `${block.label.charAt(0).toUpperCase()}${block.label.slice(1)}` : "Sem cota";
    const detail =
      block.reason === "quota"
        ? "As tarefas esperam na fila e seguem sozinhas quando a cota voltar"
        : block.reason === "paused"
          ? "Pausado pelo limite de uso do plano que você configurou: a tarefa em curso termina o passo, nada novo começa e tudo volta sozinho quando a janela reiniciar"
          : block.reason === "hour"
          ? "Outro agente do Freebuff está com a hora aberta (o teto é de horas abertas ao mesmo tempo): as tarefas esperam na fila e seguem quando a hora dele acabar"
          : "A CLI deste motor não está disponível no servidor";
    return view("sem_cota", label, detail);
  }
  switch (status) {
    case "starting":
      return view("iniciando", "Iniciando", "O processo da CLI está subindo");
    case "idle":
      return view("ligado", "Ligado", info?.chatting ? "Conversando com você" : "Processo no ar, esperando ordens", { canStop: true });
    case "busy":
      return view("ligado", "Ligado", info?.chatting ? "Conversando com você" : "Processo no ar, trabalhando", { canStop: true, midTurn: true });
    case "error":
      return view("erro", "Com erro", friendlyTerminalError(info?.error), { canStart: true, canStop: true });
    case "stopped":
      if (!info?.everStarted) return view("novo", "Criado, nunca iniciado", "Sobe sozinho na primeira tarefa (ou em Ligar)", { canStart: true });
      return view("desligado", "Desligado", `${info.stoppedReason ?? "Parado"}: sobe sozinho na próxima tarefa`, { canStart: true });
  }
}

// ---------- Conversa direta com um agente (POST /api/w/:ws/agents/:id/chat) ----------

/**
 * Mensagem direta para um agente (a caixa na tela de trabalho dele). Nada vira pedido sozinho:
 * - agente numa tarefa: vira uma NOTA na sessão da tarefa (no meio do turno, se a CLI aceitar;
 *   senão no próximo limite de turno) e aparece no log da tarefa;
 * - agente livre: conversa com ele numa sessão "conversa" própria (separada das tarefas), no log
 *   `conversa-<agente>-AAAAMMDD` (entradas `chat`).
 * O agente simulado responde com um texto pronto.
 */
export const agentChatBodySchema = z.strictObject({ text: z.string().trim().min(1, "A mensagem está vazia").max(100_000) });
export type AgentChatBody = z.input<typeof agentChatBodySchema>;

/**
 * Resposta do POST …/agents/:id/chat (202): `nota` (foi para a tarefa `taskId`; `live`: entrou no
 * turno em curso, senão espera o fim dele) ou `conversa` (o log do dia é `logId`).
 */
export type AgentChatResponse = { mode: "nota"; taskId: string; live: boolean; messageId: string } | { mode: "conversa"; logId: string; messageId: string };

/**
 * Em que pé está uma mensagem mandada a um agente (evento `agent:chat-status`, sem polling: o servidor é
 * dono do terminal da CLI e sabe a entrega):
 * - `queued`: o agente está ocupado (ou subindo); ele lê quando terminar o turno;
 * - `delivered`: o agente recebeu (a mensagem entrou no turno, ou abriu um turno);
 * - `answered`: o turno da mensagem terminou (conversa: a resposta chegou);
 * - `failed`: não chegou (o terminal caiu, a CLI recusou) ou o turno deu erro.
 */
export const CHAT_MESSAGE_STATUSES = ["queued", "delivered", "answered", "failed"] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

export type AgentChatStatus = {
  messageId: string;
  agentId: string;
  status: ChatMessageStatus;
  /** `nota` (para a tarefa em curso) ou `conversa` (sessão própria). */
  mode: "nota" | "conversa";
  /** Motivo, quando `failed`. */
  error?: string;
  at: string;
};

const CHAT_STATUS_RANK: Record<ChatMessageStatus, number> = { queued: 0, delivered: 1, answered: 2, failed: -1 };

/**
 * O estado seguinte de uma mensagem, dado o que já se sabe. Só avança: uma confirmação atrasada corrige
 * "falhou" para "entregue" (ou "respondeu"), mas "entregue" e "respondeu" nunca viram "falhou", e nada volta
 * para "na fila". `failed` só vale sobre `queued` (ou sobre nada).
 */
export function advanceChatStatus(previous: ChatMessageStatus | undefined, next: ChatMessageStatus): ChatMessageStatus {
  if (previous === undefined) return next;
  if (next === "failed") return previous === "queued" || previous === "failed" ? "failed" : previous;
  if (previous === "failed") return next;
  return CHAT_STATUS_RANK[next] > CHAT_STATUS_RANK[previous] ? next : previous;
}

/** POST …/agents/:id/terminal/stop?force=1: desliga mesmo no meio de um turno (a tarefa em curso falha). */
export const terminalStopQuerySchema = z.object({ force: z.enum(["1", "true", "0", "false"]).optional() });
