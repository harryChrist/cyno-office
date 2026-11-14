import { afterEach, describe, expect, it, vi } from "vitest";
import { clampDrawerWidth, DRAWER_FULL_BELOW, dragDrawerWidth, drawerLimits, drawerWidth, loadDrawerWidth, saveDrawerWidth } from "./mediaDrawer";

describe("largura da gaveta", () => {
  it("abre com pelo menos metade da janela em qualquer tela larga", () => {
    for (const viewport of [900, 1024, 1280, 1440, 1920, 2560, 3840]) {
      const { min, initial, max, full } = drawerLimits(viewport);
      expect(full).toBe(false);
      expect(min).toBeGreaterThanOrEqual(viewport / 2);
      expect(initial).toBeGreaterThanOrEqual(viewport / 2);
      expect(initial).toBeLessThanOrEqual(max);
    }
  });

  it("tem os valores esperados em 1440 e 1920", () => {
    expect(drawerLimits(1440)).toEqual({ full: false, min: 720, max: 1224, initial: 792 });
    expect(drawerLimits(1920)).toEqual({ full: false, min: 960, max: 1600, initial: 1056 });
  });

  it("nunca fica menor que a largura mínima em pixels", () => {
    expect(drawerLimits(900).min).toBe(560);
    expect(drawerLimits(1000).min).toBe(560);
    expect(drawerLimits(1200).min).toBe(600);
  });

  it("abaixo de 900 px ocupa a tela inteira", () => {
    expect(drawerLimits(DRAWER_FULL_BELOW - 1)).toEqual({ full: true, min: 899, max: 899, initial: 899 });
    expect(drawerLimits(390).full).toBe(true);
    expect(clampDrawerWidth(300, 390)).toBe(390);
  });

  it("segura a largura entre o mínimo e o máximo e trata valor inválido", () => {
    expect(clampDrawerWidth(100, 1440)).toBe(720);
    expect(clampDrawerWidth(5000, 1440)).toBe(1224);
    expect(clampDrawerWidth(900.4, 1440)).toBe(900);
    expect(clampDrawerWidth(Number.NaN, 1440)).toBe(792);
  });

  it("usa a largura guardada, limitada à janela de agora, ou a inicial", () => {
    expect(drawerWidth(null, 1440)).toBe(792);
    expect(drawerWidth(1000, 1440)).toBe(1000);
    expect(drawerWidth(1000, 1100)).toBe(935);
    expect(drawerWidth(500, 1920)).toBe(960);
  });
});

describe("arrastar a borda", () => {
  it("arrastar para a esquerda alarga e para a direita estreita, dentro dos limites", () => {
    expect(dragDrawerWidth(800, 700, 600, 1440)).toBe(900);
    expect(dragDrawerWidth(800, 700, 760, 1440)).toBe(740);
    expect(dragDrawerWidth(800, 700, 1400, 1440)).toBe(720);
    expect(dragDrawerWidth(800, 700, 0, 1440)).toBe(1224);
  });
});

describe("largura guardada no navegador", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("guarda, lê e ignora lixo", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
    expect(loadDrawerWidth()).toBeNull();
    saveDrawerWidth(912.6);
    expect(loadDrawerWidth()).toBe(913);
    store.set("cyno.media.drawerWidth", "abc");
    expect(loadDrawerWidth()).toBeNull();
    store.set("cyno.media.drawerWidth", "-5");
    expect(loadDrawerWidth()).toBeNull();
  });

  it("sem armazenamento, não quebra", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(loadDrawerWidth()).toBeNull();
    expect(() => saveDrawerWidth(800)).not.toThrow();
  });
});
