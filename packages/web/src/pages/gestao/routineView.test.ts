import type { FieldDef, RoutineRun, TrackedItem, TrackedItemChange, TrackingStatus } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { noLinkNote } from "./gestaoView";
import {
  modeCardState,
  alertStatuses,
  cellText,
  changesByDay,
  cleanSummary,
  counterCells,
  dueText,
  emptyFilterText,
  filterCounts,
  filterRoutines,
  historyText,
  itemFilterCounts,
  itemLabel,
  matchesItemSearch,
  modeView,
  periodHistoryLine,
  periodView,
  routineActions,
  runLine,
  scheduleRows,
  sectionTitle,
  skipLabel,
  stateText,
  usdRate,
  visibleItems,
} from "./routineView";

const routine = (patch: Record<string, unknown> = {}) => ({ type: "meta", status: "ativa", skipPeriods: [] as string[], schedules: [], mode: { kind: "pede-ok" }, needsApproval: true, ...patch }) as never;
const entry = (r: Record<string, unknown>, pace = "no_ritmo") => ({ routine: routine(r), pace, periodKey: "2026-W46" }) as never;

describe("filtros da lista", () => {
  const items = [entry({ type: "meta" }), entry({ type: "acompanhamento" }), entry({ type: "meta", status: "pausada" }, "pausada"), entry({ type: "acompanhamento", status: "pausada" }, "no_ritmo")];
  it("todas, metas, acompanhamentos e pausadas", () => {
    expect(filterRoutines(items, "todas")).toHaveLength(4);
    expect(filterRoutines(items, "metas")).toHaveLength(2);
    expect(filterRoutines(items, "acompanhamentos")).toHaveLength(2);
    expect(filterRoutines(items, "pausadas")).toHaveLength(2);
    expect(filterCounts(items)).toEqual({ todas: 4, metas: 2, acompanhamentos: 2, pausadas: 2 });
  });
  it("títulos e textos de vazio seguem o filtro", () => {
    expect(sectionTitle("todas")).toBe("Rotinas");
    expect(sectionTitle("metas")).toBe("Metas");
    expect(sectionTitle("acompanhamentos")).toBe("Acompanhamentos");
    expect(sectionTitle("pausadas")).toBe("Rotinas pausadas");
    expect(emptyFilterText("acompanhamentos")).toContain("Nenhum acompanhamento");
    expect(emptyFilterText("metas")).toContain("Nenhuma meta");
  });
});

describe("botões: Pausar e Pular só quando fazem sentido", () => {
  it("meta ativa em andamento oferece tudo", () => {
    expect(routineActions(entry({}))).toEqual({ pause: true, resume: false, skip: true, unskip: false, end: true });
  });
  it("meta batida não oferece Pausar nem Pular, só Encerrar", () => {
    expect(routineActions(entry({}, "concluida"))).toEqual({ pause: false, resume: false, skip: false, unskip: false, end: true });
  });
  it("encerrada e proposta não oferecem nada", () => {
    expect(routineActions(entry({ status: "encerrada" }))).toEqual({ pause: false, resume: false, skip: false, unskip: false, end: false });
    expect(routineActions(entry({ status: "proposta" })).end).toBe(false);
  });
  it("pausada oferece Retomar; período pulado oferece Voltar a cobrar", () => {
    expect(routineActions(entry({ status: "pausada" }, "pausada"))).toMatchObject({ pause: false, resume: true, skip: true });
    expect(routineActions(entry({ skipPeriods: ["2026-W46"] }))).toMatchObject({ skip: false, unskip: true });
  });
  it("acompanhamento não tem Pular", () => {
    expect(routineActions(entry({ type: "acompanhamento" }))).toEqual({ pause: true, resume: false, skip: false, unskip: false, end: true });
  });
  it("rótulos", () => {
    expect(skipLabel("week")).toBe("Pular esta semana");
    expect(skipLabel("month")).toBe("Pular este mês");
    expect(stateText(entry({ status: "pausada", pausedReason: "3 tentativas sem entrega" }))).toBe("Pausada: 3 tentativas sem entrega");
    expect(stateText(entry({}))).toBe("Ativa");
  });
});

describe("modo", () => {
  it("Pede OK e Automático com a explicação", () => {
    expect(modeView({ mode: { kind: "pede-ok" }, needsApproval: true })).toMatchObject({ label: "Pede OK", auto: false });
    const auto = modeView({ mode: { kind: "automatico", grant: { actions: ["comentar"], sites: ["linkedin.com"], dailyCap: 8, approvedAt: "2026-11-01T00:00:00.000Z" } }, needsApproval: false });
    expect(auto).toMatchObject({ label: "Automático", auto: true });
    expect(auto.hint).toContain("linkedin.com");
    expect(auto.hint).toContain("até 8 por dia");
  });
});

describe("horários e execuções", () => {
  it("uma linha por horário, com agente próprio, escopo e desligado", () => {
    const rows = scheduleRows(
      [
        { id: "S1", label: "A", days: { kind: "uteis" }, times: ["09:00", "13:00", "18:00"], action: "olhar posts novos", enabled: true },
        { id: "S2", label: "B", days: { kind: "semana", weekdays: [2, 4, 5] }, times: ["10:00"], action: "buscar pessoas", enabled: false, agent: "linkedin/ana", scope: "itens_vencidos" },
      ],
      (address) => address.split("/")[1]!.toUpperCase(),
      (days) => (days.kind === "uteis" ? "Dias úteis" : "Ter, Qui e Sex"),
    );
    expect(rows[0]).toEqual({ id: "S1", when: "Dias úteis · 9h, 13h, 18h", what: "olhar posts novos", agent: null, scope: null, off: false });
    expect(rows[1]).toEqual({ id: "S2", when: "Ter, Qui e Sex · 10h", what: "buscar pessoas", agent: "ANA", scope: "só itens vencidos", off: true });
  });

  it("execução: resultado, motivo da pulada, tarefa e mudanças", () => {
    const base = { id: "E1", scheduleId: "S1", slotKey: "2026-11-11T09:00", startedAt: "2026-11-11T12:00:05.000Z", changes: [] } satisfies Partial<RoutineRun>;
    const schedules = [{ id: "S1", label: "Manhã" }];
    expect(runLine({ ...base, outcome: "rodando" } as RoutineRun, schedules)).toMatchObject({ when: "11/11 09:00", schedule: "Manhã", label: "Rodando", tone: "info" });
    expect(runLine({ ...base, outcome: "ok", summary: "2 novos", taskId: "t1", projectId: "P1", changes: [{ itemId: "I-1", text: "Novo: Acme", kind: "novo" }] } as RoutineRun, schedules)).toMatchObject({ label: "Concluída: 2 novos", tone: "ok", projectId: "P1", changes: "1 novo" });
    expect(runLine({ ...base, outcome: "falhou", summary: "sem cota" } as RoutineRun, schedules)).toMatchObject({ label: "Falhou: sem cota", tone: "danger" });
    expect(runLine({ ...base, outcome: "pulada", skipReason: "servidor desligado" } as RoutineRun, schedules)).toMatchObject({ label: "Pulada: servidor desligado", tone: "muted" });
  });
});

describe("resumo do agente", () => {
  it("tira o markdown e corta no limite", () => {
    expect(cleanSummary("Criei 3 itens.\n\n- **I-0001:** Acme `x`\n- **I-0002:** Beta")).toBe("Criei 3 itens. I-0001: Acme x I-0002: Beta");
    expect(cleanSummary("## Título\ntexto")).toBe("Título texto");
    expect(cleanSummary("Conferi as 3 inscrições: - Acme: passou. - Beta: recusada")).toBe("Conferi as 3 inscrições: Acme: passou. Beta: recusada");
    expect(cleanSummary("Acme - Beta")).toBe("Acme - Beta");
    expect(cleanSummary("a".repeat(300), 20)).toBe(`${"a".repeat(19)}…`);
  });
});

describe("período da meta", () => {
  const view = (patch: Record<string, unknown>) => periodView({ delivered: 2, inFlight: 1, pending: 1, missing: 1, pace: "no_ritmo", period: "week", expected: 2, daysLeft: 3, routine: { target: 5 }, ...patch } as never);
  it("alvo, entregue, em preparo e falta", () => {
    expect(view({})).toEqual({ headline: "No ritmo", lines: ["Alvo 5 esta semana", "2 entregues", "2 em preparo", "falta 1"], tone: "ok" });
    expect(view({ missing: 3, inFlight: 0, pending: 0, pace: "atrasada" })).toMatchObject({ headline: "Atrasada", tone: "danger", lines: ["Alvo 5 esta semana", "2 entregues", "faltam 3"] });
    expect(view({ delivered: 5, missing: 0, pace: "concluida", period: "month" })).toMatchObject({ headline: "Meta batida", tone: "done", lines: expect.arrayContaining(["Alvo 5 este mês", "meta batida"]) });
  });
  it("contadores e histórico dos períodos", () => {
    expect(counterCells({ prepared: 6, approved: 3, dismissed: 3 })).toEqual([
      { label: "Preparadas", value: 6 },
      { label: "Aprovadas", value: 3 },
      { label: "Dispensadas", value: 3 },
    ]);
    const money = (usd: number) => `R$ ${(usd * 5).toFixed(2)}`;
    expect(periodHistoryLine({ delivered: 3, target: 3, prepared: 6, approved: 3, costUsd: 0.2 }, money)).toBe("3 de 3 · 6 preparadas · 3 aprovadas · R$ 1.00");
    expect(periodHistoryLine({ delivered: 1, target: 3 }, money)).toBe("1 de 3");
    expect(usdRate({ periodUsd: 2, periodBrl: 11, totalUsd: 0, totalBrl: 0 })).toBe(5.5);
    expect(usdRate({ periodUsd: 0, periodBrl: 0, totalUsd: 0, totalBrl: 0 })).toBeGreaterThan(5);
  });
});

describe("tabela de itens", () => {
  const fields: FieldDef[] = [
    { key: "empresa", label: "Empresa", type: "texto" },
    { key: "vaga", label: "Vaga", type: "texto" },
    { key: "inscritoEm", label: "Inscrito em", type: "data" },
    { key: "link", label: "Link", type: "link" },
  ];
  const statuses: TrackingStatus[] = [{ name: "Inscrito" }, { name: "Entrevista", alert: true }, { name: "Recusado", terminal: true }];
  const item = (id: string, patch: Partial<TrackedItem> = {}): TrackedItem => ({ id, routineId: "R-0002", values: { empresa: `Empresa ${id}` }, status: "Inscrito", state: "ativo", createdAt: "2026-11-01T00:00:00.000Z", history: [], ...patch });
  const items = [
    item("I-0001", { expiresAt: "2026-11-20T00:00:00.000Z" }),
    item("I-0002", { status: "Entrevista", expiresAt: "2026-11-13T00:00:00.000Z", values: { empresa: "Acme Ação", vaga: "Dev" } }),
    item("I-0003", { status: "Recusado", state: "encerrado", endReason: "terminal", endedAt: "2026-11-05T00:00:00.000Z" }),
    item("I-0004", { state: "parado", endedAt: "2026-11-06T00:00:00.000Z" }),
  ];
  const alerts = alertStatuses(statuses);

  it("filtros: ativos, com alerta, encerrados, parados e todos", () => {
    expect(visibleItems(items, "ativos", "", alerts).map((i) => i.id)).toEqual(["I-0002", "I-0001"]);
    expect(visibleItems(items, "alerta", "", alerts).map((i) => i.id)).toEqual(["I-0002"]);
    expect(visibleItems(items, "encerrados", "", alerts).map((i) => i.id)).toEqual(["I-0003"]);
    expect(visibleItems(items, "parados", "", alerts).map((i) => i.id)).toEqual(["I-0004"]);
    expect(visibleItems(items, "todos", "", alerts).map((i) => i.id)).toEqual(["I-0002", "I-0001", "I-0004", "I-0003"]);
    expect(itemFilterCounts(items, alerts)).toEqual({ ativos: 2, alerta: 1, encerrados: 1, parados: 1, todos: 4 });
  });

  it("busca sem acento nem caixa em valores, status e id", () => {
    expect(matchesItemSearch(items[1]!, "acao")).toBe(true);
    expect(matchesItemSearch(items[1]!, "ENTREVISTA")).toBe(true);
    expect(matchesItemSearch(items[1]!, "i-0002")).toBe(true);
    expect(matchesItemSearch(items[1]!, "zzz")).toBe(false);
    expect(visibleItems(items, "todos", "dev", alerts).map((i) => i.id)).toEqual(["I-0002"]);
  });

  it("células e rótulo da linha", () => {
    expect(cellText(fields[2]!, "2026-11-11")).toBe("11/11/2026");
    expect(cellText(fields[3]!, "https://www.site.com/vaga/1/")).toBe("site.com/vaga/1");
    expect(cellText(fields[1]!, undefined)).toBe("–");
    expect(itemLabel(fields, items[1]!)).toBe("Acme Ação");
    expect(itemLabel(fields, item("I-0009", { values: {} }))).toBe("I-0009");
  });

  it("vence em e o histórico do item", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(dueText(items[1]!, now)).toBe("Vence em 2 dias");
    expect(dueText(items[3]!, now)).toBe("Parado por você");
    expect(dueText({ state: "encerrado", endReason: "expirou" }, now)).toBe("Prazo acabou");
    expect(historyText({ at: "x", by: "agente", field: "status", from: "Em análise", to: "Entrevista" })).toBe("Em análise → Entrevista");
    expect(historyText({ at: "x", by: "agente", field: "criado", to: "Inscrito" })).toBe("Criado como Inscrito");
    expect(historyText({ at: "x", by: "usuario", field: "vaga", from: "Dev", to: "Dev Sr" }, (key) => (key === "vaga" ? "Vaga" : key))).toBe("Vaga: Dev → Dev Sr");
    expect(historyText({ at: "x", by: "agente", field: "nota", note: "oi" })).toBe("Anotação");
  });
});

describe("mudanças recentes por dia", () => {
  it("agrupa e resume: novos e mudanças de status", () => {
    const now = new Date("2026-11-11T15:00:00Z");
    const change = (at: string, text: string): TrackedItemChange => ({ at, itemId: "I-1", label: "x", by: "agente", text });
    const days = changesByDay(
      [change("2026-11-11T12:00:00Z", "Novo: Acme (Inscrito)"), change("2026-11-11T13:00:00Z", "Novo: Beta (Inscrito)"), change("2026-11-11T14:00:00Z", "Acme → Entrevista"), change("2026-11-10T14:00:00Z", "Beta → Em análise"), change("2026-11-08T14:00:00Z", "Gama: parado")],
      now,
    );
    expect(days.map((d) => [d.label, d.summary])).toEqual([
      ["Hoje", "2 novos; Acme → Entrevista"],
      ["Ontem", "Beta → Em análise"],
      ["08/11", "Gama: parado"],
    ]);
    expect(changesByDay([], now)).toEqual([]);
  });
});

describe("modeCardState", () => {
  it("pausada e fechadas", () => {
    expect(modeCardState({ status: "ativa" })).toEqual({ paused: false, open: true, closed: false });
    expect(modeCardState({ status: "pausada" })).toMatchObject({ paused: true, open: true });
    expect(modeCardState({ status: "encerrada" })).toMatchObject({ open: false, closed: true });
    expect(modeCardState({ status: "proposta" })).toMatchObject({ open: false });
  });
});

describe("acabamento: falta registrar o link e texto completo", () => {
  it("noLinkNote diz quantas aprovadas ainda não têm link", () => {
    expect(noLinkNote(0)).toBe("");
    expect(noLinkNote(undefined)).toBe("");
    expect(noLinkNote(1)).toBe("1 aprovada, falta registrar o link");
    expect(noLinkNote(3)).toBe("3 aprovadas, falta registrar o link");
  });

  it("o período mostra as aprovadas sem link ao lado do que falta entregar", () => {
    const view = periodView({ delivered: 0, inFlight: 0, pending: 0, missing: 3, pace: "atrasada", period: "week", expected: 2, daysLeft: 3, routine: { target: 3 } as never, approvedNoLink: 3 });
    expect(view.lines).toContain("3 aprovadas, falta registrar o link");
    expect(view.lines).toContain("0 entregues");
  });

  it("runLine guarda o texto completo só quando é maior que o resumo curto", () => {
    const base = { id: "r1", startedAt: "2026-11-11T12:00:00.000Z", outcome: "ok" as const, changes: [] };
    expect(runLine({ ...base, summary: "Publiquei 2 posts.", detail: "Publiquei 2 posts." }, []).detail).toBeUndefined();
    expect(runLine({ ...base, summary: "Publiquei 2 posts.", detail: "- Publiquei 2 posts.\n- Links registrados." }, []).detail).toContain("Links registrados");
  });
});
