import { DEFAULT_ATTENTION_PREFS, nextAttention, ownerCount, type AttentionAlert, type AttentionPrefs, type AttentionPrefsBody, type AttentionServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api } from "../api/client";

type Listener = (alert: AttentionAlert) => void;
const raisedListeners = new Set<Listener>();

/** Quem quer saber de um alerta que acabou de nascer ao vivo (aviso, som, notificação). Nunca recebe o que veio do boot, da reconexão ou de uma reabertura. */
export function onAttentionRaised(listener: Listener): () => void {
  raisedListeners.add(listener);
  return () => raisedListeners.delete(listener);
}

type AttentionStore = {
  /** Os alertas abertos (a lista inteira, do mais antigo ao mais novo). */
  open: AttentionAlert[];
  /** As preferências da conta (tipos, workspaces silenciados, "não perturbe"). */
  prefs: AttentionPrefs;
  /** Já buscou a lista ao menos uma vez? */
  loaded: boolean;
  /** Onde o percurso do contador parou. */
  tour: string | null;
  /** Busca a lista e as preferências. Tudo o que vem daqui é "replay": entra no número e no sino, sem aviso. */
  load: () => Promise<void>;
  applyEvent: (event: AttentionServerEvent) => void;
  /** Anda no percurso e devolve o alerta (ou undefined quando nada espera o dono). */
  step: (dir?: 1 | -1) => AttentionAlert | undefined;
  /** O dono viu (tarefa que falhou, aviso). */
  markSeen: (key: string) => Promise<void>;
  savePrefs: (body: AttentionPrefsBody) => Promise<void>;
};

const byAge = (a: AttentionAlert, b: AttentionAlert) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

/** Troca (ou põe) o alerta pela chave, sem deixar uma versão antiga passar na frente. */
export function upsertAlert(open: readonly AttentionAlert[], alert: AttentionAlert): AttentionAlert[] {
  const current = open.find((candidate) => candidate.key === alert.key);
  if (current && current.updatedAt > alert.updatedAt) return [...open];
  return [...open.filter((candidate) => candidate.key !== alert.key), alert].sort(byAge);
}

export const useAttentionStore = create<AttentionStore>()((set, get) => ({
  open: [],
  prefs: structuredClone(DEFAULT_ATTENTION_PREFS),
  loaded: false,
  tour: null,

  async load() {
    try {
      const [{ open }, prefs] = await Promise.all([api.attention(), api.attentionPrefs()]);
      // Um evento que chegou durante a busca já está certo; a lista do servidor é a verdade do instante.
      set({ open: [...open].sort(byAge), prefs, loaded: true });
    } catch {
      // Sem rede: fica com o que tinha; a reconexão busca de novo.
    }
  },

  applyEvent(event) {
    if (event.type === "attention:cleared") {
      set((state) => ({ open: state.open.filter((alert) => alert.key !== event.key), tour: state.tour === event.key ? null : state.tour }));
      return;
    }
    const known = get().open.some((alert) => alert.key === event.alert.key);
    set((state) => ({ open: upsertAlert(state.open, event.alert) }));
    if (event.type === "attention:raised" && !known && !event.alert.replay) for (const listener of raisedListeners) listener(event.alert);
  },

  step(dir = 1) {
    const { open, tour } = get();
    const next = nextAttention(open, tour, dir);
    set({ tour: next?.key ?? null });
    return next;
  },

  async markSeen(key) {
    set((state) => ({ open: state.open.filter((alert) => alert.key !== key) }));
    try {
      await api.attentionSeen(key);
    } catch {
      // O alerta já saiu ou a rede caiu: a ressincronização acerta a lista.
      void get().load();
    }
  },

  async savePrefs(body) {
    set({ prefs: await api.saveAttentionPrefs(body) });
  },
}));

export const selectOwnerCount = (state: Pick<AttentionStore, "open">): number => ownerCount(state.open);
