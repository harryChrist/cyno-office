import { describe, expect, it } from "vitest";
import { buildModeBody, grantSummary, initialForm, modeView, onlyOtherTypesNote } from "./modeView";
import { brasiliaShortDate, fromBrasiliaInput, toBrasiliaInput } from "./workTime";

const AT = "2026-11-11T15:00:00.000Z";
const names = new Map([["comentario", "Comentário"]]);

describe("formulário do Modo Automático", () => {
  it("monta o corpo com tipos, teto e sites; recusa sem tipo ou com teto inválido", () => {
    expect(buildModeBody({ actions: ["comentario"], cap: "8", sites: "linkedin.com, www.x.com" })).toEqual({ body: { kind: "automatico", actions: ["comentario"], dailyCap: 8, sites: ["linkedin.com", "www.x.com"] } });
    expect(buildModeBody({ actions: ["comentario"], cap: "2", sites: "" })).toEqual({ body: { kind: "automatico", actions: ["comentario"], dailyCap: 2 } });
    expect(buildModeBody({ actions: [], cap: "8", sites: "" })).toHaveProperty("problem");
    expect(buildModeBody({ actions: ["a"], cap: "0", sites: "" })).toHaveProperty("problem");
    expect(buildModeBody({ actions: ["a"], cap: "2,5", sites: "" })).toHaveProperty("problem");
  });

  it("começa com a sugestão do Maestro, ou com o teto padrão", () => {
    expect(initialForm({ actions: ["comentario"], dailyCap: 4, sites: ["a.com"], approvedAt: AT })).toEqual({ actions: ["comentario"], cap: "4", sites: "a.com" });
    expect(initialForm(undefined)).toEqual({ actions: [], cap: "8", sites: "" });
  });
});

describe("visão do modo", () => {
  const base = { status: "ativo" as const, mode: { kind: "pede-ok" as const } };

  it("Pede OK com sugestão mostra a proposta", () => {
    const view = modeView({ ...base, modeProposal: { by: "maestro", at: AT, grant: { actions: ["comentario"], dailyCap: 8, approvedAt: AT } } }, Date.parse(AT));
    expect(view).toMatchObject({ kind: "pede-ok", proposal: { actions: ["comentario"], by: "maestro" } });
  });

  it("Automático: o uso é o de hoje (São Paulo), o teto atingido e a pausa aparecem", () => {
    const mode = { kind: "automatico" as const, grant: { actions: ["comentario"], dailyCap: 3, approvedAt: AT } };
    const today = { day: "2026-11-11", count: 3 };
    expect(modeView({ status: "ativo", mode, autoUsage: today }, Date.parse(AT))).toMatchObject({ kind: "automatico", used: 3, capReached: true, paused: false });
    // No dia seguinte o contador de ontem não vale.
    expect(modeView({ status: "pausado", mode, autoUsage: today }, Date.parse("2026-11-12T15:00:00.000Z"))).toMatchObject({ used: 0, capReached: false, paused: true });
  });

  it("resumo: o que está liberado e o uso", () => {
    expect(grantSummary({ actions: ["comentario"], dailyCap: 8, sites: ["linkedin.com"], approvedAt: AT }, 3, names)).toBe("Libera sozinho: comentário · só em linkedin.com · 3 de 8 hoje");
  });
});

describe("horários no fuso de São Paulo", () => {
  it("ida e volta do campo de data (UTC-3) e a data curta, seja qual for o fuso do navegador", () => {
    expect(toBrasiliaInput("2026-11-11T21:30:00.000Z")).toBe("2026-11-11T18:30");
    expect(fromBrasiliaInput("2026-11-11T18:30")).toBe("2026-11-11T21:30:00.000Z");
    expect(fromBrasiliaInput("")).toBeNull();
    expect(brasiliaShortDate("2026-11-11T21:30:00.000Z")).toBe("11/11 18:30");
    expect(brasiliaShortDate("2026-11-11T03:00:00.000Z")).toBe("11/11");
  });
});

describe("aviso quando só existe o tipo Outro", () => {
  it("explica por quê só quando a lista é só Outro", () => {
    expect(onlyOtherTypesNote([{ id: "outro" }])).toMatch(/Só há o tipo "Outro"/);
    expect(onlyOtherTypesNote([{ id: "outro" }, { id: "comentario" }])).toBeNull();
    expect(onlyOtherTypesNote([])).toBeNull();
  });
});
