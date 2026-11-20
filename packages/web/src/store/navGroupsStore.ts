import { create } from "zustand";

/** O que o dono escolheu para os grupos da barra (Gestão, Biblioteca): aberto ou fechado, lembrado por navegador. */
const GROUPS_KEY = "cyno:nav-groups";

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

/** As escolhas salvas, por grupo (valor estragado = nenhuma escolha: cada grupo segue a página atual). */
export function savedGroupChoices(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(read(GROUPS_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

type NavGroupsState = {
  choices: Record<string, boolean>;
  /** Lembra que o dono abriu (true) ou fechou (false) o grupo. */
  choose: (group: string, open: boolean) => void;
  /** Esquece a escolha (o grupo volta a seguir a página atual). */
  clear: (group: string) => void;
};

export const useNavGroupsStore = create<NavGroupsState>()((set, get) => ({
  choices: savedGroupChoices(),
  choose: (group, open) => {
    if (get().choices[group] === open) return;
    const choices = { ...get().choices, [group]: open };
    write(GROUPS_KEY, JSON.stringify(choices));
    set({ choices });
  },
  clear: (group) => {
    if (!(group in get().choices)) return;
    const { [group]: _gone, ...choices } = get().choices;
    write(GROUPS_KEY, JSON.stringify(choices));
    set({ choices });
  },
}));
