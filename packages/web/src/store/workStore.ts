import { expandAvulsas, isPlanProject, type Plan, type Project, type ServerEvent } from "@cyno/shared";
import { create } from "zustand";
import { detectHandoffs, type Handoff } from "../pages/work/planView";

/** Uma passagem de etapa sendo mostrada no escritório (só visual). */
export type HandoffMark = Handoff & { id: number; at: number };

/** Quanto tempo o papel leva de um agente ao outro (e some). */
export const HANDOFF_MS = 2600;

type WorkState = {
  /**
   * Todos os projetos do workspace (vêm no office:snapshot e nos eventos project:*), inclusive as tarefas
   * avulsas: o servidor guarda cada pedido simples como folha do projeto fixo "Avulsas" e aqui cada um volta
   * a ser um projeto `kind: "tarefa"` (id do pedido), que é o que a tela atual lê.
   */
  projects: Project[];
  /** Os projetos como o servidor mandou (com o "Avulsas" inteiro). */
  rawProjects: Project[];
  /** Só os que vieram de um plano (aprovação do usuário): quem detecta as passagens de etapa do escritório. */
  plans: Plan[];
  /** Passagens de etapa em curso (o papel indo de um agente ao próximo). */
  handoffs: HandoffMark[];
  /** Projeto a abrir na trilha da página Trabalho (pedido de foco: a página abre a linha e limpa o pedido). */
  openProjectId: string | null;
  /** Filtro pré-ligado para a página Trabalho (o resumo da Gestão abre "só com prazo em risco"); a página consome e limpa. */
  openAtRisk: boolean;
  apply: (event: ServerEvent) => void;
  /** Pede à página Trabalho para abrir um projeto (quem chama também navega para a página). */
  open: (projectId: string | null) => void;
  /** Pede à página Trabalho para abrir filtrada por "prazo em risco" (quem chama também navega). */
  openFiltered: (atRisk: boolean) => void;
  reset: () => void;
};

let handoffSeq = 0;

/** Os eventos de plano (e o office:snapshot) passam por aqui. */
export const isPlanEvent = (event: ServerEvent): event is Extract<ServerEvent, { type: "project:upserted" | "project:deleted" | "project:removed" }> =>
  event.type === "project:upserted" || event.type === "project:deleted" || event.type === "project:removed";

export const useWorkStore = create<WorkState>()((set, get) => ({
  projects: [],
  rawProjects: [],
  plans: [],
  handoffs: [],
  openProjectId: null,
  openAtRisk: false,

  apply(event) {
    if (event.type === "office:snapshot") {
      if (event.projects) set({ rawProjects: event.projects, projects: expandAvulsas(event.projects), plans: event.projects.filter(isPlanProject) });
      return;
    }
    // "project:removed" = o dono apagou o projeto de vez; sai da lista como no "project:deleted".
    if (event.type === "project:deleted" || event.type === "project:removed") {
      const raw = get().rawProjects.filter((project) => project.id !== event.id);
      set({ rawProjects: raw, projects: expandAvulsas(raw), plans: raw.filter(isPlanProject) });
      return;
    }
    if (event.type !== "project:upserted") return;
    const { rawProjects, plans } = get();
    const nextRaw = rawProjects.some((project) => project.id === event.project.id) ? rawProjects.map((project) => (project.id === event.project.id ? event.project : project)) : [...rawProjects, event.project];
    const nextProjects = expandAvulsas(nextRaw);
    if (!isPlanProject(event.project)) {
      set({ rawProjects: nextRaw, projects: nextProjects });
      return;
    }
    const previous = plans.find((plan) => plan.id === event.project.id);
    const next = previous ? plans.map((plan) => (plan.id === event.project.id ? event.project : plan)) : [...plans, event.project];
    const fresh = detectHandoffs(previous, event.project).map((handoff): HandoffMark => ({ ...handoff, id: ++handoffSeq, at: Date.now() }));
    set({ rawProjects: nextRaw, projects: nextProjects, plans: next, ...(fresh.length > 0 ? { handoffs: [...get().handoffs, ...fresh] } : {}) });
    for (const mark of fresh) {
      if (typeof window === "undefined") continue;
      window.setTimeout(() => set({ handoffs: get().handoffs.filter((candidate) => candidate.id !== mark.id) }), HANDOFF_MS + 200);
    }
  },

  open(projectId) {
    set({ openProjectId: projectId });
  },

  openFiltered(atRisk) {
    set({ openAtRisk: atRisk });
  },

  reset() {
    set({ projects: [], rawProjects: [], plans: [], handoffs: [], openProjectId: null, openAtRisk: false });
  },
}));
