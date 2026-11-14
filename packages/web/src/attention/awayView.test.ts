import { buildAwaySummary, type AwaySummary, type ForYouItem, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { shouldSendPresence } from "./awayStore";
import { awayCardView, sinceLabel } from "./awayView";

const SINCE = Date.parse("2026-11-12T12:00:00.000Z");
const UNTIL = Date.parse("2026-11-12T15:20:00.000Z");
const at = (minutes: number) => new Date(SINCE + minutes * 60_000).toISOString();
const task = (id: string, change: Partial<Task> = {}): Task => ({ id, roomId: "r", teamId: "t", agentId: "eco", prompt: `Fazer ${id}`, status: "done", createdAt: at(0), updatedAt: at(60), ...change }) as Task;
const item = (id: string, change: Partial<ForYouItem> = {}): ForYouItem => ({ id, agentId: "eco", roomId: "r", type: "post", kind: "aprovacao", status: "pendente", meta: {}, text: "Legenda", originalText: "Legenda", editedByUser: false, createdAt: at(30), title: `Post ${id}`, ...change }) as ForYouItem;

function summaryOf(workspaces: { id: string; name: string; tasks?: Task[]; items?: ForYouItem[] }[], alerts: Parameters<typeof buildAwaySummary>[0]["alerts"] = []): AwaySummary {
  return buildAwaySummary({ since: SINCE, until: UNTIL, workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, tasks: w.tasks ?? [], items: w.items ?? [], agents: [{ id: "eco", name: "Eco" }] })), alerts });
}

describe("awayCardView: o cartão ao voltar", () => {
  it("o título, o desde quando e a duração da ausência", () => {
    const view = awayCardView(summaryOf([{ id: "ws", name: "Site", tasks: [task("a")] }]), UNTIL);
    expect(view.title).toBe("Enquanto você estava fora");
    // 12:00 UTC = 09:00 em São Paulo; ausência de 3 h 20 min.
    expect(view.since).toBe("desde hoje, 09:00 · fora há 3 h 20 min");
  });

  it("uma seção por coisa, só as que têm novidade, com links para cada uma", () => {
    const summary = summaryOf(
      [{ id: "ws", name: "Site", tasks: [task("a", { result: "Post pronto" }), task("b", { status: "failed" })], items: [item("x")] }],
      [{ kind: "budget", level: "alert", text: "Orçamento hoje estourado: US$ 5,00 de US$ 5,00 equiv.", at: at(120), target: { page: "gestao", ref: "gastos" } }],
    );
    const view = awayCardView(summary, UNTIL);
    expect(view.multi).toBe(false);
    expect(view.sections.map((section) => section.key)).toEqual(["done", "failed", "approvals", "wait", "limits"]);
    const done = view.sections[0]!;
    expect(done.heading).toBe("1 tarefa concluída");
    expect(done.items[0]).toMatchObject({ label: "Fazer a", sub: "Eco · Post pronto", target: { page: "trabalho", workspaceId: "ws", ref: "a" } });
    expect(view.sections[1]!.items[0]!.kind).toBe("failed");
    expect(view.sections[2]!.heading).toContain("1 item novo espera você, a mais antiga há 2 h 50 min");
    expect(view.sections[2]!.items[0]!.target).toMatchObject({ page: "para-voce", ref: "x" });
    expect(view.sections[3]!.heading).toMatch(/^Os agentes ficaram .* esperando por você$/);
    expect(view.sections[4]!.items[0]).toMatchObject({ kind: "budget", target: { page: "gestao", ref: "gastos" } });
  });

  it("vários workspaces: cada seção leva o nome do workspace; os que não têm novidade não aparecem", () => {
    const view = awayCardView(summaryOf([{ id: "a", name: "A", tasks: [task("t1")] }, { id: "b", name: "B" }, { id: "c", name: "C", tasks: [task("t2")] }]), UNTIL);
    expect(view.multi).toBe(true);
    expect(view.sections.filter((section) => section.key === "done").map((section) => section.workspace)).toEqual(["A", "C"]);
  });

  it("lista cortada em três no cartão diz \"e mais N\"", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, { updatedAt: at(10 + i) }));
    const [done] = awayCardView(summaryOf([{ id: "ws", name: "Site", tasks }]), UNTIL).sections;
    expect(done!.heading).toBe("8 tarefas concluídas");
    expect(done!.items).toHaveLength(3);
    expect(done!.more).toBe("e mais 5");
  });

  it("gasto no período: dólar equivalente e tokens, com link para Gastos", () => {
    const summary = buildAwaySummary({
      since: SINCE,
      until: UNTIL,
      workspaces: [{ id: "ws", name: "Site", tasks: [], items: [], agents: [], usage: { costUsd: 1.5, costBrl: 8, tokens: 12_345, turns: 4, unmeasuredTurns: 0 } }],
      alerts: [],
    });
    const spend = awayCardView(summary, UNTIL).sections.find((section) => section.key === "spend")!;
    expect(spend.heading).toBe("Gasto no período: US$ 1,50 equivalentes");
    expect(spend.items[0]).toMatchObject({ label: "12.345 tokens em 4 turnos", target: { page: "gestao", ref: "gastos" } });
  });
});

describe("sinceLabel", () => {
  it("hoje, ontem ou a data (horário de São Paulo)", () => {
    const now = Date.parse("2026-11-12T15:00:00.000Z");
    expect(sinceLabel(Date.parse("2026-11-12T12:00:00.000Z"), now)).toBe("hoje, 09:00");
    expect(sinceLabel(Date.parse("2026-11-11T21:42:00.000Z"), now)).toBe("ontem, 18:42");
    expect(sinceLabel(Date.parse("2026-11-09T21:42:00.000Z"), now)).toBe("09/11, 18:42");
  });
});

describe("shouldSendPresence: nada invasivo", () => {
  const now = 1_000_000;
  it("só com a aba visível e entrada recente (dois minutos)", () => {
    expect(shouldSendPresence({ visible: true, lastInputAt: now - 30_000, now })).toBe(true);
    expect(shouldSendPresence({ visible: true, lastInputAt: now - 120_000, now })).toBe(true);
    expect(shouldSendPresence({ visible: true, lastInputAt: now - 120_001, now })).toBe(false);
    expect(shouldSendPresence({ visible: false, lastInputAt: now, now })).toBe(false);
  });
});
