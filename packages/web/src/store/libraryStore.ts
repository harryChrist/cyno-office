import type { LibraryConnector, LibrarySkillView, ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { applyLibraryEvent } from "../pages/library/libraryView";
import { applySkillEvent } from "../pages/library/skillsView";

type LibraryState = {
  /** Conectores da Biblioteca (GET /api/library/connectors + eventos library:*); null = ainda não carregados. */
  connectors: LibraryConnector[] | null;
  /** Skills da Biblioteca (GET /api/library/skills + eventos library:skill-*); null = ainda não carregadas. */
  skills: LibrarySkillView[] | null;
  skillsError: string | null;
  error: string | null;
  load: () => Promise<void>;
  loadSkills: () => Promise<void>;
  apply: (event: ServerEvent) => void;
};

/** Quantos library:* chegaram (um GET em voo que perdeu algum é repetido). */
let seenEvents = 0;
/** Idem para library:skill-*. */
let seenSkillEvents = 0;

/**
 * A Biblioteca da plataforma: fora do OfficeState e de qualquer workspace. Os eventos `library:*`
 * chegam por qualquer socket de workspace (vão para todos), então "quem usa" atualiza ao vivo.
 */
export const useLibraryStore = create<LibraryState>()((set, get) => ({
  connectors: null,
  skills: null,
  skillsError: null,
  error: null,

  async load() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = seenEvents;
      try {
        const connectors = await api.listLibraryConnectors();
        if (seen === seenEvents || attempt === 2) {
          set({ connectors, error: null });
          return;
        }
      } catch (error) {
        set({ error: describeError(error) });
        return;
      }
    }
  },

  async loadSkills() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = seenSkillEvents;
      try {
        const skills = await api.listLibrarySkills();
        if (seen === seenSkillEvents || attempt === 2) {
          set({ skills, skillsError: null });
          return;
        }
      } catch (error) {
        set({ skillsError: describeError(error) });
        return;
      }
    }
  },

  apply(event) {
    if (event.type === "library:skill-upserted" || event.type === "library:skill-deleted") {
      seenSkillEvents++;
      const skills = applySkillEvent(get().skills, event);
      if (skills !== get().skills) set({ skills });
      return;
    }
    if (event.type !== "library:upserted" && event.type !== "library:deleted") return;
    seenEvents++;
    const connectors = applyLibraryEvent(get().connectors, event);
    if (connectors !== get().connectors) set({ connectors });
  },
}));
