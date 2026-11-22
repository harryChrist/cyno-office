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
  it("relatório longo que termina listando decisões em aberto não é pergunta", () => {
    const report = [
      "Parei o lote. Resumo do que aconteceu:",
      "- Subido: 4 dos 41 capítulos novos.",
      "- Faltam 37 sem tradução.",
      "- Etapas: a #291 não está em `_etapas.json`.",
      "Obras incompletas por falta de tradução:",
      "- #292: 27 de 84",
      "- #330: 12 de 48",
      "Continuam abertas as decisões que só você pode tomar:",
      "- **Caminho da tradução:** recarregar o crédito ou redistribuir?",
      "- **Rodadas de correção:** quer que eu crie as próximas à mão?",
      "- **Bug do extrator:** corrijo a regra e confiro os capítulos?",
      "Se quiser a opção mais rápida, me diga qual das três destrava e eu faço o resto.",
    ].join("\n");
    expect(looksLikeQuestion(report)).toBe(false);
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
