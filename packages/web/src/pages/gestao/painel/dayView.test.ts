import { dayRange, HOUR_MS, zeroStateMs, type DayCompare, type DayHour, type DayStats, type ForYouItem, type MetricDelta, type StateMs, type WaitView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  agentRows,
  clampDay,
  compareChips,
  coverageNote,
  dayLabel,
  dayNav,
  dayOptions,
  doneByAgent,
  emptyView,
  heroView,
  hourChart,
  hourTable,
  legendStates,
  niceAxisMs,
  openWaitsNow,
  projectRows,
  toggleState,
  usageView,
  waitedLine,
  waitRows,
} from "./dayView";

const MIN = 60_000;
const TODAY = "2026-11-12";

const ms = (partial: Partial<StateMs> = {}): StateMs => ({ ...zeroStateMs(), ...partial });

function delta(value: number, base: number, pct?: number): MetricDelta {
  const change = value - base;
  return { current: value, base, delta: change, ...(pct !== undefined ? { pct } : {}), sense: change === 0 ? "same" : change < 0 ? "better" : "worse" };
}

function compareWith(yesterday?: MetricDelta, sameWeekday?: MetricDelta): DayCompare {
  const wrap = (metric: MetricDelta, day: string) => ({ day, metrics: { waitingOwnerMs: metric } as never });
  return { ...(yesterday ? { yesterday: wrap(yesterday, "2026-11-11") } : {}), ...(sameWeekday ? { sameWeekday: wrap(sameWeekday, "2026-11-05") } : {}) };
}

function hoursOf(day: string, values: Array<Partial<StateMs>> = []): DayHour[] {
  const { start, end } = dayRange(day);
  const out: DayHour[] = [];
  for (let t = start, i = 0; t < end; t += HOUR_MS, i += 1) out.push({ t, hour: Math.floor(((t - start) / HOUR_MS) % 24), ms: ms(values[i]) });
  return out;
}

function stats(overrides: Partial<DayStats> = {}, totals: Partial<DayStats["totals"]> = {}): DayStats {
  const { start, end } = dayRange(TODAY);
  return {
    day: TODAY,
    start,
    end,
    totals: { ms: ms({ waiting_owner: 70 * MIN }), waitWallMs: 70 * MIN, waits: 3, longestWaitMs: 48 * MIN, tasksDone: 2, deliveries: 0, tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }, costUsd: 1.5, costBrl: 8.25, turns: 4, unmeasuredTurns: 0, ...totals },
    hours: hoursOf(TODAY),
    projects: [],
    agents: [],
    providers: [],
    waits: [],
    waitWall: [],
    coverage: { states: "full" },
    ...overrides,
  };
}

function wait(partial: Partial<WaitView> = {}): WaitView {
  return { forYouIds: ["A-0001"], agentId: "eco", type: "outro", kind: "aprovacao", start: Date.UTC(2026, 10, 12, 17, 2), end: Date.UTC(2026, 10, 12, 17, 50), open: false, agentName: "Eco", ms: 48 * MIN, msInDay: 48 * MIN, ...partial };
}

describe("o herói", () => {
  it("mostra o tempo, a frase pronta e as comparações com ontem e a semana passada", () => {
    const view = heroView(stats({ compare: compareWith(delta(70 * MIN, 82 * MIN, -15), delta(70 * MIN, 60 * MIN, 17)), waits: [wait({ projectName: "Site novo" })] }), TODAY);
    expect(view.none).toBe(false);
    expect(view.value).toBe("1 h 10 min");
    expect(view.sentence).toContain("Hoje você fez os agentes esperarem 1 h 10 min");
    expect(view.sentence).toContain("12 min a menos que ontem");
    expect(view.chips).toEqual([
      { id: "yesterday", text: "12 min a menos que ontem (▼ 15%)", tone: "better" },
      { id: "sameWeekday", text: "10 min a mais que a semana passada (▲ 17%)", tone: "worse" },
    ]);
    expect(view.details).toBe("3 esperas · a maior 48 min");
  });

  it("sem comparação não há chip; com base pequena, o texto não leva percentual", () => {
    expect(heroView(stats(), TODAY).chips).toEqual([]);
    expect(compareChips(compareWith(delta(70 * MIN, 2 * MIN)), true)[0]).toEqual({ id: "yesterday", text: "1 h 08 min a mais que ontem", tone: "worse" });
  });

  it("igual ao dia anterior não finge variação", () => {
    expect(compareChips(compareWith(delta(5 * MIN, 5 * MIN, 0)), true)[0]).toEqual({ id: "yesterday", text: "Igual a ontem", tone: "same" });
  });

  it("fora de hoje o dia anterior não se chama 'ontem'", () => {
    const past = stats({ day: "2026-11-10", compare: compareWith(delta(70 * MIN, 82 * MIN, -15)) });
    const view = heroView(past, TODAY);
    expect(view.chips[0]?.text).toBe("12 min a menos que o dia anterior (▼ 15%)");
    expect(view.sentence).not.toContain("ontem");
  });

  it("ninguém esperou: 'Nada' e a frase de dia calmo", () => {
    const view = heroView(stats({}, { ms: ms(), waits: 0, longestWaitMs: 0, waitWallMs: 0 }), TODAY);
    expect(view.none).toBe(true);
    expect(view.value).toBe("Nada");
    expect(view.sentence).toBe("Hoje nenhum agente esperou por você.");
    expect(view.details).toBe("");
  });

  it("uma espera só fala no singular e o relógio só aparece quando difere", () => {
    const view = heroView(stats({}, { waits: 1, waitWallMs: 40 * MIN, ms: ms({ waiting_owner: 70 * MIN }) }), TODAY);
    expect(view.details).toBe("1 espera · a maior 48 min · com alguém esperando 40 min");
  });
});

describe("esperas abertas agora", () => {
  const item = (id: string, createdAt: string, extra: Partial<ForYouItem> = {}) => ({ id, agentId: "eco", createdAt, status: "pendente", ...extra }) as ForYouItem;
  it("só as pendentes, da mais antiga, sem as que o Modo Automático decidiu", () => {
    const now = Date.parse("2026-11-12T15:00:00Z");
    const waits = openWaitsNow(
      [item("A-2", "2026-11-12T14:30:00Z"), item("A-1", "2026-11-12T13:00:00Z"), item("A-3", "2026-11-12T14:00:00Z", { status: "aprovado" }), item("A-4", "2026-11-12T14:00:00Z", { decidedBy: "automatico" })],
      now,
      (entry) => `Item ${entry.id}`,
    );
    expect(waits.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
    expect(waits[0]).toMatchObject({ title: "Item A-1", ageMs: 2 * HOUR_MS });
    expect(openWaitsNow(null, now, () => "")).toEqual([]);
  });
});

describe("as maiores esperas", () => {
  const title = (id: string | undefined, type: string) => `${type}:${id}`;
  it("até dez, com o rótulo, o intervalo e a barra proporcional", () => {
    const many = Array.from({ length: 12 }, (_, index) => wait({ forYouIds: [`A-${index}`], ms: (60 - index) * MIN }));
    const rows = waitRows({ day: TODAY, waits: many }, title);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ forYouId: "A-0", title: "outro:A-0", duration: "1 h", ratio: 1 });
    expect(rows[9]!.ratio).toBeCloseTo(51 / 60);
  });

  it("espera aberta diz 'desde' e leva o projeto e a sprint", () => {
    const [row] = waitRows({ day: TODAY, waits: [wait({ open: true, ms: 5 * MIN, projectName: "Site novo", sprintName: "Sprint 1" })] }, title);
    expect(row!.open).toBe(true);
    expect(row!.span).toMatch(/^desde \d{2}:\d{2}$/);
    expect(row!.where).toBe("Site novo · Sprint 1");
    expect(waitRows({ day: TODAY, waits: [] }, title)).toEqual([]);
  });

  it("fechada mostra das tantas às tantas (hora de São Paulo)", () => {
    const [row] = waitRows({ day: TODAY, waits: [wait()] }, title);
    expect(row!.span).toBe("das 14:02 às 14:50");
  });

  it("espera que veio de outro dia traz a data junto da hora", () => {
    const [row] = waitRows({ day: TODAY, waits: [wait({ open: true, start: Date.UTC(2026, 10, 11, 14, 20) })] }, title);
    expect(row!.span).toBe("desde 11/11 11:20");
  });
});

describe("o dia por hora", () => {
  it("um dia de 24 horas tem 24 barras, empilhadas na ordem dos estados e na mesma escala", () => {
    const hours = hoursOf(TODAY, [{}, {}, {}, {}, {}, {}, {}, {}, { working: 30 * MIN, queued: 10 * MIN, waiting_owner: 5 * MIN }]);
    const chart = hourChart(hours, 0);
    expect(chart.bars).toHaveLength(24);
    expect(chart.axisMs).toBe(60 * MIN);
    const bar = chart.bars[8]!;
    expect(bar.segments.map((segment) => segment.state)).toEqual(["working", "queued", "waiting_owner"]);
    expect(bar.segments[0]!.pct).toBeCloseTo(50);
    expect(bar.totalMs).toBe(45 * MIN);
    expect(chart.hasData).toBe(true);
  });

  it("o eixo cresce com vários agentes na mesma hora", () => {
    const chart = hourChart(hoursOf(TODAY, [{ working: 100 * MIN }]), 0);
    expect(chart.axisMs).toBe(120 * MIN);
    expect(chart.ticks.map((tick) => tick.label)).toEqual(["0", "1 h", "2 h"]);
    expect(niceAxisMs(1)).toBe(5 * MIN);
    expect(niceAxisMs(61 * MIN)).toBe(120 * MIN);
    expect(niceAxisMs(2000 * MIN)).toBe(2880 * MIN);
  });

  it("dias de 23 e de 25 horas têm 23 e 25 barras", () => {
    // 2018-11-04: o último domingo antes do fim do horário de verão no Brasil (25 h); 2018-11-04 começa à 0h com DST.
    const long = hoursOf("2019-02-16");
    const short = hoursOf("2018-11-04");
    expect(hourChart(long, 0).bars.length).toBe(long.length);
    expect(hourChart(short, 0).bars.length).toBe(short.length);
    expect([23, 24, 25]).toContain(short.length);
    expect([23, 24, 25]).toContain(long.length);
    // Um dia com uma hora a menos (ou a mais) tem uma barra por hora, e nenhuma se repete.
    const synthetic: DayHour[] = Array.from({ length: 25 }, (_, index) => ({ t: index * HOUR_MS, hour: index === 24 ? 1 : Math.min(index, 23), ms: ms() }));
    const chart = hourChart(synthetic, 0);
    expect(chart.bars).toHaveLength(25);
    expect(new Set(chart.bars.map((bar) => bar.t)).size).toBe(25);
    expect(hourChart(synthetic.slice(0, 23), 0).bars).toHaveLength(23);
  });

  it("marca a hora atual e o que ainda não chegou", () => {
    const hours = hoursOf(TODAY);
    const now = hours[14]!.t + 20 * MIN;
    const chart = hourChart(hours, now);
    expect(chart.bars.filter((bar) => bar.current).map((bar) => bar.label)).toEqual(["14"]);
    expect(chart.bars[15]!.future).toBe(true);
    expect(chart.bars[13]!.future).toBe(false);
    expect(hourChart(hours, hours[0]!.t - HOUR_MS).bars.some((bar) => bar.current)).toBe(false);
  });

  it("a legenda liga e desliga, mas sempre sobra um", () => {
    const all = new Set(["working", "queued"] as const);
    const one = toggleState(all, "working");
    expect([...one]).toEqual(["queued"]);
    expect([...toggleState(one, "queued")]).toEqual(["queued"]);
    expect([...toggleState(one, "working")].sort()).toEqual(["queued", "working"]);
  });

  it("desligar um estado tira a parte dele da barra", () => {
    const hours = hoursOf(TODAY, [{ working: 30 * MIN, queued: 10 * MIN }]);
    const chart = hourChart(hours, 0, new Set(["queued"] as const));
    expect(chart.bars[0]!.segments.map((segment) => segment.state)).toEqual(["queued"]);
    expect(chart.bars[0]!.totalMs).toBe(10 * MIN);
  });

  it("a legenda e a tabela só trazem o que apareceu; a tabela pula hora vazia", () => {
    const hours = hoursOf(TODAY, [{ working: 30 * MIN }, {}, { working: 5 * MIN, waiting_owner: 12 * MIN }]);
    const states = legendStates(hours);
    expect(states).toEqual(["waiting_owner", "working"]);
    const rows = hourTable(hours, states);
    expect(rows.map((row) => row.hour)).toEqual(["00h", "02h"]);
    expect(rows[1]!.cells).toEqual([
      { state: "waiting_owner", text: "12 min" },
      { state: "working", text: "5 min" },
    ]);
    expect(rows[1]!.total).toBe("17 min");
    expect(rows[0]!.cells[0]!.text).toBe("—");
  });

  it("dia sem tempo por estado não tem dados", () => {
    expect(hourChart(hoursOf(TODAY), 0).hasData).toBe(false);
  });
});

describe("o selo de cobertura", () => {
  const from = new Date("2026-11-12T11:10:00Z").toISOString();
  it("dia completo: sem selo", () => {
    expect(coverageNote({ states: "full", clockFrom: from })).toBeNull();
  });
  it("antes do relógio: diz a partir de quando há registro", () => {
    expect(coverageNote({ states: "none", clockFrom: from })).toBe("Sem registro de estados antes de 12/11");
  });
  it("relógio começou no meio do dia: diz a hora", () => {
    expect(coverageNote({ states: "partial", clockFrom: from })).toBe("Sem registro de estados antes de 12/11, 08:10");
  });
  it("relógio que nunca registrou", () => {
    expect(coverageNote({ states: "none" })).toBe("Sem registro de estados neste dia");
  });
});

describe("dias e navegação", () => {
  it("nomeia hoje, ontem e os outros dias", () => {
    expect(dayLabel("2026-11-12", TODAY)).toBe("Hoje");
    expect(dayLabel("2026-11-11", TODAY)).toBe("Ontem");
    expect(dayLabel("2026-11-09", TODAY)).toMatch(/seg.*09\/11/);
  });

  it("não deixa ir ao futuro nem além dos 90 dias", () => {
    expect(dayNav(TODAY, TODAY)).toEqual({ prev: "2026-11-11", next: null, isToday: true });
    expect(dayNav("2026-11-11", TODAY).next).toBe(TODAY);
    expect(dayNav("2026-08-14", TODAY)).toEqual({ prev: null, next: "2026-08-15", isToday: false });
    expect(dayNav("2026-08-15", TODAY).prev).toBe("2026-08-14");
    expect(clampDay("2026-12-01", TODAY)).toBe(TODAY);
    expect(clampDay("2025-01-01", TODAY)).toBe("2026-08-14");
    expect(clampDay("lixo", TODAY)).toBe(TODAY);
    expect(clampDay("2026-11-05", TODAY)).toBe("2026-11-05");
  });

  it("o seletor traz hoje sempre, os dias com dado, sem repetir nem sair da janela", () => {
    const options = dayOptions(["2026-11-11", "2026-11-12", "2026-11-10", "2026-11-11", "2026-12-25", "2025-01-01", "x"], TODAY, "2026-11-03");
    expect(options.map((option) => option.day)).toEqual(["2026-11-12", "2026-11-11", "2026-11-10", "2026-11-03"]);
    expect(options[0]!.label).toBe("Hoje");
    expect(dayOptions([], TODAY).map((option) => option.day)).toEqual([TODAY]);
  });
});

describe("dia vazio", () => {
  const empty = () => stats({}, { ms: ms(), waits: 0, longestWaitMs: 0, waitWallMs: 0, tasksDone: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } });
  it("workspace novo, hoje quieto e dia passado sem nada têm textos diferentes", () => {
    expect(emptyView(empty(), TODAY, true)?.title).toBe("Ainda não há dias para mostrar");
    expect(emptyView(empty(), TODAY, false)?.title).toBe("Hoje ainda está quieto");
    expect(emptyView({ ...empty(), day: "2026-11-11" }, TODAY, false)?.text).toContain("ontem");
    expect(emptyView(stats(), TODAY, false)).toBeNull();
  });
  it("só o gasto já basta para o dia não ser vazio", () => {
    expect(emptyView(stats({}, { ms: ms(), waits: 0, tasksDone: 0, turns: 3 }), TODAY, false)).toBeNull();
  });
});

describe("por agente, projeto e sprint", () => {
  it("agrupa o tempo em trabalhando, na fila, esperando você e parado por outro", () => {
    const rows = agentRows(
      stats({ agents: [{ id: "eco", name: "Eco", ms: ms({ working: 90 * MIN, queued: 5 * MIN, waiting_owner: 48 * MIN, waiting_agent: 3 * MIN, engine_blocked: 2 * MIN }), waits: 2, longestWaitMs: 0 }] }),
      new Map([["eco", 3]]),
    );
    expect(rows).toEqual([{ id: "eco", name: "Eco", waits: 2, done: 3, cells: { working: "1 h 30 min", queued: "5 min", waitingOwner: "48 min", stalled: "5 min" } }]);
  });

  it("conta as tarefas concluídas do dia por agente (pedido do Maestro não conta)", () => {
    const { start, end } = dayRange(TODAY);
    const inside = new Date(start + HOUR_MS).toISOString();
    const outside = new Date(end + HOUR_MS).toISOString();
    const done = doneByAgent(
      [
        { agentId: "eco", role: "task", status: "done", updatedAt: inside },
        { agentId: "eco", role: "task", status: "done", updatedAt: outside },
        { agentId: "eco", role: "request", status: "done", updatedAt: inside },
        { agentId: "luz", role: "task", status: "in_progress", updatedAt: inside },
        { agentId: "luz", role: "task", status: "done", updatedAt: inside },
      ] as never,
      { start, end },
    );
    expect(Object.fromEntries(done)).toEqual({ eco: 1, luz: 1 });
  });

  it("tempo zerado vira traço e as sprints vêm dentro do projeto", () => {
    const [row] = projectRows({ projects: [{ id: "p1", name: "Site novo", ms: ms({ working: 10 * MIN }), waits: 1, sprints: [{ id: "s1", name: "Sprint 1", ms: ms({ waiting_owner: 4 * MIN }), waits: 1 }] }] });
    expect(row!.cells).toEqual({ working: "10 min", queued: "—", waitingOwner: "—", stalled: "—" });
    expect(row!.sprints[0]).toMatchObject({ name: "Sprint 1", cells: { waitingOwner: "4 min" } });
  });
});

describe("o gasto do dia", () => {
  it("tokens, turnos, custo equivalente e os motores", () => {
    const view = usageView(
      stats(
        {
          providers: [
            { provider: "claude", label: "Claude Code", turns: 3, unmeasuredTurns: 0, totalTokens: 12_345, costUsd: 1, costBrl: 5.5 },
            { provider: "gemini", label: "Antigravity", turns: 1, unmeasuredTurns: 1, totalTokens: 0, costUsd: 0, costBrl: 0 },
          ],
        },
        { tokens: { input: 100_000, output: 20_000, cacheRead: 0, cacheCreation: 0 }, turns: 4, unmeasuredTurns: 1, costBrl: 8.25, costUsd: 1.5 },
      ),
    );
    expect(view.hasUsage).toBe(true);
    expect(view.tokens).toBe("120 mil");
    expect(view.turns).toBe("4 turnos");
    expect(view.cost).toMatch(/R\$\s*8,25/);
    expect(view.costUsd).toMatch(/US\$\s*1,50/);
    expect(view.unmeasured).toBe("1 turno sem medição");
    expect(view.providers[0]).toMatchObject({ label: "Claude Code", turns: "3 turnos", tokens: "12 mil" });
    expect(view.providers[1]).toMatchObject({ tokens: "—", cost: "—", unmeasured: "1 sem medição" });
  });

  it("sem turnos não há gasto", () => {
    expect(usageView(stats({}, { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } })).hasUsage).toBe(false);
  });
});

describe("a linha do Hoje e do Cyno", () => {
  it("com espera: o tempo do dia e a maior espera", () => {
    expect(waitedLine(stats({}, { ms: ms({ waiting_owner: 130 * MIN }), waits: 4, longestWaitMs: 48 * MIN }))).toEqual({ text: "Esperando você · 2 h 10 min hoje", detail: "4 esperas · maior 48 min", quiet: false });
  });
  it("sem espera: linha calma; sem dado: nada", () => {
    expect(waitedLine(stats({}, { waits: 0, ms: ms(), longestWaitMs: 0 }))).toEqual({ text: "Esperando você · ninguém esperou hoje", detail: "", quiet: true });
    expect(waitedLine(null)).toBeNull();
  });
  it("serve também ao dia somado da plataforma", () => {
    const platform = { totals: stats({}, { ms: ms({ waiting_owner: 5 * MIN }), waits: 1, longestWaitMs: 5 * MIN }).totals };
    expect(waitedLine(platform)?.detail).toBe("1 espera · maior 5 min");
  });
});
