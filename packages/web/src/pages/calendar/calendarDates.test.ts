import type { CalendarEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  addDays,
  buildMonthGrid,
  dayPreview,
  formatDayLabel,
  formatEventTime,
  formatLongDate,
  formatMonthTitle,
  fromDateKey,
  gridRange,
  groupByDay,
  monthOf,
  moveFocus,
  pageRange,
  shiftMonth,
  toDateKey,
  upcomingDays,
} from "./calendarDates";

let seq = 0;
function makeEvent(date: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  seq += 1;
  return { id: `e${seq}`, title: `Evento ${seq}`, date, done: false, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", ...extra };
}

describe("datas no fuso local", () => {
  it("converte entre Date e chave AAAA-MM-DD", () => {
    expect(toDateKey(new Date(2026, 10, 7, 23, 59))).toBe("2026-11-07");
    expect(toDateKey(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
    const date = fromDateKey("2026-11-07");
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 10, 7]);
  });

  it("soma dias atravessando meses e anos", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-11-07", 13)).toBe("2026-11-20");
  });

  it("anda de mês em mês", () => {
    expect(monthOf("2026-11-07")).toEqual({ year: 2026, month: 10 });
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe("buildMonthGrid", () => {
  it("monta semanas de domingo a sábado cobrindo o mês todo", () => {
    // Novembro de 2026: dia 1 é domingo, dia 30 é segunda.
    const grid = buildMonthGrid({ year: 2026, month: 10 }, "2026-11-07");
    expect(grid).toHaveLength(5);
    for (const week of grid) {
      expect(week).toHaveLength(7);
      expect(week.map((day) => day.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(fromDateKey(week[0]!.key).getDay()).toBe(0);
    }
    expect(gridRange(grid)).toEqual({ from: "2026-11-01", to: "2026-12-05" });
    const days = grid.flat();
    expect(days.filter((day) => day.inMonth)).toHaveLength(30);
    expect(days.filter((day) => day.isToday).map((day) => day.key)).toEqual(["2026-11-07"]);
    expect(days.at(-1)).toMatchObject({ key: "2026-12-05", day: 5, inMonth: false });
  });

  it("completa a primeira semana com o mês anterior e usa 6 semanas quando precisa", () => {
    // Agosto de 2026: dia 1 é sábado, então a grade começa em 26/07 e tem 6 semanas.
    const grid = buildMonthGrid({ year: 2026, month: 7 }, "2026-11-07");
    expect(grid).toHaveLength(6);
    expect(grid[0]![0]).toMatchObject({ key: "2026-07-26", inMonth: false });
    expect(grid[0]![6]).toMatchObject({ key: "2026-08-01", day: 1, inMonth: true });
    expect(grid.flat().some((day) => day.isToday)).toBe(false);
  });

  it("fevereiro que começa no domingo cabe em 4 semanas", () => {
    expect(buildMonthGrid({ year: 2026, month: 1 }, "2026-11-07")).toHaveLength(4);
  });
});

describe("períodos", () => {
  it("o load cobre a grade e os próximos 14 dias", () => {
    // Hoje no fim do mês: os próximos dias passam do fim da grade.
    expect(pageRange({ year: 2026, month: 10 }, "2026-11-28")).toEqual({ from: "2026-11-01", to: "2026-12-11" });
    // Olhando um mês passado: vai da grade até hoje + 13.
    expect(pageRange({ year: 2026, month: 8 }, "2026-11-07")).toEqual({ from: "2026-08-30", to: "2026-11-20" });
  });
});

describe("agrupar por dia", () => {
  it("agrupa e ordena: dia todo primeiro, depois por hora", () => {
    const late = makeEvent("2026-11-07", { time: "15:00" });
    const allDay = makeEvent("2026-11-07");
    const early = makeEvent("2026-11-07", { time: "08:00" });
    const other = makeEvent("2026-11-09");
    const byDay = groupByDay([late, other, allDay, early]);
    expect([...byDay.keys()]).toEqual(["2026-11-07", "2026-11-09"]);
    expect(byDay.get("2026-11-07")?.map((event) => event.id)).toEqual([allDay.id, early.id, late.id]);
  });

  it("a célula mostra até 3 e conta o resto", () => {
    const events = Array.from({ length: 5 }, () => makeEvent("2026-11-07"));
    expect(dayPreview(events)).toEqual({ shown: events.slice(0, 3), hidden: 2 });
    expect(dayPreview(events.slice(0, 3)).hidden).toBe(0);
  });

  it("próximos: de hoje até 13 dias depois, só os dias com eventos", () => {
    const yesterday = makeEvent("2026-11-06");
    const today = makeEvent("2026-11-07", { time: "10:00" });
    const last = makeEvent("2026-11-20");
    const tooFar = makeEvent("2026-11-21");
    const days = upcomingDays([tooFar, last, today, yesterday], "2026-11-07");
    expect(days.map((day) => day.key)).toEqual(["2026-11-07", "2026-11-20"]);
    expect(days[0]?.events).toEqual([today]);
  });
});

describe("formatos em pt-BR", () => {
  it("títulos e rótulos", () => {
    expect(formatMonthTitle({ year: 2026, month: 10 })).toBe("Novembro de 2026");
    expect(formatMonthTitle({ year: 2027, month: 2 })).toBe("Março de 2027");
    expect(formatLongDate("2026-11-07")).toBe("sábado, 7 de novembro de 2026");
    expect(formatDayLabel("2026-11-07", "2026-11-07")).toBe("Hoje");
    expect(formatDayLabel("2026-11-08", "2026-11-07")).toBe("Amanhã");
    expect(formatDayLabel("2026-11-09", "2026-11-07")).toBe("seg., 9 de novembro");
  });

  it("horário do evento", () => {
    expect(formatEventTime({})).toBe("Dia todo");
    expect(formatEventTime({ time: "09:00" })).toBe("09:00");
    expect(formatEventTime({ time: "09:00", endTime: "10:30" })).toBe("09:00–10:30");
  });
});

describe("moveFocus (teclado na grade)", () => {
  it("setas andam um dia ou uma semana; Home/End vão às pontas da semana", () => {
    expect(moveFocus("2026-11-07", "ArrowLeft")).toBe("2026-11-06");
    expect(moveFocus("2026-11-30", "ArrowRight")).toBe("2026-12-01");
    expect(moveFocus("2026-11-07", "ArrowUp")).toBe("2026-10-31");
    expect(moveFocus("2026-11-07", "ArrowDown")).toBe("2026-11-14");
    expect(moveFocus("2026-11-04", "Home")).toBe("2026-11-01");
    expect(moveFocus("2026-11-04", "End")).toBe("2026-11-07");
    expect(moveFocus("2026-11-04", "a")).toBeNull();
  });
});
