import { describe, expect, it } from "vitest";
import { PASSO_MAXIMO_MS, alternar, escalaDeAnimacao, fracao, iniciar, irPara, mudarVelocidade, passo, pausar, tocar } from "./modelo";

describe("modelo do player", () => {
  const base = iniciar(1_000_000, 2_000_000, 1_000_000, 60);

  it("começa pausado no instante pedido, preso aos limites do dia", () => {
    expect(base).toMatchObject({ t: 1_000_000, tocando: false, velocidade: 60 });
    expect(iniciar(10, 20, 99).t).toBe(20);
    expect(iniciar(10, 20, -5).t).toBe(10);
  });

  it("tocar e pausar; só anda tocando; um passo vale no máximo 250 ms reais vezes a velocidade", () => {
    expect(passo(base, 100).t).toBe(base.t);
    const tocando = tocar(base);
    expect(tocando.tocando).toBe(true);
    expect(passo(tocando, 100).t).toBe(1_000_000 + 100 * 60);
    expect(passo(tocando, 5_000).t).toBe(1_000_000 + PASSO_MAXIMO_MS * 60);
    expect(passo(tocando, -10).t).toBe(1_000_000);
    expect(pausar(tocando).tocando).toBe(false);
    expect(alternar(alternar(base)).tocando).toBe(false);
  });

  it("a velocidade muda o ritmo sem mexer no instante", () => {
    const rapido = mudarVelocidade(tocar(base), 900);
    expect(rapido.t).toBe(base.t);
    expect(passo(rapido, 100).t).toBe(1_000_000 + 100 * 900);
  });

  it("arrastar é limitado ao dia e não muda se está tocando", () => {
    const tocando = tocar(base);
    expect(irPara(tocando, 1_500_000)).toMatchObject({ t: 1_500_000, tocando: true });
    expect(irPara(tocando, 9_999_999).t).toBe(2_000_000);
    expect(irPara(tocando, 0).t).toBe(1_000_000);
  });

  it("no fim do dia para; tocar de novo recomeça do começo", () => {
    const quase = irPara(tocar(mudarVelocidade(base, 900)), 1_999_900);
    const fim = passo(quase, 250);
    expect(fim).toMatchObject({ t: 2_000_000, tocando: false });
    expect(tocar(fim).t).toBe(1_000_000);
    expect(tocar(fim).tocando).toBe(true);
  });

  it("fração do dia e escala de animação (raiz da velocidade, de 1 a 16)", () => {
    expect(fracao({ ...base, t: 1_500_000 })).toBe(0.5);
    expect(fracao({ de: 5, ate: 5, t: 5 })).toBe(0);
    expect(escalaDeAnimacao(0)).toBe(0);
    expect(escalaDeAnimacao(60)).toBe(6);
    expect(escalaDeAnimacao(900)).toBe(16);
    expect(escalaDeAnimacao(1)).toBe(1);
  });
});
