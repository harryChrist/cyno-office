import { create } from "zustand";
import { clampZoom, stepZoom, type ZoomLevel } from "../cena/zoom";

/** Espaço (px) que um painel ocupa em cada borda da tela. */
export type Insets = { top: number; right: number; bottom: number; left: number };
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** O que está selecionado (abre o painel lateral correspondente). */
export type Selection = { kind: "agent"; id: string } | { kind: "room"; id: string } | null;

/** Para onde a câmera olha: mapa geral (todos os quartos) ou um quarto/lobby enquadrado. */
export type Focus = { kind: "map" } | { kind: "room"; id: string };

type ViewState = {
  zoom: ZoomLevel;
  /** Zoom mostrado durante a animação de foco (troca a cada degrau inteiro); null fora dela. */
  animZoom: number | null;
  selection: Selection;
  focus: Focus;
  /**
   * Seleciona um agente/quarto (o canvas chama ao clicar; os painéis leem). Com outro quarto focado,
   * selecionar um quarto leva o foco para ele (o painel nunca fala de um quarto fora da tela).
   */
  select: (selection: Selection) => void;
  /** Muda o foco da câmera (o canvas reage enquadrando; botões da UI chamam). Use id "lobby" para o lobby. */
  setFocus: (focus: Focus) => void;
  /**
   * "Ver no mapa" de um agente: o canvas foca o quarto onde ele ESTÁ agora (pode estar passeando fora de
   * casa); `fallback` é o quarto de casa, usado se o canvas não souber onde ele está. `seq` faz cada
   * pedido contar, mesmo repetido.
   */
  showAgentRequest: { id: string; fallback: string; seq: number } | null;
  showAgent: (id: string, fallback: string) => void;
  /** Áreas cobertas por painéis (por chave). A câmera enquadra o escritório no que sobra. */
  overlays: Record<string, Insets>;
  setZoom: (zoom: number) => void;
  setAnimZoom: (zoom: number | null) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Um painel informa o espaço que cobre (null = não cobre nada). */
  setOverlay: (key: string, insets: Insets | null) => void;
};

export const useViewStore = create<ViewState>()((set) => ({
  zoom: 2,
  animZoom: null,
  overlays: {},
  selection: null,
  focus: { kind: "map" },
  select: (selection) =>
    set((state) => {
      const moveFocus = selection?.kind === "room" && state.focus.kind === "room" && state.focus.id !== selection.id;
      return moveFocus ? { selection, focus: { kind: "room", id: selection.id } } : { selection };
    }),
  setFocus: (focus) => set({ focus }),
  showAgentRequest: null,
  showAgent: (id, fallback) => set((state) => ({ showAgentRequest: { id, fallback, seq: (state.showAgentRequest?.seq ?? 0) + 1 } })),
  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
  setAnimZoom: (animZoom) => set((state) => (state.animZoom === animZoom ? state : { animZoom })),
  zoomIn: () => set((state) => ({ zoom: stepZoom(state.zoom, 1) })),
  zoomOut: () => set((state) => ({ zoom: stepZoom(state.zoom, -1) })),
  setOverlay: (key, insets) =>
    set((state) => {
      const current = state.overlays[key];
      if (!insets && !current) return state;
      if (insets && current && (Object.keys(insets) as (keyof Insets)[]).every((k) => insets[k] === current[k])) return state;
      const overlays = { ...state.overlays };
      if (insets) overlays[key] = insets;
      else delete overlays[key];
      return { overlays };
    }),
}));

/** Soma das bordas cobertas (o maior valor de cada lado). */
/** Painéis fixos (sempre na tela): só eles tiram espaço da câmera. Os outros flutuam por cima do escritório. */
const FIXED_OVERLAYS = new Set(["topbar", "sidebar", "task-box"]);

export function fixedOverlays(overlays: Record<string, Insets>): Record<string, Insets> {
  return Object.fromEntries(Object.entries(overlays).filter(([key]) => FIXED_OVERLAYS.has(key)));
}

export function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export function combinedInsets(overlays: Record<string, Insets>): Insets {
  return Object.values(overlays).reduce(
    (acc, o) => ({ top: Math.max(acc.top, o.top), right: Math.max(acc.right, o.right), bottom: Math.max(acc.bottom, o.bottom), left: Math.max(acc.left, o.left) }),
    NO_INSETS,
  );
}
