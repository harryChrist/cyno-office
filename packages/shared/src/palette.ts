/**
 * Paleta única do Cyno: TODA cor do projeto (sprites, móveis, temas, UI pixel)
 * sai daqui. Tons quentes de "hotel pixel", organizados em rampas escuro -> claro.
 */
export const PALETTE = {
  // Neutros e contornos
  ink: "#1c1522",
  charcoal: "#2f2836",
  slate: "#4f4859",
  stone: "#8b8494",
  cloud: "#cfc8d2",
  cream: "#f6eedd",

  // Pele (tone1 = mais clara ... tone6 = mais escura; skin-shade sombreia a mais escura)
  "skin-1": "#fde3cf",
  "skin-2": "#f2c6a0",
  "skin-3": "#dba277",
  "skin-4": "#b67b52",
  "skin-5": "#8a5636",
  "skin-6": "#5f3a26",
  "skin-shade": "#40261a",

  // Madeira (móveis, rodapés, piso do lobby)
  "wood-dark": "#5b3a29",
  wood: "#8f5e3b",
  "wood-light": "#c28d5c",

  // Rampas dos temas (piso e paredes)
  "mint-dark": "#3f8a73",
  mint: "#6fbf9e",
  "mint-light": "#b5e3cc",
  "lavender-dark": "#6b5a9e",
  lavender: "#9d8cc9",
  "lavender-light": "#d3c9ec",
  "terracotta-dark": "#8f3f2b",
  terracotta: "#c4663f",
  "terracotta-light": "#e9a983",
  "ocean-dark": "#245a7a",
  ocean: "#3f8fb5",
  "ocean-light": "#94cde3",
  "sand-dark": "#b08a52",
  sand: "#dcbf86",
  "sand-light": "#f1e2b8",
  "ice-dark": "#6fa8c4",
  ice: "#b7dcea",
  "ice-light": "#e6f4f8",
  tangerine: "#ec8a3e",
  peach: "#f8c69a",

  // Plantas
  "leaf-dark": "#2f5e34",
  leaf: "#4f8f47",
  "leaf-light": "#8cc663",

  // Tela de PC (o corpo do monitor usa os neutros slate/stone)
  "screen-dark": "#1f3b48",
  "screen-glow": "#7fe3d4",

  // Roupas e detalhes
  tomato: "#d8513f",
  wine: "#8c2c43",
  mustard: "#e0a93b",
  sunflower: "#f5d769",
  denim: "#4b6fa8",
  navy: "#2d3b66",
  rose: "#e58aa5",
  "rose-dark": "#b4557a",
  "rose-light": "#f6c3cf",
  // Néons (temas Noite e Neon)
  violet: "#9b5de5",
  magenta: "#e0408a",
} as const satisfies Record<string, `#${string}`>;

export type PaletteColorId = keyof typeof PALETTE;

export const PALETTE_COLOR_IDS = Object.keys(PALETTE) as PaletteColorId[];

export function isPaletteColorId(id: string): id is PaletteColorId {
  return Object.hasOwn(PALETTE, id);
}

/** Hex da cor (ex.: "#1c1522"). */
export function paletteHex(id: PaletteColorId): string {
  return PALETTE[id];
}

/** Cor como número 0xRRGGBB (formato usado pelo PixiJS). */
export function paletteNumber(id: PaletteColorId): number {
  return Number.parseInt(PALETTE[id].slice(1), 16);
}
