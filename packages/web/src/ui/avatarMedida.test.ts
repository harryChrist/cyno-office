import { describe, expect, it } from "vitest";
import { BUSTO, medirCabeca, ROSTO } from "./avatarMedida";

describe("medirCabeca (avatar pequeno)", () => {
  it("usa o busto de 20 px sem ampliar numa bolinha de 24 px", () => {
    expect(medirCabeca(24)).toEqual({ recorte: BUSTO, ampliacao: 1, pixelsDoCanvas: 20, cssPx: 20 });
  });

  it("amplia o busto 2x numa caixa de 40 px e o rosto 2x numa de 36 px", () => {
    expect(medirCabeca(40)).toMatchObject({ recorte: BUSTO, ampliacao: 2, pixelsDoCanvas: 40 });
    expect(medirCabeca(36)).toMatchObject({ recorte: ROSTO, ampliacao: 2, pixelsDoCanvas: 36 });
  });

  it("nunca passa da caixa e sempre usa ampliação inteira em pixels do aparelho", () => {
    for (const dpr of [1, 1.5, 2, 2.625, 3]) {
      for (let size = 16; size <= 96; size += 1) {
        const medida = medirCabeca(size, dpr);
        expect(Number.isInteger(medida.ampliacao)).toBe(true);
        expect(medida.pixelsDoCanvas).toBe(medida.recorte * medida.ampliacao);
        if (size * dpr >= BUSTO) expect(medida.pixelsDoCanvas).toBeLessThanOrEqual(size * dpr + 1e-9);
        expect(medida.cssPx).toBeCloseTo(medida.pixelsDoCanvas / dpr);
      }
    }
  });

  it("em tela de alta densidade o rosto ganha mais pixels", () => {
    expect(medirCabeca(24, 2)).toMatchObject({ recorte: BUSTO, ampliacao: 2, pixelsDoCanvas: 40, cssPx: 20 });
    expect(medirCabeca(26, 3)).toMatchObject({ recorte: ROSTO, ampliacao: 4, pixelsDoCanvas: 72 });
  });

  it("numa caixa menor que o busto ainda desenha em 1x (a caixa corta, o desenho não borra)", () => {
    expect(medirCabeca(12)).toMatchObject({ ampliacao: 1 });
  });
});
