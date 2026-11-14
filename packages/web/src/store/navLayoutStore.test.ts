import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RAIL_BELOW,
  clampNavWidth,
  initialCollapsed,
  isNavToggleShortcut,
  NAV_SNAP_TO_RAIL,
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  NAV_WIDTH_STEP,
  navWidthKey,
  resolveNavDrag,
  savedCollapsed,
  savedNavWidth,
  useNavLayoutStore,
} from "./navLayoutStore";

/** localStorage de mentira (o ambiente dos testes é node). */
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

describe("navLayoutStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: fakeStorage(), innerWidth: 1440 });
    useNavLayoutStore.setState({ collapsed: false, width: NAV_WIDTH_DEFAULT, dragging: false, dragFrom: NAV_WIDTH_DEFAULT, drawerOpen: false, panel: null });
  });

  it("sem escolha salva, recolhe só em telas estreitas", () => {
    expect(savedCollapsed()).toBeNull();
    expect(initialCollapsed(AUTO_RAIL_BELOW - 1)).toBe(true);
    expect(initialCollapsed(AUTO_RAIL_BELOW)).toBe(false);
  });

  it("lembra a escolha de recolher e ela vale em qualquer largura", () => {
    useNavLayoutStore.getState().toggleCollapsed();
    expect(useNavLayoutStore.getState().collapsed).toBe(true);
    expect(savedCollapsed()).toBe(true);
    expect(initialCollapsed(1920)).toBe(true);
    useNavLayoutStore.getState().toggleCollapsed();
    expect(initialCollapsed(800)).toBe(false);
  });

  it("sem armazenamento (aba privada) não quebra: só não lembra", () => {
    vi.stubGlobal("window", {
      innerWidth: 1440,
      get localStorage(): Storage {
        throw new Error("bloqueado");
      },
    });
    expect(savedCollapsed()).toBeNull();
    expect(() => useNavLayoutStore.getState().toggleCollapsed()).not.toThrow();
    expect(useNavLayoutStore.getState().collapsed).toBe(true);
  });

  it("o mesmo item abre e fecha o painel; outro item troca de painel", () => {
    const { togglePanel, closePanel } = useNavLayoutStore.getState();
    togglePanel("notificacoes");
    expect(useNavLayoutStore.getState().panel).toBe("notificacoes");
    togglePanel("agentes");
    expect(useNavLayoutStore.getState().panel).toBe("agentes");
    togglePanel("agentes");
    expect(useNavLayoutStore.getState().panel).toBeNull();
    togglePanel("notificacoes");
    closePanel();
    expect(useNavLayoutStore.getState().panel).toBeNull();
  });

  it("a largura fica entre o mínimo e o máximo (e valor estragado vira a padrão)", () => {
    expect(clampNavWidth(120)).toBe(NAV_WIDTH_MIN);
    expect(clampNavWidth(999)).toBe(NAV_WIDTH_MAX);
    expect(clampNavWidth(287.6)).toBe(288);
    expect(clampNavWidth(Number.NaN)).toBe(NAV_WIDTH_DEFAULT);
    expect(savedNavWidth()).toBe(NAV_WIDTH_DEFAULT);
    window.localStorage.setItem("agent-office:nav-width", "abc");
    expect(savedNavWidth()).toBe(NAV_WIDTH_DEFAULT);
    window.localStorage.setItem("agent-office:nav-width", "5000");
    expect(savedNavWidth()).toBe(NAV_WIDTH_MAX);
  });

  it("arrastar abaixo do limite recolhe e guarda a última largura aberta; voltar para fora abre", () => {
    expect(resolveNavDrag(NAV_SNAP_TO_RAIL - 1, 300)).toEqual({ collapsed: true, width: 300 });
    expect(resolveNavDrag(NAV_SNAP_TO_RAIL, 300)).toEqual({ collapsed: false, width: NAV_WIDTH_MIN });
    expect(resolveNavDrag(320, 300)).toEqual({ collapsed: false, width: 320 });
    expect(resolveNavDrag(500, 300)).toEqual({ collapsed: false, width: NAV_WIDTH_MAX });
  });

  it("o arraste só salva no fim, e a largura e a recolhida voltam ao recarregar", () => {
    const store = useNavLayoutStore.getState();
    store.startDrag();
    store.dragTo(320);
    expect(useNavLayoutStore.getState()).toMatchObject({ width: 320, collapsed: false, dragging: true });
    expect(window.localStorage.getItem("agent-office:nav-width")).toBeNull();
    store.endDrag();
    expect(useNavLayoutStore.getState().dragging).toBe(false);
    expect(savedNavWidth()).toBe(320);
    expect(savedCollapsed()).toBe(false);

    // No caminho até recolher a barra passa pela largura mínima, mas guarda a de antes do arraste.
    store.startDrag();
    store.dragTo(210);
    store.dragTo(80);
    store.endDrag();
    expect(useNavLayoutStore.getState()).toMatchObject({ collapsed: true, width: 320 });
    expect(savedCollapsed()).toBe(true);
    expect(savedNavWidth()).toBe(320);
  });

  it("teclas do puxador: setas, Home/End, Enter; seta à esquerda no mínimo recolhe", () => {
    const open = { collapsed: false, width: 240 };
    expect(navWidthKey("ArrowRight", false, open)).toEqual({ collapsed: false, width: 240 + NAV_WIDTH_STEP });
    expect(navWidthKey("ArrowLeft", true, { collapsed: false, width: 300 })).toEqual({ collapsed: false, width: 300 - 3 * NAV_WIDTH_STEP });
    expect(navWidthKey("ArrowLeft", true, open)).toEqual({ collapsed: false, width: NAV_WIDTH_MIN });
    expect(navWidthKey("Home", false, open)).toEqual({ collapsed: false, width: NAV_WIDTH_MIN });
    expect(navWidthKey("End", false, open)).toEqual({ collapsed: false, width: NAV_WIDTH_MAX });
    expect(navWidthKey("ArrowLeft", false, { collapsed: false, width: NAV_WIDTH_MIN })).toEqual({ collapsed: true, width: NAV_WIDTH_MIN });
    expect(navWidthKey("ArrowRight", false, { collapsed: true, width: 300 })).toEqual({ collapsed: false, width: 300 });
    expect(navWidthKey("ArrowLeft", false, { collapsed: true, width: 300 })).toBeNull();
    expect(navWidthKey("Enter", false, open)).toEqual({ collapsed: true, width: 240 });
    expect(navWidthKey("a", false, open)).toBeNull();
  });

  it("Ctrl+B / ⌘B alterna, mas não digitando, no terminal, com janela aberta ou já tratado", () => {
    const key = { key: "b", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, repeat: false };
    const free = { typing: false, terminal: false, modalOpen: false };
    expect(isNavToggleShortcut(key, free)).toBe(true);
    expect(isNavToggleShortcut({ ...key, ctrlKey: false, metaKey: true, key: "B" }, free)).toBe(true);
    expect(isNavToggleShortcut({ ...key, ctrlKey: false }, free)).toBe(false);
    expect(isNavToggleShortcut({ ...key, shiftKey: true }, free)).toBe(false);
    expect(isNavToggleShortcut({ ...key, defaultPrevented: true }, free)).toBe(false);
    expect(isNavToggleShortcut(key, { ...free, typing: true })).toBe(false);
    expect(isNavToggleShortcut(key, { ...free, terminal: true })).toBe(false);
    expect(isNavToggleShortcut(key, { ...free, modalOpen: true })).toBe(false);
  });
});
