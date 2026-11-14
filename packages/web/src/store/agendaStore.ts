import type { AgendaEvent, AgendaPostItem, AgendaRoutineItem, AgendaServerEvent, Availability } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { connectCynoSocket } from "../ws/cynoSocket";

export type AgendaRange = { from: string; to: string; routines: boolean };
type LoadStatus = "idle" | "loading" | "ready" | "error";

type AgendaStore = {
  /** Compromissos do período carregado (os cancelados ficam, com `status: "cancelado"`). */
  events: AgendaEvent[];
  /** Camada Postagens (calendários dos workspaces) e a opcional Rotinas, só leitura. */
  posts: AgendaPostItem[];
  routines: AgendaRoutineItem[];
  availability: Availability | null;
  workspaces: { id: string; name: string }[];
  range: AgendaRange | null;
  status: LoadStatus;
  error: string | null;
  load: (range: AgendaRange) => Promise<void>;
  reload: () => Promise<void>;
  /** `agenda:upserted` e `agenda:availability` do websocket do Cyno. */
  applyEvent: (event: AgendaServerEvent) => void;
  /** Mostra já a resposta de uma gravação (o websocket confirma depois). */
  show: (event: AgendaEvent) => void;
  /** Liga o websocket (a Sua agenda abre); devolve a função que desliga. A reconexão recarrega o período. */
  connect: () => () => void;
};

/** Número do load mais recente (respostas antigas são descartadas) e eventos que chegaram durante ele. */
let loadSeq = 0;
let buffered: AgendaServerEvent[] | null = null;

/** Troca ou insere um compromisso pelo id, mantendo a ordem de início; uma versão mais antiga não sobrescreve. */
export function upsertAgendaEvent(events: readonly AgendaEvent[], incoming: AgendaEvent): AgendaEvent[] {
  const current = events.find((event) => event.id === incoming.id);
  if (current && (current.updatedAt ?? current.createdAt) > (incoming.updatedAt ?? incoming.createdAt)) return events as AgendaEvent[];
  const rest = events.filter((event) => event.id !== incoming.id);
  return [...rest, incoming].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

function applyOne(state: Pick<AgendaStore, "events" | "availability">, event: AgendaServerEvent): Pick<AgendaStore, "events" | "availability"> {
  if (event.type === "agenda:availability") return { events: state.events, availability: event.availability };
  return { events: upsertAgendaEvent(state.events, event.event), availability: state.availability };
}

export const useAgendaStore = create<AgendaStore>()((set, get) => ({
  events: [],
  posts: [],
  routines: [],
  availability: null,
  workspaces: [],
  range: null,
  status: "idle",
  error: null,

  async load(range) {
    const seq = ++loadSeq;
    buffered = [];
    set({ range, status: "loading", error: null });
    try {
      const response = await api.listAgenda({ from: range.from, to: range.to, routines: range.routines, cancelled: true });
      if (seq !== loadSeq) return;
      const base = { events: response.events, availability: response.availability };
      const merged = (buffered ?? []).reduce(applyOne, base);
      buffered = null;
      set({ ...merged, posts: response.posts, routines: response.routines, workspaces: response.workspaces, status: "ready" });
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

  applyEvent(event) {
    buffered?.push(event);
    set((state) => applyOne(state, event));
  },

  show(event) {
    set((state) => ({ events: upsertAgendaEvent(state.events, event) }));
  },

  connect() {
    return connectCynoSocket({
      onEvent: (event) => {
        if (event.type === "agenda:upserted" || event.type === "agenda:availability") get().applyEvent(event);
        // Conexão nova (ou reconexão): o que mudou enquanto estava fora volta numa busca só.
        else if (event.type === "cyno:snapshot" && get().range) void get().reload();
      },
    });
  },
}));
