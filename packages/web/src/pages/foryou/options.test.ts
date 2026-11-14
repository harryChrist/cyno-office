import { describe, expect, it } from "vitest";
import { joinOptions, shortOptionLabel, splitOptions } from "./options";

const TEXT = "OPÇÃO 1 · PIX\n\nPagamento aprovado.\n\n---\n\nOPÇÃO 2 · Banco\n\nOutro texto.\n\n---\n\nOPÇÃO 3\n\nTerceiro.\n";

describe("splitOptions", () => {
  it("fatia as opções e remonta o texto idêntico", () => {
    const options = splitOptions(TEXT);
    expect(options?.parts.map((part) => part.label)).toEqual(["Opção 1 · PIX", "Opção 2 · Banco", "Opção 3"]);
    expect(options?.parts[0]?.body).toBe("OPÇÃO 1 · PIX\n\nPagamento aprovado.\n");
    expect(joinOptions(options!)).toBe(TEXT);
  });

  it("editar uma opção troca só o corpo dela", () => {
    const options = splitOptions(TEXT)!;
    const next = joinOptions(options, 1, "OPÇÃO 2 · Banco\n\nNovo.\n");
    expect(next).toBe(TEXT.replace("Outro texto.\n", "Novo.\n"));
    expect(splitOptions(next)?.parts).toHaveLength(3);
  });

  it("funciona sem separador ---, com markdown e sem acento", () => {
    const text = "## Opcao 1: Curta\nA\n\n## Opcao 2: Longa\nB";
    const options = splitOptions(text)!;
    expect(options.parts.map((part) => part.label)).toEqual(["Opção 1 · Curta", "Opção 2 · Longa"]);
    expect(joinOptions(options)).toBe(text);
  });

  it("espaços no fim da opção ativa ficam no corpo (digitar não some com o espaço)", () => {
    const options = splitOptions("OPÇÃO 1\nA\n\n---\n\nOPÇÃO 2\nB")!;
    const next = joinOptions(options, 0, "OPÇÃO 1\nA\n\n\n");
    expect(splitOptions(next)?.parts[0]?.body).toBe("OPÇÃO 1\nA\n\n\n");
  });

  it("não trata como opções: um título só, texto antes do primeiro título, texto comum", () => {
    expect(splitOptions("OPÇÃO 1\nsó uma")).toBeNull();
    expect(splitOptions("Olá!\n\nOPÇÃO 1\nA\n\nOPÇÃO 2\nB")).toBeNull();
    expect(splitOptions("Um post normal.\n\n---\n\nCom linha.")).toBeNull();
    expect(splitOptions("Veja a opção 1 e a opção 2 no texto")).toBeNull();
  });

  it("rótulo curto da aba", () => {
    expect(shortOptionLabel("Opção 2 · Banco")).toBe("Opção 2");
  });
});
