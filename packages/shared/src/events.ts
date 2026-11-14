import type { ActivityEntry } from "./activity";
import type { AgentLogEntry } from "./agent-log";
import type { BrowserActivity, BrowserState } from "./browser";
import type { Connector, ConnectorActivity } from "./connectors";
import type { LibrarySkillView } from "./library-skills";
import type { LibraryApp, LibraryConnector } from "./library";
import type { AppRun, InstallJob } from "./library-apps";
import type { ForYouItem } from "./for-you";
import type { ForYouTypeDef } from "./for-you-types";
import type { Project } from "./projects";
import type { MediaItem } from "./media";
import type { Routine, RoutineEntry, RoutineExecution, RoutineRunChange } from "./routines";
import type { AgentChatStatus, AgentTerminalInfo } from "./terminal";
import type { AgentUsageTurn, SubscriptionUsage } from "./usage";
import type { Agent, CalendarEvent, OfficeState, Room, Task, Team, Workspace } from "./types";

/** Caminho do WebSocket de eventos do server: `/ws?workspace=<id>`. */
export const WS_PATH = "/ws";
/** Parâmetro de query do WebSocket com o id do workspace. */
export const WS_WORKSPACE_PARAM = "workspace";
/**
 * Parâmetros da reconexão: o último `seq` recebido e o `epoch` do hub em que ele valia. Com os dois,
 * o server reenvia só o que faltou (`sync:resumed` + os eventos); sem o histórico, manda o snapshot.
 */
export const WS_SINCE_PARAM = "since";
export const WS_EPOCH_PARAM = "epoch";
/** Código de fechamento do WebSocket quando o workspace pedido não existe (ou foi excluído). */
export const WS_CLOSE_WORKSPACE_NOT_FOUND = 4404;

/** Até onde o cliente já recebeu os eventos de um workspace (para a reconexão pedir só o que faltou). */
export type EventCursor = { epoch: string; seq: number };

/** Url (caminho + query) do WebSocket de um workspace (com o cursor, na reconexão). */
export function workspaceSocketPath(workspaceId: string, cursor?: EventCursor | null): string {
  const base = `${WS_PATH}?${WS_WORKSPACE_PARAM}=${encodeURIComponent(workspaceId)}`;
  if (!cursor) return base;
  return `${base}&${WS_SINCE_PARAM}=${cursor.seq}&${WS_EPOCH_PARAM}=${encodeURIComponent(cursor.epoch)}`;
}

/** Último progresso conhecido de uma tarefa ativa (o mesmo conteúdo do último task:progress). */
export type TaskProgressInfo = {
  agentId: string;
  /** 0..1 */
  progress: number;
  /** Última mensagem; numa tarefa em waiting_approval, é a pergunta de aprovação. */
  message: string;
};

/**
 * Todo evento que o server envia pelo WebSocket (união discriminada por `type`). Cada socket
 * recebe só os eventos do seu workspace, mais `workspaces:list` (para todos, ao conectar e
 * sempre que um workspace é criado, renomeado ou excluído).
 */
export type ServerEvent =
  | { type: "workspaces:list"; workspaces: Workspace[] }
  | {
      type: "office:snapshot";
      office: OfficeState;
      /**
       * Último task:progress de cada tarefa ativa, por id da tarefa (só o que o server tem em
       * memória; some num restart). Opcional: o progresso não faz parte do OfficeState.
       */
      progress?: Record<string, TaskProgressInfo>;
      /** Terminais de CLI conhecidos pelo server (agentes com motor de CLI), por id do agente. */
      terminals?: Record<string, AgentTerminalInfo>;
      /** Último uso conhecido da assinatura de cada CLI (é da conta: igual em todos os workspaces). */
      usage?: SubscriptionUsage[];
      /** Projetos (projects/<id>.json; fora do OfficeState). */
      projects?: Project[];
      /** Itens e tipos do "Para você" (fora do OfficeState): o snapshot é o retrato completo do workspace. */
      forYou?: ForYouItem[];
      forYouTypes?: ForYouTypeDef[];
      /** Conectores (sem segredos) e as abas do navegador compartilhado. */
      connectors?: Connector[];
      browser?: BrowserState;
      /**
       * Id do hub de eventos do workspace (muda quando o server reinicia) e o `seq` do último evento
       * já refletido neste retrato. O cliente os devolve na reconexão (`?since=&epoch=`).
       */
      epoch?: string;
      seq?: number;
    }
  /**
   * Reconexão aceita: o server tinha todos os eventos desde o `since` pedido e vai reenviar só eles
   * (`replayed` eventos, do `since + 1` ao `until`, cada um com o seu `seq`, logo em seguida), sem snapshot.
   */
  | { type: "sync:resumed"; epoch: string; since: number; until: number; replayed: number }
  | { type: "room:upserted"; room: Room }
  | { type: "room:deleted"; id: string }
  | { type: "team:upserted"; team: Team }
  | { type: "team:deleted"; id: string }
  | { type: "agent:upserted"; agent: Agent }
  | { type: "agent:deleted"; id: string }
  | { type: "task:upserted"; task: Task }
  /** Projeto criado ou alterado (aprovação, distribuição, etapa passada adiante, fim). */
  | { type: "project:upserted"; project: Project }
  | { type: "project:deleted"; id: string }
  /** Item do "Para você" criado ou alterado (decidido, reaberto). */
  | { type: "foryou:upserted"; item: ForYouItem }
  /** Item do "Para você" apagado (junto com o quarto, o agente ou a tarefa a que pertencia). */
  | { type: "foryou:deleted"; id: string }
  /** Tipo do "Para você" criado (`created`) ou editado; o web o guarda junto com os itens. */
  | { type: "foryou-types:upserted"; forYouType: ForYouTypeDef; created?: boolean }
  /** Tipo excluído (ou juntado a outro): os itens já foram para `movedTo` (foryou:upserted). */
  | { type: "foryou-types:deleted"; id: string; movedTo: string }
  | {
      type: "task:progress";
      taskId: string;
      agentId: string;
      /** 0..1 */
      progress: number;
      message: string;
    }
  /** Calendário do workspace (fica fora do OfficeState e do office:snapshot; o web carrega por GET). */
  | { type: "calendar:upserted"; calendarEvent: CalendarEvent }
  | { type: "calendar:deleted"; id: string }
  /** Rotinas (routines.json): rotina criada/alterada, item novo ou entregue/descartado no livro-razão, execução registrada. */
  | { type: "routine:upserted"; routine: Routine }
  /** Rotina apagada (só encerrada ou proposta): some da lista com o histórico. */
  | { type: "routine:removed"; routineId: string }
  | { type: "routine:entry"; entry: RoutineEntry }
  | { type: "routine:execution"; execution: RoutineExecution }
  /** Itens acompanhados de uma rotina mudaram (a tela recarrega a lista); `expired` traz os que o servidor encerrou por fim da vida. */
  | { type: "routine:items"; routineId: string; expired?: RoutineRunChange[] }
  /** Biblioteca de mídia (media/media.json): item criado ou alterado (mesmo `id`) e item apagado. */
  | { type: "media:upserted"; media: MediaItem }
  | { type: "media:deleted"; id: string }
  /** Fechamento semanal feito (o resumo foi pedido ao Maestro). */
  | { type: "routine:closed"; periodKey: string; routineIds: string[] }
  /**
   * A meta de uma rotina foi batida (as entregas do período chegaram ao alvo): uma vez por rotina e por período.
   * Só ao vivo (a carga inicial não manda): o mapa comemora na sala do dono.
   */
  | { type: "routine:goal-hit"; routineId: string; periodKey: string; title: string; delivered: number; target: number; agentId?: string; teamId?: string }
  /**
   * Entrada nova (ou ferramenta atualizada no lugar, mesmo `id`) no log de trabalho de um agente.
   * Só vai para os clientes do workspace; o histórico vem por GET (tasks/:id/log, agents/:id/log).
   */
  | { type: "agent:log"; entry: AgentLogEntry }
  /** O terminal de CLI de um agente mudou de estado (subiu, ocupado, ocioso, parou, caiu). */
  | { type: "agent:terminal"; terminal: AgentTerminalInfo }
  /** Estado de entrega de uma mensagem mandada a um agente pela caixa de conversa (na fila, entregue, respondeu, falhou). */
  | { type: "agent:chat-status"; chat: AgentChatStatus }
  /** Uso da assinatura de uma CLI mudou (vai para os sockets de todos os workspaces). */
  | { type: "usage:updated"; usage: SubscriptionUsage }
  /** Um agente de CLI do workspace terminou um turno: o "Por agente" do uso soma sem consultar a rota. */
  | { type: "usage:agents"; turn: AgentUsageTurn }
  /** Conector (servidor MCP externo) criado ou alterado: cadastro, estado, ferramentas ou agentes ligados (sem segredos). */
  | { type: "connector:upserted"; connector: Connector }
  | { type: "connector:deleted"; id: string }
  /** Um agente chamou uma ferramenta de um conector (início e fim): só para o visual (pulso do ícone, balão). */
  | { type: "connector:activity"; activity: ConnectorActivity }
  /** Item da Biblioteca da plataforma criado ou alterado (estado, ferramentas, liberações; sem segredos). Vai para todos os sockets. */
  | { type: "library:upserted"; kind: "connector"; item: LibraryConnector }
  | { type: "library:deleted"; kind: "connector"; id: string }
  | { type: "library:skill-upserted"; item: LibrarySkillView }
  | { type: "library:skill-deleted"; id: string }
  /** App externo da Biblioteca instalado/alterado, ou removido; andamento da instalação e linhas do log ao vivo (só as linhas não ganham seq). */
  | { type: "library:app"; app: LibraryApp }
  | { type: "library:app-removed"; id: string }
  | { type: "library:app-run"; run: AppRun }
  | { type: "library:job"; job: InstallJob }
  | { type: "library:job-log"; jobId: string; line: string }
  /** Abas do navegador compartilhado mudaram (abriu, fechou, navegou) ou ele subiu/fechou. */
  | { type: "browser:tabs"; browser: BrowserState }
  /** Um agente usou o navegador: só para o visual (globo no balão do agente). */
  | { type: "browser:activity"; activity: BrowserActivity }
  /** Entrada nova na Atividade (do workspace; as do servidor vão para todos). Só ao vivo: o histórico vem por GET. */
  | { type: "activity:appended"; entry: ActivityEntry }
  /** Aviso visível do servidor (ex.: uma gravação falhou depois das novas tentativas). Só ao vivo, sem histórico. */
  | { type: "system:warning"; message: string; at: string };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

const EVENT_TYPES: Record<ServerEventType, true> = {
  "workspaces:list": true,
  "office:snapshot": true,
  "sync:resumed": true,
  "room:upserted": true,
  "room:deleted": true,
  "team:upserted": true,
  "team:deleted": true,
  "agent:upserted": true,
  "agent:deleted": true,
  "task:upserted": true,
  "project:upserted": true,
  "project:deleted": true,
  "task:progress": true,
  "calendar:upserted": true,
  "calendar:deleted": true,
  "routine:upserted": true,
  "routine:removed": true,
  "routine:entry": true,
  "routine:execution": true,
  "routine:items": true,
  "routine:closed": true,
  "routine:goal-hit": true,
  "media:upserted": true,
  "media:deleted": true,
  "foryou:upserted": true,
  "foryou:deleted": true,
  "foryou-types:upserted": true,
  "foryou-types:deleted": true,
  "agent:log": true,
  "agent:terminal": true,
  "agent:chat-status": true,
  "usage:updated": true,
  "usage:agents": true,
  "connector:upserted": true,
  "connector:deleted": true,
  "connector:activity": true,
  "library:upserted": true,
  "library:deleted": true,
  "library:skill-upserted": true,
  "library:skill-deleted": true,
  "library:app": true,
  "library:app-removed": true,
  "library:app-run": true,
  "library:job": true,
  "library:job-log": true,
  "browser:tabs": true,
  "browser:activity": true,
  "activity:appended": true,
  "system:warning": true,
};

/** Eventos do calendário (o web os guarda no calendarStore, não no escritório). */
export type CalendarServerEvent = ServerEventOf<"calendar:upserted" | "calendar:deleted">;

export function isCalendarServerEvent(event: ServerEvent): event is CalendarServerEvent {
  return event.type === "calendar:upserted" || event.type === "calendar:deleted";
}

export const SERVER_EVENT_TYPES = Object.keys(EVENT_TYPES) as ServerEventType[];

/**
 * Eventos só visuais (um pulso, um balão): vão ao vivo, mas não ganham `seq` nem entram no histórico
 * da reconexão (reenviá-los depois faria piscar uma atividade que já passou).
 */
export const UNSEQUENCED_EVENT_TYPES: ReadonlySet<ServerEventType> = new Set<ServerEventType>(["connector:activity", "browser:activity", "activity:appended", "system:warning", "library:job-log"]);

/** Uma mensagem do WebSocket: o evento e, nos eventos do workspace, o número de ordem (`seq`). */
export type ServerMessage = { event: ServerEvent; seq?: number };

/** Lê uma mensagem do WebSocket separando o `seq` do evento; null se não for um ServerEvent conhecido. */
export function parseServerMessage(raw: string): ServerMessage | null {
  const event = parseServerEvent(raw);
  if (!event) return null;
  if (event.type === "office:snapshot") return { event, ...(typeof event.seq === "number" ? { seq: event.seq } : {}) };
  if (!("seq" in event)) return { event };
  const { seq, ...rest } = event as ServerEvent & { seq: unknown };
  return { event: rest as ServerEvent, ...(typeof seq === "number" && Number.isInteger(seq) ? { seq } : {}) };
}

/** Lê uma mensagem do WebSocket; retorna null se não for um ServerEvent conhecido. */
export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("type" in data)) return null;
    const { type } = data;
    if (typeof type !== "string" || !Object.hasOwn(EVENT_TYPES, type)) return null;
    return data as ServerEvent;
  } catch {
    return null;
  }
}
