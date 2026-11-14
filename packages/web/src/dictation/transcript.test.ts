import { describe, expect, it } from "vitest";
import { dictationAvailability, dictationErrorMessage, splitResults, UNAVAILABLE_MESSAGES } from "./speech";
import { composeDictation, insertTranscript, joinSpeech } from "./transcript";

describe("insertTranscript", () => {
  it("campo vazio: a fala entra com maiúscula e o cursor vai para o fim dela", () => {
    expect(insertTranscript({ text: "", caret: 0 }, "criar um post sobre vagas")).toEqual({ text: "Criar um post sobre vagas", caret: 25 });
  });

  it("no fim do texto: separa com espaço e não força maiúscula no meio da frase", () => {
    expect(insertTranscript({ text: "Criar um post", caret: 13 }, "sobre vagas")).toEqual({ text: "Criar um post sobre vagas", caret: 25 });
  });

  it("depois de ponto ou quebra de linha começa frase nova", () => {
    expect(insertTranscript({ text: "Feito.", caret: 6 }, "agora revise")).toEqual({ text: "Feito. Agora revise", caret: 19 });
    expect(insertTranscript({ text: "Linha\n", caret: 6 }, "outra")).toEqual({ text: "Linha\nOutra", caret: 11 });
  });

  it("no meio do texto (cursor): espaços dos dois lados, sem espaço antes de pontuação", () => {
    expect(insertTranscript({ text: "post vagas", caret: 4 }, "sobre")).toEqual({ text: "post sobre vagas", caret: 10 });
    expect(insertTranscript({ text: "post, ok", caret: 4 }, "de vagas")).toEqual({ text: "post de vagas, ok", caret: 13 });
  });

  it("fala vazia não muda nada; cursor fora do texto é ajustado", () => {
    expect(insertTranscript({ text: "abc", caret: 3 }, "   ")).toEqual({ text: "abc", caret: 3 });
    expect(insertTranscript({ text: "abc", caret: 99 }, "d")).toEqual({ text: "abc d", caret: 5 });
  });
});

describe("composeDictation / joinSpeech", () => {
  it("o interino aparece ao vivo depois do definitivo, sempre a partir da mesma base", () => {
    const base = { text: "Pedido:", caret: 7 };
    expect(joinSpeech(" revisar  o ", "post ")).toBe("revisar o post");
    expect(composeDictation(base, "", "revisar")).toEqual({ text: "Pedido: revisar", caret: 15 });
    expect(composeDictation(base, "revisar o post", "de hoje")).toEqual({ text: "Pedido: revisar o post de hoje", caret: 30 });
    expect(composeDictation(base, "", "")).toEqual(base);
  });
});

describe("speech", () => {
  it("disponibilidade: HTTPS primeiro, depois a API do navegador", () => {
    expect(dictationAvailability({ secure: false, hasApi: true })).toEqual({ ok: false, reason: "insecure" });
    expect(dictationAvailability({ secure: true, hasApi: false })).toEqual({ ok: false, reason: "unsupported" });
    expect(dictationAvailability({ secure: true, hasApi: true })).toEqual({ ok: true });
    expect(UNAVAILABLE_MESSAGES.insecure).toMatch(/HTTPS/);
  });

  it("separa resultados definitivos e interinos", () => {
    const result = (transcript: string, isFinal: boolean) => Object.assign([{ transcript }], { isFinal });
    expect(splitResults(Object.assign([result("revisar o post", true), result("de", false), result("hoje", false)]))).toEqual({
      finalText: "revisar o post",
      interimText: "de hoje",
    });
  });

  it("mensagens de erro em pt-BR; cancelar não é erro", () => {
    expect(dictationErrorMessage("aborted")).toBeNull();
    expect(dictationErrorMessage("not-allowed")).toMatch(/Permissão do microfone/);
    expect(dictationErrorMessage("audio-capture")).toBe("Nenhum microfone encontrado.");
    expect(dictationErrorMessage("qualquer")).toBe("O ditado falhou. Tente de novo.");
  });
});
