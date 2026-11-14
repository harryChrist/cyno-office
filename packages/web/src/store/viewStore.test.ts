import { beforeEach, describe, expect, it } from "vitest";
import { fixedOverlays, NO_INSETS, useViewStore } from "./viewStore";

describe("viewStore", () => {
  beforeEach(() => useViewStore.setState({ selection: null, focus: { kind: "map" }, animZoom: null }));

  it("selecionar um quarto com outro focado leva o foco para o selecionado", () => {
    useViewStore.getState().setFocus({ kind: "room", id: "projetox" });
    useViewStore.getState().select({ kind: "room", id: "projetoy" });
    expect(useViewStore.getState().focus).toEqual({ kind: "room", id: "projetoy" });
    useViewStore.getState().select({ kind: "room", id: "lobby" });
    expect(useViewStore.getState().focus).toEqual({ kind: "room", id: "lobby" });
  });

  it("no mapa, ou selecionando o próprio quarto focado ou um agente, o foco não muda", () => {
    useViewStore.getState().select({ kind: "room", id: "projetoy" });
    expect(useViewStore.getState().focus).toEqual({ kind: "map" });
    const focus = { kind: "room" as const, id: "projetox" };
    useViewStore.getState().setFocus(focus);
    useViewStore.getState().select({ kind: "room", id: "projetox" });
    useViewStore.getState().select({ kind: "agent", id: "lia" });
    useViewStore.getState().select(null);
    expect(useViewStore.getState().focus).toBe(focus);
  });

  it("zoom da animação: só muda quando o degrau muda", () => {
    const before = useViewStore.getState();
    useViewStore.getState().setAnimZoom(null);
    expect(useViewStore.getState()).toBe(before);
    useViewStore.getState().setAnimZoom(2);
    expect(useViewStore.getState().animZoom).toBe(2);
  });

  it("ver no mapa: cada pedido conta, mesmo repetido para o mesmo agente", () => {
    useViewStore.getState().showAgent("lia", "projetox");
    const first = useViewStore.getState().showAgentRequest;
    useViewStore.getState().showAgent("lia", "projetox");
    const second = useViewStore.getState().showAgentRequest;
    expect(first).toMatchObject({ id: "lia", fallback: "projetox" });
    expect(second).not.toBe(first);
    expect(second!.seq).toBe(first!.seq + 1);
  });
});

describe("fixedOverlays", () => {
  it("a barra lateral tira espaço da câmera, como a barra de cima e a caixa de tarefa", () => {
    const side = { ...NO_INSETS, left: 240 };
    const feed = { ...NO_INSETS, left: 560 };
    expect(fixedOverlays({ sidebar: side, "activity-feed": feed })).toEqual({ sidebar: side });
  });
});
