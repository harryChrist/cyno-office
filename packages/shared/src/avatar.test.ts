import { describe, expect, it } from "vitest";
import { AVATAR_OPTIONS, SKIN_TONE_COLORS, SKIN_TONE_SHADES } from "./avatar";
import { isPaletteColorId } from "./palette";

describe("AVATAR_OPTIONS", () => {
  it("lista os tons, cabelos e acessórios previstos", () => {
    expect(AVATAR_OPTIONS.skin).toEqual(["tone1", "tone2", "tone3", "tone4", "tone5", "tone6"]);
    expect([...AVATAR_OPTIONS.hair].sort()).toEqual(
      ["bald", "bun", "buzz", "curly", "long", "mohawk", "ponytail", "short"],
    );
    expect([...AVATAR_OPTIONS.accessory].sort()).toEqual(
      ["cap", "earring", "glasses", "headphones", "scarf"],
    );
  });

  it("cores de cabelo e roupa são ids da paleta, sem repetição", () => {
    for (const list of [AVATAR_OPTIONS.hairColor, AVATAR_OPTIONS.shirt, AVATAR_OPTIONS.pants]) {
      for (const id of list) expect(isPaletteColorId(id)).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("cada tom de pele tem cor base e sombra da paleta", () => {
    for (const tone of AVATAR_OPTIONS.skin) {
      expect(isPaletteColorId(SKIN_TONE_COLORS[tone])).toBe(true);
      expect(isPaletteColorId(SKIN_TONE_SHADES[tone])).toBe(true);
      expect(SKIN_TONE_SHADES[tone]).not.toBe(SKIN_TONE_COLORS[tone]);
    }
  });
});
