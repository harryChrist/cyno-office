import type { MuralEntry } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";

type MuralStore = {
  /** Itens ativos do mural, os mais novos primeiro. */
  entries: MuralEntry[];
  /** Por workspace: quantas novidades o Maestro dele ainda não viu. */
  news: Record<string, number>;
  loaded: boolean;
  error: string | null;
  /** Ids com uma ação em andamento. */
  busy: string[];
  load: () => Promise<void>;
  /** Compartilha uma mídia de um workspace com a plataforma (o dono, pela tela de Mídia). */
  share: (workspace: string, mediaId: string, note?: string) => Promise<boolean>;
  /** O workspace traz o item para a própria biblioteca. */
  use: (id: string, workspace: string) => Promise<string | undefined>;
  retire: (id: string) => Promise<void>;
  clearError: () => void;
};

/** Itens de outros workspaces (o que o Maestro vê como novidade) com o selo "N novos" por workspace. */
export const useMuralStore = create<MuralStore>()((set, get) => ({
  entries: [],
  news: {},
  loaded: false,
  error: null,
  busy: [],

  async load() {
    try {
      const { entries, news } = await api.mural();
      set({ entries, news, loaded: true });
    } catch {
      // Sem rede: fica com o que tinha; o próximo evento ou a reconexão busca de novo.
      set({ loaded: true });
    }
  },

  async share(workspace, mediaId, note) {
    set({ error: null });
    try {
      await api.shareToMural({ workspace, mediaId, ...(note ? { note } : {}) });
      await get().load();
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async use(id, workspace) {
    const key = `${id}:${workspace}`;
    if (get().busy.includes(key)) return undefined;
    set((current) => ({ busy: [...current.busy, key], error: null }));
    try {
      const used = await api.useFromMural(id, workspace);
      await get().load();
      return used.mediaId;
    } catch (error) {
      set({ error: describeError(error) });
      return undefined;
    } finally {
      set((current) => ({ busy: current.busy.filter((item) => item !== key) }));
    }
  },

  async retire(id) {
    set({ error: null });
    try {
      await api.retireFromMural(id);
      await get().load();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  clearError: () => set({ error: null }),
}));
