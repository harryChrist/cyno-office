import { describe, expect, it } from "vitest";
import { GESTAO_TABS, gestaoTabEnabled, gestaoTabFromSub } from "./gestaoTabs";

describe("abas da Gestão", () => {
  it("lê a aba do endereço; sem final ou desconhecido abre o Painel", () => {
    expect(gestaoTabFromSub("")).toBe("painel");
    expect(gestaoTabFromSub("rotinas")).toBe("visao-geral");
    expect(gestaoTabFromSub("visao-geral")).toBe("visao-geral");
    expect(gestaoTabFromSub("pessoas")).toBe("pessoas");
    expect(gestaoTabFromSub("pessoas/clara")).toBe("pessoas");
    expect(gestaoTabFromSub("gastos")).toBe("gastos");
    expect(gestaoTabFromSub("atividade")).toBe("atividade");
    expect(gestaoTabFromSub("relatorios")).toBe("relatorios");
    expect(gestaoTabFromSub("relatorios/semana")).toBe("relatorios");
    expect(gestaoTabFromSub("nada")).toBe("painel");
  });

  it("as abas, na ordem do plano, cada uma com o seu endereço", () => {
    expect(GESTAO_TABS.map((tab) => tab.label)).toEqual(["Painel", "Rotinas e metas", "Pessoas", "Gastos", "Atividade", "Relatórios"]);
    expect(GESTAO_TABS.map((tab) => tab.sub)).toEqual(["", "rotinas", "pessoas", "gastos", "atividade", "relatorios"]);
    for (const tab of GESTAO_TABS) expect(gestaoTabFromSub(tab.sub)).toBe(tab.sub === "" ? "painel" : tab.id);
  });

  it("sem workspace só a Atividade (Sistema) abre", () => {
    expect(gestaoTabEnabled("atividade", false)).toBe(true);
    expect(gestaoTabEnabled("gastos", false)).toBe(false);
    expect(gestaoTabEnabled("visao-geral", true)).toBe(true);
    expect(gestaoTabEnabled("painel", false)).toBe(false);
    expect(gestaoTabEnabled("pessoas", false)).toBe(false);
    expect(gestaoTabEnabled("pessoas", true)).toBe(true);
    expect(gestaoTabEnabled("relatorios", false)).toBe(false);
    expect(gestaoTabEnabled("relatorios", true)).toBe(true);
  });
});
