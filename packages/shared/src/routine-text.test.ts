import { describe, expect, it } from "vitest";
import { cleanSummary, fullDetail } from "./routine-text";

describe("cleanSummary", () => {
  it("tira o markdown e fica com a primeira frase útil", () => {
    const text = "## Resumo\n\n- **Publiquei** 2 posts no [LinkedIn](https://linkedin.com/x). Os links estão registrados.\n- Nada mais.";
    expect(cleanSummary(text)).toBe("Publiquei 2 posts no LinkedIn.");
  });

  it("achata listas e ignora cercas de código e linhas de enfeite", () => {
    const out = cleanSummary("---\n```\nnoise\n```\n1. Conferi 3 vagas\n2. Nenhuma mudou");
    expect(out).not.toMatch(/[`*#-]{2}/);
    expect(out.startsWith("Conferi 3 vagas")).toBe(true);
    expect(out).not.toContain("noise");
  });

  it("corta em 200 caracteres com reticências e não corta decimais nem domínios", () => {
    const out = cleanSummary("palavra ".repeat(80));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanSummary("Abri linkedin.com e achei 3.5 mil vagas. Depois fechei.")).toBe("Abri linkedin.com e achei 3.5 mil vagas.");
  });

  it("texto vazio dá vazio", () => {
    expect(cleanSummary("  \n ")).toBe("");
  });
});

describe("fullDetail", () => {
  it("mantém as quebras de linha e aplica o limite", () => {
    expect(fullDetail("a  \nb\n\n")).toBe("a\nb");
    expect(fullDetail("x".repeat(50), 10)).toHaveLength(10);
  });
});
