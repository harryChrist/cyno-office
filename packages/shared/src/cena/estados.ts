import { agentEngine, friendlyTerminalError, isCliEngine, type AttentionKind, type Agent, type AgentTerminalInfo, type Blocked, type ForYouItem } from "../index";
import type { AgentStatus } from "@cyno/cena/tipos";

/**
 * Estado do agente do Cyno -> estado do motor (tabela 2.3 do plano da Junção V2). Puro: recebe tudo pronto.
 *
 * Regras, na ordem (a primeira que casar vence):
 * (Terminal parado por ociosidade NÃO é regra: no Cyno o terminal dorme sozinho depois de uns minutos sem uso, e o agente continua
 *  no escritório, à toa; cai na última regra (`idle`) e a próxima tarefa o leva de volta à mesa. O `offline` não sai daqui: o elevador
 *  fica para quem chega (agente novo) e quem sai (agente removido do escritório).)
 * 1. terminal com erro -> `waiting` ("terminal com erro: motivo")
 * 2. motor sem cota (ou CLI ausente) e terminal sem rodar -> `shell` ("Sem cota · volta às 14:30")
 * 3. esperando o dono (aprovação pendente, `waiting_approval`, projeto parado "esperando você", alerta aberto da cadeia de atenção) -> `waiting`
 * 4. pedido de ajuda ao Maestro ou espera de acesso (projeto parado por "agente"/"acesso"/"cota") -> `shell`
 * 5. o Maestro com o pedido nas mãos de um time e terminal ocioso -> `shell` ("Esperando o time X")
 * 6. trabalhando (terminal ocupado ou `working`) -> `working`
 * 7. conversando com o dono -> `working`
 * 8. o resto (parado, concluiu) -> `idle`
 */
export type EntradaDeEstado = {
  agent: Agent;
  maestro: boolean;
  /** Há uma tarefa do agente em andamento ou esperando aprovação (inclui o pedido do Maestro). */
  temTarefaAtiva: boolean;
  terminal: AgentTerminalInfo | undefined;
  /** Rótulo de indisponibilidade do motor ("sem cota · volta às 14:30"), se houver. */
  indisponivel: string | undefined;
  /** Itens do "Para você" pendentes deste agente (o primeiro vale para o texto). */
  pendentes: readonly ForYouItem[];
  /** Mensagem de progresso da tarefa ativa. */
  progresso: string | undefined;
  /** Bloqueio de uma tarefa de projeto do agente (o mais antigo). */
  bloqueio: Blocked | undefined;
  /** O Maestro tem pedido nas mãos de times: os nomes deles. */
  delegandoA: readonly string[];
  /** O que a cadeia de atenção tem aberto para este agente e espera o dono (a mão levantada). */
  atencao?: { kind: AttentionKind; count: number } | undefined;
};

/** O que o agente espera do dono, por tipo de alerta (quando nem o progresso nem o item dizem). */
const PEDIDO_DO_ALERTA: Record<AttentionKind, string> = {
  approval: "aprovar uma entrega",
  plan: "aprovar o plano",
  sprint: "aprovar a sprint",
  routine: "decidir sobre uma rotina",
  question: "responder uma pergunta",
  help: "pedido de ajuda",
  failed: "ver uma falha",
  blocked: "destravar uma tarefa",
  engine_down: "motor fora do ar",
  usage: "limite de uso",
  budget: "orçamento",
  delivery: "ver uma entrega",
};

export type EstadoDecidido = {
  status: AgentStatus;
  waitingFor?: string;
  /** Rótulo do `shell` (a espera com as brincadeiras). */
  espera?: { id: string; rotulo: string; desde?: number };
  /** Terminal rodando uma conversa direta (regra 8). */
  conversando?: boolean;
  /** Regra que decidiu (para testes e depuração). */
  regra: number;
};

const corta = (texto: string, max: number): string => (texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto);
const capitaliza = (texto: string): string => (texto ? `${texto.charAt(0).toUpperCase()}${texto.slice(1)}` : texto);

const rodando = (terminal: AgentTerminalInfo | undefined): boolean => terminal?.status === "idle" || terminal?.status === "busy";

export function decidirEstado(e: EntradaDeEstado): EstadoDecidido {
  const cli = isCliEngine(agentEngine(e.agent));
  const terminal = e.terminal;

  // 1. Terminal com erro: o dono precisa agir.
  if (cli && terminal?.status === "error") return { status: "waiting", waitingFor: corta(`terminal com erro: ${friendlyTerminalError(terminal.error)}`, 80), regra: 1 };

  // 2. Sem cota (só vale com o terminal sem rodar: com um turno em curso o agente está trabalhando).
  if (e.indisponivel && !rodando(terminal) && terminal?.status !== "starting") return { status: "shell", espera: { id: "cota", rotulo: capitaliza(e.indisponivel) }, regra: 2 };

  // 3. Esperando o dono.
  const pendente = e.pendentes[0];
  if (e.agent.status === "waiting_approval" || pendente || e.bloqueio?.type === "voce" || e.atencao) {
    const item = pendente ? (pendente.title ?? pendente.where ?? pendente.to ?? pendente.type) : undefined;
    const pergunta = e.progresso?.trim() || (item ? `aprovar: ${item}` : e.bloqueio?.type === "voce" ? e.bloqueio.note : e.atencao ? PEDIDO_DO_ALERTA[e.atencao.kind] : "aprovar uma entrega");
    return { status: "waiting", waitingFor: corta(pergunta, 80), regra: 3 };
  }

  // 4. Pedido de ajuda, acesso ou cota de um projeto.
  if (e.bloqueio) {
    const { type, note, by, since } = e.bloqueio;
    const desde = Date.parse(since);
    const base = Number.isFinite(desde) ? { desde } : {};
    if (type === "acesso") return { status: "shell", espera: { id: "acesso", rotulo: corta(`Esperando acesso: ${note}`, 60), ...base }, regra: 4 };
    if (type === "cota") return { status: "shell", espera: { id: "cota", rotulo: corta(note || "Sem cota", 60), ...base }, regra: 4 };
    return { status: "shell", espera: { id: "ajuda", rotulo: by ? `Esperando ${by.split("/").pop()}` : "Esperando o Maestro", ...base }, regra: 4 };
  }

  // 5. O Maestro esperando o time que pegou o pedido.
  const ocupado = terminal?.status === "busy";
  if (e.maestro && e.delegandoA.length > 0 && cli && terminal?.status === "idle") {
    const times = e.delegandoA;
    const rotulo = times.length === 1 ? `Esperando o time ${times[0]}` : `Esperando ${times.length} times`;
    return { status: "shell", espera: { id: "times", rotulo }, regra: 5 };
  }

  // 6. Trabalhando.
  if (e.agent.status === "working" || ocupado) return { status: "working", ...(terminal?.chatting ? { conversando: true } : {}), regra: 6 };

  // 7. Conversando com o dono (fora de uma tarefa).
  if (terminal?.chatting) return { status: "working", conversando: true, regra: 7 };

  // 8. Parado, concluiu ou com o terminal dormindo por ociosidade (continua no escritório, à toa).
  return { status: "idle", regra: 8 };
}
