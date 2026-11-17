import { isCalendarServerEvent, type ForYouItem, type ForYouTypeDef, type OfficeState, type ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api } from "../api/client";
import { backendUp, type SocketStatus } from "../ws/officeSocket";
import { useChatStatusStore } from "./chatStatusStore";
import { useAgentLogStore } from "./agentLogStore";
import { useAgentUsageStore } from "./agentUsageStore";
import { useCalendarStore } from "./calendarStore";
import { isBrowserEvent, useBrowserStore } from "./browserStore";
import { isBoardEvent, useBoardStore } from "./boardStore";
import { isMediaEvent, useMediaStore } from "./mediaStore";
import { useGoalHitsStore } from "./goalHitsStore";
import { isRoutineEvent, useRoutinesStore } from "./routinesStore";
import { useDayStatsStore } from "./dayStatsStore";
import { useSpendChipsStore } from "./spendChipsStore";
import { useTodayStore } from "./todayStore";
import { isConnectorEvent, useConnectorsStore } from "./connectorsStore";
import type { ForYouItems } from "./forYouItems";
import { createdByMaestro, isForYouTypesEvent, type ForYouTypes } from "./forYouTypes";
import { useNavStore } from "./navStore";
import { useTerminalsStore } from "./terminalsStore";
import { useUsageStore } from "./usageStore";
import { useNoticesStore } from "./notices";
import { isPlanEvent, useWorkStore } from "./workStore";
import { INITIAL_SYNC, officeReducer } from "./officeReducer";
import type { TaskProgressMap } from "./taskProgress";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

type OfficeStoreState = {
  office: OfficeState | null;
  /** Progresso das tarefas ativas (vem de task:progress; não faz parte do OfficeState). */
  progress: TaskProgressMap;
  /** Itens do "Para você" (GET /for-you + eventos foryou:*); null = ainda não carregados. */
  forYou: ForYouItems;
  /** Tipos do "Para você" do workspace (GET /for-you/types + eventos foryou-types:*). */
  forYouTypes: ForYouTypes;
  forYouError: string | null;
  status: LoadStatus;
  error: string | null;
  socket: SocketStatus;
  /** Desde quando (Date.now()) o socket está no estado atual. */
  socketSince: number;
  /** true depois do primeiro office:snapshot: a partir daí o WebSocket manda no estado. */
  live: boolean;
  /** Carrega GET /api/office (só vale enquanto o WebSocket ainda não mandou o snapshot). */
  load: () => Promise<void>;
  /**
   * Carrega GET /for-you e GET /for-you/types. Só para um server antigo, cujo office:snapshot não traz o
   * "Para você". Se chegar evento foryou:* ou foryou-types:* durante o GET, busca de novo.
   */
  loadForYou: () => Promise<void>;
  /** Esquece o escritório (troca de workspace): o próximo load/snapshot preenche de novo. */
  reset: () => void;
  /** Aplica um evento recebido pelo WebSocket (os `calendar:*` vão para o calendarStore). */
  applyEvent: (event: ServerEvent) => void;
  setSocketStatus: (socket: SocketStatus) => void;
};

/** Quantos foryou:* e foryou-types:* chegaram (para saber se um GET em voo ficou velho). */
let forYouEvents = 0;

export const useOfficeStore = create<OfficeStoreState>()((set, get) => ({
  office: INITIAL_SYNC.office,
  progress: INITIAL_SYNC.progress,
  forYou: INITIAL_SYNC.forYou,
  forYouTypes: INITIAL_SYNC.forYouTypes,
  forYouError: null,
  status: "idle",
  error: null,
  socket: "connecting",
  socketSince: Date.now(),
  live: false,

  async load() {
    if (get().status === "loading") return;
    // Sem workspace escolhido ainda: o snapshot do WebSocket (com a lista) preenche tudo.
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const stale = () => useNavStore.getState().workspaceId !== workspaceId;
    set({ status: "loading", error: null });
    // Com o backend fora (ex.: reinício), não chama a API: o proxy responderia 502 (erro no console).
    // O snapshot do WebSocket, que só conecta quando o backend sobe, preenche o escritório.
    if (!(await backendUp())) return;
    try {
      const office = await api.getOffice();
      // Trocou de workspace no meio: esta resposta é do anterior.
      if (stale()) return;
      // Se o snapshot chegou antes, ele (e os eventos seguintes) são mais novos que esta resposta.
      if (get().live) set({ status: "ready" });
      else set({ office, status: "ready" });
    } catch (error) {
      if (stale()) return;
      const message = error instanceof Error ? error.message : String(error);
      set({ status: get().office ? "ready" : "error", error: message });
    }
  },

  async loadForYou() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = forYouEvents;
      let items: ForYouItem[];
      let types: ForYouTypeDef[];
      try {
        [items, types] = await Promise.all([api.listForYou(), api.listForYouTypes()]);
      } catch (error) {
        if (useNavStore.getState().workspaceId !== workspaceId) return;
        set({ forYouError: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (useNavStore.getState().workspaceId !== workspaceId) return;
      // Sem evento no meio: esta resposta é a mais nova.
      if (seen === forYouEvents || attempt === 2) {
        set({ forYou: items, forYouTypes: types, forYouError: null });
        return;
      }
    }
  },

  reset() {
    set({ office: INITIAL_SYNC.office, progress: INITIAL_SYNC.progress, forYou: INITIAL_SYNC.forYou, forYouTypes: INITIAL_SYNC.forYouTypes, forYouError: null, status: "idle", error: null, live: false });
    useNoticesStore.getState().reset();
    useConnectorsStore.getState().reset();
    useBrowserStore.getState().reset();
    useTerminalsStore.getState().reset();
    useWorkStore.getState().reset();
    useAgentUsageStore.getState().reset();
    useSpendChipsStore.getState().reset();
    useRoutinesStore.getState().reset();
    useTodayStore.getState().reset();
    useGoalHitsStore.getState().reset();
    useMediaStore.getState().reset();
    useBoardStore.getState().reset();
  },

  applyEvent(event) {
    // O painel "Hoje" recalcula (com debounce) quando algo que ele mostra muda.
    useTodayStore.getState().apply(event);
    // A festa da meta de rotina batida (só ao vivo) é do mapa.
    useGoalHitsStore.getState().apply(event);
    // O "Meu dia" recarrega (1 s depois) quando uma aprovação é decidida ou uma tarefa termina.
    useDayStatsStore.getState().apply(event);
    // Os chips de gasto (agente e tarefa) recarregam quando um turno é gravado.
    useSpendChipsStore.getState().apply(event);
    // O calendário não faz parte do escritório: tem store próprio (e chega mesmo antes do snapshot).
    if (isCalendarServerEvent(event)) {
      useCalendarStore.getState().applyEvent(event);
      return;
    }
    // Uso da assinatura das CLIs (da conta, não do workspace): store próprio; vem no snapshot e em usage:updated.
    useUsageStore.getState().apply(event);
    if (event.type === "usage:updated") return;
    // Turno terminado por um agente de CLI: entra no "Por agente" do uso (sem consultar a rota).
    if (event.type === "usage:agents") {
      useAgentUsageStore.getState().apply(event.turn);
      return;
    }
    // Reconexão sem perda: os eventos que faltaram chegam em seguida; nada a recarregar.
    if (event.type === "sync:resumed") return;
    // Rotinas e metas: store próprio (a página Gestão e o selo da barra lateral).
    if (isRoutineEvent(event)) {
      useRoutinesStore.getState().apply(event);
      return;
    }
    // Biblioteca de mídia: store próprio (a página Mídia e as miniaturas do Para você).
    if (isMediaEvent(event)) {
      useMediaStore.getState().apply(event);
      return;
    }
    // Quadros do workspace: store próprio (a página Quadro).
    if (isBoardEvent(event)) {
      useBoardStore.getState().apply(event);
      return;
    }
    // Terminais de CLI (status, modo interativo e Remote Control do Maestro): store próprio.
    useTerminalsStore.getState().apply(event);
    if (event.type === "agent:terminal") return;
    // O estado de entrega das mensagens aos agentes (na fila, entregue, respondeu, falhou): store próprio.
    if (event.type === "agent:chat-status") {
      useChatStatusStore.getState().apply(event.chat);
      return;
    }
    // O log de trabalho dos agentes também tem store próprio (a tela de trabalho de cada agente).
    if (event.type === "agent:log") {
      useAgentLogStore.getState().apply(event.entry);
      return;
    }
    // Planos dos pedidos: store próprio (vêm também no office:snapshot).
    useWorkStore.getState().apply(event);
    if (isPlanEvent(event)) return;
    // Conectores (servidores MCP externos) e a atividade deles: store próprio.
    if (isConnectorEvent(event)) {
      useConnectorsStore.getState().apply(event);
      return;
    }
    // Navegador compartilhado (abas e a atividade dos agentes nele): store próprio.
    if (isBrowserEvent(event)) {
      useBrowserStore.getState().apply(event);
      return;
    }
    const { office, progress, forYou, forYouTypes } = get();
    const next = officeReducer({ office, progress, forYou, forYouTypes }, event);
    if (event.type === "foryou:upserted" || event.type === "foryou:deleted" || isForYouTypesEvent(event)) forYouEvents++;
    const created = createdByMaestro(event);
    if (created) {
      useNoticesStore.getState().push({ key: `foryou-type:${created.id}:${created.createdAt}`, text: `O Maestro criou o tipo “${created.name}”`, at: created.createdAt, target: "foryou-types" });
    }
    if (event.type === "office:snapshot") {
      const reconnected = get().live;
      set({ ...next, status: "ready", error: null, live: true });
      resyncOutsideSnapshot(event, reconnected);
    } else if (next.office !== office || next.progress !== progress || next.forYou !== forYou || next.forYouTypes !== forYouTypes) {
      set(next);
    }
  },

  setSocketStatus(socket) {
    if (get().socket !== socket) set({ socket, socketSince: Date.now() });
  },
}));

/**
 * Ressincronização total (o office:snapshot chega na conexão nova e na reconexão que o server já não
 * consegue completar com o histórico): o snapshot troca escritório, progresso, terminais, uso, planos,
 * "Para você", conectores e navegador; o resto, que fica fora dele, é recarregado aqui. Numa
 * reconexão com replay (sync:resumed) nada disto acontece: os eventos que faltaram bastam.
 */
function resyncOutsideSnapshot(snapshot: Extract<ServerEvent, { type: "office:snapshot" }>, reconnected: boolean): void {
  if (snapshot.forYou) forYouEvents++;
  else void useOfficeStore.getState().loadForYou();
  if (snapshot.connectors) useConnectorsStore.getState().replace(snapshot.connectors);
  else void useConnectorsStore.getState().load();
  if (snapshot.browser) useBrowserStore.getState().replace(snapshot.browser);
  else void useBrowserStore.getState().load();
  // Logs carregados podem ter perdido eventos: os painéis abertos recarregam (sem limpar o que já mostram).
  useAgentLogStore.getState().invalidate();
  // Já estava ao vivo (reconexão sem histórico): o calendário carregado (o período da tela) e o
  // "Por agente" do uso buscam de novo. Na primeira conexão, quem os abre já busca.
  if (!reconnected) return;
  void useCalendarStore.getState().reload();
  const agentUsage = useAgentUsageStore.getState();
  if (agentUsage.data) void agentUsage.load(agentUsage.data.since);
}
