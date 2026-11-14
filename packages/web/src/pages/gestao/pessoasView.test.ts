import { describe, expect, it } from "vitest";
import { DEFAULT_SORT, loadBars, nextSort, parallelText, peopleEmpty, personRows, refusalByType, sortPeople, type Person } from "./pessoasView";
import { group, makeReport, metric, rate } from "./metricsFixture";

const H = 3_600_000;
const PEOPLE: Person[] = [
  { id: "clara", name: "Clara", engine: "Claude · claude-sonnet-5-5" },
  { id: "eco", name: "Eco", engine: "Gemini · gemini-3.8-flash-medium" },
  { id: "beto", name: "Beto", engine: "Claude · claude-haiku-4-5" },
];
// Janela de 28 dias (o que a aba Pessoas pede): 28 entregas = 7 por semana, volume normal.
const WIDE = { from: "2026-10-16T03:00:00.000Z", to: "2026-11-13T03:00:00.000Z" };

function report(over: Parameters<typeof makeReport>[0] = {}) {
  const base = makeReport();
  return makeReport({
    windows: { rates: WIDE, medians: WIDE },
    throughput: { ...base.throughput, ...metric({ value: 28, n: 28 }), agentWeeks: [{ key: "clara", label: "Clara", counts: [0, 0, 0, 0, 1, 2, 3, 4] }, { key: "eco", label: "Eco", counts: [0, 0, 0, 0, 0, 1, 1, 3] }, { key: "beto", label: "Beto", counts: [0, 0, 0, 0, 0, 0, 0, 2] }] },
    cycleTime: { ...base.cycleTime, byAgent: [group("clara", "Clara", { value: 4 * H, n: 9, prev: 4 * H, prevN: 8, fewData: false }), group("eco", "Eco", { value: 7 * H, n: 6, fewData: false }), group("beto", "Beto", { value: H, n: 2 })] },
    rejectionRate: { ...base.rejectionRate, byAgent: [{ key: "clara", label: "Clara", ...rate(1, 10, 1, 10) }, { key: "eco", label: "Eco", ...rate(4, 12, 1, 12, "up") }, { key: "beto", label: "Beto", ...rate(0, 2) }], byType: [{ key: "comentario", label: "comentario", ...rate(4, 13) }, { key: "convite", label: "convite", ...rate(1, 12) }, { key: "post", label: "post", ...rate(1, 3) }] },
    rework: { ...base.rework, byAgent: [{ key: "clara", label: "Clara", ...rate(1, 12) }] },
    failureRate: { ...base.failureRate, byAgent: [{ key: "beto", label: "Beto", ...rate(1, 2) }] },
    editRate: { ...base.editRate, byAgent: [{ key: "clara", label: "Clara", ...rate(6, 10), intensity: 0.4 }] },
    costPerDelivery: { ...base.costPerDelivery, byAgent: [group("clara", "Clara", { value: 0.31, n: 12, fewData: false }), group("eco", "Eco", { value: 0.12, n: 5, fewData: false })] },
    load: { running: 2, maxRunning: 3, perAgentLimit: 1, queued: 4, agents: [{ id: "clara", name: "Clara", doing: 1, queued: 2, waiting: 0, workedMs7d: 0 }, { id: "eco", name: "Eco", doing: 1, queued: 0, waiting: 1, workedMs7d: 0 }, { id: "beto", name: "Beto", doing: 0, queued: 0, waiting: 0, workedMs7d: 0 }] },
    ...over,
  });
}

describe("linhas de Pessoas", () => {
  const rows = personRows(report(), PEOPLE);
  const by = (id: string) => rows.find((row) => row.id === id)!;

  it("uma linha por agente, com o agora em palavras e o motor", () => {
    expect(rows.map((row) => row.id)).toEqual(["clara", "eco", "beto"]);
    expect(by("clara").now).toMatchObject({ text: "fazendo 1 · fila 2", busy: true });
    expect(by("eco").now.text).toBe("fazendo 1 · esperando 1");
    expect(by("beto").now).toMatchObject({ text: "livre", busy: false });
    expect(by("clara").engine).toBe("Claude · claude-sonnet-5-5");
  });

  it("entregas: as últimas 4 semanas, com a soma e a barra mais alta", () => {
    expect(by("clara").deliveries).toEqual({ total: 10, weeks: [1, 2, 3, 4], max: 4 });
    expect(by("eco").deliveries.total).toBe(5);
    expect(by("beto").deliveries).toEqual({ total: 2, weeks: [0, 0, 0, 2], max: 2 });
  });

  it("n < 5: traço e quantos faltam (Beto: 2 amostras); n >= 5: o valor, com seta só se mudou mais de 10 pontos", () => {
    expect(by("beto").cycle).toMatchObject({ text: "—", note: "faltam 3 entregas para mostrar", known: false });
    expect(by("beto").rejected).toMatchObject({ text: "—", note: "faltam 3 decisões para mostrar" });
    expect(by("clara").cycle.text).toBe("4 h");
    expect(by("clara").rejected).toMatchObject({ text: "10%", arrow: null });
    expect(by("eco").rejected.text).toBe("33%");
    expect(by("eco").rejected.arrow?.glyph).toBe("▲");
    expect(by("eco").rejected.arrow?.text).toBe("era 8%, agora 33%");
  });

  it("sem registro do agente no período: 'sem ... no período', nunca em branco", () => {
    expect(by("eco").failed).toMatchObject({ text: "—", note: "sem tarefas no período", known: false });
    expect(by("eco").edited.note).toBe("sem textos aprovados no período");
  });

  it("você editou traz a intensidade; custo é por entrega e só com n >= 5", () => {
    expect(by("clara").edited).toMatchObject({ text: "60%", intensity: "trocando cerca de 40%" });
    expect(by("clara").cost.text).toBe("US$ 0,31");
    expect(by("eco").cost.text).toBe("US$ 0,12");
    expect(by("beto").cost).toMatchObject({ text: "—", note: "sem entregas no período" });
  });

  it("com menos de 3 entregas por semana as taxas viram contagens", () => {
    const low = personRows(report({ throughput: { ...report().throughput, ...metric({ value: 8, n: 8 }) } }), PEOPLE);
    expect(low.find((row) => row.id === "clara")!.rejected).toMatchObject({ text: "1 de 10", arrow: null });
    expect(low.find((row) => row.id === "beto")!.rejected.text).toBe("0 de 2");
    expect(low.find((row) => row.id === "clara")!.edited.intensity).toBeUndefined();
  });
});

describe("ordenação", () => {
  const rows = personRows(report(), PEOPLE);
  const ids = (list: ReturnType<typeof sortPeople>) => list.map((row) => row.id);

  it("padrão: quem mais entregou primeiro", () => {
    expect(ids(sortPeople(rows, DEFAULT_SORT.key, DEFAULT_SORT.dir))).toEqual(["clara", "eco", "beto"]);
  });

  it("quem não tem número vai para o fim, na subida e na descida", () => {
    expect(ids(sortPeople(rows, "rejected", "desc"))).toEqual(["eco", "clara", "beto"]);
    expect(ids(sortPeople(rows, "rejected", "asc"))).toEqual(["clara", "eco", "beto"]);
    expect(ids(sortPeople(rows, "cycle", "asc"))).toEqual(["clara", "eco", "beto"]);
    expect(ids(sortPeople(rows, "cost", "desc"))).toEqual(["clara", "eco", "beto"]);
  });

  it("por nome (pt-BR) e pelo que faz agora; empate pelo nome", () => {
    expect(ids(sortPeople(rows, "name", "asc"))).toEqual(["beto", "clara", "eco"]);
    expect(ids(sortPeople(rows, "name", "desc"))).toEqual(["eco", "clara", "beto"]);
    expect(ids(sortPeople(rows, "now", "desc"))).toEqual(["clara", "eco", "beto"]);
    expect(ids(sortPeople(rows, "failed", "desc"))).toEqual(["beto", "clara", "eco"]);
  });

  it("clicar na coluna: a mesma inverte, outra começa pela direção natural", () => {
    expect(nextSort({ key: "deliveries", dir: "desc" }, "deliveries")).toEqual({ key: "deliveries", dir: "asc" });
    expect(nextSort({ key: "deliveries", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "name", dir: "asc" }, "rejected")).toEqual({ key: "rejected", dir: "desc" });
  });
});

describe("carga agora", () => {
  it("barras empilhadas na escala da maior; a mais carregada primeiro", () => {
    const view = loadBars(report(), PEOPLE);
    expect(view.rows.map((row) => row.id)).toEqual(["clara", "eco", "beto"]);
    expect(view.max).toBe(3);
    expect(view.rows[0]).toMatchObject({ total: 3, text: "fazendo 1 · fila 2" });
    expect(view.rows[0]!.widths).toEqual({ doing: 1 / 3, queued: 2 / 3, waiting: 0 });
    expect(view.rows[2]).toMatchObject({ total: 0, text: "livre" });
    expect(view.anyLoad).toBe(true);
  });

  it("ninguém com trabalho: anyLoad falso para a tela dizer isso", () => {
    expect(loadBars(makeReport(), PEOPLE).anyLoad).toBe(false);
  });
});

describe("quem mais é recusado, por tipo", () => {
  it("do mais recusado ao menos; tipo com n < 5 fica com traço e no fim", () => {
    const rows = refusalByType(report(), (type) => type.toUpperCase());
    expect(rows.map((row) => [row.label, row.cell.text])).toEqual([["COMENTARIO", "31%"], ["CONVITE", "8%"], ["POST", "—"]]);
    expect(rows[2]!.cell.note).toBe("faltam 2 decisões para mostrar");
  });
});

describe("cabeçalho e estados vazios", () => {
  it("o texto do trabalho em paralelo", () => {
    expect(parallelText(report())).toBe("agora 2 de 3 rodando · por agente 1 · fila de 4");
    expect(parallelText(makeReport())).toBe("agora 0 de 3 rodando · por agente 1 · fila vazia");
  });

  it("diz o que falta: sem agentes, sem entregas; com dados, nada", () => {
    expect(peopleEmpty(report(), [])).toMatchObject({ title: "Nenhum agente neste workspace" });
    expect(peopleEmpty(makeReport(), PEOPLE)).toEqual({ title: "Sem entregas ainda", text: "Os números por agente aparecem depois das primeiras tarefas concluídas." });
    expect(peopleEmpty(report(), PEOPLE)).toBeNull();
  });

  it("nenhum texto usa jargão", () => {
    const texts = personRows(report(), PEOPLE).flatMap((row) => [row.now.text, row.cycle.text, row.cycle.note, row.rejected.note, row.cost.note]);
    expect(texts.join(" ")).not.toMatch(/p90|n=|throughput|lead time|SLA|retrabalho/i);
  });
});
