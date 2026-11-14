import { describe, expect, it } from "vitest";
import { SETTINGS_BREAKPOINTS, settingsLayout } from "./settingsLayout";

describe("settingsLayout", () => {
  it("celular e janelas médias ficam em uma coluna, sem painel ao lado", () => {
    expect(settingsLayout(390)).toMatchObject({ columns: 1, split: false });
    expect(settingsLayout(767)).toMatchObject({ columns: 1, split: false });
    expect(settingsLayout(1024)).toMatchObject({ columns: 1, split: false });
  });

  it("a partir de 1280 os motores abrem ao lado da lista", () => {
    expect(settingsLayout(1280)).toMatchObject({ columns: 1, split: true });
    expect(settingsLayout(1440)).toMatchObject({ columns: 1, split: true });
  });

  it("telas largas ganham colunas de cartões, sempre com largura máxima", () => {
    expect(settingsLayout(1680).columns).toBe(2);
    expect(settingsLayout(1920).columns).toBe(2);
    expect(settingsLayout(2200).columns).toBe(3);
    expect(settingsLayout(2560).columns).toBe(3);
    for (const width of [390, 1280, 1680, 2560]) expect(settingsLayout(width).maxWidth).toBeLessThan(1900);
  });

  it("a largura máxima só cresce com a janela", () => {
    const widths = [390, SETTINGS_BREAKPOINTS.split, SETTINGS_BREAKPOINTS.two, SETTINGS_BREAKPOINTS.three];
    const maxima = widths.map((width) => settingsLayout(width).maxWidth);
    expect([...maxima].sort((a, b) => a - b)).toEqual(maxima);
  });
});
