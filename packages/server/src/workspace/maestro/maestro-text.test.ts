import { describe, expect, it } from "vitest";
import { citedRequestId, isChatTag, looksLikeQuestion } from "./maestro-text";

describe("looksLikeQuestion", () => {
  it("última linha com ? (mesmo com marcação markdown depois)", () => {
    expect(looksLikeQuestion("Pronto.\n\nQual tom você prefere?")).toBe(true);
    expect(looksLikeQuestion("Qual tom você prefere?**")).toBe(true);
  });
  it("duas perguntas entre as últimas linhas", () => {
    expect(looksLikeQuestion("Quer A?\nOu B?\nEscolha um, por favor.")).toBe(true);
  });
  it("afirmação e uma pergunta isolada no meio não contam", () => {
    expect(looksLikeQuestion("Feito. Entreguei o texto.")).toBe(false);
    expect(looksLikeQuestion("Quer A?\nFeito.\nObrigado.")).toBe(false);
  });
});

describe("etiquetas e citações", () => {
  it("isChatTag reconhece só 'conversa:'", () => {
    expect(isChatTag("conversa:abc")).toBe(true);
    expect(isChatTag("pedido-1")).toBe(false);
    expect(isChatTag(undefined)).toBe(false);
  });
  it("citedRequestId acha o uuid depois de 'Pedido '", () => {
    const id = "0b9c1f2e-1111-4222-8333-444455556666";
    expect(citedRequestId(`Pedido ${id}: continue`)).toBe(id);
    expect(citedRequestId("sem pedido aqui")).toBeUndefined();
  });
});
