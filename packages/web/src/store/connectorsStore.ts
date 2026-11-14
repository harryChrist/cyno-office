import type { Connector, ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { ACTIVITY_MS, applyConnectorEvent, expireActivity, recordActivity, RUNNING_MAX_MS, type ActivityMark, type ConnectorList } from "../connectors/connectorView";
import { useNavStore } from "./navStore";

type ConnectorsState = {
  /** Conectores do workspace (GET /connectors + eventos connector:*); null = ainda não carregados. */
  list: ConnectorList;
  error: string | null;
  /** Última chamada de ferramenta por conector e por agente (connector:activity): o pulso e o balão. */
  byConnector: Record<string, ActivityMark>;
  byAgent: Record<string, ActivityMark>;
  load: () => Promise<void>;
  /** A lista que veio no office:snapshot (retrato completo: um GET em voo fica velho). */
  replace: (list: Connector[]) => void;
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

/** Quantos connector:upserted/deleted chegaram (um GET em voo que perdeu algum é repetido). */
let seenEvents = 0;
/** Número de ordem das marcas de atividade. */
let activitySeq = 0;

/**
 * Conectores do workspace atual (fora do OfficeState, como o "Para você"). Vêm em cada
 * office:snapshot (conexão nova ou reconexão sem histórico) e seguem os eventos `connector:*`.
 */
export const useConnectorsStore = create<ConnectorsState>()((set, get) => ({
  list: null,
  error: null,
  byConnector: {},
  byAgent: {},

  async load() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = seenEvents;
      try {
        const list = await api.listConnectors();
        if (useNavStore.getState().workspaceId !== workspaceId) return;
        if (seen === seenEvents || attempt === 2) {
          set({ list, error: null });
          return;
        }
      } catch (error) {
        if (useNavStore.getState().workspaceId === workspaceId) set({ error: describeError(error) });
        return;
      }
    }
  },

  replace(list) {
    seenEvents++;
    set({ list, error: null });
  },

  apply(event) {
    if (event.type === "connector:activity") {
      const { byConnector, byAgent, mark } = recordActivity(get(), event.activity, ++activitySeq);
      set({ byConnector, byAgent });
      // A marca some sozinha: o pulso e o balão duram ACTIVITY_MS depois do fim (rodando: até terminar).
      window.setTimeout(() => set(expireActivity(get(), mark)), mark.running ? RUNNING_MAX_MS : ACTIVITY_MS);
      return;
    }
    if (event.type !== "connector:upserted" && event.type !== "connector:deleted") return;
    seenEvents++;
    const list = applyConnectorEvent(get().list, event);
    if (list !== get().list) set({ list });
  },

  reset() {
    set({ list: null, error: null, byConnector: {}, byAgent: {} });
  },
}));

export function isConnectorEvent(event: ServerEvent): boolean {
  return event.type === "connector:upserted" || event.type === "connector:deleted" || event.type === "connector:activity";
}
