import { LOBBY_ID } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { NO_INSETS, type Insets } from "../store/viewStore";
import { alvoDoFoco, idDoPai, insetsDaCena, mesmaSelecaoDaView, selecaoDaCena, selecaoParaCena } from "./traducaoView";

const insets = (parcial: Partial<Insets>): Insets => ({ ...NO_INSETS, ...parcial });

describe("selecaoDaCena (cena -> viewStore)", () => {
  it("personagem vira o agente", () => {
    expect(selecaoDaCena({ type: "agent", id: "ana" })).toEqual({ kind: "agent", id: "ana" });
  });

  it("subagente seleciona o agente pai", () => {
    expect(selecaoDaCena({ type: "agent", id: "ana::t7" })).toEqual({ kind: "agent", id: "ana" });
    expect(idDoPai("ana::t7")).toBe("ana");
    expect(idDoPai("ana")).toBe("ana");
  });

  it("sala vira a sala", () => {
    expect(selecaoDaCena({ type: "room", id: "estudio" })).toEqual({ kind: "room", id: "estudio" });
  });

  it("qualquer parte do núcleo (recepção, copa, lounge, banheiros) abre o lobby", () => {
    for (const id of ["core:recepcao", "core:copa", "core:lounge", "core:banheiros"]) {
      expect(selecaoDaCena({ type: "room", id })).toEqual({ kind: "room", id: LOBBY_ID });
    }
  });

  it("o vazio limpa a seleção", () => {
    expect(selecaoDaCena(null)).toBeNull();
  });

  it("sala que o Cyno não conhece é ignorada (undefined)", () => {
    expect(selecaoDaCena({ type: "room", id: "fantasma" }, (id) => id === "estudio")).toBeUndefined();
    expect(selecaoDaCena({ type: "room", id: "estudio" }, (id) => id === "estudio")).toEqual({ kind: "room", id: "estudio" });
  });
});

describe("selecaoParaCena (viewStore -> cena)", () => {
  it("agente e sala passam direto; o lobby vira a copa; nada vira nada", () => {
    expect(selecaoParaCena({ kind: "agent", id: "ana" })).toEqual({ type: "agent", id: "ana" });
    expect(selecaoParaCena({ kind: "room", id: "estudio" })).toEqual({ type: "room", id: "estudio" });
    expect(selecaoParaCena({ kind: "room", id: LOBBY_ID })).toEqual({ type: "room", id: "core:copa" });
    expect(selecaoParaCena(null)).toBeNull();
  });

  it("ida e volta: o que o Cyno seleciona volta igual da cena", () => {
    for (const sel of [{ kind: "agent", id: "ana" }, { kind: "room", id: "estudio" }, { kind: "room", id: LOBBY_ID }, null] as const) {
      expect(mesmaSelecaoDaView(selecaoDaCena(selecaoParaCena(sel)) ?? null, sel)).toBe(true);
    }
  });

  it("subagente selecionado na cena conta como o pai selecionado no Cyno (sem eco)", () => {
    expect(mesmaSelecaoDaView(selecaoDaCena({ type: "agent", id: "ana::t7" }) ?? null, { kind: "agent", id: "ana" })).toBe(true);
  });
});

describe("alvoDoFoco", () => {
  it("mapa = visão geral (null); sala = o id; lobby = a copa", () => {
    expect(alvoDoFoco({ kind: "map" })).toBeNull();
    expect(alvoDoFoco({ kind: "room", id: "estudio" })).toBe("estudio");
    expect(alvoDoFoco({ kind: "room", id: LOBBY_ID })).toBe("core:copa");
  });
});

describe("insetsDaCena (área livre da câmera)", () => {
  const desktop = { w: 1440, h: 900 };
  const celular = { w: 390, h: 844 };

  it("sem painéis nada é coberto", () => {
    expect(insetsDaCena({}, desktop)).toEqual(NO_INSETS);
  });

  it("menu aberto e menu recolhido: só a faixa da esquerda muda", () => {
    expect(insetsDaCena({ sidebar: insets({ left: 256 }), topbar: insets({ top: 0 }) }, desktop)).toEqual(insets({ left: 256 }));
    expect(insetsDaCena({ sidebar: insets({ left: 72 }) }, desktop)).toEqual(insets({ left: 72 }));
  });

  it("painel lateral aberto tira espaço da direita; a caixa do Maestro, de baixo", () => {
    const area = insetsDaCena({ sidebar: insets({ left: 256 }), "side-panel": insets({ right: 408 }), "task-box": insets({ bottom: 72 }), topbar: insets({ top: 48 }) }, desktop);
    expect(area).toEqual({ top: 48, right: 408, bottom: 72, left: 256 });
  });

  it("painéis que flutuam e não são da lista (ex.: atividade) não contam", () => {
    expect(insetsDaCena({ "activity-feed": insets({ right: 300 }) }, desktop)).toEqual(NO_INSETS);
  });

  it("celular: o painel do agente é uma folha por cima de tudo e não entra na conta; a caixa e a barra, sim", () => {
    const area = insetsDaCena({ "side-panel": insets({ right: 382 }), topbar: insets({ top: 56 }), "task-box": insets({ bottom: 64 }) }, celular);
    expect(area).toEqual({ top: 56, right: 0, bottom: 64, left: 0 });
  });
});
