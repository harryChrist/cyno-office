import { agendaEventSchema } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { emptyAgendaForm, eventToAgendaForm, slotOf, toCreateBody, toUpdateBody, validateAgendaForm } from "./agendaForm";

const event = agendaEventSchema.parse({ id: "G-0001", title: "Reunião", start: "2026-11-12T20:00:00.000Z", end: "2026-11-12T21:00:00.000Z", kind: "reuniao", createdAt: "2026-11-01T00:00:00.000Z", link: "https://meet.example/x" });

describe("formulário do compromisso", () => {
  it("novo compromisso começa no horário pedido com a duração padrão", () => {
    expect(emptyAgendaForm("2026-11-12", 17 * 60, 90)).toMatchObject({ date: "2026-11-12", start: "17:00", end: "18:30", kind: "reuniao", workspace: "" });
    expect(emptyAgendaForm("2026-11-12", 23 * 60 + 30, 90).end).toBe("23:59");
  });

  it("evento -> formulário usa o dia e as horas de São Paulo; criar converte de volta para ISO", () => {
    const form = eventToAgendaForm(event);
    expect(form).toMatchObject({ date: "2026-11-12", start: "17:00", end: "18:00", link: "https://meet.example/x" });
    expect(slotOf(form)).toEqual({ start: "2026-11-12T20:00:00.000Z", end: "2026-11-12T21:00:00.000Z" });
    expect(toCreateBody({ ...form, title: "  Nova  ", workspace: "linkedin", notes: "" }, true)).toEqual({
      title: "Nova",
      start: "2026-11-12T20:00:00.000Z",
      end: "2026-11-12T21:00:00.000Z",
      kind: "reuniao",
      workspace: "linkedin",
      link: "https://meet.example/x",
      override: true,
    });
  });

  it("valida título, horas e ordem", () => {
    const form = { ...emptyAgendaForm("2026-11-12"), title: "" };
    expect(validateAgendaForm(form)).toEqual({ title: "Dê um título ao compromisso." });
    expect(validateAgendaForm({ ...form, title: "x", start: "10:00", end: "09:00" })).toEqual({ end: "O fim precisa ser depois do início." });
    expect(validateAgendaForm({ ...form, title: "x", date: "", start: "" })).toMatchObject({ date: "Escolha o dia.", start: "Escolha a hora de início." });
    expect(slotOf({ date: "2026-11-12", start: "10:00", end: "09:00" })).toBeNull();
  });

  it("editar manda só o que mudou; o horário só vai se mudou (e `override` só com horário)", () => {
    const form = eventToAgendaForm(event);
    expect(toUpdateBody(form, event, true)).toEqual({});
    expect(toUpdateBody({ ...form, title: "Outra", notes: "pauta" }, event, true)).toEqual({ title: "Outra", notes: "pauta" });
    expect(toUpdateBody({ ...form, link: "" }, event, false)).toEqual({ link: null });
    expect(toUpdateBody({ ...form, start: "18:00", end: "19:00" }, event, false)).toEqual({ start: "2026-11-12T21:00:00.000Z", end: "2026-11-12T22:00:00.000Z" });
    expect(toUpdateBody({ ...form, date: "2026-11-13" }, event, true)).toMatchObject({ start: "2026-11-13T20:00:00.000Z", override: true });
  });
});
