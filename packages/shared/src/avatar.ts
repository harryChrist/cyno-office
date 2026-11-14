import type { PaletteColorId } from "./palette";

/** Opções válidas de avatar. Cores são subconjuntos nomeados da paleta. */
export const AVATAR_OPTIONS = {
  skin: ["tone1", "tone2", "tone3", "tone4", "tone5", "tone6"],
  hair: ["short", "long", "curly", "buzz", "bun", "mohawk", "bald", "ponytail"],
  hairColor: [
    "ink",
    "wood-dark",
    "wood",
    "sunflower",
    "terracotta",
    "stone",
    "cloud",
    "rose",
    "ocean",
    "lavender",
  ],
  shirt: [
    "tomato",
    "wine",
    "mustard",
    "mint",
    "leaf",
    "ocean",
    "denim",
    "navy",
    "lavender",
    "rose",
    "cream",
    "charcoal",
  ],
  pants: ["denim", "navy", "charcoal", "slate", "wood", "sand-dark", "wine", "leaf-dark"],
  accessory: ["glasses", "headphones", "cap", "scarf", "earring"],
} as const satisfies {
  skin: readonly string[];
  hair: readonly string[];
  hairColor: readonly PaletteColorId[];
  shirt: readonly PaletteColorId[];
  pants: readonly PaletteColorId[];
  accessory: readonly string[];
};

/**
 * As peças do motor de cena (as mesmas de `packages/cena/shared/appearance.ts`; um teste do web confere que não se
 * separam). Ficam no campo opcional `avatar.cena`: quem não o tem continua valendo pelos campos de cima, e o
 * motor usa o `cena` por cima quando existe.
 */
export const SCENE_AVATAR_OPTIONS = {
  hairStyle: ["short", "buzz", "spiky", "side_part", "curly", "afro", "bob", "long", "ponytail", "bun", "pigtails", "mohawk", "bald", "wavy"],
  topStyle: ["tshirt", "hoodie", "shirt_tie", "sweater", "jacket", "blouse", "polo"],
  accessory: ["none", "glasses", "sunglasses", "headphones", "cap", "beanie", "earrings", "bow"],
} as const;
export type SceneHairStyle = (typeof SCENE_AVATAR_OPTIONS.hairStyle)[number];
export type SceneTopStyle = (typeof SCENE_AVATAR_OPTIONS.topStyle)[number];
export type SceneAccessory = (typeof SCENE_AVATAR_OPTIONS.accessory)[number];

export type SkinToneId = (typeof AVATAR_OPTIONS.skin)[number];
export type HairStyleId = (typeof AVATAR_OPTIONS.hair)[number];
export type HairColorId = (typeof AVATAR_OPTIONS.hairColor)[number];
export type ShirtColorId = (typeof AVATAR_OPTIONS.shirt)[number];
export type PantsColorId = (typeof AVATAR_OPTIONS.pants)[number];
export type AccessoryId = (typeof AVATAR_OPTIONS.accessory)[number];

/** Cor base da paleta para cada tom de pele. */
export const SKIN_TONE_COLORS: Record<SkinToneId, PaletteColorId> = {
  tone1: "skin-1",
  tone2: "skin-2",
  tone3: "skin-3",
  tone4: "skin-4",
  tone5: "skin-5",
  tone6: "skin-6",
};

/** Cor de sombra de cada tom (o próximo degrau mais escuro da rampa de pele). */
export const SKIN_TONE_SHADES: Record<SkinToneId, PaletteColorId> = {
  tone1: "skin-2",
  tone2: "skin-3",
  tone3: "skin-4",
  tone4: "skin-5",
  tone5: "skin-6",
  tone6: "skin-shade",
};
