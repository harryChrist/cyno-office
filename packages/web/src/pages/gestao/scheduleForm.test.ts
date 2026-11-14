import { scheduleInputSchema, type RoutineSchedule } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { daysPhrase, emptySchedule, scheduleToForm, scheduleToInput, schedulePreview, shortLabel, timesText, validateSchedule } from "./scheduleForm";

describe("texto dos horários", () => {
  it("dias e horas por extenso", () => {
    expect(daysPhrase({ mode: "todo_dia", weekdays: [], monthDay: "1" })).toBe("todo dia");
    expect(daysPhrase({ mode: "uteis", weekdays: [], monthDay: "1" })).toBe("todo dia útil");
    expect(daysPhrase({ mode: "semana", weekdays: [5, 2, 4], monthDay: "1" })).toBe("toda terça, quinta e sexta");
    expect(daysPhrase({ mode: "semana", weekdays: [6, 7], monthDay: "1" })).toBe("todo sábado e domingo");
    expect(daysPhrase({ mode: "semana", weekdays: [3], monthDay: "1" })).toBe("toda quarta");
    expect(daysPhrase({ mode: "semana", weekdays: [], monthDay: "1" })).toBe("(escolha os dias)");
    expect(daysPhrase({ mode: "mes", weekdays: [], monthDay: "5" })).toBe("no dia 5 de cada mês");
    expect(timesText(["18:00", "09:00", "13:30", "", "xx"])).toBe("9h, 13h30 e 18h");
    expect(timesText(["09:00"])).toBe("9h");
  });

  it("prévia do que o horário vai fazer", () => {
    const schedule = emptySchedule({ mode: "uteis", times: ["09:00", "13:00", "18:00"], action: "Olhar posts novos e preparar comentários." });
    expect(schedulePreview(schedule, "o ECO")).toBe("Todo dia útil às 9h, 13h e 18h, o ECO vai olhar posts novos e preparar comentários.");
    expect(schedulePreview(emptySchedule({ mode: "mes", monthDay: "1", times: ["08:00"], action: "Montar o relatório", scope: "itens_vencidos" }), "o time Conteúdo")).toBe("No dia 1 de cada mês às 8h, o time Conteúdo vai montar o relatório (só roda se houver item para conferir).");
    expect(schedulePreview(emptySchedule({ times: [""], action: "" }), "o ECO")).toBe("Todo dia útil às (escolha as horas), o ECO vai ….");
  });

  it("nome do horário a partir da ação", () => {
    expect(shortLabel("olhar posts novos e preparar comentários")).toBe("Olhar posts novos");
    expect(shortLabel("Buscar pessoas para conexão")).toBe("Buscar pessoas");
    expect(shortLabel("Confira o ritmo da meta")).toBe("Confira o ritmo");
    expect(shortLabel("  ")).toBe("");
    expect(scheduleToInput(emptySchedule({ action: "Buscar pessoas para conexão" })).label).toBe("Buscar pessoas");
  });
});

describe("validação do horário (regras do shared)", () => {
  it("campos obrigatórios e dias", () => {
    expect(validateSchedule(emptySchedule({ action: " " }))).toEqual({ action: "Diga o que fazer neste horário." });
    expect(validateSchedule(emptySchedule({ action: "x", times: ["", " "] }))).toEqual({ times: "Informe pelo menos uma hora." });
    expect(validateSchedule(emptySchedule({ action: "x", times: ["25:00"] }))).toEqual({ times: "Use horas válidas, como 09:00." });
    expect(validateSchedule(emptySchedule({ action: "x", mode: "semana", weekdays: [] }))).toEqual({ days: "Marque pelo menos um dia da semana." });
    expect(validateSchedule(emptySchedule({ action: "x", mode: "mes", monthDay: "32" }))).toEqual({ days: "O dia do mês vai de 1 a 31." });
    expect(validateSchedule(emptySchedule({ action: "x", mode: "mes", monthDay: "31", times: ["08:00"] }))).toEqual({});
    expect(validateSchedule(emptySchedule({ action: "x", agent: "Eco" }))).toMatchObject({ agent: expect.any(String) });
  });

  it("o corpo passa no zod do shared, com horas em ordem e sem repetição", () => {
    const input = scheduleToInput(emptySchedule({ action: "Ler e-mails", mode: "semana", weekdays: [5, 2], times: ["18:00", "08:00", "18:00", ""], scope: "itens_vencidos", agent: "linkedin/eco" }));
    const parsed = scheduleInputSchema.parse(input);
    expect(parsed).toMatchObject({ days: { kind: "semana", weekdays: [2, 5] }, times: ["08:00", "18:00"], scope: "itens_vencidos", agent: "linkedin/eco", enabled: true });
  });

  it("ida e volta de um horário existente mantém o id e o gatilho", () => {
    const schedule: RoutineSchedule = { id: "S2", label: "Post", days: { kind: "semana", weekdays: [3] }, times: ["09:00"], action: "Montar o post", enabled: false, scope: "geral" };
    const form = scheduleToForm(schedule);
    expect(form).toMatchObject({ id: "S2", mode: "semana", weekdays: [3], enabled: false });
    expect(scheduleToInput(form)).toMatchObject({ id: "S2", label: "Post", enabled: false, days: { kind: "semana", weekdays: [3] } });
  });
});
