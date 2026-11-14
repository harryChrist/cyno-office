import { describe, expect, it } from "vitest";
import { aindaReenquadrando, guardarEnquadre, JANELA_DE_REENQUADRE_MS, restaurarEnquadre } from "./enquadre";

describe("enquadramento da cidade na tela cheia", () => {
  it("guarda o centro e o zoom e os devolve depois de a câmera ter sido reenquadrada", () => {
    const camera = { x: 120, y: 80, zoom: 0.75 };
    const antes = guardarEnquadre(camera);
    // entrou em tela cheia: a vista reenquadra (outro centro, outro zoom)
    camera.x = 400;
    camera.y = 300;
    camera.zoom = 1.6;
    expect(antes).toEqual({ x: 120, y: 80, zoom: 0.75 });
    restaurarEnquadre(camera, antes);
    expect(camera).toEqual({ x: 120, y: 80, zoom: 0.75 });
  });

  it("a foto não acompanha mudanças posteriores da câmera", () => {
    const camera = { x: 1, y: 2, zoom: 1 };
    const foto = guardarEnquadre(camera);
    camera.zoom = 2;
    expect(foto.zoom).toBe(1);
  });

  it("o reenquadre por resize vale só na janela curta da transição", () => {
    expect(aindaReenquadrando(1000, 1000 + JANELA_DE_REENQUADRE_MS)).toBe(true);
    expect(aindaReenquadrando(1000, 1001 + JANELA_DE_REENQUADRE_MS)).toBe(false);
  });
});
