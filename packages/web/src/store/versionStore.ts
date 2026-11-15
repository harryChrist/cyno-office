import type { VersionResponse } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";

/** De quanto em quanto tempo a tela relê o último resultado do servidor (barato: sem rede no servidor). */
export const VERSION_POLL_MS = 10 * 60_000;

/** Enquanto a atualização baixa, a tela relê o andamento a cada 1,5 s. */
export const UPDATE_POLL_MS = 1500;

type VersionState = {
  /** Versão instalada e último resultado da verificação; null = ainda não carregado. */
  data: VersionResponse | null;
  error: string | null;
  /** O botão "Verificar agora" está em andamento. */
  checking: boolean;
  /** O pedido de "Baixar atualização" está a caminho do servidor. */
  starting: boolean;
  load: () => Promise<void>;
  /** Pede ao servidor para verificar agora. */
  check: () => Promise<void>;
  /** Pede ao servidor para baixar a atualização (ele baixa em segundo plano). Lança o erro (ex.: motivo do bloqueio). */
  update: () => Promise<void>;
};

let fastTimer: number | undefined;

/** Com a atualização em andamento, relê o servidor logo e repete até terminar. */
function followUpdate(response: VersionResponse | null): void {
  if (fastTimer !== undefined) {
    window.clearTimeout(fastTimer);
    fastTimer = undefined;
  }
  if (response?.update.job?.state !== "running") return;
  fastTimer = window.setTimeout(() => {
    fastTimer = undefined;
    void useVersionStore.getState().load();
  }, UPDATE_POLL_MS);
}

export const useVersionStore = create<VersionState>()((set) => ({
  data: null,
  error: null,
  checking: false,
  starting: false,
  async load() {
    try {
      const data = await api.getVersion();
      set({ data, error: null });
      followUpdate(data);
    } catch (error) {
      set({ error: describeError(error) });
      // uma falha de rede no meio do download não pode parar o acompanhamento
      if (useVersionStore.getState().data?.update.job?.state === "running") followUpdate(useVersionStore.getState().data);
    }
  },
  async update() {
    set({ starting: true, error: null });
    try {
      const data = await api.updateVersion();
      set({ data, starting: false });
      followUpdate(data);
    } catch (error) {
      set({ starting: false });
      void useVersionStore.getState().load();
      throw error;
    }
  },
  async check() {
    set({ checking: true, error: null });
    try {
      const data = await api.checkVersion();
      set({ data, checking: false });
      followUpdate(data);
    } catch (error) {
      set({ checking: false, error: describeError(error) });
    }
  },
}));

let watchers = 0;
let timer: number | undefined;

/** Mantém a versão carregada e a relê a cada 10 min enquanto houver quem olhe (barra, gaveta e Configurações compartilham). */
export function watchVersion(): () => void {
  watchers += 1;
  if (watchers === 1) {
    void useVersionStore.getState().load();
    timer = window.setInterval(() => void useVersionStore.getState().load(), VERSION_POLL_MS);
  } else if (useVersionStore.getState().data === null) {
    void useVersionStore.getState().load();
  }
  return () => {
    watchers -= 1;
    if (watchers === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
