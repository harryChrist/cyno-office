import { describe, expect, it } from "vitest";
import { isPaletteColorId, type PaletteColorId } from "./palette";
import { FLOOR_PATTERNS, ROOM_THEME_IDS, THEME_LABELS, THEMES, themeFloorPattern, themeWallStyle, WALL_STYLES, type ThemeColors } from "./themes";

const COLOR_FIELDS = ["floorA", "floorB", "wall", "wallShadow", "baseboard", "accent", "sofa", "floorLine", "wainscot"] as const satisfies readonly (keyof ThemeColors)[];

describe("THEMES", () => {
  it("tem os temas previstos (15 de quarto + lobby)", () => {
    expect(ROOM_THEME_IDS).toHaveLength(15);
    expect(Object.keys(THEMES).sort()).toEqual([...ROOM_THEME_IDS, "lobby"].sort());
    expect(new Set(ROOM_THEME_IDS).size).toBe(ROOM_THEME_IDS.length);
  });

  it("só usa cores da paleta em todos os papéis de cor", () => {
    for (const [id, theme] of Object.entries(THEMES)) {
      for (const field of COLOR_FIELDS) {
        const color: PaletteColorId | undefined = theme[field];
        if (color !== undefined) expect(isPaletteColorId(color), `${id}.${field}`).toBe(true);
      }
    }
  });

  it("piso e parede usam desenhos conhecidos (padrões: xadrez e lisa)", () => {
    for (const theme of Object.values(THEMES)) {
      expect(FLOOR_PATTERNS).toContain(themeFloorPattern(theme));
      expect(WALL_STYLES).toContain(themeWallStyle(theme));
    }
    expect(themeFloorPattern(THEMES.mint)).toBe("checker");
    expect(themeWallStyle(THEMES.mint)).toBe("plain");
    // Os temas, juntos, exercitam todos os desenhos de piso e acabamentos de parede.
    expect(new Set(Object.values(THEMES).map(themeFloorPattern))).toEqual(new Set(FLOOR_PATTERNS));
    expect(new Set(Object.values(THEMES).map(themeWallStyle))).toEqual(new Set(WALL_STYLES));
  });

  it("parede, sombra e piso se distinguem em todo tema de quarto", () => {
    for (const id of ROOM_THEME_IDS) {
      const t = THEMES[id];
      expect(t.wall, id).not.toBe(t.floorA);
      expect(t.wall, id).not.toBe(t.wallShadow);
    }
  });

  it("todo tema de quarto existe e tem rótulo único", () => {
    for (const id of ROOM_THEME_IDS) {
      expect(THEMES[id]).toBeDefined();
      expect(THEME_LABELS[id]).toBeTruthy();
    }
    expect(new Set(ROOM_THEME_IDS.map((id) => THEME_LABELS[id])).size).toBe(ROOM_THEME_IDS.length);
    expect(ROOM_THEME_IDS).not.toContain("lobby");
  });
});
