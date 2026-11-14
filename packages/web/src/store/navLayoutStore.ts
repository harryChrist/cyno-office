import { create } from "zustand";

/** Painel que abre ao lado da barra lateral (ou como folha, no celular). */
export type NavPanel = "notificacoes" | "hoje" | "agentes" | "uso";

/** Abaixo disso a barra lateral vira a gaveta do celular (barra curta em cima + menu). */
export const MOBILE_NAV_QUERY = "(max-width: 767px)";

/** Sem escolha salva, telas mais estreitas que isso (px) começam com a barra recolhida (só ícones). */
export const AUTO_RAIL_BELOW = 1200;

/** Larguras da barra aberta (px): o arraste fica entre o mínimo e o máximo. */
export const NAV_WIDTH_MIN = 200;
export const NAV_WIDTH_MAX = 360;
export const NAV_WIDTH_DEFAULT = 232;
/** Largura da barra recolhida (só ícones), em px. Igual ao --sidenav-rail-w do appNav.css. */
export const NAV_RAIL_WIDTH = 60;
/** Arrastar a borda para menos que isso (px) recolhe a barra; passar disso de volta abre de novo. */
export const NAV_SNAP_TO_RAIL = 140;
/** Passo das setas no puxador (px); com Shift, o triplo. */
export const NAV_WIDTH_STEP = 16;

const COLLAPSED_KEY = "agent-office:nav-collapsed";
const WIDTH_KEY = "agent-office:nav-width";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sem armazenamento (aba privada): só não lembra.
  }
}

/** Escolha salva (recolhida ou aberta); null = nunca escolheu (ou sem armazenamento). */
export function savedCollapsed(): boolean | null {
  const value = readStorage(COLLAPSED_KEY);
  return value === "1" ? true : value === "0" ? false : null;
}

/** Começa recolhida? A escolha salva vale; sem ela, depende da largura da tela. */
export function initialCollapsed(width: number): boolean {
  return savedCollapsed() ?? width < AUTO_RAIL_BELOW;
}

/** Largura da barra aberta dentro dos limites (arredondada para o pixel). */
export function clampNavWidth(width: number): number {
  if (!Number.isFinite(width)) return NAV_WIDTH_DEFAULT;
  return Math.round(Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, width)));
}

/** Largura salva (já dentro dos limites); sem nada salvo (ou valor estragado), a padrão. */
export function savedNavWidth(): number {
  const value = readStorage(WIDTH_KEY);
  const parsed = value === null ? Number.NaN : Number(value);
  return clampNavWidth(parsed);
}

/**
 * Onde o arraste da borda deixa a barra: abaixo de `NAV_SNAP_TO_RAIL` ela recolhe (e guarda a
 * última largura aberta para quando abrir de novo); acima, abre na largura arrastada, nos limites.
 */
export function resolveNavDrag(rawWidth: number, lastWidth: number): { collapsed: boolean; width: number } {
  if (rawWidth < NAV_SNAP_TO_RAIL) return { collapsed: true, width: lastWidth };
  return { collapsed: false, width: clampNavWidth(rawWidth) };
}

/**
 * Teclas no puxador (padrão "divisor de janela"): setas mudam a largura (a seta para a esquerda
 * na largura mínima recolhe; a da direita na recolhida abre), Home/End vão aos limites e Enter
 * alterna recolhida/aberta. null = tecla que o puxador não trata.
 */
export function navWidthKey(key: string, shift: boolean, state: { collapsed: boolean; width: number }): { collapsed: boolean; width: number } | null {
  const step = NAV_WIDTH_STEP * (shift ? 3 : 1);
  if (key === "Enter") return { collapsed: !state.collapsed, width: state.width };
  if (state.collapsed) return key === "ArrowRight" || key === "End" ? { collapsed: false, width: key === "End" ? NAV_WIDTH_MAX : state.width } : null;
  if (key === "ArrowLeft") return state.width <= NAV_WIDTH_MIN ? { collapsed: true, width: state.width } : { collapsed: false, width: clampNavWidth(state.width - step) };
  if (key === "ArrowRight") return { collapsed: false, width: clampNavWidth(state.width + step) };
  if (key === "Home") return { collapsed: false, width: NAV_WIDTH_MIN };
  if (key === "End") return { collapsed: false, width: NAV_WIDTH_MAX };
  return null;
}

/**
 * Atalho para recolher/abrir a barra: Ctrl+B (⌘B no Mac). Fica de fora quando a tecla é de outro
 * dono: digitando num campo (negrito), no terminal do Maestro (o Claude Code usa Ctrl+B), na tela
 * do Navegador (que repassa as teclas e marca o evento) ou com uma janela aberta.
 */
export function isNavToggleShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "repeat">, context: { typing: boolean; terminal: boolean; modalOpen: boolean }): boolean {
  if (event.key.toLowerCase() !== "b" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  return !event.defaultPrevented && !event.repeat && !context.typing && !context.terminal && !context.modalOpen;
}

type NavLayoutState = {
  /** Barra lateral recolhida (só ícones, com dicas ao passar o mouse). */
  collapsed: boolean;
  /** Largura da barra aberta (px); recolhida, fica guardada para quando abrir de novo. */
  width: number;
  /** A borda está sendo arrastada (a câmera só se ajusta no fim). */
  dragging: boolean;
  /** Largura de quando o arraste começou: recolher arrastando guarda esta (não a mínima do caminho). */
  dragFrom: number;
  /** Gaveta do celular aberta. */
  drawerOpen: boolean;
  /** Painel aberto ao lado da barra (notificações ou agentes). */
  panel: NavPanel | null;
  toggleCollapsed: () => void;
  /** Recolhida e largura de uma vez (teclas do puxador), já salvas. */
  setLayout: (layout: { collapsed: boolean; width: number }) => void;
  startDrag: () => void;
  /** Durante o arraste: a largura crua que a borda alcançou (sem salvar a cada quadro). */
  dragTo: (rawWidth: number) => void;
  /** Fim do arraste: salva a largura e se ficou recolhida. */
  endDrag: () => void;
  setDrawerOpen: (open: boolean) => void;
  /** Abre o painel (ou fecha, se já era ele). */
  togglePanel: (panel: NavPanel) => void;
  closePanel: () => void;
};

function saveLayout(collapsed: boolean, width: number): void {
  writeStorage(COLLAPSED_KEY, collapsed ? "1" : "0");
  writeStorage(WIDTH_KEY, String(width));
}

export const useNavLayoutStore = create<NavLayoutState>()((set, get) => ({
  collapsed: typeof window === "undefined" ? false : initialCollapsed(window.innerWidth),
  width: typeof window === "undefined" ? NAV_WIDTH_DEFAULT : savedNavWidth(),
  dragging: false,
  dragFrom: NAV_WIDTH_DEFAULT,
  drawerOpen: false,
  panel: null,
  toggleCollapsed: () => {
    const { collapsed, width } = get();
    saveLayout(!collapsed, width);
    set({ collapsed: !collapsed });
  },
  setLayout: ({ collapsed, width }) => {
    const clamped = clampNavWidth(width);
    saveLayout(collapsed, clamped);
    set({ collapsed, width: clamped });
  },
  startDrag: () => set((state) => ({ dragging: true, dragFrom: state.width })),
  dragTo: (rawWidth) => {
    const next = resolveNavDrag(rawWidth, get().dragFrom);
    const { collapsed, width } = get();
    if (next.collapsed !== collapsed || next.width !== width) set(next);
  },
  endDrag: () => {
    const { collapsed, width } = get();
    saveLayout(collapsed, width);
    set({ dragging: false });
  },
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  togglePanel: (panel) => set((state) => ({ panel: state.panel === panel ? null : panel })),
  closePanel: () => set({ panel: null }),
}));
