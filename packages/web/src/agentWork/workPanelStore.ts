import { isMaestroAgent } from "@cyno/shared";
import { create } from "zustand";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";

/**
 * Qual tela de trabalho de agente está aberta (dialog por cima de tudo). O Maestro não entra aqui:
 * o painel dele é acoplado à caixa "Fale com o Maestro" do rodapé (`maestroOpen`).
 */
export type WorkPanelTarget = { kind: "maestro" } | { kind: "agent"; agentId: string } | null;

/** Abas do painel acoplado do Maestro. */
export const MAESTRO_TABS = ["conversa", "pedidos", "atividade", "terminal"] as const;
export type MaestroTab = (typeof MAESTRO_TABS)[number];

const TAB_KEY = "agent-office:maestro-tab";

function readTab(): MaestroTab | null {
  try {
    const saved = window.localStorage.getItem(TAB_KEY);
    return (MAESTRO_TABS as readonly string[]).includes(saved ?? "") ? (saved as MaestroTab) : null;
  } catch {
    return null;
  }
}

function writeTab(tab: MaestroTab): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Sem armazenamento: só não lembra a aba.
  }
}

type WorkPanelState = {
  /** A tela de trabalho de um agente aberta (null = nenhuma). */
  target: Exclude<WorkPanelTarget, { kind: "maestro" }> | null;
  /** O painel do Maestro, acoplado à caixa do rodapé, está aberto? */
  maestroOpen: boolean;
  /** A aba que o painel do Maestro mostra (lembrada neste navegador; null = a padrão). */
  maestroTab: MaestroTab | null;
  /** Sobe a cada pedido para abrir o Maestro: a caixa leva o foco para o campo. */
  maestroFocus: number;
  /** Texto para pré-preencher a caixa do Maestro (a caixa lê e zera; nada é enviado sozinho). */
  maestroDraft: string | null;
  /** Abre (ou troca) a tela. O Maestro (ou um agente que é o Maestro) abre o painel acoplado. */
  open: (target: Exclude<WorkPanelTarget, null>) => void;
  openAgent: (agentId: string) => void;
  /** Abre o painel do Maestro (vai para o Office, se preciso) e põe o foco no campo. */
  openMaestro: () => void;
  /** Abre o painel do Maestro com a caixa já preenchida com `text` (o usuário revisa e envia). */
  openMaestroWith: (text: string) => void;
  /** Recolhe o painel do Maestro (a caixa continua no rodapé). */
  collapseMaestro: () => void;
  setMaestroTab: (tab: MaestroTab) => void;
  /** Fecha a tela de trabalho de agente aberta. */
  close: () => void;
};

/** O agente é o Maestro do escritório carregado? */
function isMaestroId(agentId: string): boolean {
  const office = useOfficeStore.getState().office;
  const agent = office?.agents.find((candidate) => candidate.id === agentId);
  return Boolean(office && agent && isMaestroAgent(office, agent));
}

/**
 * As telas de trabalho: a de um agente (uma por vez, dialog que flutua por cima de tudo; quem
 * desenha é o WorkPanelHost) e o painel do Maestro, que faz parte da página (a caixa do rodapé
 * cresce para cima e o escritório continua à vista e clicável).
 */
export const useWorkPanelStore = create<WorkPanelState>()((set, get) => ({
  target: null,
  maestroOpen: false,
  maestroTab: readTab(),
  maestroFocus: 0,
  maestroDraft: null,
  open: (target) => (target.kind === "maestro" ? get().openMaestro() : get().openAgent(target.agentId)),
  openAgent: (agentId) => (isMaestroId(agentId) ? get().openMaestro() : set({ target: { kind: "agent", agentId } })),
  openMaestro: () => {
    const nav = useNavStore.getState();
    if (nav.page !== "office") nav.go("office");
    set((state) => ({ target: null, maestroOpen: true, maestroFocus: state.maestroFocus + 1 }));
  },
  openMaestroWith: (text) => {
    set({ maestroDraft: text });
    get().openMaestro();
  },
  collapseMaestro: () => set({ maestroOpen: false }),
  setMaestroTab: (tab) => {
    writeTab(tab);
    set({ maestroTab: tab });
  },
  close: () => set({ target: null }),
}));

// Saiu do Office (Trabalho, Configurações…): o painel do Maestro recolhe (ele é parte do Office).
useNavStore.subscribe((state, prev) => {
  if (prev.page === "office" && state.page !== "office" && useWorkPanelStore.getState().maestroOpen) useWorkPanelStore.getState().collapseMaestro();
});
