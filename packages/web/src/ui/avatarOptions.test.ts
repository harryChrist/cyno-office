import { AVATAR_OPTIONS, avatarSchema, isPaletteColorId, SCENE_AVATAR_OPTIONS } from "@cyno/shared";
import { ACCESSORIES, HAIR_STYLES, TOP_STYLES } from "../../../cena/shared/appearance";
import { avatarParaPartes } from "@cyno/shared/cena";
import { describe, expect, it } from "vitest";
import { ACCESSORY_LABELS, COLOR_LABELS, DEFAULT_AVATAR, HAIR_LABELS, randomAvatar, SCENE_ACCESSORY_LABELS, SCENE_HAIR_LABELS, SCENE_TOP_LABELS, sceneAccessoryOf, sceneHairOf, SKIN_LABELS, toAvatarInput, withSceneAccessory, withSceneHair, withSceneTop } from "./avatarOptions";

/** Gerador determinístico (LCG) para testar várias sementes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("randomAvatar", () => {
  it("sempre gera um avatar válido pelo schema da API", () => {
    for (let seed = 0; seed < 300; seed++) {
      const avatar = randomAvatar(seeded(seed));
      expect(avatarSchema.safeParse(avatar).success, JSON.stringify(avatar)).toBe(true);
    }
  });

  it("aguenta os extremos do random (0 e quase 1)", () => {
    expect(avatarSchema.safeParse(randomAvatar(() => 0)).success).toBe(true);
    expect(avatarSchema.safeParse(randomAvatar(() => 0.999999)).success).toBe(true);
    expect(randomAvatar(() => 0).accessory).toBeUndefined();
    // O último acessório do motor (o laço) não tem par no formato antigo: o campo antigo fica sem acessório.
    expect(randomAvatar(() => 0.999999).cena?.accessory).toBe("bow");
    expect(randomAvatar(() => 0.999999).accessory).toBeUndefined();
  });

  it("varia: sementes diferentes cobrem várias opções", () => {
    const shirts = new Set(Array.from({ length: 200 }, (_, seed) => randomAvatar(seeded(seed)).shirt));
    expect(shirts.size).toBeGreaterThan(6);
  });
});

describe("rótulos do editor", () => {
  it("toda opção tem nome em pt-BR", () => {
    for (const hair of AVATAR_OPTIONS.hair) expect(HAIR_LABELS[hair]).toBeTruthy();
    for (const accessory of AVATAR_OPTIONS.accessory) expect(ACCESSORY_LABELS[accessory]).toBeTruthy();
    for (const skin of AVATAR_OPTIONS.skin) expect(SKIN_LABELS[skin]).toBeTruthy();
    for (const color of [...AVATAR_OPTIONS.hairColor, ...AVATAR_OPTIONS.shirt, ...AVATAR_OPTIONS.pants]) {
      expect(isPaletteColorId(color)).toBe(true);
      expect(COLOR_LABELS[color], color).toBeTruthy();
    }
  });

  it("toAvatarInput mantém o avatar válido e troca o inválido pelo padrão", () => {
    const valid = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "wine", pants: "navy", accessory: "cap" };
    expect(toAvatarInput(valid)).toEqual(valid);
    expect(toAvatarInput({ ...valid, hair: "afro" })).toEqual(DEFAULT_AVATAR);
  });
});


describe("editor com as opções do motor de cena", () => {
  it("as listas do formato são as do motor (não se separam)", () => {
    expect([...SCENE_AVATAR_OPTIONS.hairStyle]).toEqual([...HAIR_STYLES]);
    expect([...SCENE_AVATAR_OPTIONS.topStyle]).toEqual([...TOP_STYLES]);
    expect([...SCENE_AVATAR_OPTIONS.accessory]).toEqual([...ACCESSORIES]);
  });

  it("toda opção do motor tem nome em pt-BR", () => {
    for (const hair of SCENE_AVATAR_OPTIONS.hairStyle) expect(SCENE_HAIR_LABELS[hair]).toBeTruthy();
    for (const accessory of SCENE_AVATAR_OPTIONS.accessory) expect(SCENE_ACCESSORY_LABELS[accessory]).toBeTruthy();
    for (const top of SCENE_AVATAR_OPTIONS.topStyle) expect(SCENE_TOP_LABELS[top]).toBeTruthy();
  });

  it("escolher cabelo, acessório e roupa grava o campo `cena` e mantém o formato antigo coerente", () => {
    let avatar = withSceneHair(DEFAULT_AVATAR, "pigtails");
    expect(avatar).toMatchObject({ hair: "ponytail", cena: { hairStyle: "pigtails" } });
    avatar = withSceneAccessory(avatar, "sunglasses");
    expect(avatar).toMatchObject({ accessory: "glasses", cena: { hairStyle: "pigtails", accessory: "sunglasses" } });
    avatar = withSceneAccessory(avatar, "bow");
    expect(avatar.accessory).toBeUndefined();
    avatar = withSceneTop(avatar, "hoodie");
    expect(avatar.cena).toEqual({ hairStyle: "pigtails", accessory: "bow", topStyle: "hoodie" });
    expect(withSceneTop(avatar, "").cena?.topStyle).toBeUndefined();
    expect(avatarSchema.safeParse(avatar).success).toBe(true);
  });

  it("o motor desenha o que o editor mostra: o `cena` vale por cima; avatar antigo (cachecol) vira sem acessório", () => {
    const avatar = withSceneAccessory(withSceneHair(DEFAULT_AVATAR, "afro"), "beanie");
    expect(avatarParaPartes(avatar)).toMatchObject({ hairStyle: "afro", accessory: "beanie" });
    expect(avatarParaPartes(withSceneAccessory(DEFAULT_AVATAR, "none")).accessory).toBe("none");
    const antigo = { ...DEFAULT_AVATAR, accessory: "scarf" as const };
    expect(sceneAccessoryOf(antigo)).toBe("none");
    expect(sceneHairOf(antigo)).toBe("short");
    expect(avatarParaPartes(DEFAULT_AVATAR).hairStyle).toBe("short");
  });
});
