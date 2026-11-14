import { beforeEach, describe, expect, it } from "vitest";
import { selectPanelWide, usePanelWidthStore } from "./panelWidth";

describe("largura do painel lateral", () => {
  beforeEach(() => usePanelWidthStore.setState({ wideClaims: 0 }));

  it("fica largo enquanto algum formulário de edição estiver aberto", () => {
    const wide = () => selectPanelWide(usePanelWidthStore.getState());
    expect(wide()).toBe(false);
    const releaseRoom = usePanelWidthStore.getState().claimWide();
    const releaseTeam = usePanelWidthStore.getState().claimWide();
    expect(wide()).toBe(true);
    releaseRoom();
    expect(wide()).toBe(true);
    releaseTeam();
    expect(wide()).toBe(false);
  });

  it("liberar duas vezes não desconta o pedido de outro formulário", () => {
    const release = usePanelWidthStore.getState().claimWide();
    const other = usePanelWidthStore.getState().claimWide();
    release();
    release();
    expect(usePanelWidthStore.getState().wideClaims).toBe(1);
    other();
    expect(usePanelWidthStore.getState().wideClaims).toBe(0);
  });
});
