import type { RoutineProposalSchedule, RoutineProposalView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { diffViews, goalDetails, goalLine, lifespanText, proposalMode, suggestedModeText, whenText, whoText } from "./routineProposal";

const sched = (patch: Partial<RoutineProposalSchedule> = {}): RoutineProposalSchedule => ({ id: "S1", label: "Posts", days: { kind: "uteis" }, times: ["09:00", "13:00", "18:00"], action: "Olhe posts", enabled: true, ...patch });
const view = (schedules: RoutineProposalSchedule[], patch: Partial<RoutineProposalView> = {}): RoutineProposalView => ({ title: "R", type: "meta", owner: "Eco", schedules, ...patch });

describe("cartão de proposta de rotina", () => {
  it("textos: horário, agente, meta, vida do item e modo sugerido", () => {
    expect(whenText(sched())).toBe("Dias úteis · 9h, 13h, 18h");
    expect(whoText(sched(), "Eco")).toBe("Eco");
    expect(whoText(sched({ agent: "lab/lia", agentName: "Lia" }), "Eco")).toBe("Lia");
    expect(goalLine({ target: 2, period: "week", stopOnHit: true, prepareFactor: 1 }, "post")).toBe("2 posts por semana");
    expect(goalDetails({ target: 2, period: "week", preferredDays: [2, 4], stopOnHit: true, prepareFactor: 2 })).toEqual(["De preferência: terça, quinta", "Para ao bater a meta, até o próximo período", "Prepara 2x mais opções para você escolher"]);
    expect(lifespanText({ fields: [], statuses: [{ name: "A" }], lifespan: { days: 15, untilTerminal: true }, expireStatus: "Sem resposta", checkEveryHours: 24 })).toBe("15 dias ou até um status final · ao expirar vira “Sem resposta” · conferido a cada 24 h");
    expect(suggestedModeText({ actions: ["comentario"], sites: ["linkedin.com"], dailyCap: 4 })).toEqual(["Decide sozinho: comentario", "Só em: linkedin.com", "Teto de 4 por dia, somando todas as execuções da rotina"]);
    expect(proposalMode({ mode: "alterar" })).toBe("alterar");
    expect(proposalMode({ mode: "x" })).toBe("criar");
  });

  it("antes e depois: horário mudado, novo e removido", () => {
    const before = view([sched(), sched({ id: "S2", label: "Conexões" })]);
    const after = view([sched({ times: ["08:00", "13:00", "18:00"] }), sched({ id: "S3", label: "Sexta" })], { owner: "Lia" });
    const diff = diffViews(before, after);
    expect(diff.schedules.map((row) => row.status)).toEqual(["mudou", "novo"]);
    expect(diff.schedules[0]!.before!.times[0]).toBe("09:00");
    expect(diff.removed.map((row) => row.id)).toEqual(["S2"]);
    expect(diff.notes).toEqual(["Dono: Eco → Lia"]);
    expect(diffViews(undefined, after).schedules.every((row) => row.status === "igual")).toBe(true);
  });
});
