import {
  AVATAR_OPTIONS,
  avatarSchema,
  SCENE_AVATAR_OPTIONS,
  SKIN_TONE_COLORS,
  type AccessoryId,
  type Avatar,
  type CreateAgentBody,
  type HairStyleId,
  type PaletteColorId,
  type SceneAccessory,
  type SceneHairStyle,
  type SceneTopStyle,
  type SkinToneId,
} from "@cyno/shared";

export const HAIR_LABELS: Record<HairStyleId, string> = {
  short: "Curto",
  long: "Longo",
  curly: "Cacheado",
  buzz: "Raspado",
  bun: "Coque",
  mohawk: "Moicano",
  bald: "Careca",
  ponytail: "Rabo de cavalo",
};

export const ACCESSORY_LABELS: Record<AccessoryId, string> = {
  glasses: "Óculos",
  headphones: "Fones",
  cap: "Boné",
  scarf: "Cachecol",
  earring: "Brinco",
};

/** Os cabelos do motor de cena (os que o personagem tem no mapa). */
export const SCENE_HAIR_LABELS: Record<SceneHairStyle, string> = {
  short: "Curto",
  buzz: "Raspado",
  spiky: "Espetado",
  side_part: "Risca de lado",
  curly: "Cacheado",
  afro: "Black power",
  bob: "Chanel",
  long: "Longo",
  ponytail: "Rabo de cavalo",
  bun: "Coque",
  pigtails: "Maria-chiquinha",
  mohawk: "Moicano",
  bald: "Careca",
  wavy: "Ondulado",
};

export const SCENE_ACCESSORY_LABELS: Record<SceneAccessory, string> = {
  none: "Nenhum",
  glasses: "Óculos",
  sunglasses: "Óculos escuros",
  headphones: "Fones",
  cap: "Boné",
  beanie: "Gorro",
  earrings: "Brincos",
  bow: "Laço",
};

export const SCENE_TOP_LABELS: Record<SceneTopStyle, string> = {
  tshirt: "Camiseta",
  hoodie: "Moletom",
  shirt_tie: "Camisa e gravata",
  sweater: "Suéter",
  jacket: "Jaqueta",
  blouse: "Blusa",
  polo: "Polo",
};

/** O campo antigo `hair` mais parecido com cada cabelo do motor (quem lê só o formato antigo continua certo). */
const LEGACY_HAIR: Record<SceneHairStyle, HairStyleId> = {
  short: "short",
  buzz: "buzz",
  spiky: "short",
  side_part: "short",
  curly: "curly",
  afro: "curly",
  bob: "long",
  long: "long",
  ponytail: "ponytail",
  bun: "bun",
  pigtails: "ponytail",
  mohawk: "mohawk",
  bald: "bald",
  wavy: "long",
};

/** O campo antigo `accessory` mais parecido com cada acessório do motor (ou nenhum). */
const LEGACY_ACCESSORY: Partial<Record<SceneAccessory, AccessoryId>> = {
  glasses: "glasses",
  sunglasses: "glasses",
  headphones: "headphones",
  cap: "cap",
  beanie: "cap",
  earrings: "earring",
};

/** O cabelo que o personagem mostra: a escolha do motor, ou o campo antigo (que tem o mesmo nome no motor). */
export function sceneHairOf(avatar: Pick<AvatarInput, "hair" | "cena">): SceneHairStyle {
  return avatar.cena?.hairStyle ?? avatar.hair;
}

/** O acessório que o personagem mostra: o escolhido; sem escolha, o campo antigo (cachecol não existe no motor: nenhum). */
export function sceneAccessoryOf(avatar: Pick<AvatarInput, "accessory" | "cena">): SceneAccessory {
  if (avatar.cena?.accessory) return avatar.cena.accessory;
  const old = avatar.accessory;
  return old === "earring" ? "earrings" : old && old !== "scarf" ? old : "none";
}

/** A roupa de cima escolhida; "" = sem escolha (o personagem usa a que a semente do agente dá). */
export function sceneTopOf(avatar: Pick<AvatarInput, "cena">): SceneTopStyle | "" {
  return avatar.cena?.topStyle ?? "";
}

/** Escolhe um cabelo do motor: grava a escolha e o campo antigo mais parecido. */
export function withSceneHair(avatar: AvatarInput, hairStyle: SceneHairStyle): AvatarInput {
  return { ...avatar, hair: LEGACY_HAIR[hairStyle], cena: { ...avatar.cena, hairStyle } };
}

/** Escolhe um acessório do motor: grava a escolha e o campo antigo mais parecido (ou o tira). */
export function withSceneAccessory(avatar: AvatarInput, accessory: SceneAccessory): AvatarInput {
  const { accessory: _old, ...rest } = avatar;
  void _old;
  const legacy = LEGACY_ACCESSORY[accessory];
  return { ...rest, ...(legacy ? { accessory: legacy } : {}), cena: { ...avatar.cena, accessory } };
}

export function withSceneTop(avatar: AvatarInput, topStyle: SceneTopStyle | ""): AvatarInput {
  const { topStyle: _old, ...cena } = avatar.cena ?? {};
  void _old;
  return { ...avatar, cena: { ...cena, ...(topStyle ? { topStyle } : {}) } };
}

export const SKIN_LABELS: Record<SkinToneId, string> = {
  tone1: "Tom 1 (mais claro)",
  tone2: "Tom 2",
  tone3: "Tom 3",
  tone4: "Tom 4",
  tone5: "Tom 5",
  tone6: "Tom 6 (mais escuro)",
};

/** Nome em pt-BR de cada cor da paleta usada em cabelo e roupas. */
export const COLOR_LABELS: Partial<Record<PaletteColorId, string>> = {
  ink: "Preto",
  "wood-dark": "Castanho escuro",
  wood: "Castanho",
  sunflower: "Loiro",
  terracotta: "Ruivo",
  stone: "Grisalho",
  cloud: "Branco",
  rose: "Rosa",
  ocean: "Azul",
  lavender: "Lavanda",
  tomato: "Tomate",
  wine: "Vinho",
  mustard: "Mostarda",
  mint: "Menta",
  leaf: "Folha",
  denim: "Jeans",
  navy: "Marinho",
  cream: "Creme",
  charcoal: "Grafite",
  slate: "Ardósia",
  "sand-dark": "Cáqui",
  "leaf-dark": "Musgo",
};

export function colorLabel(id: PaletteColorId): string {
  return COLOR_LABELS[id] ?? id;
}

export function skinColor(tone: SkinToneId): PaletteColorId {
  return SKIN_TONE_COLORS[tone];
}

/** Avatar com os tipos estreitos que a API aceita (cada campo é uma das AVATAR_OPTIONS). */
export type AvatarInput = CreateAgentBody["avatar"];

/** Converte o avatar do store (strings) para o tipo da API; inválido cai no padrão. */
export function toAvatarInput(avatar: Avatar): AvatarInput {
  const parsed = avatarSchema.safeParse(avatar);
  return parsed.success ? parsed.data : DEFAULT_AVATAR;
}

function pick<T>(options: readonly T[], random: () => number): T {
  const index = Math.min(options.length - 1, Math.floor(random() * options.length));
  return options[Math.max(0, index)]!;
}

/** Avatar aleatório válido (accessory some em ~40% das vezes). `random` em [0, 1). */
export function randomAvatar(random: () => number = Math.random): AvatarInput {
  const avatar: AvatarInput = {
    skin: pick(AVATAR_OPTIONS.skin, random),
    hair: pick(AVATAR_OPTIONS.hair, random),
    hairColor: pick(AVATAR_OPTIONS.hairColor, random),
    shirt: pick(AVATAR_OPTIONS.shirt, random),
    pants: pick(AVATAR_OPTIONS.pants, random),
  };
  const withAccessory = withSceneAccessory(
    withSceneTop(withSceneHair(avatar, pick(SCENE_AVATAR_OPTIONS.hairStyle, random)), pick(SCENE_AVATAR_OPTIONS.topStyle, random)),
    random() >= 0.4 ? pick(SCENE_AVATAR_OPTIONS.accessory.filter((option) => option !== "none"), random) : "none",
  );
  return withAccessory;
}

export const DEFAULT_AVATAR: AvatarInput = { skin: "tone2", hair: "short", hairColor: "wood-dark", shirt: "mint", pants: "denim" };
