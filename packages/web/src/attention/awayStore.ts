import { AWAY_PATH, AWAY_SEEN_PATH, PRESENCE_EVERY_MS, PRESENCE_IDLE_MS, PRESENCE_PATH, type AwayResponse, type AwaySummary, type PresenceResponse } from "@cyno/shared";
import { create } from "zustand";
import { requestJson } from "../api/client";

/**
 * "Enquanto você estava fora": a presença do dono e o resumo ao voltar.
 *
 * O navegador manda a presença ao servidor a cada minuto, só com a aba visível e com entrada recente
 * (mouse, teclado ou toque nos últimos 2 minutos): nada além do "estou aqui". O servidor decide se houve
 * uma ausência de 30 minutos ou mais e monta o resumo por código; aqui só se pede e se mostra. O "Ok, vi" vale
 * para todos os navegadores (o servidor guarda), e cada navegador descobre na próxima presença.
 */

/** Pura: a presença vale agora? Aba visível e entrada recente. */
export function shouldSendPresence(state: { visible: boolean; lastInputAt: number; now: number }): boolean {
  return state.visible && state.now - state.lastInputAt <= PRESENCE_IDLE_MS;
}

type AwayStore = {
  summary: AwaySummary | null;
  /** O dono fechou o cartão neste navegador (some já, antes de o servidor confirmar). */
  dismissed: boolean;
  /** Manda a presença; se houver ausência pendente, busca o resumo (e some com o cartão se não houver mais). */
  ping: () => Promise<void>;
  /** "Ok, vi": zera para todos os navegadores. */
  confirm: () => Promise<void>;
};

export const useAwayStore = create<AwayStore>()((set, get) => ({
  summary: null,
  dismissed: false,
  async ping() {
    try {
      const { awayPending } = await requestJson<PresenceResponse>(PRESENCE_PATH, { method: "POST" });
      if (!awayPending) {
        if (get().summary) set({ summary: null, dismissed: false });
        return;
      }
      const away = await requestJson<AwayResponse>(AWAY_PATH);
      if (!away.pending || !away.summary) {
        set({ summary: null, dismissed: false });
        return;
      }
      // A mesma ausência que o dono já fechou aqui não volta; uma ausência nova (outra `since`) volta.
      const current = get().summary;
      set({ summary: away.summary, dismissed: current?.since === away.summary.since ? get().dismissed : false });
    } catch {
      // Sem rede ou sem servidor: tenta no próximo minuto.
    }
  },
  async confirm() {
    set({ dismissed: true });
    try {
      await requestJson<unknown>(AWAY_SEEN_PATH, { method: "POST" });
      set({ summary: null, dismissed: false });
    } catch {
      // Não confirmou no servidor: o cartão fica fechado aqui e volta na próxima conferência.
    }
  },
}));

/** Liga a presença deste navegador (montar uma vez no app). Devolve o desligar. */
export function startPresence(): () => void {
  let lastInputAt = Date.now();
  const touch = () => {
    lastInputAt = Date.now();
  };
  const tick = () => {
    if (shouldSendPresence({ visible: document.visibilityState === "visible", lastInputAt, now: Date.now() })) void useAwayStore.getState().ping();
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    // Voltar para a aba conta como entrada: é o momento em que o dono volta de verdade.
    touch();
    tick();
  };
  const events = ["pointermove", "pointerdown", "keydown", "touchstart", "scroll"] as const;
  for (const name of events) window.addEventListener(name, touch, { passive: true });
  document.addEventListener("visibilitychange", onVisible);
  tick();
  const timer = window.setInterval(tick, PRESENCE_EVERY_MS);
  return () => {
    for (const name of events) window.removeEventListener(name, touch);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}
