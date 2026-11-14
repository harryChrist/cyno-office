import { agendaEventSchema, availabilitySchema, type AgendaEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  addDayKeys,
  applyView,
  availabilityBands,
  dayKeyOf,
  dayLabel,
  daySegments,
  DEFAULT_LAYERS,
  eventTimeLabel,
  instantOf,
  layoutLanes,
  splitInstant,
  timeLabel,
  upcomingEvents,
  visibleHours,
  weekKeys,
  weekTitle,
  workspaceHue,
} from "./agendaTime";

const at = (day: number, time: string) => `2026-11-${String(day).padStart(2, "0")}T${time}:00-03:00`;
const ev = (id: number, start: string, end: string, extra: Partial<AgendaEvent> = {}): AgendaEvent =>
  agendaEventSchema.parse({ id: `G-${String(id).padStart(4, "0")}`, title: `E${id}`, start, end, createdAt: "2026-11-01T00:00:00.000Z", ...extra });

describe("dias no fuso de São Paulo", () => {
  it("dia e hora são os de São Paulo, não os do aparelho", () => {
    // 01:30 UTC de 12/11 ainda é 22:30 de 11/11 em São Paulo.
    expect(dayKeyOf("2026-11-12T01:30:00Z")).toBe("2026-11-11");
    expect(timeLabel("2026-11-12T01:30:00Z")).toBe("22:30");
    expect(instantOf("2026-11-12", "17:00")).toBe("2026-11-12T20:00:00.000Z");
    expect(splitInstant("2026-11-12T20:00:00.000Z")).toEqual({ date: "2026-11-12", time: "17:00" });
  });

  it("semana de domingo a sábado e viradas de mês", () => {
    expect(weekKeys("2026-11-11")).toEqual(["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(weekKeys("2026-11-29")[0]).toBe("2026-11-29");
    expect(addDayKeys("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekTitle(weekKeys("2026-11-11"))).toBe("8 – 14 de novembro de 2026");
    expect(weekTitle(weekKeys("2026-12-01"))).toBe("29 de nov – 5 de dez de 2026");
    expect(dayLabel("2026-11-11", "2026-11-11")).toBe("Hoje");
    expect(dayLabel("2026-11-12", "2026-11-11")).toBe("Amanhã");
    expect(dayLabel("2026-11-14", "2026-11-11")).toBe("sáb., 14 de novembro");
  });

  it("rótulo do horário, inclusive o que passa da meia-noite", () => {
    expect(eventTimeLabel(ev(1, at(10, "17:00"), at(10, "18:30")))).toBe("17:00–18:30");
    expect(eventTimeLabel(ev(2, at(10, "23:00"), at(11, "01:00")))).toBe("23:00 – 11/11 01:00");
  });
});

describe("trechos e colunas do dia", () => {
  it("o evento que atravessa a meia-noite aparece cortado nos dois dias", () => {
    const night = ev(1, at(10, "23:00"), at(11, "01:00"));
    expect(daySegments([night], "2026-11-10")).toMatchObject([{ startMin: 23 * 60, endMin: 24 * 60, continuesAfter: true, continuesBefore: false }]);
    expect(daySegments([night], "2026-11-11")).toMatchObject([{ startMin: 0, endMin: 60, continuesBefore: true, continuesAfter: false }]);
    expect(daySegments([night], "2026-11-12")).toEqual([]);
    // O que termina à meia-noite em ponto não entra no dia seguinte.
    expect(daySegments([ev(2, at(10, "22:00"), at(11, "00:00"))], "2026-11-11")).toEqual([]);
  });

  it("sobreposição divide a largura em faixas; grupos separados não se misturam", () => {
    const segments = daySegments(
      [ev(1, at(10, "09:00"), at(10, "11:00")), ev(2, at(10, "10:00"), at(10, "12:00")), ev(3, at(10, "10:30"), at(10, "11:30")), ev(4, at(10, "14:00"), at(10, "15:00"))],
      "2026-11-10",
    );
    const laid = layoutLanes(segments);
    expect(laid.map((item) => [item.event.id, item.lane, item.lanes])).toEqual([
      ["G-0001", 0, 3],
      ["G-0002", 1, 3],
      ["G-0003", 2, 3],
      ["G-0004", 0, 1],
    ]);
    // Uma faixa livre é reaproveitada.
    const reuse = layoutLanes(daySegments([ev(5, at(10, "09:00"), at(10, "10:00")), ev(6, at(10, "09:30"), at(10, "11:00")), ev(7, at(10, "10:15"), at(10, "10:45"))], "2026-11-10"));
    expect(reuse.map((item) => item.lane)).toEqual([0, 1, 0]);
  });
});

describe("disponibilidade na grade", () => {
  it("faixas do dia em minutos; sábado vazio; exceção troca a janela", () => {
    const availability = availabilitySchema.parse({ exceptions: [{ date: "2026-11-12", from: "13:00", to: "15:00" }] });
    expect(availabilityBands(availability, "2026-11-10")).toEqual([{ from: 9 * 60, to: 18 * 60 }]);
    expect(availabilityBands(availability, "2026-11-14")).toEqual([]);
    expect(availabilityBands(availability, "2026-11-12")).toEqual([{ from: 13 * 60, to: 15 * 60 }]);
  });

  it("horas visíveis: padrão 7h-21h, ampliado pelo que houver, sem virar 24h por uma janela inteira", () => {
    expect(visibleHours([], [])).toEqual({ from: 7, to: 21 });
    expect(visibleHours([5 * 60 + 30, 22 * 60], [])).toEqual({ from: 5, to: 22 });
    expect(visibleHours([], [{ from: 6 * 60, to: 23 * 60 }])).toEqual({ from: 6, to: 23 });
    expect(visibleHours([], [{ from: 0, to: 24 * 60 }])).toEqual({ from: 7, to: 21 });
  });
});

describe("camadas, filtro e próximos", () => {
  const data = {
    events: [ev(1, at(10, "10:00"), at(10, "11:00"), { workspace: "a" }), ev(2, at(10, "12:00"), at(10, "13:00"), { workspace: "b" }), ev(3, at(10, "14:00"), at(10, "15:00"), { status: "cancelado" })],
    posts: [
      { id: "p1", workspace: "a", workspaceName: "A", title: "Post", date: "2026-11-10", done: false },
      { id: "p2", workspace: "b", workspaceName: "B", title: "Post B", date: "2026-11-10", done: false },
    ],
    routines: [{ routineId: "R-1", workspace: "a", workspaceName: "A", title: "Convites", at: at(10, "09:00") }],
  };

  it("filtra por workspace e liga/desliga camadas; cancelados não aparecem", () => {
    expect(applyView(data, { workspace: null, layers: DEFAULT_LAYERS }).events.map((event) => event.id)).toEqual(["G-0001", "G-0002"]);
    expect(applyView(data, { workspace: "a", layers: DEFAULT_LAYERS })).toMatchObject({ events: [{ id: "G-0001" }], posts: [{ id: "p1" }], routines: [] });
    expect(applyView(data, { workspace: null, layers: { mine: false, posts: true, routines: true } })).toMatchObject({ events: [], posts: [{}, {}], routines: [{}] });
  });

  it("próximos: só marcados que não terminaram, em ordem, com limite", () => {
    const now = new Date(at(10, "10:30"));
    expect(upcomingEvents(data.events, now, 5).map((event) => event.id)).toEqual(["G-0001", "G-0002"]);
    expect(upcomingEvents(data.events, now, 1).map((event) => event.id)).toEqual(["G-0001"]);
    expect(upcomingEvents(data.events, new Date(at(10, "11:30")), 5).map((event) => event.id)).toEqual(["G-0002"]);
  });

  it("cor do workspace é estável e foge do âmbar do Cyno", () => {
    expect(workspaceHue("linkedin")).toBe(workspaceHue("linkedin"));
    for (const id of ["a", "b", "linkedin", "design", "youtube", "principal"]) {
      const hue = workspaceHue(id);
      expect(hue >= 30 && hue <= 60).toBe(false);
    }
  });
});
