import type { Board, BoardChange, ServerEvent, UpdateBoardBody } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { applyBoardEvent } from "../pages/quadro/quadroView";
import { useNavStore } from "./navStore";

/** Eventos dos quadros (ficam fora do escritório; esta store os aplica). */
export const isBoardEvent = (event: ServerEvent): boolean => event.type === "board:upserted" || event.type === "board:deleted";

/** O último aviso de mudança de um quadro (a tela do quadro aberto reage a ele; `seq` distingue avisos iguais seguidos). */
export type BoardSignal = { seq: number; id: string; changed: BoardChange[]; board: Board };

type BoardState = {
  /** Workspace dos dados abaixo (trocar de workspace descarta tudo). */
  workspaceId: string | null;
  /** null = ainda não carregou. */
  boards: Board[] | null;
  error: string | null;
  signal: BoardSignal | null;
  /** Busca a lista do workspace atual. */
  load: () => Promise<void>;
  /** Carrega uma vez por workspace. */
  ensureLoaded: () => void;
  apply: (event: ServerEvent) => void;
  rename: (id: string, body: UpdateBoardBody) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reset: () => void;
};

let seq = 0;

export const useBoardStore = create<BoardState>()((set, get) => ({
  workspaceId: null,
  boards: null,
  error: null,
  signal: null,

  async load() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    if (get().workspaceId !== workspaceId) set({ workspaceId, boards: null, error: null, signal: null });
    try {
      const boards = await api.listBoards();
      if (useNavStore.getState().workspaceId !== workspaceId) return;
      set({ boards, error: null });
    } catch (error) {
      if (useNavStore.getState().workspaceId !== workspaceId) return;
      set({ error: describeError(error) });
    }
  },

  ensureLoaded() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const { workspaceId: loaded, boards, error } = get();
    if (loaded === workspaceId && (boards !== null || error !== null)) return;
    void get().load();
  },

  apply(event) {
    if (event.type === "board:upserted") {
      seq += 1;
      set({ signal: { seq, id: event.board.id, changed: event.changed, board: event.board } });
    }
    const boards = get().boards;
    // Ainda não carregou: o primeiro load já traz o estado mais novo.
    if (!boards) return;
    if (event.type === "board:upserted" || event.type === "board:deleted") set({ boards: applyBoardEvent(boards, event) });
  },

  async rename(id, body) {
    const board = await api.updateBoard(id, body);
    // O evento do servidor também chega; aplicar já deixa a tela certa mesmo se ele demorar.
    const boards = get().boards;
    if (boards) set({ boards: boards.map((current) => (current.id === id ? board : current)) });
  },

  async remove(id) {
    await api.deleteBoard(id);
    const boards = get().boards;
    if (boards) set({ boards: boards.filter((current) => current.id !== id) });
  },

  reset() {
    set({ workspaceId: null, boards: null, error: null, signal: null });
  },
}));
