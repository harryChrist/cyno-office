import type { Workspace } from "@cyno/shared";
import { create } from "zustand";
import { useNavStore } from "./navStore";

type WorkspaceListState = {
  /** Lista de workspaces (chega pelo WebSocket em `workspaces:list`); null = ainda não chegou. */
  workspaces: Workspace[] | null;
  setList: (workspaces: Workspace[]) => void;
};

/**
 * Workspace válido para abrir: o atual se ele existe na lista; senão o primeiro.
 * (O "último usado" já entrou como atual na abertura, veja navStore.)
 */
export function pickWorkspace(current: string | null, workspaces: readonly Workspace[]): string | null {
  if (current && workspaces.some((ws) => ws.id === current)) return current;
  return workspaces[0]?.id ?? null;
}

export const useWorkspaceStore = create<WorkspaceListState>()((set) => ({
  workspaces: null,
  setList: (workspaces) => {
    set({ workspaces });
    // O atual sumiu (excluído) ou nunca existiu: vai para um que existe.
    const nav = useNavStore.getState();
    // Também completa o endereço (#/<ws>/<página>) se ele ainda não tinha o workspace.
    const next = pickWorkspace(nav.workspaceId, workspaces);
    if (next) nav.setWorkspace(next);
    // Nenhum workspace: o endereço perde o workspace e a UI mostra o estado vazio.
    else if (nav.workspaceId !== null) nav.clearWorkspace();
  },
}));

/**
 * O que a UI mostra: `loading` enquanto a lista não chegou (ou o workspace do endereço ainda está
 * sendo trocado), `empty` sem workspace nenhum e `ready` com o workspace atual na lista.
 */
export type WorkspaceView = "loading" | "empty" | "ready";

export function workspaceView(workspaces: readonly Workspace[] | null, current: string | null): WorkspaceView {
  if (workspaces === null) return "loading";
  if (workspaces.length === 0) return "empty";
  return current !== null && workspaces.some((ws) => ws.id === current) ? "ready" : "loading";
}

/** Estado da UI em relação aos workspaces (veja workspaceView). */
export function useWorkspaceView(): WorkspaceView {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const current = useNavStore((state) => state.workspaceId);
  return workspaceView(workspaces, current);
}

/** Nome do workspace atual (ou null enquanto a lista não chegou). */
export function currentWorkspaceName(workspaces: readonly Workspace[] | null, id: string | null): string | null {
  return workspaces?.find((ws) => ws.id === id)?.name ?? null;
}
