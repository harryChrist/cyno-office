import type { OfficeState } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { makeAgent, makeOffice, makeRoom } from "../test-fixtures";
import { dockEscapeCollapses, isClick, type DockEscapeInput } from "../ui/maestroDock";
import { activeRequests, currentMaestroTab, maestroTabs } from "./maestroTabs";
import type { RequestItem } from "./timelineLogic";
import { useWorkPanelStore } from "./workPanelStore";

function withMaestro(): OfficeState {
  const office = makeOffice();
  office.rooms.push(makeRoom("sala", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: -1, y: 0 } }));
  office.teams.push({ id: "gerencia", roomId: "sala", name: "Gerência", focus: "coordenar" });
  office.agents.push(makeAgent("maestro", "gerencia", { role: "maestro" }));
  return office;
}

const request = (id: string, stage: RequestItem["stage"]): RequestItem => ({
  kind: "request",
  id,
  at: "2026-11-09T10:00:00.000Z",
  prompt: id,
  stage,
  stageLabel: stage,
  tone: "neutral",
  updatedAt: "2026-11-09T10:00:00.000Z",
});

describe("abas do painel do Maestro", () => {
  it("terminal interativo: o terminal é a conversa (abre nele)", () => {
    expect(maestroTabs("terminal")).toEqual({ tabs: ["terminal", "pedidos", "atividade"], fallback: "terminal" });
  });

  it("CLI sem terminal: chat, pedidos, atividade e o terminal (explicando que não há)", () => {
    expect(maestroTabs("conversa")).toEqual({ tabs: ["conversa", "pedidos", "atividade", "terminal"], fallback: "conversa" });
  });

  it("simulado: a conversa são os próprios pedidos (sem aba Pedidos repetida)", () => {
    expect(maestroTabs("simulado").tabs).toEqual(["conversa", "atividade", "terminal"]);
  });

  it("lembra a aba escolhida quando ela existe no modo; senão, a padrão", () => {
    expect(currentMaestroTab("atividade", "simulado")).toBe("atividade");
    expect(currentMaestroTab("pedidos", "simulado")).toBe("conversa");
    expect(currentMaestroTab("conversa", "terminal")).toBe("terminal");
    expect(currentMaestroTab(null, "conversa")).toBe("conversa");
  });
});

describe("activeRequests", () => {
  it("só os abertos, mais novos primeiro", () => {
    const items = [request("a", "done"), request("b", "routed"), request("c", "failed"), request("d", "waiting_you")];
    expect(activeRequests(items).map((item) => item.id)).toEqual(["d", "b"]);
  });
});

describe("dockEscapeCollapses", () => {
  const base: DockEscapeInput = { key: "Escape", defaultPrevented: false, modalOpen: false, insideDock: true, insideTerminal: false, onPage: false };

  it("Esc no painel ou solto na página/escritório recolhe", () => {
    expect(dockEscapeCollapses(base)).toBe(true);
    expect(dockEscapeCollapses({ ...base, insideDock: false, onPage: true })).toBe(true);
  });

  it("não recolhe com janela modal, Esc já tratado, no terminal (é do Claude Code) ou noutro painel", () => {
    expect(dockEscapeCollapses({ ...base, modalOpen: true })).toBe(false);
    expect(dockEscapeCollapses({ ...base, defaultPrevented: true })).toBe(false);
    expect(dockEscapeCollapses({ ...base, insideTerminal: true })).toBe(false);
    expect(dockEscapeCollapses({ ...base, insideDock: false, onPage: false })).toBe(false);
    expect(dockEscapeCollapses({ ...base, key: "Enter" })).toBe(false);
  });
});

describe("isClick", () => {
  it("quase parado é clique; arrastar a câmera não", () => {
    expect(isClick({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(true);
    expect(isClick({ x: 10, y: 10 }, { x: 30, y: 10 })).toBe(false);
  });
});

describe("workPanelStore: o Maestro abre o painel acoplado", () => {
  afterEach(() => {
    useWorkPanelStore.setState({ target: null, maestroOpen: false });
    useOfficeStore.setState({ office: null });
  });

  it("openMaestro abre o painel, pede o foco e fecha a tela de agente aberta", () => {
    useWorkPanelStore.setState({ target: { kind: "agent", agentId: "ana" } });
    const before = useWorkPanelStore.getState().maestroFocus;
    useWorkPanelStore.getState().openMaestro();
    const state = useWorkPanelStore.getState();
    expect(state.maestroOpen).toBe(true);
    expect(state.target).toBeNull();
    expect(state.maestroFocus).toBe(before + 1);
  });

  it("abrir a tela do agente que é o Maestro abre o painel acoplado (não o dialog)", () => {
    useOfficeStore.setState({ office: withMaestro() });
    useWorkPanelStore.getState().openAgent("maestro");
    expect(useWorkPanelStore.getState()).toMatchObject({ target: null, maestroOpen: true });
    useWorkPanelStore.getState().openAgent("ana");
    expect(useWorkPanelStore.getState().target).toEqual({ kind: "agent", agentId: "ana" });
  });

  it("sair do Office recolhe o painel; a aba escolhida fica lembrada", () => {
    useNavStore.setState({ page: "office" });
    useWorkPanelStore.getState().openMaestro();
    useWorkPanelStore.getState().setMaestroTab("atividade");
    useNavStore.setState({ page: "trabalho" });
    expect(useWorkPanelStore.getState().maestroOpen).toBe(false);
    expect(useWorkPanelStore.getState().maestroTab).toBe("atividade");
  });
});
