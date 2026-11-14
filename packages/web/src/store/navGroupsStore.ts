import { create } from "zustand";

/** Grupos recolhidos da barra (Gestão, Biblioteca) e o aviso "o menu foi reorganizado": lembrados por navegador. */
const GROUPS_KEY = "cyno:nav-groups-collapsed";
const MOVED_KEY = "cyno:nav-moved-hint-dismissed";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sem armazenamento (aba privada): só não lembra.
  }
}

/** Os grupos que o dono recolheu (todos abertos por padrão; valor estragado = todos abertos). */
export function savedCollapsedGroups(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(GROUPS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

type NavGroupsState = {
  collapsed: string[];
  /** O aviso de "onde foi parar" já foi dispensado neste navegador? */
  movedDismissed: boolean;
  isOpen: (group: string) => boolean;
  toggle: (group: string) => void;
  dismissMoved: () => void;
};

export const useNavGroupsStore = create<NavGroupsState>()((set, get) => ({
  collapsed: savedCollapsedGroups(),
  movedDismissed: read(MOVED_KEY) === "1",
  isOpen: (group) => !get().collapsed.includes(group),
  toggle: (group) => {
    const current = get().collapsed;
    const collapsed = current.includes(group) ? current.filter((id) => id !== group) : [...current, group];
    write(GROUPS_KEY, JSON.stringify(collapsed));
    set({ collapsed });
  },
  dismissMoved: () => {
    write(MOVED_KEY, "1");
    set({ movedDismissed: true });
  },
}));
