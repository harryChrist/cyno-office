import type { ReportList, ReportListItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { REPORT_FRAME_SANDBOX, downloadName, emptyMessage, generatedText, itemLabel, itemSub, itemsOf, pickSelection, selectLabel, sandboxedHtml } from "./reportsView";

const item = (over: Partial<ReportListItem>): ReportListItem => ({ kind: "week", period: "2026-W46", from: "2026-11-09T03:00:00.000Z", to: "2026-11-16T03:00:00.000Z", generatedAt: "2026-11-16T11:30:00.000Z", final: true, deliveries: 12, hasAi: false, ...over });
const list = (items: ReportListItem[]): ReportList => ({ items, imageAvailable: true, settings: { dailyAt: "18:30", weekly: "seg 08:30" }, now: "2026-11-16T12:00:00.000Z" });

describe("aba Relatórios: a lista", () => {
  it("separa por tipo e põe o período mais novo primeiro", () => {
    const l = list([item({ period: "2026-W45" }), item({ period: "2026-W46" }), item({ kind: "day", period: "2026-11-15" }), item({ kind: "month", period: "2026-10" })]);
    expect(itemsOf(l, "week").map((entry) => entry.period)).toEqual(["2026-W46", "2026-W45"]);
    expect(itemsOf(l, "day")).toHaveLength(1);
    expect(itemsOf(null, "week")).toEqual([]);
  });

  it("os rótulos de gente: dia da semana e data, semana com os dias, mês por extenso (no fuso de São Paulo)", () => {
    expect(itemLabel(item({ kind: "day", period: "2026-11-13" }))).toBe("sex, 13/11");
    expect(itemLabel(item({}))).toBe("Semana 46 · 09/11 a 15/11");
    expect(itemLabel(item({ kind: "month", period: "2026-11" }))).toBe("novembro de 2026");
  });

  it("o texto da opção do seletor do celular é curto: o período, e só o parcial ganha etiqueta (revisão L9)", () => {
    expect(selectLabel(item({}))).toBe("Semana 46 · 09/11 a 15/11");
    expect(selectLabel(item({ final: false }))).toBe("Semana 46 · 09/11 a 15/11 · parcial");
    expect(selectLabel(item({ hasAi: true, deliveries: 38 }))).not.toMatch(/entregas|fechad|Maestro/);
  });

  it("a segunda linha diz quantas entregas e se está fechado ou parcial; o parágrafo do Maestro aparece quando existe", () => {
    expect(itemSub(item({ deliveries: 1 }))).toBe("1 entrega · fechado");
    expect(itemSub(item({ final: false, deliveries: 0 }))).toBe("0 entregas · parcial");
    expect(itemSub(item({ hasAi: true }))).toContain("com parágrafo do Maestro");
    expect(generatedText(item({}))).toContain("fechado e guardado");
    expect(generatedText(item({ final: false }))).toContain("será refeito quando o período fechar");
  });

  it("mantém o aberto enquanto ele existe; senão abre o mais novo; lista vazia não abre nada", () => {
    const items = [item({ period: "2026-W46" }), item({ period: "2026-W45" })];
    expect(pickSelection(items, "2026-W45")).toBe("2026-W45");
    expect(pickSelection(items, "2026-W10")).toBe("2026-W46");
    expect(pickSelection(items, null)).toBe("2026-W46");
    expect(pickSelection([], "2026-W46")).toBeNull();
  });
});

describe("aba Relatórios: o estado vazio diz o que falta", () => {
  it("a semana diz o dia e a hora configurados", () => {
    expect(emptyMessage("week", { dailyAt: "18:30", weekly: "seg 08:30" })).toBe("A primeira revisão sai na segunda, 08:30.");
    expect(emptyMessage("week", { dailyAt: null, weekly: "sex 17:00" })).toBe("A primeira revisão sai na sexta, 17:00.");
    expect(emptyMessage("week", undefined)).toBe("A primeira revisão sai na segunda, 08:30.");
  });
  it("o dia e o mês", () => {
    expect(emptyMessage("day", { dailyAt: "18:30", weekly: "seg 08:30" })).toContain("18:30");
    expect(emptyMessage("day", { dailyAt: null, weekly: "seg 08:30" })).toContain("desligado");
    expect(emptyMessage("month", undefined)).toContain("última semana do mês");
  });
});

describe("a página do relatório fica isolada", () => {
  it("o iframe não tem script nem formulário; o documento ganha uma política sem script", () => {
    expect(REPORT_FRAME_SANDBOX).not.toMatch(/allow-scripts|allow-forms|allow-top-navigation/);
    const html = sandboxedHtml("<!doctype html><html><head><title>x</title></head><body>oi</body></html>");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<title>"));
    expect(sandboxedHtml("<p>sem head</p>").startsWith("<meta")).toBe(true);
  });

  it("nome do arquivo baixado", () => {
    expect(downloadName("week", "2026-W46", "md")).toBe("relatorio-week-2026-W46.md");
  });
});
