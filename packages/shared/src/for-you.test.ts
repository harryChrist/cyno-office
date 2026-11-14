import { describe, expect, it } from "vitest";
import { forYouDecisionBodySchema } from "./api";
import { deduceForYouType, nextForYouId, REJECTION_CATEGORIES } from "./for-you";
import { legacyForYouLimit as forYouLimit, LEGACY_FOR_YOU_TYPES } from "./for-you-types";

describe("deduceForYouType", () => {
  it.each([
    ["Escrever um post sobre o lançamento", "post"],
    ["Responder o comentário da Ana", "comentario"],
    ["Mandar convites para 3 recrutadores", "convite"],
    ["Revisar o perfil", "perfil"],
    ["Mensagem para o Rui", "mensagem"],
    ["Resposta para a Bia", "resposta"],
    ["Mensagem de boas-vindas para novos contatos", "boas-vindas"],
    ["Boas vindas ao Caio", "boas-vindas"],
    ["Resposta ao comentário do Leo", "resposta"],
    ["Qual o melhor horário para publicar? [aprovar]", "pergunta"],
    ["Devo usar emoji", "pergunta"],
    ["Tenho uma dúvida sobre o tom", "pergunta"],
    ["Organizar a planilha [aprovar]", "outro"],
  ] as const)("%s -> %s", (prompt, type) => {
    expect(deduceForYouType(prompt)).toBe(type);
  });

  it("todo tipo deduzido existe entre os de antes (com rótulo)", () => {
    const ids = LEGACY_FOR_YOU_TYPES.map((type) => type.id);
    for (const prompt of ["post", "comentário", "convite", "perfil", "mensagem", "resposta", "boas-vindas", "qual?", "x"]) {
      expect(ids).toContain(deduceForYouType(prompt));
    }
  });

  it("um tipo novo do workspace citado pelo nome vence (o nome mais longo primeiro)", () => {
    const types = [
      { id: "reels", name: "Reels" },
      { id: "reels-curtos", name: "Reels curtos" },
      { id: "comentario", name: "Comentário" },
    ];
    expect(deduceForYouType("Roteiro de reels curtos sobre o lançamento", types)).toBe("reels-curtos");
    expect(deduceForYouType("Fazer um reel novo", types)).toBe("outro");
    expect(deduceForYouType("Gravar 3 reels", types)).toBe("reels");
    // Os de antes continuam com a prioridade das palavras próprias.
    expect(deduceForYouType("Resposta ao comentário do Leo", types)).toBe("resposta");
  });
});

describe("forYouLimit", () => {
  it("limites por tipo e, no perfil, pelo 'onde'", () => {
    expect(forYouLimit("convite")).toEqual({ max: 200, name: "convite" });
    expect(forYouLimit("boas-vindas")?.max).toBe(300);
    expect(forYouLimit("mensagem")?.max).toBe(1000);
    expect(forYouLimit("resposta")?.max).toBe(1000);
    expect(forYouLimit("perfil", "Headline")?.max).toBe(220);
    expect(forYouLimit("perfil", "Título")?.max).toBe(220);
    expect(forYouLimit("perfil", "Sobre")?.max).toBe(2600);
    expect(forYouLimit("perfil", "Experiência na Acme")?.max).toBe(2000);
    expect(forYouLimit("perfil", "Projeto X")?.max).toBe(2000);
    expect(forYouLimit("perfil", "Foto")).toBeNull();
    expect(forYouLimit("post")).toBeNull();
    expect(forYouLimit("pergunta")).toBeNull();
  });
});

describe("nextForYouId", () => {
  it("começa em A-0001 e segue o maior existente", () => {
    expect(nextForYouId([])).toBe("A-0001");
    expect(nextForYouId([{ id: "A-0001" }, { id: "A-0009" }, { id: "A-0003" }])).toBe("A-0010");
    expect(nextForYouId([{ id: "A-9999" }])).toBe("A-10000");
  });
});

describe("forYouDecisionBodySchema", () => {
  it("responder exige resposta; aprovar não aceita texto vazio", () => {
    expect(forYouDecisionBodySchema.safeParse({ status: "respondido" }).success).toBe(false);
    expect(forYouDecisionBodySchema.safeParse({ status: "respondido", response: "  " }).success).toBe(false);
    expect(forYouDecisionBodySchema.safeParse({ status: "respondido", response: "ok" }).success).toBe(true);
    expect(forYouDecisionBodySchema.safeParse({ status: "aprovado", text: "" }).success).toBe(false);
    expect(forYouDecisionBodySchema.safeParse({ status: "aprovado" }).success).toBe(true);
    expect(forYouDecisionBodySchema.safeParse({ status: "pendente" }).success).toBe(true);
    expect(forYouDecisionBodySchema.safeParse({ status: "rejeitado", extra: 1 }).success).toBe(false);
  });

  it("a categoria da recusa é opcional e só aceita a lista curta", () => {
    expect(forYouDecisionBodySchema.safeParse({ status: "rejeitado" }).success).toBe(true);
    for (const category of REJECTION_CATEGORIES) expect(forYouDecisionBodySchema.safeParse({ status: "rejeitado", category }).success).toBe(true);
    expect(REJECTION_CATEGORIES).toEqual(["texto", "tom", "fato_errado", "formato", "fora_do_pedido", "outro"]);
    expect(forYouDecisionBodySchema.safeParse({ status: "rejeitado", category: "chato" }).success).toBe(false);
  });
});
