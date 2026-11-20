import type { ScriptRun, ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { removeRun, upsertRun } from "../pages/scripts/scriptsView";
import { useNavStore } from "./navStore";

type ScriptsStoreState = {
  /** Scripts do workspace atual (mais novos primeiro); null = ainda não carregado. */
  runs: ScriptRun[] | null;
  error: string | null;
  /** GET /scripts: rede de segurança ao abrir a página (o retrato e os eventos já mantêm a lista). */
  load: () => Promise<void>;
  /** A lista que veio no office:snapshot. */
  replace: (runs: ScriptRun[]) => void;
  apply: (event: ServerEvent) => void;
  reset: () => void;
};

/** Quantos eventos de script chegaram (um GET em voo que perdeu algum é descartado). */
let seen = 0;

/** Scripts dos agentes do workspace atual (fora do OfficeState, como o navegador e os conectores). */
export const useScriptsStore = create<ScriptsStoreState>()((set, get) => ({
  runs: null,
  error: null,

  async load() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const before = seen;
    try {
      const state = await api.listScripts();
      if (useNavStore.getState().workspaceId !== workspaceId || before !== seen) return;
      set({ runs: upsertAll(state.runs), error: null });
    } catch (error) {
      if (useNavStore.getState().workspaceId === workspaceId) set({ error: describeError(error) });
    }
  },

  replace(runs) {
    seen++;
    set({ runs: upsertAll(runs), error: null });
  },

  apply(event) {
    if (event.type === "script:updated") {
      seen++;
      set({ runs: upsertRun(get().runs ?? [], event.run) });
    } else if (event.type === "script:removed") {
      seen++;
      set({ runs: removeRun(get().runs ?? [], event.id) });
    }
  },

  reset() {
    seen++;
    set({ runs: null, error: null });
  },
}));

function upsertAll(runs: readonly ScriptRun[]): ScriptRun[] {
  return runs.reduce<ScriptRun[]>((all, run) => upsertRun(all, run), []);
}

export function isScriptEvent(event: ServerEvent): boolean {
  return event.type === "script:updated" || event.type === "script:removed";
}
