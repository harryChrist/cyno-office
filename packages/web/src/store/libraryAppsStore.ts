import type { AppsListing, ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { describeError } from "../api/client";
import { appsApi } from "../api/libraryApps";
import { applyAppsEvent } from "../pages/library/apps/appsView";

const MAX_LOG_LINES = 3000;

type LibraryAppsState = {
  /** O catálogo com o que está instalado (GET /api/library/apps + eventos library:app*); null = ainda não carregado. */
  listing: AppsListing | null;
  error: string | null;
  /** Linhas do log por job (ao vivo; o que veio antes de abrir a página vem do GET do log). */
  logs: Record<string, string[]>;
  /** Avisos curtos por app ("Instalação cancelada e limpa"), que o cartão mostra e o dono dispensa. */
  flash: Record<string, string>;
  load: () => Promise<void>;
  loadLog: (jobId: string) => Promise<void>;
  apply: (event: ServerEvent) => void;
  dismissFlash: (appId: string) => void;
};

/** Os apps externos da Biblioteca (plataforma inteira). Os eventos chegam por qualquer socket de workspace. */
export const useLibraryAppsStore = create<LibraryAppsState>()((set, get) => ({
  listing: null,
  error: null,
  logs: {},
  flash: {},

  async load() {
    try {
      set({ listing: await appsApi.list(), error: null });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loadLog(jobId) {
    if (get().logs[jobId]) return;
    const text = await appsApi.log(jobId).catch(() => "");
    const lines = text.split("\n").filter((line) => line.length > 0);
    // Linhas que chegaram ao vivo durante o GET ficam por cima do que já estava no arquivo.
    set((state) => ({ logs: { ...state.logs, [jobId]: state.logs[jobId] && state.logs[jobId]!.length > lines.length ? state.logs[jobId]! : lines } }));
  },

  apply(event) {
    if (event.type === "library:job-log") {
      set((state) => {
        const lines = [...(state.logs[event.jobId] ?? []), event.line];
        return { logs: { ...state.logs, [event.jobId]: lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines } };
      });
      return;
    }
    if (event.type !== "library:app" && event.type !== "library:app-removed" && event.type !== "library:job" && event.type !== "library:app-run") return;
    if (event.type === "library:app-run") {
      set({ listing: applyAppsEvent(get().listing, event) });
      return;
    }
    const flash = { ...get().flash };
    if (event.type === "library:job" && event.job.phase === "cancelado") flash[event.job.appId] = "Instalação cancelada. A pasta, o conector e o que foi baixado só para ela foram apagados.";
    if (event.type === "library:job" && event.job.kind === "uninstall" && event.job.phase === "pronto") flash[event.job.appId] = "Desinstalado: a pasta, o conector e as liberações foram removidos.";
    set({ listing: applyAppsEvent(get().listing, event), flash });
    // Terminou: recarrega (requisitos da máquina, atualização disponível, runtimes e tamanhos).
    if (event.type === "library:job" && (event.job.phase === "pronto" || event.job.phase === "cancelado")) void get().load();
  },

  dismissFlash(appId) {
    const flash = { ...get().flash };
    delete flash[appId];
    set({ flash });
  },
}));
