import { describe, expect, it } from "vitest";
import {
  autoForYouType,
  builtinForYouTypes,
  createForYouTypeBodySchema,
  findForYouType,
  formatCharCount,
  forYouLimit,
  forYouLimitsText,
  forYouOverLimit,
  forYouTextLength,
  forYouTypeForRequest,
  forYouTypeColorVar,
  forYouTypeDefSchema,
  forYouTypeIdFrom,
  forYouTypeNameFrom,
  iconForText,
  LEGACY_FOR_YOU_TYPES,
  legacyForYouTypes,
  nextFreeColor,
  sliceForYouText,
  FOR_YOU_TYPE_COLORS,
  type ForYouTypeDef,
} from "./for-you-types";

const AT = "2026-11-08T12:00:00.000Z";

describe("tipos embutidos e os de antes", () => {
  it("todo workspace nasce com pergunta e outro (do sistema)", () => {
    const types = builtinForYouTypes(AT);
    expect(types.map((type) => [type.id, type.behavior, type.createdBy])).toEqual([
      ["pergunta", "pergunta", "system"],
      ["outro", "texto", "system"],
    ]);
  });

  it("os 9 de antes são válidos, com os mesmos rótulos e cores distintas", () => {
    const types = legacyForYouTypes(AT);
    for (const type of types) expect(forYouTypeDefSchema.safeParse(type).success).toBe(true);
    expect(types.map((type) => type.name)).toEqual(["Pergunta", "Perfil", "Convite", "Boas-vindas", "Mensagem", "Resposta", "Comentário", "Post", "Outro"]);
    expect(new Set(types.map((type) => type.color)).size).toBe(9);
  });

  it("a cor vira o token --ui-tc-N", () => {
    expect(forYouTypeColorVar("azul")).toBe("var(--ui-tc-1)");
    expect(forYouTypeColorVar("coral")).toBe("var(--ui-tc-10)");
  });
});

describe("forYouLimit", () => {
  const byId = (id: string) => LEGACY_FOR_YOU_TYPES.find((type) => type.id === id);

  it("limites dos de antes iguais aos de sempre", () => {
    expect(forYouLimit(byId("convite"))).toEqual({ max: 200, name: "convite" });
    expect(forYouLimit(byId("boas-vindas"))).toEqual({ max: 300, name: "boas-vindas" });
    expect(forYouLimit(byId("perfil"), "Título")).toEqual({ max: 220, name: "headline" });
    expect(forYouLimit(byId("perfil"), "  sobre mim")).toEqual({ max: 2600, name: "Sobre" });
    expect(forYouLimit(byId("perfil"))).toBeNull();
    expect(forYouLimit(undefined)).toBeNull();
  });

  it("por 'onde': prefixo sem caixa nem acento; senão o padrão com o nome do tipo", () => {
    const reels = {
      name: "Reels",
      limits: { default: 150, byWhere: [{ match: "Legenda", max: 2200, name: "legenda" }, { match: "título", max: 60, name: "título" }] },
    };
    expect(forYouLimit(reels, "legenda do reel 3")).toEqual({ max: 2200, name: "legenda" });
    expect(forYouLimit(reels, "TITULO")).toEqual({ max: 60, name: "título" });
    expect(forYouLimit(reels, "Roteiro")).toEqual({ max: 150, name: "reels" });
    expect(forYouLimit(reels)).toEqual({ max: 150, name: "reels" });
  });
});

describe("contagem de caracteres (a mesma no web e no server)", () => {
  it("conta por code point: emoji e acento composto contam como no contador", () => {
    expect(forYouTextLength("")).toBe(0);
    expect(forYouTextLength("Olá, mundo")).toBe(10);
    expect("🎉".length).toBe(2);
    expect(forYouTextLength("🎉 festa")).toBe(7);
    expect(forYouTextLength("linha 1\nlinha 2")).toBe(15);
    expect(sliceForYouText("🎉🎉🎉abc", 4)).toBe("🎉🎉🎉a");
  });

  it("milhar com ponto", () => {
    expect(formatCharCount(7)).toBe("7");
    expect(formatCharCount(2200)).toBe("2.200");
    expect(formatCharCount(2450)).toBe("2.450");
    expect(formatCharCount(100000)).toBe("100.000");
  });

  it("forYouOverLimit: só quando passa (pelo 'onde')", () => {
    const legenda = { name: "Legenda de post", limits: { default: 2200 } };
    expect(forYouOverLimit(legenda, "x".repeat(2200))).toBeNull();
    expect(forYouOverLimit(legenda, "x".repeat(2450))).toEqual({ limit: { max: 2200, name: "legenda de post" }, length: 2450, over: 250 });
    expect(forYouOverLimit(legenda, "🎉".repeat(2200))).toBeNull();
    const perfil = LEGACY_FOR_YOU_TYPES.find((type) => type.id === "perfil");
    expect(forYouOverLimit(perfil, "x".repeat(300), "Headline")?.over).toBe(80);
    expect(forYouOverLimit(perfil, "x".repeat(300), "Sobre")).toBeNull();
    expect(forYouOverLimit(undefined, "x".repeat(99999))).toBeNull();
  });

  it("texto dos limites para o agente", () => {
    expect(forYouLimitsText({ default: 2200 })).toBe("Limite: 2.200 caracteres.");
    expect(forYouLimitsText({ default: 150, byWhere: [{ match: "titulo", max: 60, name: "título" }] })).toBe(
      'Limites conforme o "onde": "titulo…" (título) = 60 caracteres. Nos outros casos, limite: 150 caracteres.',
    );
    expect(forYouLimitsText(undefined)).toBeNull();
    expect(forYouLimitsText({})).toBeNull();
  });

  it("tipo de um pedido: id, slug ou nome; senão o modelo dos de antes; sem tipo, o outro", () => {
    const types: ForYouTypeDef[] = [...builtinForYouTypes(AT), { ...autoForYouType("Legenda de post", [], AT), limits: { default: 2200 } }];
    expect(findForYouType(types, "Legenda de Post")?.id).toBe("legenda-de-post");
    expect(forYouTypeForRequest(types, "legenda-de-post")?.limits).toEqual({ default: 2200 });
    expect(forYouTypeForRequest(types, "convite")?.limits).toEqual({ default: 200 });
    expect(forYouTypeForRequest(types, undefined)?.id).toBe("outro");
    expect(forYouTypeForRequest(types, "Reels")).toBeUndefined();
  });
});

describe("tipo criado na hora (tipo desconhecido)", () => {
  it("ícone pelas palavras do nome", () => {
    expect(iconForText("Reels")).toBe("video");
    expect(iconForText("Carrossel do Instagram")).toBe("imagem");
    expect(iconForText("Newsletter semanal")).toBe("email");
    expect(iconForText("Relatório de métricas")).toBe("grafico");
    expect(iconForText("Coisa sem pista")).toBe("documento");
  });

  it("nome e id a partir do que o agente mandou", () => {
    expect(forYouTypeIdFrom("Reels Curtos")).toBe("reels-curtos");
    expect(forYouTypeIdFrom("!!!")).toBe("outro");
    expect(forYouTypeNameFrom("reels-curtos")).toBe("Reels curtos");
    expect(forYouTypeNameFrom("Thread no X")).toBe("Thread no X");
  });

  it("cores em rodízio: a próxima livre (sem o cinza) e, todas em uso, a menos usada", () => {
    const types = builtinForYouTypes(AT); // âmbar e cinza
    expect(nextFreeColor(types)).toBe("azul");
    const all = FOR_YOU_TYPE_COLORS.filter((color) => color !== "cinza").map((color) => ({ color }));
    expect(nextFreeColor(all)).toBe("azul");
    expect(nextFreeColor([...all, { color: "azul" as const }])).toBe("ciano");
  });

  it("tipo novo: texto, ícone por palavra, próxima cor livre, criado pelo Maestro", () => {
    const types: ForYouTypeDef[] = builtinForYouTypes(AT);
    const reels = autoForYouType("Reels", types, AT);
    expect(reels).toMatchObject({ id: "reels", name: "Reels", behavior: "texto", icon: "video", color: "azul", createdBy: "maestro" });
    expect(forYouTypeDefSchema.safeParse(reels).success).toBe(true);
    const next = autoForYouType("newsletter", [...types, reels], AT);
    expect(next).toMatchObject({ id: "newsletter", name: "Newsletter", icon: "email", color: "ciano" });
  });

  it("um dos de antes vem do modelo (limites e ícone); a cor muda se já estiver em uso", () => {
    const convite = autoForYouType("convite", builtinForYouTypes(AT), AT);
    expect(convite).toMatchObject({ name: "Convite", icon: "pessoa-mais", color: "ciano", limits: { default: 200 } });
    const taken = autoForYouType("convite", [...builtinForYouTypes(AT), { ...convite, id: "x", color: "ciano" }], AT);
    expect(taken.color).toBe("azul");
  });
});

describe("validação", () => {
  it("criar exige nome; id, ícone e cor só da lista", () => {
    expect(createForYouTypeBodySchema.safeParse({ name: "Reels" }).success).toBe(true);
    expect(createForYouTypeBodySchema.safeParse({ name: " " }).success).toBe(false);
    expect(createForYouTypeBodySchema.safeParse({ name: "Reels", color: "roxo" }).success).toBe(false);
    expect(createForYouTypeBodySchema.safeParse({ name: "Reels", icon: "foguete" }).success).toBe(false);
    expect(createForYouTypeBodySchema.safeParse({ name: "Reels", id: "Reels!" }).success).toBe(false);
  });
});
