import { describe, expect, it } from "vitest";
import {
  calendarEventSchema,
  compareCalendarEvents,
  createCalendarEventBodySchema,
  isCalendarDate,
  isCalendarTime,
  listCalendarQuerySchema,
  updateCalendarEventBodySchema,
} from "./calendar";
import type { CalendarEvent } from "./types";

const base: CalendarEvent = {
  id: "a1",
  title: "Revisar posts",
  date: "2026-11-07",
  done: false,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
};

describe("datas e horas do calendário", () => {
  it("aceita só dias que existem", () => {
    expect(isCalendarDate("2026-11-07")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-00-10")).toBe(false);
    expect(isCalendarDate("2026-1-07")).toBe(false);
    expect(isCalendarDate("07/11/2026")).toBe(false);
  });

  it("aceita horas HH:MM de 00:00 a 23:59", () => {
    expect(isCalendarTime("00:00")).toBe(true);
    expect(isCalendarTime("23:59")).toBe(true);
    expect(isCalendarTime("24:00")).toBe(false);
    expect(isCalendarTime("9:00")).toBe(false);
    expect(isCalendarTime("12:60")).toBe(false);
  });
});

describe("schemas do calendário", () => {
  it("aceita um evento completo e um mínimo", () => {
    expect(calendarEventSchema.parse(base)).toEqual(base);
    const full = { ...base, time: "09:00", endTime: "10:30", roomId: "projetox", notes: "levar café" };
    expect(calendarEventSchema.parse(full)).toEqual(full);
  });

  it("valida título, data e campos extras na criação, com mensagens em pt-BR", () => {
    const empty = createCalendarEventBodySchema.safeParse({ title: "   ", date: "2026-02-30" });
    expect(empty.success).toBe(false);
    const messages = empty.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    expect(messages).toContain("title: o título não pode ficar vazio");
    expect(messages?.some((m) => m.startsWith("date: data inválida"))).toBe(true);
    expect(createCalendarEventBodySchema.safeParse({ title: "x".repeat(201), date: "2026-11-07" }).success).toBe(false);
    expect(createCalendarEventBodySchema.safeParse({ title: "x".repeat(200), date: "2026-11-07" }).success).toBe(true);
    expect(createCalendarEventBodySchema.safeParse({ title: "x", date: "2026-11-07", id: "hack" }).success).toBe(false);
  });

  it("confere o término: precisa de início e não pode ser antes dele", () => {
    const noStart = createCalendarEventBodySchema.safeParse({ title: "x", date: "2026-11-07", endTime: "10:00" });
    expect(noStart.error?.issues[0]).toMatchObject({ path: ["endTime"], message: "o horário de término precisa de um horário de início" });
    const before = createCalendarEventBodySchema.safeParse({ title: "x", date: "2026-11-07", time: "10:00", endTime: "09:00" });
    expect(before.error?.issues[0]?.message).toBe("o horário de término não pode ser antes do início");
  });

  it("PATCH aceita null para apagar campos opcionais, mas não para título e data", () => {
    expect(updateCalendarEventBodySchema.safeParse({ time: null, roomId: null, notes: null }).success).toBe(true);
    expect(updateCalendarEventBodySchema.safeParse({ title: null }).success).toBe(false);
    expect(updateCalendarEventBodySchema.safeParse({ date: null }).success).toBe(false);
  });

  it("período da listagem: o fim não pode ser antes do início", () => {
    expect(listCalendarQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-30" }).success).toBe(true);
    expect(listCalendarQuerySchema.safeParse({ from: "2026-11-30", to: "2026-11-01" }).success).toBe(false);
    expect(listCalendarQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe("compareCalendarEvents", () => {
  it("ordena por dia, depois o dia todo primeiro, depois a hora e o título", () => {
    const events: CalendarEvent[] = [
      { ...base, id: "c", date: "2026-11-08", title: "Amanhã" },
      { ...base, id: "b", time: "14:00", title: "Tarde" },
      { ...base, id: "a", time: "09:00", title: "Manhã" },
      { ...base, id: "d", title: "Dia todo" },
    ];
    expect(events.sort(compareCalendarEvents).map((event) => event.id)).toEqual(["d", "a", "b", "c"]);
  });
});
