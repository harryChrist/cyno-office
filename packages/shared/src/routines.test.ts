import { describe, expect, it } from "vitest";
import {
  clampTarget,
  dailyCapOf,
  expectedByNow,
  hostMatchesSite,
  normalizeRoutineUrl,
  paceStatus,
  periodBounds,
  periodBoundsOfKey,
  periodKey,
  previousPeriodKeys,
  routineLabelAllowed,
  weeklyCloseAt,
} from "./routines";

describe("períodos (semana ISO em São Paulo)", () => {
  it("a semana começa na segunda 00:00 de São Paulo, não do servidor", () => {
    // 2026-11-09 02:30Z = domingo 23:30 em SP: ainda é a semana anterior (W45).
    expect(periodKey(new Date("2026-11-09T02:30:00Z"))).toBe("2026-W45");
    // 03:00Z = segunda 00:00 em SP: já é W46.
    expect(periodKey(new Date("2026-11-09T03:00:00Z"))).toBe("2026-W46");
    const bounds = periodBounds(new Date("2026-11-12T15:00:00Z"));
    expect(bounds.key).toBe("2026-W46");
    expect(bounds.start.toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-11-16T03:00:00.000Z");
  });

  it("virada de ano: W53 de 2020 e W01 de 2021", () => {
    expect(periodKey(new Date("2021-01-03T15:00:00Z"))).toBe("2020-W53");
    expect(periodKey(new Date("2021-01-04T15:00:00Z"))).toBe("2021-W01");
    expect(periodKey(new Date("2024-12-30T15:00:00Z"))).toBe("2025-W01");
    expect(periodKey(new Date("2026-01-01T15:00:00Z"))).toBe("2026-W01");
  });

  it("periodBoundsOfKey volta ao mesmo período e rejeita chave inválida", () => {
    const bounds = periodBoundsOfKey("2026-W46")!;
    expect(bounds.start.toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(periodBoundsOfKey("2020-W53")?.key).toBe("2020-W53");
    expect(periodBoundsOfKey("2021-W53")).toBeUndefined();
    expect(periodBoundsOfKey("lixo")).toBeUndefined();
  });

  it("períodos anteriores, do mais antigo ao mais novo, atravessando o ano", () => {
    expect(previousPeriodKeys(new Date("2021-01-12T15:00:00Z"), 3)).toEqual(["2020-W52", "2020-W53", "2021-W01"]);
  });

  it("fechamento semanal: segunda 08:00 de São Paulo", () => {
    expect(weeklyCloseAt(new Date("2026-11-12T15:00:00Z")).toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });
});

describe("ritmo", () => {
  const bounds = periodBounds(new Date("2026-11-12T15:00:00Z"));
  it("espalha a meta pela semana (arredonda para cima)", () => {
    expect(expectedByNow(10, bounds.start, bounds)).toBe(0);
    expect(expectedByNow(10, new Date(bounds.start.getTime() + 3_600_000), bounds)).toBe(1);
    expect(expectedByNow(10, new Date(bounds.start.getTime() + 3.5 * 86_400_000), bounds)).toBe(5);
    expect(expectedByNow(2, new Date(bounds.start.getTime() + 3 * 86_400_000), bounds)).toBe(1);
    expect(expectedByNow(10, bounds.end, bounds)).toBe(10);
  });

  it("estados do ritmo", () => {
    expect(paceStatus({ delivered: 5, target: 5, expected: 2 })).toBe("concluida");
    expect(paceStatus({ delivered: 1, target: 5, expected: 2, paused: true })).toBe("pausada");
    expect(paceStatus({ delivered: 1, target: 5, expected: 2 })).toBe("atrasada");
    expect(paceStatus({ delivered: 3, target: 5, expected: 2 })).toBe("adiantada");
    expect(paceStatus({ delivered: 2, target: 5, expected: 2 })).toBe("no_ritmo");
  });
});

describe("limites e rótulos", () => {
  it("limita a meta ao teto semanal do tipo", () => {
    expect(clampTarget("invite", 100)).toBe(60);
    expect(clampTarget("like", 500)).toBe(100);
    expect(clampTarget("comment", 100)).toBe(56);
    expect(clampTarget("post", 20)).toBe(7);
    expect(clampTarget("invite", 0)).toBe(1);
  });

  it("teto diário: o seu nunca passa o da tabela", () => {
    expect(dailyCapOf({ kind: "invite" })).toBe(15);
    expect(dailyCapOf({ kind: "invite", dailyCap: 5 })).toBe(5);
    expect(dailyCapOf({ kind: "invite", dailyCap: 50 })).toBe(15);
    expect(dailyCapOf({ kind: "other" })).toBeUndefined();
  });

  it("rótulos por tipo; Conectar e mensagem nunca", () => {
    expect(routineLabelAllowed("comment", "Comentar")).toBe(true);
    expect(routineLabelAllowed("comment", " Publicar… ")).toBe(true);
    expect(routineLabelAllowed("comment", "Enviar comentário")).toBe(true);
    expect(routineLabelAllowed("comment", "Conectar")).toBe(false);
    expect(routineLabelAllowed("comment", "Enviar mensagem")).toBe(false);
    expect(routineLabelAllowed("invite", "Conectar")).toBe(false);
    expect(routineLabelAllowed("invite", "Enviar sem nota")).toBe(true);
    expect(routineLabelAllowed("comment", "Publicar post")).toBe(false);
    expect(routineLabelAllowed("other", "Comentar")).toBe(false);
  });

  it("site e links", () => {
    expect(hostMatchesSite("www.linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatchesSite("br.linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatchesSite("evillinkedin.com", "linkedin.com")).toBe(false);
    expect(normalizeRoutineUrl("https://www.linkedin.com/in/ana/#x")).toBe("linkedin.com/in/ana");
    expect(normalizeRoutineUrl("https://linkedin.com/in/ana/")).toBe("linkedin.com/in/ana");
    expect(normalizeRoutineUrl("javascript:alert(1)")).toBeUndefined();
  });
});
