import { describe, expect, it } from "vitest";
import {
  clockLabel,
  dailyLimitMs,
  effectivePriority,
  effectiveRank,
  isDeadlineAtRisk,
  nextWorkDayStart,
  parseClock,
  pruneWorked,
  urgencyTier,
  windowState,
  workClock,
  workDayStart,
  workRank,
  type RankInput,
} from "./projects";

describe("workRank (ordem de urgência)", () => {
  const NOW = Date.parse("2026-11-11T15:00:00.000Z");
  const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
  type Item = RankInput & { id: string };
  const item = (id: string, priority: Item["priority"], extra: Partial<RankInput> = {}): Item => ({ id, priority, ...extra });
  const order = (items: Item[], options?: Parameters<typeof workRank>[2]) => workRank(items, NOW, options).map((entry) => entry.id);

  it("\"Isso primeiro\": o fixado passa na frente de tudo (até do atrasado), entre fixados o fixado há mais tempo vem antes", () => {
    const late = item("atrasado", "alta", { dueAt: inHours(-5) });
    const pinnedLow = item("fixado-baixa", "baixa", { pinnedAt: "2026-11-11T14:00:00.000Z" });
    const pinnedLater = item("fixado-depois", "alta", { pinnedAt: "2026-11-11T14:30:00.000Z" });
    expect(order([late, item("normal", "normal"), pinnedLater, pinnedLow])).toEqual(["fixado-baixa", "fixado-depois", "atrasado", "normal"]);
    expect(order([pinnedLow, late], { tieBreak: "approved" })).toEqual(["fixado-baixa", "atrasado"]);
  });

  it("sem fixados a ordem é a de sempre; fixados no mesmo instante caem na regra normal", () => {
    const same = "2026-11-11T14:00:00.000Z";
    expect(order([item("b", "baixa", { pinnedAt: same }), item("a", "alta", { pinnedAt: same })])).toEqual(["a", "b"]);
    expect(order([item("n", "normal"), item("alta", "alta")])).toEqual(["alta", "n"]);
  });

  it("atrasado, depois prazo em menos de 24 h, depois prioridade, depois prazo mais próximo", () => {
    const list = [
      item("baixa-sem-prazo", "baixa"),
      item("alta-sem-prazo", "alta"),
      item("normal-prazo-longe", "normal", { dueAt: inHours(100) }),
      item("normal-prazo-perto", "normal", { dueAt: inHours(30) }),
      item("baixa-em-5h", "baixa", { dueAt: inHours(5) }),
      item("alta-atrasada", "alta", { dueAt: inHours(-2) }),
      item("baixa-atrasada-faz-tempo", "baixa", { dueAt: inHours(-50) }),
    ];
    expect(order(list)).toEqual(["alta-atrasada", "baixa-atrasada-faz-tempo", "baixa-em-5h", "alta-sem-prazo", "normal-prazo-perto", "normal-prazo-longe", "baixa-sem-prazo"]);
  });

  it("empate de prioridade e prazo: aprovado há mais tempo, depois a posição (agendador)", () => {
    const list = [
      item("novo", "normal", { approvedAt: "2026-11-10T00:00:00.000Z", position: 0 }),
      item("velho-p2", "normal", { approvedAt: "2026-11-01T00:00:00.000Z", position: 2 }),
      item("velho-p1", "normal", { approvedAt: "2026-11-01T00:00:00.000Z", position: 1 }),
    ];
    expect(order(list, { tieBreak: "approved" })).toEqual(["velho-p1", "velho-p2", "novo"]);
  });

  it("na tela o desempate é o mais recente primeiro", () => {
    const list = [item("antigo", "normal", { createdAt: "2026-11-01T00:00:00.000Z" }), item("recente", "normal", { createdAt: "2026-11-09T00:00:00.000Z" })];
    expect(order(list)).toEqual(["recente", "antigo"]);
  });

  it("urgência extra: prazo mais curto que o tempo médio das tarefas sobe a prioridade uma classe", () => {
    expect(effectiveRank({ priority: "baixa", dueAt: inHours(0.4) }, NOW, 3_600_000)).toBe(1);
    expect(effectiveRank({ priority: "baixa", dueAt: inHours(2) }, NOW, 3_600_000)).toBe(2);
    expect(effectiveRank({ priority: "alta", dueAt: inHours(0.4) }, NOW, 3_600_000)).toBe(0);
    expect(effectiveRank({ priority: "baixa", dueAt: inHours(-1) }, NOW, 3_600_000)).toBe(2);
    const two = [item("normal-folgada", "normal", { dueAt: inHours(20) }), item("baixa-apertada", "baixa", { dueAt: inHours(0.5) })];
    expect(order(two, { avgTaskMs: 3_600_000 })).toEqual(["baixa-apertada", "normal-folgada"]);
    expect(order(two)).toEqual(["normal-folgada", "baixa-apertada"]);
  });

  it("não muda a lista recebida e mantém a ordem num empate total", () => {
    const list = [item("a", "normal"), item("b", "normal")];
    workRank(list, NOW);
    expect(list.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(order(list)).toEqual(["a", "b"]);
  });

  it("faixas de urgência e prazo em risco", () => {
    expect(urgencyTier({ dueAt: inHours(23.9) }, NOW)).toBe(1);
    expect(urgencyTier({ dueAt: inHours(24.1) }, NOW)).toBe(2);
    expect(urgencyTier({ dueAt: inHours(-0.1) }, NOW)).toBe(0);
    expect(urgencyTier({}, NOW)).toBe(2);
    expect(isDeadlineAtRisk({ dueAt: inHours(5), status: "ativo" }, NOW)).toBe(true);
    expect(isDeadlineAtRisk({ dueAt: inHours(5), status: "concluido" }, NOW)).toBe(false);
    expect(isDeadlineAtRisk({ status: "ativo" }, NOW)).toBe(false);
  });

  it("prioridade da tarefa herda a do projeto quando é a padrão", () => {
    expect(effectivePriority({ priority: "alta" }, { priority: "normal" })).toBe("alta");
    expect(effectivePriority({ priority: "alta" }, { priority: "baixa" })).toBe("baixa");
  });
});

describe("horário de trabalho (America/Sao_Paulo)", () => {
  // 2026-11-11T15:30:00Z = 12:30 em São Paulo (UTC-3, sem horário de verão).
  const at = Date.parse("2026-11-11T15:30:00.000Z");

  it("dia local, minutos e virada do dia", () => {
    expect(workClock(at)).toEqual({ day: "2026-11-11", minutes: 12 * 60 + 30, seconds: 0 });
    expect(workClock(Date.parse("2026-11-12T01:30:00.000Z")).day).toBe("2026-11-11");
    expect(new Date(nextWorkDayStart(at)).toISOString()).toBe("2026-11-12T03:00:00.000Z");
    expect(new Date(workDayStart(at)).toISOString()).toBe("2026-11-11T03:00:00.000Z");
  });

  it("janela simples, fechada e que atravessa a meia-noite", () => {
    expect(windowState({ from: "09:00", to: "13:00" }, at)).toEqual({ open: true });
    const closed = windowState({ from: "13:00", to: "18:00" }, at);
    expect(closed).toMatchObject({ open: false, opensAtMinutes: 13 * 60 });
    expect(new Date((closed as { opensAt: number }).opensAt).toISOString()).toBe("2026-11-11T16:00:00.000Z");
    const after = windowState({ from: "09:00", to: "12:00" }, at) as { open: false; opensAt: number };
    expect(after.open).toBe(false);
    expect(new Date(after.opensAt).toISOString()).toBe("2026-11-12T12:00:00.000Z");
    expect(windowState({ from: "22:00", to: "06:00" }, at).open).toBe(false);
    expect(windowState({ from: "22:00", to: "06:00" }, Date.parse("2026-11-12T02:00:00.000Z")).open).toBe(true);
    expect(windowState({ from: "22:00", to: "06:00" }, Date.parse("2026-11-12T08:00:00.000Z")).open).toBe(true);
    expect(windowState(undefined, at).open).toBe(true);
    expect(windowState({ from: "09:00", to: "09:00" }, at).open).toBe(true);
  });

  it("rótulos, limite diário e poda do worked", () => {
    expect(clockLabel(9 * 60)).toBe("9h");
    expect(clockLabel(9 * 60 + 30)).toBe("9h30");
    expect(parseClock("24:00")).toBeUndefined();
    expect(dailyLimitMs({ hoursPerDay: 1 })).toBe(3_600_000);
    expect(dailyLimitMs({})).toBeUndefined();
    const worked = { "2026-11-11": 5, "2026-01-01": 9, "2026-08-20": 3 };
    expect(pruneWorked(worked, at)).toBe(true);
    expect(Object.keys(worked).sort()).toEqual(["2026-08-20", "2026-11-11"]);
    expect(pruneWorked(worked, at)).toBe(false);
  });
});
