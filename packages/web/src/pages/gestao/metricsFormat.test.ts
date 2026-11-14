import { describe, expect, it } from "vitest";
import { arrowOf, formatRate, formatSpan, formatUsd, isLowThroughput, missingText, rateCell, weeklyThroughput } from "./metricsFormat";

const H = 3_600_000;
const metric = (over: Partial<Parameters<typeof arrowOf>[0]> = {}): Parameters<typeof arrowOf>[0] => ({ value: 0.3, prev: 0.1, n: 10, prevN: 10, trend: "up", ...over });

describe("formatSpan", () => {
  it("escreve durações em palavras curtas", () => {
    expect(formatSpan(20_000)).toBe("menos de 1 min");
    expect(formatSpan(12 * 60_000)).toBe("12 min");
    expect(formatSpan(5 * H + 20 * 60_000)).toBe("5 h 20 min");
    expect(formatSpan(3 * H)).toBe("3 h");
    expect(formatSpan(27 * H)).toBe("1 d 3 h");
    expect(formatSpan(48 * H)).toBe("2 d");
    expect(formatSpan(null)).toBe("—");
  });
});

describe("dinheiro e taxa", () => {
  it("dólar com vírgula e o 'menos de um centavo'", () => {
    expect(formatUsd(6.4)).toBe("US$ 6,40");
    expect(formatUsd(0.001)).toBe("< US$ 0,01");
    expect(formatUsd(0)).toBe("US$ 0,00");
    expect(formatUsd(null)).toBe("—");
  });
  it("taxa em porcentagem inteira", () => {
    expect(formatRate(0.125)).toBe("13%");
    expect(formatRate(null)).toBe("—");
  });
});

describe("seta: só com n >= 5 nos dois lados e mudança que passou de 10 pontos", () => {
  it("mostra quando o servidor diz up ou down com amostras suficientes", () => {
    expect(arrowOf(metric(), () => "x")).toEqual({ dir: "up", glyph: "▲", text: "x" });
    expect(arrowOf(metric({ trend: "down" }), () => "y")?.glyph).toBe("▼");
  });
  it("some com n < 5, com período anterior curto, com 'igual' e sem tendência", () => {
    expect(arrowOf(metric({ n: 4 }), () => "")).toBeNull();
    expect(arrowOf(metric({ prevN: 3 }), () => "")).toBeNull();
    expect(arrowOf(metric({ trend: "flat" }), () => "")).toBeNull();
    expect(arrowOf(metric({ trend: undefined }), () => "")).toBeNull();
    expect(arrowOf(metric({ prev: null }), () => "")).toBeNull();
  });
});

describe("missingText", () => {
  it("diz quantos faltam, no singular e no plural", () => {
    expect(missingText(2, { one: "entrega", many: "entregas" })).toBe("faltam 3 entregas para mostrar");
    expect(missingText(4, { one: "entrega", many: "entregas" })).toBe("falta 1 entrega para mostrar");
  });
});

describe("taxa por semana e contagem no lugar da taxa", () => {
  const window28 = { from: "2026-10-16T00:00:00.000Z", to: "2026-11-13T00:00:00.000Z" };
  it("entregas por semana pela janela de 7 ou 28 dias", () => {
    expect(weeklyThroughput(8, window28)).toBe(2);
    expect(weeklyThroughput(8, { from: "2026-11-06T00:00:00.000Z", to: "2026-11-13T00:00:00.000Z" })).toBe(8);
    expect(isLowThroughput(2.9)).toBe(true);
    expect(isLowThroughput(3)).toBe(false);
  });

  const unit = { one: "decisão", many: "decisões" };
  const base = { value: 0.5, prev: 0.2, prevN: 9, trend: "up" as const };
  it("com pouca entrega mostra 'hits de n', mesmo com n pequeno", () => {
    expect(rateCell({ ...base, n: 2, hits: 1 }, { lowVolume: true, unit })).toMatchObject({ text: "1 de 2", arrow: null, known: true });
  });
  it("n < 5 sem pouca entrega: traço e quantos faltam", () => {
    expect(rateCell({ ...base, n: 3, hits: 1 }, { lowVolume: false, unit })).toMatchObject({ text: "—", note: "faltam 2 decisões para mostrar", known: false, sort: null });
  });
  it("n >= 5: porcentagem e seta", () => {
    const cell = rateCell({ ...base, n: 8, hits: 4 }, { lowVolume: false, unit });
    expect(cell.text).toBe("50%");
    expect(cell.arrow?.glyph).toBe("▲");
    expect(cell.arrow?.text).toBe("era 20%, agora 50%");
  });
  it("n = 0: sem dados no período", () => {
    expect(rateCell({ ...base, n: 0, value: null }, { lowVolume: false, unit })).toMatchObject({ text: "—", note: "sem decisões no período" });
  });
});
