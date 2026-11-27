import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abertaPorPadrao, escolherPredio, guardarFaixaAberta, lerFaixaAberta, resumoDaFaixa } from "./cidadeFaixaView";

/** localStorage de mentira (o ambiente dos testes é node). */
beforeEach(() => {
  const dados = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => dados.get(k) ?? null, setItem: (k: string, v: string) => void dados.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

describe("a faixa da cidade", () => {
  it("nasce aberta em tela larga e recolhida no celular", () => {
    expect(abertaPorPadrao(1440)).toBe(true);
    expect(abertaPorPadrao(1100)).toBe(true);
    expect(abertaPorPadrao(390)).toBe(false);
    expect(lerFaixaAberta(390)).toBe(false);
    expect(lerFaixaAberta(1440)).toBe(true);
  });

  it("lembra a escolha do dono, mesmo contra o padrão", () => {
    guardarFaixaAberta(false);
    expect(lerFaixaAberta(1440)).toBe(false);
    guardarFaixaAberta(true);
    expect(lerFaixaAberta(390)).toBe(true);
  });

  it("sem armazenamento, vale o padrão e nada quebra", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(lerFaixaAberta(1440)).toBe(true);
    expect(() => guardarFaixaAberta(false)).not.toThrow();
  });

  it("o clique escolhe o prédio, troca de prédio e fecha no chão ou no mesmo prédio", () => {
    expect(escolherPredio(null, "a")).toBe("a");
    expect(escolherPredio("a", "b")).toBe("b");
    expect(escolherPredio("a", "a")).toBeNull();
    expect(escolherPredio("a", null)).toBeNull();
    expect(escolherPredio(null, null)).toBeNull();
  });

  it("o resumo da faixa recolhida", () => {
    const base = { predios: [], acesos: 0, esperando: 0 };
    expect(resumoDaFaixa(base)).toBe("Nenhum prédio ainda");
    const tres = { predios: [1, 2, 3] as never[], acesos: 2, esperando: 4 };
    expect(resumoDaFaixa(tres)).toBe("3 prédios · 2 trabalhando · 4 esperam você");
    expect(resumoDaFaixa({ predios: [1] as never[], acesos: 0, esperando: 1 })).toBe("1 prédio · ninguém trabalhando · 1 espera você");
  });
});
