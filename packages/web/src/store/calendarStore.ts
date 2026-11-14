import type { CalendarEvent, CalendarServerEvent, ListCalendarQuery } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { applyCalendarEvent } from "./calendarEvents";
import { useNavStore } from "./navStore";
import type { LoadStatus } from "./officeStore";

export type CalendarRange = Required<ListCalendarQuery>;

type CalendarStoreState = {
  /** Eventos do workspace atual (do período carregado, mais os que chegaram ao vivo). */
  items: CalendarEvent[];
  /** Período do último load (o "Recarregar" e a reconexão do socket pedem o mesmo). */
  range: CalendarRange | null;
  status: LoadStatus;
  error: string | null;
  /** GET /api/w/:ws/calendar?from=&to=; os eventos que chegarem no meio são reaplicados por cima. */
  load: (range: CalendarRange) => Promise<void>;
  /** Carrega de novo o último período (ex.: o WebSocket reconectou e pode ter perdido eventos). */
  reload: () => Promise<void>;
  /** Esquece tudo (troca de workspace). */
  reset: () => void;
  /** Aplica `calendar:upserted`/`calendar:deleted` vindos do WebSocket. */
  applyEvent: (event: CalendarServerEvent) => void;
};

/** Número do load mais recente (respostas de loads antigos são descartadas). */
let loadSeq = 0;
/** Eventos recebidos durante o load atual (null = nenhum load em andamento). */
let buffered: CalendarServerEvent[] | null = null;

export const useCalendarStore = create<CalendarStoreState>()((set, get) => ({
  items: [],
  range: null,
  status: "idle",
  error: null,

  async load(range) {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const seq = ++loadSeq;
    buffered = [];
    set({ range, status: "loading", error: null });
    try {
      const fetched = await api.listCalendar(range);
      if (seq !== loadSeq || useNavStore.getState().workspaceId !== workspaceId) return;
      const items = (buffered ?? []).reduce(applyCalendarEvent, fetched);
      buffered = null;
      set({ items, status: "ready" });
    } catch (error) {
      if (seq !== loadSeq) return;
      buffered = null;
      set({ status: "error", error: describeError(error) });
    }
  },

  async reload() {
    const { range } = get();
    if (range) await get().load(range);
  },

  reset() {
    loadSeq += 1;
    buffered = null;
    set({ items: [], range: null, status: "idle", error: null });
  },

  applyEvent(event) {
    buffered?.push(event);
    const { items } = get();
    const next = applyCalendarEvent(items, event);
    if (next !== items) set({ items: next });
  },
}));
