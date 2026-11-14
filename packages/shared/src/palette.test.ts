import { describe, expect, it } from "vitest";
import { isSafeId } from "./ids";
import { PALETTE, PALETTE_COLOR_IDS, paletteNumber } from "./palette";

describe("PALETTE", () => {
  it("tem entre 32 e 56 cores (rampas dos temas incluídas)", () => {
    expect(PALETTE_COLOR_IDS.length).toBeGreaterThanOrEqual(32);
    expect(PALETTE_COLOR_IDS.length).toBeLessThanOrEqual(56);
  });

  it("usa hex válidos e únicos", () => {
    const hexes = Object.values(PALETTE).map((hex) => hex.toLowerCase());
    for (const hex of hexes) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  it("usa ids de cor seguros", () => {
    for (const id of PALETTE_COLOR_IDS) expect(isSafeId(id)).toBe(true);
  });

  it("converte para número no formato do PixiJS", () => {
    expect(paletteNumber("ink")).toBe(0x1c1522);
  });
});
