import { describe, expect, it } from "vitest";
import { routineNoticeOf } from "./notices";

describe("avisos do sino de uma rotina de acompanhamento", () => {
  const base = { id: "a1", at: "2026-11-11T12:00:00.000Z", category: "rotina", summary: "Inscrições: 2 novos; Acme → Entrevista" };

  it("execução com mudanças, alerta e item expirado viram aviso; o resto da Atividade não", () => {
    expect(routineNoticeOf({ ...base, action: "mudou" })).toEqual({ key: "rotina:a1", text: base.summary, at: base.at, target: "gestao" });
    expect(routineNoticeOf({ ...base, action: "alerta" })).toMatchObject({ alert: true, target: "gestao" });
    expect(routineNoticeOf({ ...base, action: "expirou" })).toMatchObject({ target: "gestao" });
    expect(routineNoticeOf({ ...base, action: "executada" })).toBeUndefined();
    expect(routineNoticeOf({ ...base, category: "tarefa", action: "mudou" })).toBeUndefined();
  });
});
