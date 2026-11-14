import type { ActivityEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useActivityLogStore } from "../../store/activityLogStore";
import { parseHash } from "../../store/navStore";
import { DEFAULT_FILTERS, addDaysKey, dayLabel, entryDelivery, entryFacts, formatDuration, formatUsd, groupByDay, isRoutineAlert, matchesFilters, mergeLive, rangeOf, refLinks, toneOf, todayKey } from "./activityView";

const entry = (id: string, at: string, partial: Partial<ActivityEntry> = {}): ActivityEntry => ({ id, at, category: "tarefa", action: "concluida", actor: "eco", summary: "ECO concluiu “Post”", ...partial });

describe("período e dias (São Paulo)", () => {
  it("hoje vale o dia de São Paulo, não o de UTC", () => {
    expect(todayKey(new Date("2026-11-10T01:30:00Z"))).toBe("2026-11-09");
    expect(todayKey(new Date("2026-11-10T12:00:00Z"))).toBe("2026-11-10");
  });

  it("calcula Hoje, 7 e 30 dias terminando hoje", () => {
    const now = new Date("2026-11-10T15:00:00Z");
    expect(rangeOf("hoje", now)).toEqual({ from: "2026-11-10", to: "2026-11-10" });
    expect(rangeOf("7d", now)).toEqual({ from: "2026-11-04", to: "2026-11-10" });
    expect(rangeOf("30d", now)).toEqual({ from: "2026-10-12", to: "2026-11-10" });
    expect(addDaysKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("nomeia os dias: Hoje, Ontem e a data por extenso", () => {
    expect(dayLabel("2026-11-10", "2026-11-10")).toBe("Hoje");
    expect(dayLabel("2026-11-09", "2026-11-10")).toBe("Ontem");
    expect(dayLabel("2026-11-03", "2026-11-10")).toBe("Terça, 3 de novembro");
    expect(dayLabel("2025-12-31", "2026-11-10")).toBe("Quarta, 31 de dezembro de 2025");
  });

  it("agrupa a lista (mais nova primeiro) por dia, pelo fuso gravado na entrada", () => {
    const groups = groupByDay([entry("a", "2026-11-10T09:00:00.000-03:00"), entry("b", "2026-11-10T08:00:00.000-03:00"), entry("c", "2026-11-09T23:59:00.000-03:00")], "2026-11-10");
    expect(groups.map((group) => [group.label, group.entries.length])).toEqual([["Hoje", 2], ["Ontem", 1]]);
  });
});

describe("filtros e ao vivo", () => {
  const range = { from: "2026-11-04", to: "2026-11-10" };
  it("categoria, quem fez, busca sem acento e período", () => {
    const post = entry("a", "2026-11-10T09:00:00.000-03:00", { summary: "Ana publicou o comentário", category: "publicacao", actor: "ana", refs: { url: "https://linkedin.com/x" } });
    expect(matchesFilters(post, DEFAULT_FILTERS, range)).toBe(true);
    expect(matchesFilters(post, { ...DEFAULT_FILTERS, categories: ["tarefa"] }, range)).toBe(false);
    expect(matchesFilters(post, { ...DEFAULT_FILTERS, categories: ["publicacao", "tarefa"], actor: "ana" }, range)).toBe(true);
    expect(matchesFilters(post, { ...DEFAULT_FILTERS, actor: "eco" }, range)).toBe(false);
    expect(matchesFilters(post, { ...DEFAULT_FILTERS, q: "COMENTARIO" }, range)).toBe(true);
    expect(matchesFilters(post, { ...DEFAULT_FILTERS, q: "linkedin" }, range)).toBe(true);
    expect(matchesFilters(entry("old", "2026-10-01T09:00:00.000-03:00"), DEFAULT_FILTERS, range)).toBe(false);
  });

  it("mistura as entradas ao vivo no topo, sem repetir e só as que passam", () => {
    const list = [entry("b", "2026-11-10T09:00:00.000-03:00"), entry("a", "2026-11-10T08:00:00.000-03:00")];
    const live = [entry("c", "2026-11-10T10:00:00.000-03:00"), entry("b", "2026-11-10T09:00:00.000-03:00"), entry("x", "2026-11-10T11:00:00.000-03:00", { category: "midia" })];
    const merged = mergeLive(list, live, (item) => item.category === "tarefa");
    expect(merged.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect(mergeLive(list, [], () => true)).toBe(list);
  });

  it("o store ao vivo ignora repetidas", () => {
    const store = useActivityLogStore.getState();
    store.clear();
    store.push(entry("a", "2026-11-10T08:00:00.000-03:00"));
    store.push(entry("a", "2026-11-10T08:00:00.000-03:00"));
    expect(useActivityLogStore.getState().live).toHaveLength(1);
    expect(useActivityLogStore.getState().version).toBe(1);
  });
});

describe("apresentação", () => {
  it("links: tarefa, Aprovações, mídia, rotina e só URLs http(s)", () => {
    expect(refLinks({ taskId: "t1", forYouId: "A-0001", mediaId: "M-0002", routineId: "R-0003", url: "https://www.linkedin.com/feed/x" }).map((link) => [link.kind, link.label])).toEqual([
      ["task", "Tarefa"],
      ["foryou", "Aprovações"],
      ["media", "Mídia"],
      ["routine", "Rotina"],
      ["url", "linkedin.com"],
    ]);
    expect(refLinks({ url: "javascript:alert(1)" })).toEqual([]);
    expect(refLinks(undefined)).toEqual([]);
  });

  it("tom, valores e números da entrada", () => {
    expect(toneOf({ category: "tarefa", action: "falhou" })).toBe("danger");
    expect(toneOf({ category: "tarefa", action: "concluida" })).toBe("ok");
    expect(toneOf({ category: "sistema", action: "memoria_baixa" })).toBe("warn");
    expect(formatUsd(1.234)).toBe("US$ 1,23");
    expect(formatUsd(0.001)).toBe("< US$ 0,01");
    expect(formatDuration(125_000)).toBe("2 min");
    expect(entryFacts(entry("a", "2026-11-10T09:00:00.000-03:00", { data: { costUsd: 0.5, backfill: true } }))).toEqual(["US$ 0,50", "recuperado do histórico"]);
  });

  it("a entrega de uma tarefa concluída mostra a manchete (e o resumo) que o servidor gravou", () => {
    expect(entryDelivery(entry("a", "2026-11-10T09:00:00.000-03:00", { data: { headline: "O post ficou pronto.", summary: "Texto corrido." } }))).toEqual({ headline: "O post ficou pronto.", summary: "Texto corrido." });
    expect(entryDelivery(entry("a", "2026-11-10T09:00:00.000-03:00", { data: { headline: "  " } }))).toBeUndefined();
    expect(entryDelivery(entry("a", "2026-11-10T09:00:00.000-03:00", { action: "falhou", data: { headline: "x" } }))).toBeUndefined();
  });

  it("o endereço antigo #/<workspace>/logs abre a Atividade", () => {
    expect(parseHash("#/principal/logs")).toEqual({ workspaceId: "principal", page: "gestao", sub: "atividade" });
    expect(parseHash("#/logs")).toEqual({ workspaceId: null, page: "gestao", sub: "atividade" });
    expect(parseHash("#/principal/atividade")).toEqual({ workspaceId: "principal", page: "gestao", sub: "atividade" });
  });
});

describe("alerta de rotina", () => {
  it("destaca a ação alerta e a mudança com alerta, e só da categoria rotina", () => {
    expect(isRoutineAlert({ category: "rotina", action: "alerta" })).toBe(true);
    expect(isRoutineAlert({ category: "rotina", action: "mudou", data: { alert: true } })).toBe(true);
    expect(isRoutineAlert({ category: "rotina", action: "mudou", data: { alert: false } })).toBe(false);
    expect(isRoutineAlert({ category: "tarefa", action: "alerta" })).toBe(false);
    expect(toneOf({ category: "rotina", action: "alerta" })).toBe("alert");
    expect(entryFacts(entry("a", "2026-11-10T10:00:00-03:00", { category: "rotina", action: "alerta" }))).toContain("Alerta");
  });
});
