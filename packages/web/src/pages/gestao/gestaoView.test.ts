import type { GoalVerdict, ManagementSummary, RoutineEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  PACE_VIEW,
  ageLabel,
  approvalView,
  costText,
  daysLeftLabel,
  expectedPct,
  groupEntriesByWeek,
  nextDispatchText,
  parseWhole,
  progressSplit,
  progressText,
  metaSummary,
  projectionView,
  statsText,
  weekLabel,
  runView,
  scheduleLine,
  slotLabel,
  trackingText,
  expiryText,
  proposalModeOf,
  PROPOSAL_ROW_LABELS,
  pendingChangeProposals,
  quotaBars,
  targetWarning,
  troubleParts,
  verdictSentence,
  waitingParts,
} from "./gestaoView";

const goals = (patch: Partial<GoalVerdict>): GoalVerdict => ({ total: 0, onTrack: 0, ahead: 0, behind: 0, paused: 0, done: 0, ...patch });

describe("ritmo", () => {
  it("cada ritmo tem rótulo, cor e ícone próprios", () => {
    expect(PACE_VIEW.no_ritmo).toMatchObject({ label: "No ritmo", tone: "ok" });
    expect(PACE_VIEW.adiantada.label).toBe("Adiantada");
    expect(PACE_VIEW.atrasada).toMatchObject({ label: "Atrasada", tone: "danger", icon: "alert" });
    expect(PACE_VIEW.pausada.tone).toBe("muted");
    expect(PACE_VIEW.concluida.label).toBe("Batida");
    expect(new Set(Object.values(PACE_VIEW).map((view) => view.icon)).size).toBe(5);
  });

  it("a barra separa entregue de registrado e nunca passa de 100%", () => {
    expect(progressSplit(3, 2, 10)).toEqual({ deliveredPct: 30, registeredPct: 20 });
    expect(progressSplit(8, 5, 10)).toEqual({ deliveredPct: 80, registeredPct: 20 });
    expect(progressSplit(12, 3, 10)).toEqual({ deliveredPct: 100, registeredPct: 0 });
    expect(progressSplit(0, 0, 0)).toEqual({ deliveredPct: 0, registeredPct: 0 });
    expect(expectedPct(5, 10)).toBe(50);
    expect(expectedPct(20, 10)).toBe(100);
  });

  it("textos de prazo e progresso", () => {
    expect(daysLeftLabel(4)).toBe("faltam 4 dias");
    expect(daysLeftLabel(1)).toBe("falta 1 dia");
    expect(daysLeftLabel(0)).toBe("termina hoje");
    expect(progressText({ delivered: 3, daysLeft: 4, expected: 5, routine: { target: 10 } })).toBe("3 de 10 entregues · faltam 4 dias · esperado até agora: 5");
  });
});

describe("veredito e resumo", () => {
  it("frase do veredito", () => {
    expect(verdictSentence(goals({ total: 3, onTrack: 2, ahead: 1 }))).toEqual({ text: "Você está no ritmo: 3 de 3 metas em dia", tone: "ok" });
    expect(verdictSentence(goals({ total: 3, onTrack: 2, behind: 1 }))).toEqual({ text: "Atenção: 1 meta atrasada", tone: "warn" });
    expect(verdictSentence(goals({ total: 4, behind: 2, onTrack: 2 })).text).toBe("Atenção: 2 metas atrasadas");
    expect(verdictSentence(goals({ total: 2, paused: 2 })).tone).toBe("muted");
    expect(verdictSentence(goals({ total: 3, onTrack: 1, done: 1, paused: 1 })).text).toBe("Você está no ritmo: 2 de 2 metas em dia");
    expect(verdictSentence(goals({})).text).toBe("Nenhuma meta ativa ainda");
    expect(verdictSentence(goals({}), 2).text).toBe("Sem metas ativas · 2 acompanhamentos ativos");
    expect(verdictSentence(goals({}), 1).text).toBe("Sem metas ativas · 1 acompanhamento ativo");
  });

  it("idades", () => {
    expect(ageLabel(20_000)).toBe("agora");
    expect(ageLabel(35 * 60_000)).toBe("há 35 min");
    expect(ageLabel(10 * 3_600_000)).toBe("há 10 h");
    expect(ageLabel(47 * 3_600_000)).toBe("há 47 h");
    expect(ageLabel(72 * 3_600_000)).toBe("há 3 dias");
  });

  it("esperando você", () => {
    const waiting = { count: 13, oldestAt: null, oldestAgeMs: 10 * 3_600_000, avgAgeMs: 0, olderThan24h: 5 };
    expect(waitingParts(waiting)).toEqual({ headline: "Esperando você: 13", details: ["a mais antiga há 10 h", "5 há mais de 24 h"] });
    expect(waitingParts({ ...waiting, olderThan24h: 0 }).details).toEqual(["a mais antiga há 10 h"]);
    expect(waitingParts({ ...waiting, count: 0 }).details).toEqual([]);
  });

  it("tarefas com problema e cota", () => {
    const brief = { id: "T-1", title: "x", status: "failed", updatedAt: "" };
    const tasks: ManagementSummary["tasks"] = { failedToday: [brief, brief], waitingApproval: [], blockedByEngine: [brief] };
    expect(troubleParts(tasks)).toEqual({ failed: 2, blocked: 1, text: "2 falharam hoje · 1 parada sem cota" });
    expect(troubleParts({ ...tasks, failedToday: [], blockedByEngine: [] }).text).toBe("Nenhuma falha hoje");
    const quota: ManagementSummary["quota"] = [
      {
        provider: "claude",
        updatedAt: "",
        windows: [
          { id: "five_hour", utilization: 0.42 },
          { id: "seven_day", utilization: 0.97 },
          { id: "seven_day_opus", utilization: 0.1 },
        ],
      },
    ];
    expect(quotaBars(quota)).toEqual([
      { key: "claude:five_hour", label: "5 h", percent: 42, text: "42%", tone: "ok", old: false, renewed: false, ageLabel: "" },
      { key: "claude:seven_day", label: "Semana", percent: 97, text: "97%", tone: "danger", old: false, renewed: false, ageLabel: "" },
    ]);
    // Leitura de 42 min: esmaecida, com a idade e sem cor de alerta; janela que já renovou: "renovada" e traço.
    const now = Date.parse("2026-11-08T12:00:00Z");
    const aged: ManagementSummary["quota"] = [
      {
        provider: "claude",
        updatedAt: "2026-11-08T11:18:00.000Z",
        windows: [
          { id: "five_hour", utilization: 0.9, resetsAt: "2026-11-08T11:30:00.000Z" },
          { id: "seven_day", utilization: 0.9, resetsAt: "2026-11-11T12:00:00.000Z" },
        ],
      },
    ];
    expect(quotaBars(aged, now)).toMatchObject([
      { percent: null, text: "renovada", renewed: true, tone: "ok" },
      { percent: 90, tone: "ok", old: true, ageLabel: "há 42 min" },
    ]);
    const both = [...quota, { provider: "gemini", updatedAt: quota[0]!.updatedAt, windows: [{ id: "five_hour", utilization: 0 }] }] as typeof quota;
    expect(quotaBars(both).map((bar) => bar.label)).toEqual(["Claude · 5 h", "Claude · Semana", "Antigravity · 5 h"]);
  });
});

describe("cartão", () => {
  it("OK ou age sozinho, com a lista do tipo na dica", () => {
    expect(approvalView({ needsApproval: true, kind: "invite" }).label).toBe("Precisa do meu OK");
    const auto = approvalView({ needsApproval: false, kind: "comment" });
    expect(auto.label).toBe("Automático");
    expect(auto.hint).toContain("comentar");
    expect(auto.hint).toContain("até 8 por dia");
    expect(approvalView({ needsApproval: false, kind: "other" }).hint).toContain("tudo pede OK");
  });

  it("próxima cobrança, custo e avisos de limite", () => {
    expect(nextDispatchText({ state: "aguardando", reason: "limite diário atingido" })).toBe("Aguardando · limite diário atingido");
    expect(nextDispatchText({ state: "agora", reason: "" })).toBe("Cobra agora");
    const cost = { periodUsd: 0.5, periodBrl: 3, perUnitUsd: 0.1, perUnitBrl: 0.6, totalUsd: 1, totalBrl: 6 };
    expect(costText(cost, "convite").replace(/\s/g, " ")).toBe("R$ 0,60 por convite · R$ 3,00 na semana");
    expect(costText({ ...cost, perUnitBrl: null }, "convite")).toContain("na semana");
    expect(targetWarning("invite", 80)).toContain("60");
    expect(targetWarning("invite", 10)).toBe("");
    expect(targetWarning("other", 5000)).toBe("");
  });

  it("agrupa os itens por semana, a mais nova primeiro", () => {
    const entry = (id: string, periodKey: string, at: string): RoutineEntry => ({ id, routineId: "R-0001", periodKey, url: "https://x.com/" + id, taskId: "T-1", agentId: "a", stage: "entregue", at });
    const groups = groupEntriesByWeek([entry("a", "2026-W45", "2026-11-04T10:00:00Z"), entry("b", "2026-W46", "2026-11-09T10:00:00Z"), entry("c", "2026-W46", "2026-11-10T10:00:00Z")]);
    expect(groups.map((group) => group.periodKey)).toEqual(["2026-W46", "2026-W45"]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["c", "b"]);
  });
});

describe("cartão do Para você", () => {
  it("modo e número", () => {
    expect(proposalModeOf({ mode: "criar" })).toBe("criar");
    expect(proposalModeOf({ mode: "ajustar" })).toBe("ajustar");
    expect(proposalModeOf({ mode: "revisar" })).toBe("revisar");
    expect(proposalModeOf({ mode: "alterar" })).toBe("alterar");
    expect(PROPOSAL_ROW_LABELS.alterar).toBe("Mudança em rotina");
    expect(proposalModeOf(undefined)).toBe("criar");
    expect(parseWhole(" 7 ", 60)).toBe(7);
    expect(parseWhole("90", 60)).toBe(60);
    expect(parseWhole("0", 60)).toBe(1);
    expect(parseWhole("abc", 60)).toBeNull();
    expect(parseWhole("", 60)).toBeNull();
  });
});

describe("horários e execuções", () => {
  it("linha do horário com dias, horas e o que faz", () => {
    expect(scheduleLine({ label: "E-mail", days: { kind: "uteis" }, times: ["09:00", "13:00", "18:00"], enabled: true })).toBe("Dias úteis · 9h, 13h, 18h → E-mail");
    expect(scheduleLine({ label: "Conferir", days: { kind: "semana", weekdays: [2, 4] }, times: ["10:30"], enabled: false })).toBe("Ter e qui · 10h30 → Conferir (desligado)");
    expect(scheduleLine({ label: "Gatilho", days: { kind: "todo_dia" }, times: [], enabled: true, trigger: { kind: "email_novo", connector: "gmail" } })).toBe("Quando chegar e-mail → Gatilho");
  });

  it("chave do horário vira dia/mês e hora", () => {
    expect(slotLabel("2026-11-11T09:00")).toBe("11/11 09:00");
    expect(slotLabel(undefined)).toBe("");
  });

  it("execução: texto e cor juntos", () => {
    expect(runView({ outcome: "rodando" })).toEqual({ label: "Rodando", tone: "info" });
    expect(runView({ outcome: "ok", summary: "2 novos" })).toEqual({ label: "Rodou: 2 novos", tone: "ok" });
    expect(runView({ outcome: "falhou" })).toEqual({ label: "Falhou", tone: "danger" });
    expect(runView({ outcome: "pulada", skipReason: "servidor desligado" })).toEqual({ label: "Pulada: servidor desligado", tone: "muted" });
  });
});

describe("Meta v2 no cartão", () => {
  const base = { delivered: 2, inFlight: 0, pending: 0, pace: "no_ritmo" as const, period: "week" as const, routine: { target: 5 } };

  it("linha do cartão: entregues, em preparo (aprovadas + opções esperando OK) e o ritmo", () => {
    expect(metaSummary({ ...base, inFlight: 1, pending: 2 })).toBe("2 de 5 esta semana · 3 em preparo · no ritmo");
    expect(metaSummary({ ...base, pace: "atrasada" })).toBe("2 de 5 esta semana · atrasada");
    expect(metaSummary({ ...base, delivered: 5, pace: "concluida", period: "month" })).toBe("5 de 5 este mês · batida");
  });

  it("estatística do período: some quando nada foi preparado", () => {
    expect(statsText({})).toBe("");
    expect(statsText({ prepared: 6, approved: 3, dismissed: 3 })).toBe("6 preparadas · 3 aprovadas · 3 dispensadas");
    expect(statsText({ prepared: 1, approved: 1, dismissed: 0 })).toBe("1 preparada · 1 aprovada · 0 dispensadas");
  });

  it("rótulo do período: semana ou mês", () => {
    expect(weekLabel("2026-W45")).toBe("semana 45");
    expect(weekLabel("2026-M11")).toBe("nov/2026");
  });
});

describe("itens acompanhados", () => {
  it("resumo do cartão", () => {
    expect(trackingText({ active: 0, ended: 0, stopped: 0, changedToday: 0, due: 0 })).toBe("Nenhum item acompanhado ainda");
    expect(trackingText({ active: 7, ended: 0, stopped: 0, changedToday: 2, due: 3 })).toBe("7 itens acompanhados · 2 mudaram hoje");
    expect(trackingText({ active: 1, ended: 1, stopped: 1, changedToday: 1, due: 0 })).toBe("1 item acompanhado · 1 mudou hoje · 2 encerrados");
    expect(trackingText({ active: 3, ended: 0, stopped: 0, changedToday: 0, due: 0 })).toBe("3 itens acompanhados · nada mudou hoje");
  });

  it("vence em", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(expiryText({ state: "ativo", expiresAt: "2026-11-14T12:00:00Z" }, now)).toBe("Vence em 3 dias");
    expect(expiryText({ state: "ativo", expiresAt: "2026-11-12T12:00:00Z" }, now)).toBe("Vence amanhã");
    expect(expiryText({ state: "ativo", expiresAt: "2026-11-11T12:00:00Z" }, now)).toBe("Vence hoje");
    expect(expiryText({ state: "ativo" }, now)).toBe("Sem fim");
    expect(expiryText({ state: "parado" }, now)).toBe("Parado por você");
    expect(expiryText({ state: "encerrado", endReason: "expirou" }, now)).toBe("Terminou o prazo");
  });
});

describe("avisos de ajuste pendente", () => {
  const item = (id: string, mode: string, status = "pendente") => ({ id, status, routineId: "R-0001", routine: { routineId: "R-0001", mode, title: "Post semanal" } }) as never;
  it("só os cartões alterar sem decisão", () => {
    const list = pendingChangeProposals([item("a", "alterar"), item("b", "criar"), item("c", "alterar", "aprovado")]);
    expect(list).toEqual([{ itemId: "a", routineId: "R-0001", title: "Post semanal", text: "Ajuste proposto pelo Maestro" }]);
    expect(pendingChangeProposals(null)).toEqual([]);
  });
});

describe("projeção no cartão da meta", () => {
  const projection = { routineId: "R1", title: "Conexões", period: "week" as const, periodKey: "2026-W46", target: 10, delivered: 3, expected: 6, pace: "atrasada" as const, n: 3, ratePerDay: 0.6, daysLeft: 1.5, projected: 3, closes: false, confidence: "baixa" as const, text: "no ritmo atual fecha em 3 de 10 (n=3, poucos dados)" };
  const base = { routine: { target: 10 }, delivered: 3, pace: "atrasada" as const, projection };

  it("mostra a frase do servidor, a cor pelo ritmo e a base no title", () => {
    expect(projectionView(base)).toEqual({ text: "no ritmo atual fecha em 3 de 10 (n=3, poucos dados)", tone: "danger", detail: "0,6 por dia útil nos últimos 7 dias, 1,5 dias úteis restantes · confiança baixa" });
    expect(projectionView({ ...base, pace: "no_ritmo", projection: { ...projection, pace: "no_ritmo", closes: true, projected: 10, text: "no ritmo atual bate a meta (n=6)", confidence: "media" } })).toMatchObject({ tone: "ok", text: "no ritmo atual bate a meta (n=6)" });
    expect(projectionView({ ...base, pace: "adiantada" })!.tone).toBe("warn");
  });

  it("some quando não há projeção, a meta foi batida, está pausada ou ainda sem ritmo", () => {
    expect(projectionView({ ...base, projection: undefined })).toBeNull();
    expect(projectionView({ ...base, delivered: 10 })).toBeNull();
    expect(projectionView({ ...base, pace: "pausada" })).toBeNull();
    expect(projectionView({ ...base, projection: { ...projection, projected: null, ratePerDay: null, text: "sem ritmo medido ainda" } })).toBeNull();
  });
});
