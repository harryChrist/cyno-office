import { describe, expect, it } from "vitest";
import {
  ASIDE_DEFAULT,
  defaultAsideWidth,
  ASIDE_MIN,
  KEY_STEP,
  KEY_STEP_LARGE,
  MAIN_MIN,
  asideBounds,
  asideWidthForKey,
  clampAside,
  parseSplitPrefs,
  serializeSplitPrefs,
  splitStorageKey,
} from "./splitPane";

describe("defaultAsideWidth", () => {
  it("é metade do corpo (50/50); sem medida, o valor de reserva", () => {
    expect(defaultAsideWidth(1000)).toBe(500);
    expect(defaultAsideWidth(901)).toBe(450);
    expect(defaultAsideWidth(0)).toBe(ASIDE_DEFAULT);
  });
});

describe("asideBounds", () => {
  it("deixa a conversa com o mínimo dela", () => {
    expect(asideBounds(1000)).toEqual({ min: ASIDE_MIN, max: 1000 - MAIN_MIN });
  });

  it("quando não cabem os dois mínimos, a lateral fica no dela", () => {
    expect(asideBounds(500)).toEqual({ min: ASIDE_MIN, max: ASIDE_MIN });
  });

  it("sem medida, só o mínimo vale", () => {
    expect(asideBounds(0)).toEqual({ min: ASIDE_MIN, max: Number.POSITIVE_INFINITY });
  });
});

describe("clampAside", () => {
  const bounds = asideBounds(1000);

  it("prende nos limites e arredonda", () => {
    expect(clampAside(100, bounds)).toBe(ASIDE_MIN);
    expect(clampAside(900, bounds)).toBe(640);
    expect(clampAside(333.6, bounds)).toBe(334);
  });

  it("valor inválido volta ao padrão", () => {
    expect(clampAside(Number.NaN, bounds)).toBe(ASIDE_DEFAULT);
  });

  it("encolhe quando o dialog fica menor", () => {
    expect(clampAside(600, asideBounds(800))).toBe(800 - MAIN_MIN);
  });
});

describe("asideWidthForKey", () => {
  const bounds = asideBounds(1000);

  it("← faz a lateral crescer, → encolher", () => {
    expect(asideWidthForKey("ArrowLeft", false, 300, bounds)).toBe(300 + KEY_STEP);
    expect(asideWidthForKey("ArrowRight", false, 300, bounds)).toBe(300 - KEY_STEP);
  });

  it("Shift usa o passo maior", () => {
    expect(asideWidthForKey("ArrowLeft", true, 300, bounds)).toBe(300 + KEY_STEP_LARGE);
  });

  it("respeita os limites", () => {
    expect(asideWidthForKey("ArrowRight", true, 250, bounds)).toBe(ASIDE_MIN);
    expect(asideWidthForKey("ArrowLeft", true, 630, bounds)).toBe(640);
  });

  it("Home e End vão ao mínimo e ao máximo", () => {
    expect(asideWidthForKey("Home", false, 400, bounds)).toBe(ASIDE_MIN);
    expect(asideWidthForKey("End", false, 400, bounds)).toBe(640);
    expect(asideWidthForKey("End", false, 400, asideBounds(0))).toBeNull();
  });

  it("outras teclas não são da divisória", () => {
    expect(asideWidthForKey("Enter", false, 300, bounds)).toBeNull();
    expect(asideWidthForKey("ArrowUp", false, 300, bounds)).toBeNull();
  });
});

describe("preferências salvas", () => {
  it("chave por painel", () => {
    expect(splitStorageKey("maestro")).toBe("agent-office:split:v2:maestro");
  });

  it("ida e volta", () => {
    expect(parseSplitPrefs(serializeSplitPrefs({ width: 412.4, collapsed: true }))).toEqual({ width: 412, collapsed: true });
  });

  it("vazio ou estragado volta ao padrão", () => {
    expect(parseSplitPrefs(null)).toEqual({ width: null, collapsed: false });
    expect(parseSplitPrefs("{nope")).toEqual({ width: null, collapsed: false });
    expect(parseSplitPrefs("42")).toEqual({ width: null, collapsed: false });
    expect(parseSplitPrefs(JSON.stringify({ width: "x", collapsed: "sim" }))).toEqual({ width: null, collapsed: false });
    expect(parseSplitPrefs(JSON.stringify({ width: 380 }))).toEqual({ width: 380, collapsed: false });
  });
});
