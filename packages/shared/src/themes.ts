import type { PaletteColorId } from "./palette";

/** Desenho do piso: xadrez (o de sempre), tábuas, ladrilhos grandes, carpete ou taco (parquet). */
export const FLOOR_PATTERNS = ["checker", "planks", "tiles", "carpet", "parquet"] as const;
export type FloorPattern = (typeof FLOOR_PATTERNS)[number];

/** Acabamento da parede: lisa, lambri (parte de baixo em outro tom), tijolos ou faixa de néon no alto. */
export const WALL_STYLES = ["plain", "wainscot", "brick", "stripe"] as const;
export type WallStyle = (typeof WALL_STYLES)[number];

export const FLOOR_PATTERN_LABELS: Record<FloorPattern, string> = {
  checker: "Xadrez",
  planks: "Tábuas",
  tiles: "Ladrilhos",
  carpet: "Carpete",
  parquet: "Taco",
};

/**
 * Papéis de cor de um tema (nomes em pt no planejamento):
 * floorA/floorB = pisoA/pisoB, wall = parede, wallShadow = paredeSombra,
 * baseboard = rodapé, accent = detalhe (placa, tapetes), sofa = estofado do sofá do quarto.
 * Os campos opcionais têm padrão: piso "checker", parede "plain", juntas e lambri derivados das rampas.
 */
export type ThemeColors = {
  floorA: PaletteColorId;
  floorB: PaletteColorId;
  wall: PaletteColorId;
  wallShadow: PaletteColorId;
  baseboard: PaletteColorId;
  accent: PaletteColorId;
  sofa: PaletteColorId;
  floorPattern?: FloorPattern;
  wallStyle?: WallStyle;
  /** Cor das juntas/linhas do piso (padrão: um tom abaixo do piso). */
  floorLine?: PaletteColorId;
  /** Cor do lambri na parede iluminada (só com wallStyle "wainscot"; padrão: um tom abaixo da parede). */
  wainscot?: PaletteColorId;
};

/** Temas que um quarto pode usar; "lobby" é exclusivo do lobby. */
export const ROOM_THEME_IDS = [
  "mint",
  "lavender",
  "terracotta",
  "ocean",
  "sand",
  "graphite",
  "forest",
  "night",
  "cherry",
  "coffee",
  "snow",
  "sunset",
  "industrial",
  "office",
  "cyber",
] as const;
export type RoomThemeId = (typeof ROOM_THEME_IDS)[number];
export type ThemeId = RoomThemeId | "lobby";

export const THEMES: Record<ThemeId, ThemeColors> = {
  mint: { floorA: "cream", floorB: "mint-light", wall: "mint", wallShadow: "mint-dark", baseboard: "wood-dark", accent: "wood-light", sofa: "terracotta" },
  lavender: { floorA: "lavender-light", floorB: "cloud", wall: "lavender", wallShadow: "lavender-dark", baseboard: "slate", accent: "rose", sofa: "rose" },
  terracotta: { floorA: "sand-light", floorB: "terracotta-light", wall: "terracotta", wallShadow: "terracotta-dark", baseboard: "wood-dark", accent: "mustard", sofa: "mustard" },
  ocean: { floorA: "ocean-light", floorB: "cloud", wall: "ocean", wallShadow: "ocean-dark", baseboard: "navy", accent: "sand", sofa: "sand" },
  sand: { floorA: "sand-light", floorB: "sand", wall: "sand-dark", wallShadow: "wood", baseboard: "wood-dark", accent: "leaf", sofa: "leaf" },
  // Grafite: paredes cinza-ardósia e piso de concreto em placas.
  graphite: { floorA: "cloud", floorB: "cream", wall: "stone", wallShadow: "slate", baseboard: "charcoal", accent: "mustard", sofa: "mustard", floorPattern: "tiles" },
  // Floresta: verde-musgo com lambri de madeira e assoalho de tábuas.
  forest: { floorA: "wood-light", floorB: "wood", wall: "leaf", wallShadow: "leaf-dark", baseboard: "wood-dark", accent: "sunflower", sofa: "terracotta", floorPattern: "planks", wallStyle: "wainscot", wainscot: "wood" },
  // Noite: azul-marinho, carpete lilás e faixa de néon violeta.
  night: { floorA: "lavender-dark", floorB: "navy", wall: "navy", wallShadow: "charcoal", baseboard: "ink", accent: "violet", sofa: "lavender", floorPattern: "carpet", wallStyle: "stripe" },
  // Cereja: rosa com lambri vinho-rosado e xadrez de lanchonete.
  cherry: { floorA: "cream", floorB: "rose-light", wall: "rose", wallShadow: "rose-dark", baseboard: "wine", accent: "leaf", sofa: "wine", wallStyle: "wainscot", wainscot: "rose-dark" },
  // Café: marrons com lambri escuro e piso de taco.
  coffee: { floorA: "sand", floorB: "sand-dark", wall: "wood", wallShadow: "wood-dark", baseboard: "skin-shade", accent: "cream", sofa: "wine", floorPattern: "parquet", wallStyle: "wainscot", wainscot: "wood-dark" },
  // Neve: branco-gelo e azul-claro, ladrilhos claros.
  snow: { floorA: "ice-light", floorB: "cream", wall: "ice", wallShadow: "ice-dark", baseboard: "ocean", accent: "ocean", sofa: "denim", floorPattern: "tiles" },
  // Pôr do sol: tangerina e pêssego, tábuas claras e faixa dourada.
  sunset: { floorA: "peach", floorB: "sand-light", wall: "tangerine", wallShadow: "terracotta", baseboard: "terracotta-dark", accent: "sunflower", sofa: "wine", floorPattern: "planks", wallStyle: "stripe" },
  // Industrial: tijolo aparente e placas de concreto.
  industrial: { floorA: "stone", floorB: "cloud", wall: "terracotta-dark", wallShadow: "wood-dark", baseboard: "charcoal", accent: "mustard", sofa: "navy", floorPattern: "tiles", wallStyle: "brick" },
  // Escritório: bege corporativo com carpete cinza.
  office: { floorA: "stone", floorB: "slate", wall: "sand-light", wallShadow: "sand", baseboard: "slate", accent: "denim", sofa: "navy", floorPattern: "carpet" },
  // Neon: escuro com grade ciano no piso e faixa magenta.
  cyber: { floorA: "charcoal", floorB: "slate", wall: "slate", wallShadow: "charcoal", baseboard: "ink", accent: "magenta", sofa: "magenta", floorPattern: "tiles", wallStyle: "stripe", floorLine: "screen-glow" },
  lobby: { floorA: "wood-light", floorB: "wood", wall: "wine", wallShadow: "ink", baseboard: "wood-dark", accent: "mustard", sofa: "wine" },
};

export const THEME_LABELS: Record<ThemeId, string> = {
  mint: "Menta",
  lavender: "Lavanda",
  terracotta: "Terracota",
  ocean: "Oceano",
  sand: "Areia",
  graphite: "Grafite",
  forest: "Floresta",
  night: "Noite",
  cherry: "Cereja",
  coffee: "Café",
  snow: "Neve",
  sunset: "Pôr do sol",
  industrial: "Industrial",
  office: "Escritório",
  cyber: "Neon",
  lobby: "Lobby",
};

export function isRoomThemeId(id: string): id is RoomThemeId {
  return (ROOM_THEME_IDS as readonly string[]).includes(id);
}

/** Desenho do piso do tema (padrão "checker"). */
export function themeFloorPattern(theme: ThemeColors): FloorPattern {
  return theme.floorPattern ?? "checker";
}

/** Acabamento da parede do tema (padrão "plain"). */
export function themeWallStyle(theme: ThemeColors): WallStyle {
  return theme.wallStyle ?? "plain";
}
