import { LOBBY_ID } from "@cyno/shared";
import type { Selection as SelecaoDaCena } from "@cyno/cena";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOfficeStore } from "../store/officeStore";
import { NO_INSETS, useViewStore } from "../store/viewStore";
import { makeOffice } from "../test-fixtures";
import { CONFERE_SALA_MS, ESPERA_DA_SALA_MS, FOLGA_DO_PAINEL_MS, ligarInterface, type MundoInterativo } from "./ligarInterface";

/** Janela e documento mínimos: o que a ligação toca. */
function falsoNavegador() {
  const teclas = new Set<(e: unknown) => void>();
  vi.stubGlobal("window", {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: (tipo: string, fn: (e: unknown) => void) => tipo === "keydown" && teclas.add(fn),
    removeEventListener: (tipo: string, fn: (e: unknown) => void) => tipo === "keydown" && teclas.delete(fn),
  });
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("HTMLElement", class {});
  return { teclar: (key: string) => teclas.forEach((fn) => fn({ key, defaultPrevented: false, target: null })) };
}

function falsoMundo(presentes: string[] = ["ana", "caio"]) {
  let selecao: SelecaoDaCena = null;
  const ouvintes = new Set<(s: SelecaoDaCena) => void>();
  const mundo = {
    select: vi.fn((s: SelecaoDaCena) => {
      selecao = s;
      ouvintes.forEach((cb) => cb(s));
    }),
    getSelection: vi.fn(() => selecao),
    onSelect: vi.fn((cb: (s: SelecaoDaCena) => void) => {
      ouvintes.add(cb);
      return () => void ouvintes.delete(cb);
    }),
    focusAgent: vi.fn(),
    focusRoom: vi.fn(),
    overview: vi.fn(),
    zoomBy: vi.fn(),
    setViewInsets: vi.fn(),
    social: vi.fn((id: string) => (presentes.includes(id) ? ({} as never) : null)),
  } satisfies MundoInterativo;
  /** O dono clica na cena. */
  const clicar = (s: SelecaoDaCena) => {
    selecao = s;
    ouvintes.forEach((cb) => cb(s));
  };
  return { mundo, clicar };
}

describe("ligarInterface", () => {
  let nav: ReturnType<typeof falsoNavegador>;
  let desligar: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    nav = falsoNavegador();
    useViewStore.setState({ selection: null, focus: { kind: "map" }, overlays: {}, showAgentRequest: null });
    useOfficeStore.setState({ office: makeOffice() });
  });
  afterEach(() => {
    desligar?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const salaDoOffice = () => useOfficeStore.getState().office!.rooms[0]!.id;
  const passarFolga = () => vi.advanceTimersByTime(FOLGA_DO_PAINEL_MS + 5);

  it("informa a área livre ao ligar e quando um painel abre ou fecha", () => {
    const { mundo } = falsoMundo();
    desligar = ligarInterface(mundo);
    expect(mundo.setViewInsets).toHaveBeenLastCalledWith(NO_INSETS);
    useViewStore.getState().setOverlay("sidebar", { ...NO_INSETS, left: 256 });
    expect(mundo.setViewInsets).toHaveBeenLastCalledWith({ ...NO_INSETS, left: 256 });
    useViewStore.getState().setOverlay("side-panel", { ...NO_INSETS, right: 408 });
    expect(mundo.setViewInsets).toHaveBeenLastCalledWith({ ...NO_INSETS, left: 256, right: 408 });
    useViewStore.getState().setOverlay("side-panel", null);
    expect(mundo.setViewInsets).toHaveBeenLastCalledWith({ ...NO_INSETS, left: 256 });
  });

  it("clicar num personagem seleciona o agente; no subagente, o pai; no vazio, limpa", () => {
    const { mundo, clicar } = falsoMundo();
    desligar = ligarInterface(mundo);
    clicar({ type: "agent", id: "ana" });
    expect(useViewStore.getState().selection).toEqual({ kind: "agent", id: "ana" });
    clicar({ type: "agent", id: "caio::t1" });
    expect(useViewStore.getState().selection).toEqual({ kind: "agent", id: "caio" });
    clicar(null);
    expect(useViewStore.getState().selection).toBeNull();
  });

  it("clicar numa sala seleciona a sala; no núcleo, o lobby; sala desconhecida é ignorada", () => {
    const { mundo, clicar } = falsoMundo();
    desligar = ligarInterface(mundo);
    clicar({ type: "room", id: salaDoOffice() });
    expect(useViewStore.getState().selection).toEqual({ kind: "room", id: salaDoOffice() });
    clicar({ type: "room", id: "core:recepcao" });
    expect(useViewStore.getState().selection).toEqual({ kind: "room", id: LOBBY_ID });
    clicar({ type: "room", id: "fantasma" });
    expect(useViewStore.getState().selection).toEqual({ kind: "room", id: LOBBY_ID });
  });

  it("sala recém-criada: a interface espera a sala chegar à cena antes de selecionar e focar (senão a cena limpava a seleção)", () => {
    const { mundo } = falsoMundo();
    const salas = new Map<string, { listed: boolean }>();
    desligar = ligarInterface({ ...mundo, probe: () => ({ sim: { rooms: salas } }) });
    useViewStore.getState().select({ kind: "room", id: "nova" });
    useViewStore.getState().setFocus({ kind: "room", id: "nova" });
    passarFolga();
    vi.advanceTimersByTime(CONFERE_SALA_MS * 3);
    expect(mundo.select).not.toHaveBeenCalled();
    expect(mundo.focusRoom).not.toHaveBeenCalled();
    // O mapa recebe a sala: a seleção e o foco seguem.
    salas.set("nova", { listed: true });
    vi.advanceTimersByTime(CONFERE_SALA_MS + 5);
    expect(mundo.select).toHaveBeenCalledWith({ type: "room", id: "nova" }, expect.anything());
    expect(mundo.focusRoom).toHaveBeenCalledWith("nova");
  });

  it("sala que nunca chega: passado o prazo a interface empurra mesmo assim (a cena decide)", () => {
    const { mundo } = falsoMundo();
    desligar = ligarInterface({ ...mundo, probe: () => ({ sim: { rooms: new Map() } }) });
    useViewStore.getState().select({ kind: "room", id: "nunca" });
    passarFolga();
    vi.advanceTimersByTime(ESPERA_DA_SALA_MS + CONFERE_SALA_MS);
    expect(mundo.select).toHaveBeenCalledTimes(1);
  });

  it("o clique na cena não volta como pedido de foco (a câmera não pula)", () => {
    const { mundo, clicar } = falsoMundo();
    desligar = ligarInterface(mundo);
    clicar({ type: "agent", id: "ana" });
    passarFolga();
    expect(mundo.select).not.toHaveBeenCalled();
    expect(mundo.focusAgent).not.toHaveBeenCalled();
  });

  it("selecionar um agente pela lista destaca e enquadra o personagem, depois de o painel medir o espaço", () => {
    const { mundo } = falsoMundo();
    desligar = ligarInterface(mundo);
    useViewStore.getState().select({ kind: "agent", id: "caio" });
    expect(mundo.select).not.toHaveBeenCalled(); // espera o painel abrir e informar a área livre
    useViewStore.getState().setOverlay("side-panel", { ...NO_INSETS, right: 408 });
    passarFolga();
    expect(mundo.setViewInsets).toHaveBeenLastCalledWith({ ...NO_INSETS, right: 408 });
    expect(mundo.select).toHaveBeenCalledWith({ type: "agent", id: "caio" }, { focus: true });
  });

  it("agente que não está na cena (dormindo fora, a chegar) só abre o painel: a cena não é tocada com ele", () => {
    const { mundo } = falsoMundo(["ana"]);
    desligar = ligarInterface(mundo);
    useViewStore.getState().select({ kind: "agent", id: "caio" });
    passarFolga();
    expect(mundo.select).toHaveBeenCalledTimes(1);
    expect(mundo.select).toHaveBeenCalledWith(null);
    expect(useViewStore.getState().selection).toEqual({ kind: "agent", id: "caio" });
  });

  it("fechar o painel limpa a seleção da cena sem fechar de novo o painel", () => {
    const { mundo, clicar } = falsoMundo();
    desligar = ligarInterface(mundo);
    clicar({ type: "agent", id: "ana" });
    useViewStore.getState().select(null);
    passarFolga();
    expect(mundo.select).toHaveBeenCalledWith(null);
    expect(useViewStore.getState().selection).toBeNull();
  });

  it("selecionar o lobby seleciona a copa na cena, sem mover a câmera", () => {
    const { mundo } = falsoMundo();
    desligar = ligarInterface(mundo);
    useViewStore.getState().select({ kind: "room", id: LOBBY_ID });
    passarFolga();
    expect(mundo.select).toHaveBeenCalledWith({ type: "room", id: "core:copa" }, { focus: false });
  });

  it("foco do Cyno: mapa = visão geral; sala = enquadra a sala; lobby = a copa", () => {
    const { mundo } = falsoMundo();
    desligar = ligarInterface(mundo);
    useViewStore.getState().setFocus({ kind: "room", id: salaDoOffice() });
    passarFolga();
    expect(mundo.focusRoom).toHaveBeenLastCalledWith(salaDoOffice());
    useViewStore.getState().setFocus({ kind: "room", id: LOBBY_ID });
    passarFolga();
    expect(mundo.focusRoom).toHaveBeenLastCalledWith("core:copa");
    useViewStore.getState().setFocus({ kind: "map" });
    passarFolga();
    expect(mundo.overview).toHaveBeenCalledTimes(1);
  });

  it('"Ver no mapa": segue o agente se ele está na cena; senão enquadra a sala de casa', () => {
    const { mundo } = falsoMundo(["ana"]);
    desligar = ligarInterface(mundo);
    useViewStore.getState().showAgent("ana", "estudio");
    passarFolga();
    expect(mundo.focusAgent).toHaveBeenCalledWith("ana", { follow: true });
    useViewStore.getState().showAgent("caio", "estudio");
    passarFolga();
    expect(mundo.focusRoom).toHaveBeenLastCalledWith("estudio");
  });

  it("Esc volta à visão geral quando há algo aberto ou enquadrado, e não mexe na câmera à toa", () => {
    const { mundo } = falsoMundo();
    desligar = ligarInterface(mundo);
    nav.teclar("Escape");
    expect(mundo.overview).not.toHaveBeenCalled();
    useViewStore.setState({ selection: { kind: "room", id: salaDoOffice() } });
    nav.teclar("Escape");
    expect(mundo.overview).toHaveBeenCalledTimes(1);
  });

  it("ao desligar, para de ouvir a interface e a cena", () => {
    const { mundo, clicar } = falsoMundo();
    const parar = ligarInterface(mundo);
    parar();
    clicar({ type: "agent", id: "ana" });
    useViewStore.getState().setOverlay("sidebar", { ...NO_INSETS, left: 99 });
    expect(useViewStore.getState().selection).toBeNull();
    expect(mundo.setViewInsets).toHaveBeenCalledTimes(1);
    desligar = () => undefined;
  });
});
