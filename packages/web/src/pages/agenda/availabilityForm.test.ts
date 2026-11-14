import { availabilitySchema } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { availabilityToForm, describeAvailability, hasAvailabilityErrors, toAvailability, validateAvailabilityForm } from "./availabilityForm";

const base = availabilitySchema.parse({});

describe("formulário da disponibilidade", () => {
  it("vai e volta sem perder nada (janelas, exceções, números e fuso)", () => {
    const original = availabilitySchema.parse({
      weekly: [
        { weekday: 1, from: "14:00", to: "18:00" },
        { weekday: 1, from: "09:00", to: "12:00" },
        { weekday: 6, from: "10:00", to: "24:00" },
      ],
      exceptions: [
        { date: "2026-12-25", off: true, note: "Natal" },
        { date: "2026-11-14", from: "10:00", to: "12:00" },
      ],
      bufferMinutes: 30,
      minNoticeMinutes: 120,
      defaultDurationMinutes: 45,
    });
    const form = availabilityToForm(original);
    expect(form.days[1]).toEqual([
      { from: "09:00", to: "12:00" },
      { from: "14:00", to: "18:00" },
    ]);
    expect(form.exceptions.map((exception) => exception.date)).toEqual(["2026-11-14", "2026-12-25"]);
    expect(hasAvailabilityErrors(validateAvailabilityForm(form))).toBe(false);
    const back = toAvailability(form, original);
    expect(back).toMatchObject({ bufferMinutes: 30, minNoticeMinutes: 120, defaultDurationMinutes: 45, timezone: "America/Sao_Paulo" });
    expect(back.weekly).toEqual([
      { weekday: 1, from: "09:00", to: "12:00" },
      { weekday: 1, from: "14:00", to: "18:00" },
      { weekday: 6, from: "10:00", to: "24:00" },
    ]);
    expect(back.exceptions).toEqual([
      { date: "2026-11-14", from: "10:00", to: "12:00" },
      { date: "2026-12-25", off: true, note: "Natal" },
    ]);
    expect(availabilitySchema.parse(back)).toEqual(back);
  });

  it("confere janelas, sobreposição, exceções repetidas e números", () => {
    const form = availabilityToForm(base);
    form.days[1] = [
      { from: "09:00", to: "12:00" },
      { from: "11:00", to: "13:00" },
    ];
    form.days[2] = [{ from: "10:00", to: "09:00" }];
    form.exceptions = [
      { date: "2026-11-14", mode: "off", from: "", to: "", note: "" },
      { date: "2026-11-14", mode: "off", from: "", to: "", note: "" },
      { date: "", mode: "off", from: "", to: "", note: "" },
      { date: "2026-11-20", mode: "window", from: "12:00", to: "10:00", note: "" },
    ];
    form.bufferMinutes = "200";
    form.defaultDurationMinutes = "";
    const errors = validateAvailabilityForm(form);
    expect(errors.days).toEqual({ 1: "As janelas do mesmo dia não podem se sobrepor.", 2: "Cada janela precisa começar antes de terminar." });
    expect(Object.keys(errors.exceptions)).toEqual(["1", "2", "3"]);
    expect(Object.keys(errors.numbers).sort()).toEqual(["bufferMinutes", "defaultDurationMinutes"]);
    expect(hasAvailabilityErrors(errors)).toBe(true);
  });

  it("descreve o padrão em uma frase", () => {
    expect(describeAvailability(base)).toBe("Seg a sex, 9h às 18h");
    expect(describeAvailability({ ...base, weekly: [] })).toBe("Nenhum horário disponível definido");
    expect(
      describeAvailability({
        ...base,
        weekly: [
          { weekday: 1, from: "09:00", to: "12:00" },
          { weekday: 1, from: "14:00", to: "18:00" },
          { weekday: 6, from: "10:00", to: "12:00" },
        ],
      }),
    ).toBe("Seg, 9h às 12h e 14h às 18h · Sáb, 10h às 12h");
  });
});
