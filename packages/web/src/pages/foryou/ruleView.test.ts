import { describe, expect, it } from "vitest";
import { ruleScopeLabel, ruleScopeOptions, ruleSourceLabel, ruleStateText, sameScope, scopeKey } from "./ruleView";

describe("cartão de regra: escopo", () => {
  it("a chave e a comparação ignoram o quarto que acompanha o agente", () => {
    expect(scopeKey({ global: true })).toBe("global");
    expect(scopeKey({ agentId: "clara", roomId: "q" })).toBe("agent-clara");
    expect(scopeKey({ roomId: "q" })).toBe("room-q");
    expect(sameScope({ agentId: "clara", roomId: "q" }, { agentId: "clara" })).toBe(true);
    expect(sameScope({ agentId: "clara" }, { global: true })).toBe(false);
  });

  it("as três opções (agente, quarto, workspace) dizem onde a nota vai", () => {
    const options = ruleScopeOptions({ agentId: "clara", roomId: "q" }, { scope: { global: true } }, "Clara", "Estúdio");
    expect(options.map((option) => option.label)).toEqual(["Só Clara", "Todos do quarto Estúdio", "Todo o workspace"]);
    expect(options[0]!.scope).toEqual({ agentId: "clara", roomId: "q" });
    expect(options[1]!.scope).toEqual({ roomId: "q" });
    expect(options[2]!.scope).toEqual({ global: true });
    expect(ruleScopeLabel({ agentId: "x" }, undefined, undefined)).toBe("Só o agente");
  });

  it("a origem e o estado do cartão", () => {
    expect(ruleSourceLabel("molde")).toBe("Texto por molde, sem IA.");
    expect(ruleSourceLabel("maestro")).toBe("Escrita pelo Maestro.");
    expect(ruleStateText({ status: "pendente" })).toBe("esperando o seu OK");
    expect(ruleStateText({ status: "aprovado", decidedAt: "2026-11-13T15:00:00.000Z" })).toBe("aprovada em 13/11: a nota está no Cérebro");
    expect(ruleStateText({ status: "rejeitado", decidedAt: "2026-11-13T15:00:00.000Z" })).toContain("8 semanas");
  });
});
