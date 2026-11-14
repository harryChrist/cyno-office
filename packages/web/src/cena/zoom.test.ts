import { describe, expect, it } from "vitest";
import { clampZoom, stepZoom, ZOOM_LEVELS } from "./zoom";

describe("zoom inteiro", () => {
  it("só existe 1x, 2x, 3x e 4x", () => {
    expect(ZOOM_LEVELS).toEqual([1, 2, 3, 4]);
  });

  it("arredonda e limita", () => {
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(2.4)).toBe(2);
    expect(clampZoom(2.6)).toBe(3);
    expect(clampZoom(9)).toBe(4);
  });

  it("anda um nível por vez sem passar dos limites", () => {
    expect(stepZoom(1, 1)).toBe(2);
    expect(stepZoom(3, 1)).toBe(4);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(1, -1)).toBe(1);
  });
});
