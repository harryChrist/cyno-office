import type { MetricsReport, ProjectForecast } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { blockedView, cycleLine, forecastBar, forecastView, goalFacts, kpiTiles, niceMax, painelView, pendingRows, quotaRows, ruleLine, weekFacts, weeklyBars } from "./painelView";
import { makeReport, metric, rate } from "./metricsFixture";

const H = 3_600_000;
// Quinta, 12/11/2026 12:00 em São Paulo; fixo, nada aqui lê o relógio nem o fuso da máquina.
const NOW = Date.parse("2026-11-12T15:00:00.000Z");

const withCounts = (counts: number[]) => {
  const base = makeReport();
  return makeReport({ throughput: { ...base.throughput, weeks: base.throughput.weeks.map((week, index) => ({ ...week, count: counts[index] ?? 0, avg4: 2 })) } });
};

describe("cartões do Painel (ordem e texto)", () => {
  it("vêm na ordem do plano e com os nomes sem jargão", () => {
    const tiles = kpiTiles(makeReport());
    expect(tiles.map((tile) => tile.label)).toEqual(["Esperando seu OK", "Entregas na semana", "Tempo até entregar", "Gasto da semana"]);
    expect(tiles.map((tile) => tile.id)).toEqual(["waiting", "throughput", "cycle", "spend"]);
  });

  it("Esperando seu OK: contagem, o mais velho e os que passaram de 1 dia; vazio diz 'Nada' e 'Tudo em dia'", () => {
    const empty = kpiTiles(makeReport())[0]!;
    expect(empty).toMatchObject({ value: "Nada", lines: ["Tudo em dia"], tone: "neutral" });
    const report = makeReport({ approvalWait: { ...makeReport().approvalWait, pending: { count: 5, over24h: 2, oldestMs: 9 * H, items: [] } } });
    expect(kpiTiles(report)[0]).toMatchObject({ value: "5", tone: "warn", lines: ["o mais velho há 9 h", "2 passaram de 1 dia"] });
    const one = makeReport({ approvalWait: { ...makeReport().approvalWait, pending: { count: 1, over24h: 1, oldestMs: 30 * H, items: [] } } });
    expect(kpiTiles(one)[0]!.lines).toEqual(["o mais velho há 1 d 6 h", "1 passou de 1 dia"]);
  });

  it("Entregas na semana: seta só com 5 ou mais nas duas semanas e com mudança acima de 10 pontos", () => {
    const big = makeReport({ throughput: { ...makeReport().throughput, ...metric({ value: 12, n: 12, prev: 9, prevN: 9, fewData: false, trend: "up" }) } });
    expect(kpiTiles(big)[1]).toMatchObject({ value: "12", delta: "+3 vs. passada" });
    expect(kpiTiles(big)[1]!.arrow?.glyph).toBe("▲");
    const small = makeReport({ throughput: { ...makeReport().throughput, ...metric({ value: 4, n: 4, prev: 9, prevN: 9, fewData: true, trend: "down" }) } });
    expect(kpiTiles(small)[1]!.arrow).toBeNull();
    expect(kpiTiles(small)[1]!.delta).toBeUndefined();
    const flat = makeReport({ throughput: { ...makeReport().throughput, ...metric({ value: 10, n: 10, prev: 10, prevN: 10, fewData: false, trend: "flat" }) } });
    expect(kpiTiles(flat)[1]!.arrow).toBeNull();
  });

  it("Tempo até entregar: com n < 5 mostra '—' e quantas entregas faltam; com n >= 5 a mediana, o p90 e o peso da espera", () => {
    const few = makeReport({ cycleTime: { ...makeReport().cycleTime, ...metric({ value: 5 * H, n: 3, fewData: true }), p90: 8 * H } });
    expect(kpiTiles(few)[2]).toMatchObject({ value: "—", lines: ["faltam 2 entregas para mostrar"] });
    const none = kpiTiles(makeReport())[2]!;
    expect(none.value).toBe("—");
    expect(none.lines[0]).toContain("sem entregas");
    const ok = makeReport({
      cycleTime: { ...makeReport().cycleTime, ...metric({ value: 5 * H + 20 * 60_000, n: 9, prev: 8 * H, prevN: 7, fewData: false, trend: "down" }), p90: 27 * H },
      approvalWait: { ...makeReport().approvalWait, weightInCycle: 0.32 },
    });
    const tile = kpiTiles(ok)[2]!;
    expect(tile.value).toBe("5 h 20 min");
    expect(tile.lines).toEqual(["mediana de 9 entregas · 90% até 1 d 3 h", "32% desse tempo foi espera por você"]);
    expect(tile.arrow?.glyph).toBe("▼");
  });

  it("Gasto da semana é sempre 'equivalente'", () => {
    const tile = kpiTiles(makeReport({ spend: { usd: 6.4, prevUsd: 5 } }))[3]!;
    expect(tile).toMatchObject({ value: "US$ 6,40", unit: "equivalente" });
    expect(tile.lines[0]).toContain("equivalente à API");
    expect(tile.lines[0]).toContain("US$ 5,00");
  });

  it("nenhum texto usa jargão (p90, n=, throughput, lead time, SLA)", () => {
    const report = makeReport({ cycleTime: { ...makeReport().cycleTime, ...metric({ value: H, n: 9, fewData: false }), p90: 2 * H } });
    const text = JSON.stringify([kpiTiles(report).map(({ label, value, unit, lines }) => [label, value, unit, lines]), weekFacts(report).map((fact) => fact.text), painelView(report).empty, forecastView(makeReport(), NOW)]);
    expect(text).not.toMatch(/p90|n=|throughput|lead time|SLA|percentil/i);
  });
});

describe("barras por semana", () => {
  it("8 barras, a atual marcada, a altura pelo teto redondo e a média de 4 semanas", () => {
    const view = weeklyBars(withCounts([2, 3, 4, 5, 6, 7, 8, 11]).throughput.weeks);
    expect(view.bars).toHaveLength(8);
    expect(view.max).toBe(12);
    expect(view.bars.at(-1)).toMatchObject({ label: "09/11", count: 11, current: true });
    expect(view.bars.filter((bar) => bar.current)).toHaveLength(1);
    expect(view.bars.at(-1)!.height).toBeCloseTo(11 / 12, 10);
    expect(view.bars[0]!.avg).toBeCloseTo(2 / 12, 10);
    expect(view.empty).toBe(false);
    expect(view.ariaLabel).toContain("09/11, 11 (semana em andamento)");
  });

  it("sem nenhuma entrega: vazio (a tela diz o que falta) e teto mínimo de 4", () => {
    const view = weeklyBars(makeReport().throughput.weeks);
    expect(view.empty).toBe(true);
    expect(view.max).toBe(4);
    expect(painelView(makeReport()).empty).toEqual({ title: "Sem entregas ainda", text: "Os números aparecem depois da primeira tarefa concluída." });
    expect(painelView(withCounts([0, 0, 0, 0, 0, 0, 0, 1])).empty).toBeNull();
  });

  it("teto redondo", () => {
    expect([1, 4, 5, 9, 13, 26, 101].map(niceMax)).toEqual([4, 4, 5, 10, 15, 30, 200]);
  });
});

describe("mini-linha do tempo até entregar", () => {
  it("só as semanas com entrega; ponto cheio com n >= 5; y e faixa sobre o maior p90", () => {
    const base = makeReport();
    const weeks = base.cycleTime.weeks.map((week, index) => (index === 5 ? { ...week, n: 6, median: 4 * H, p90: 8 * H } : index === 7 ? { ...week, n: 2, median: 6 * H, p90: 10 * H } : week));
    const line = cycleLine(weeks);
    expect(line.points.map((point) => [point.label, point.solid])).toEqual([["W44", true], ["W46", false]]);
    expect(line.max).toBe(10 * H);
    expect(line.points[0]).toMatchObject({ y: 0.4, y90: 0.8 });
    expect(line.points[1]!.x).toBe(1);
    expect(line.ariaLabel).toContain("W44, 4 h (até 8 h)");
  });

  it("sem entrega, sem pontos e com texto de apoio", () => {
    const line = cycleLine(makeReport().cycleTime.weeks);
    expect(line.points).toEqual([]);
    expect(line.ariaLabel).toContain("Sem entregas");
  });
});

describe("Travado", () => {
  const item = (over: Partial<ReturnType<typeof makeReport>["blockedNow"]["items"][number]>) => ({ projectId: "p1", projectTitle: "Site novo", ref: "T1", title: "Post da semana", type: "cota" as const, since: "2026-11-12T13:00:00.000Z", ageMs: 2 * H, agentId: "eco", ...over });

  it("lista do mais velho, com a razão em palavras, o agente e a idade; o resto vira 'e mais N'", () => {
    const items = [item({}), item({ ref: "T2", type: "voce", ageMs: 9 * H, agentId: "clara" }), item({ ref: "T3", type: "falha", ageMs: H })];
    const report = makeReport({ blockedNow: { count: 3, byType: { cota: 1, voce: 1, falha: 1 }, items } });
    const view = blockedView(report, (id) => (id === "eco" ? "Eco" : undefined), 2);
    expect(view.rows).toHaveLength(2);
    expect(view.rows[0]).toMatchObject({ typeLabel: "sem cota", tone: "warn", agentName: "Eco", age: "2 h", projectId: "p1", title: "Post da semana" });
    expect(view.rows[1]).toMatchObject({ typeLabel: "esperando você", agentName: "clara" });
    expect(view.more).toBe(1);
    expect(view.summary).toBe("1 sem cota · 1 esperando você · 1 falhou");
  });

  it("vazio: contagem zero (a tela diz 'Nada travado')", () => {
    expect(blockedView(makeReport(), () => undefined)).toMatchObject({ count: 0, rows: [], more: 0, summary: "" });
  });
});

const forecastOf = (over: Partial<ProjectForecast> & Pick<ProjectForecast, "projectId" | "title">): ProjectForecast => ({ state: "previsto", remaining: 3, text: "No ritmo atual termina na quinta, 12 (entre quarta e sábado). Prazo: sexta, 13.", ...over });

describe("prazos e previsão", () => {
  const late = forecastOf({ projectId: "a", title: "Site novo", at: "2026-11-12T20:00:00.000Z", low: "2026-11-12T17:00:00.000Z", high: "2026-11-13T12:00:00.000Z", dueAt: "2026-11-11T15:00:00.000Z", verdict: "atrasa", lateByMs: 29 * H, confidence: "media", basis: "11 tarefas", n: 11 });
  const tight = forecastOf({ projectId: "b", title: "Webinar", remaining: 1, at: "2026-11-12T19:00:00.000Z", low: "2026-11-12T17:00:00.000Z", high: "2026-11-13T08:00:00.000Z", dueAt: "2026-11-13T01:00:00.000Z", verdict: "apertado", confidence: "baixa", basis: "4 tarefas", n: 4 });
  const fine = forecastOf({ projectId: "c", title: "Relatório do mês", at: "2026-11-12T22:00:00.000Z", low: "2026-11-12T18:00:00.000Z", high: "2026-11-13T03:00:00.000Z", dueAt: "2026-11-18T15:00:00.000Z", verdict: "no_prazo", confidence: "alta", basis: "20 tarefas", n: 20 });
  const noDue = forecastOf({ projectId: "d", title: "Sem prazo", at: "2026-11-12T22:00:00.000Z", low: "2026-11-12T18:00:00.000Z", high: "2026-11-13T03:00:00.000Z", confidence: "media", basis: "9 tarefas", n: 9 });
  const unknown = forecastOf({ projectId: "e", title: "Novo agente", state: "sem_previsao", reason: "Faltam tarefas concluídas deste agente para estimar", text: "Sem previsão ainda.", remaining: 2 });
  const withForecast = (projects: ProjectForecast[]) => makeReport({ forecast: { projects, text: "" } });

  it("sem projeto aberto, diz o que falta", () => {
    expect(forecastView(makeReport(), NOW)).toEqual({ rows: [], more: 0, empty: "Nenhum projeto aberto com tarefas a fazer.", summary: "" });
  });

  it("uma linha por projeto na ordem que o servidor mandou, com veredito, frase e quanto falta", () => {
    const view = forecastView(withForecast([late, tight, fine, noDue, unknown]), NOW);
    expect(view.rows.map((row) => [row.title, row.verdict?.label ?? null, row.verdict?.tone ?? null])).toEqual([
      ["Site novo", "Atrasa", "danger"],
      ["Webinar", "Apertado", "warn"],
      ["Relatório do mês", "No prazo", "ok"],
      ["Sem prazo", null, null],
      ["Novo agente", null, null],
    ]);
    expect(view.rows[0]).toMatchObject({ remaining: "3 tarefas a fazer", sentence: late.text, dueNote: "passa do prazo em 1 d 5 h" });
    expect(view.rows[1]!.remaining).toBe("1 tarefa a fazer");
    expect(view.summary).toBe("1 atrasa · 1 apertado · 1 no prazo");
  });

  it("projeto sem prazo diz 'Sem prazo: só a previsão'; sem amostras, o que falta; no prazo e apertado não têm nota de atraso", () => {
    const view = forecastView(withForecast([tight, fine, noDue, unknown]), NOW);
    expect(view.rows[2]!.dueNote).toBe("Sem prazo: só a previsão");
    expect(view.rows[0]!.dueNote).toBeNull();
    expect(view.rows[1]!.dueNote).toBeNull();
    expect(view.rows[3]).toMatchObject({ sentence: "Faltam tarefas concluídas deste agente para estimar", bar: null, verdict: null, confidence: null });
  });

  it("a confiança fala em palavras e diz 'poucos dados' quando é baixa; nada de jargão", () => {
    const view = forecastView(withForecast([late, tight, fine]), NOW);
    expect(view.rows.map((row) => row.confidence)).toEqual(["confiança média · baseada em 11 tarefas", "confiança baixa · baseada em 4 tarefas, poucos dados", "confiança alta · baseada em 20 tarefas"]);
    expect(JSON.stringify(view)).not.toMatch(/p25|p75|p90|n=|throughput|lead time|percentil/i);
  });

  it("mostra no máximo `limit` linhas e conta o resto", () => {
    const view = forecastView(withForecast([late, tight, fine, noDue]), NOW, 2);
    expect(view.rows).toHaveLength(2);
    expect(view.more).toBe(2);
  });

  it("a régua: hoje, a faixa, o fim provável e o prazo em posições de 0 a 1, com a faixa antes do fim e dentro da régua", () => {
    const bar = forecastBar(tight, NOW)!;
    expect(bar.now).toBeLessThan(bar.low);
    expect(bar.low).toBeLessThan(bar.at);
    expect(bar.at).toBeLessThan(bar.high);
    expect(bar.due).not.toBeNull();
    expect(bar.due!).toBeGreaterThan(bar.at);
    expect(bar.due!).toBeLessThan(bar.high);
    expect([bar.now, bar.low, bar.at, bar.high, bar.due!].every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(bar).toMatchObject({ startLabel: "hoje", endLabel: "sex, 13/11" });
    expect(bar.ariaLabel).toBe("Webinar: termina por volta de qui, 12/11, entre qui, 12/11 e sex, 13/11, prazo qui, 12/11.");
  });

  it("prazo no passado fica antes de hoje na régua; sem prazo não há marcador; sem datas não há régua", () => {
    const bar = forecastBar(late, NOW)!;
    expect(bar.due).not.toBeNull();
    expect(bar.due!).toBeLessThan(bar.now);
    expect(forecastBar(noDue, NOW)!.due).toBeNull();
    expect(forecastBar(unknown, NOW)).toBeNull();
  });
});

describe("Metas da semana", () => {
  const goal = (over: Partial<MetricsReport["goals"]["items"][number]> & Pick<MetricsReport["goals"]["items"][number], "routineId" | "title">): MetricsReport["goals"]["items"][number] => ({
    period: "week",
    periodKey: "2026-W46",
    target: 2,
    delivered: 1,
    expected: 1,
    pace: "no_ritmo",
    n: 4,
    ratePerDay: 0.5,
    daysLeft: 2,
    projected: 2,
    closes: true,
    confidence: "baixa",
    text: "no ritmo atual bate a meta (poucos dados)",
    ...over,
  });
  const report = (items: MetricsReport["goals"]["items"]) => makeReport({ goals: { items, text: "" } });

  it("'Posts 1/2 no ritmo' e 'Conexões 3/10 ▼ fecha em 6 de 10', com a projeção explicada no title", () => {
    const facts = goalFacts(report([goal({ routineId: "R1", title: "Posts" }), goal({ routineId: "R2", title: "Conexões", target: 10, delivered: 3, pace: "atrasada", closes: false, projected: 6, n: 3, text: "no ritmo atual fecha em 6 de 10 (poucos dados)" })]));
    expect(facts.map((fact) => fact.text)).toEqual(["Posts 1/2 no ritmo", "Conexões 3/10 ▼ fecha em 6 de 10"]);
    expect(facts.map((fact) => fact.tone)).toEqual(["ok", "danger"]);
    expect(facts[1]!.detail).toBe("no ritmo atual fecha em 6 de 10 (poucos dados) · confiança baixa");
  });

  it("batida, pausada, adiantada, sem ritmo medido e as do mês", () => {
    const facts = goalFacts(report([goal({ routineId: "a", title: "A", delivered: 2 }), goal({ routineId: "b", title: "B", pace: "pausada", closes: false, projected: 1 }), goal({ routineId: "c", title: "C", pace: "adiantada" }), goal({ routineId: "d", title: "D", projected: null, closes: false }), goal({ routineId: "e", title: "E", period: "month", target: 8 })]));
    expect(facts.map((fact) => fact.text)).toEqual(["A 2/2 batida", "B 1/2 pausada", "C 1/2 adiantada", "D 1/2 sem ritmo ainda", "E 1/8 no mês no ritmo"]);
  });

  it("sem metas, a lista é vazia (a tela esconde a linha)", () => {
    expect(goalFacts(makeReport())).toEqual([]);
  });
});

describe("linha da semana", () => {
  const base = makeReport();
  it("com 3 ou mais entregas e n >= 5, traz a porcentagem junto da contagem", () => {
    const report = makeReport({
      throughput: { ...base.throughput, value: 12 },
      rework: { ...base.rework, ...rate(2, 12) },
      failureRate: { ...base.failureRate, ...rate(1, 20) },
      rejectionRate: { ...base.rejectionRate, ...rate(3, 10) },
      editRate: { ...base.editRate, ...rate(4, 10) },
    });
    expect(weekFacts(report).map((fact) => fact.text)).toEqual(["2 refeitos (17%)", "1 falha (5%)", "3 recusas (30%)", "você editou 40% dos textos"]);
  });

  it("com menos de 3 entregas na semana mostra contagens, nunca taxas", () => {
    const report = makeReport({
      throughput: { ...base.throughput, value: 2 },
      rework: { ...base.rework, ...rate(1, 2) },
      failureRate: { ...base.failureRate, ...rate(0, 2) },
      rejectionRate: { ...base.rejectionRate, ...rate(1, 6) },
      editRate: { ...base.editRate, ...rate(1, 6) },
    });
    const texts = weekFacts(report).map((fact) => fact.text);
    expect(texts).toEqual(["1 refeito", "0 falhas", "1 recusa", "você editou 1 de 6 textos"]);
    expect(texts.join(" ")).not.toContain("%");
  });

  it("com n < 5 (mesmo com entregas) a porcentagem não aparece", () => {
    const report = makeReport({ throughput: { ...base.throughput, value: 10 }, rejectionRate: { ...base.rejectionRate, ...rate(1, 3) }, editRate: { ...base.editRate, ...rate(0, 0) } });
    const texts = weekFacts(report).map((fact) => fact.text);
    expect(texts[2]).toBe("1 recusa");
    expect(texts[3]).toBe("você ainda não aprovou textos nesta semana");
  });
});

describe("itens esperando e cota", () => {
  it("o título de reserva vem do tipo e a idade em palavras", () => {
    const report = makeReport({ approvalWait: { ...makeReport().approvalWait, pending: { count: 1, over24h: 0, oldestMs: 3 * H, items: [{ id: "A-1", type: "comentario", agentId: "clara", ageMs: 3 * H }] } } });
    expect(pendingRows(report, (type) => `Tipo ${type}`)).toEqual([{ id: "A-1", title: "Tipo comentario", agentId: "clara", age: "há 3 h" }]);
  });

  it("cota: só janelas com leitura, mais os agentes sem motor", () => {
    const report = makeReport({
      quota: {
        windows: [
          { provider: "claude", id: "5h", label: "5 h", state: "value", percent: 86, text: "Claude: 5 h em 86%, volta às 15h", pace: 1.4, warn: true },
          { provider: "gemini", id: "d", label: "dia", state: "none", percent: null, text: "sem leitura", pace: null, warn: false },
        ],
        blocked: [{ agentId: "eco", name: "Eco", label: "Claude sem cota, volta às 15h" }],
      },
    });
    expect(quotaRows(report)).toEqual([
      { id: "claude:5h", text: "Claude: 5 h em 86%, volta às 15h", percent: 86, warn: true },
      { id: "block:eco", text: "Eco: Claude sem cota, volta às 15h", percent: null, warn: true },
    ]);
  });
});

describe("regras para decidir (revisão L4)", () => {
  it("a linha do cartão Esperando seu OK explica o 3 do menu contra o 2 do cartão", () => {
    expect(ruleLine(1)).toBe("+1 regra para decidir em “O que aprendemos”");
    expect(ruleLine(3)).toBe("+3 regras para decidir em “O que aprendemos”");
  });
});
