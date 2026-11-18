import { describe, expect, it } from "vitest";
import { cleanRule, parseRules, renderRules, rulesCountLabel } from "./rulesText";

describe("rulesText", () => {
  it("lê uma lista simples, com ou sem abertura", () => {
    expect(parseRules("- a\n- b")).toEqual({ intro: "", rules: ["a", "b"] });
    expect(parseRules("Regras que valem nesta sala.\n\n- a\n* b\n1. c")).toEqual({ intro: "Regras que valem nesta sala.", rules: ["a", "b", "c"] });
    expect(parseRules("")).toEqual({ intro: "", rules: [] });
  });

  it("linha recuada continua a regra de cima", () => {
    expect(parseRules("- primeira parte\n  segunda parte\n- outra")).toEqual({ intro: "", rules: ["primeira parte segunda parte", "outra"] });
  });

  it("texto que não é só uma lista fica para a edição como texto", () => {
    expect(parseRules("- a\n\nUm parágrafo solto")).toBeNull();
    expect(parseRules("## Título\n- a")).toBeNull();
    expect(parseRules("- a\n## Outro bloco\n- b")).toBeNull();
  });

  it("devolve o markdown com um traço por regra e sem as vazias", () => {
    expect(renderRules({ intro: "", rules: ["a", "  ", "- b", "c\nd"] })).toBe("- a\n- b\n- c d");
    expect(renderRules({ intro: "Abertura.", rules: ["a"] })).toBe("Abertura.\n\n- a");
    expect(renderRules({ intro: "Abertura.", rules: [] })).toBe("Abertura.");
    expect(renderRules({ intro: "", rules: [] })).toBe("");
  });

  it("ida e volta não muda o texto", () => {
    const text = "Abertura.\n\n- a\n- b";
    expect(renderRules(parseRules(text)!)).toBe(text);
  });

  it("limpa a regra e conta", () => {
    expect(cleanRule("  - sempre   conferir \n antes ")).toBe("sempre conferir antes");
    expect(rulesCountLabel([])).toBe("Nenhuma regra");
    expect(rulesCountLabel(["a", " "])).toBe("1 regra");
    expect(rulesCountLabel(["a", "b"])).toBe("2 regras");
  });
});
