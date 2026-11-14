import type { ForYouItem, ModelSaving } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { agentChoices, batchView, canReassign, dispatchChoices, dispatchOptions, dispatchSentence, rejectionText, savingView, targetNote, targetStep } from "./actionsView";
import { group, makeReport, rate } from "./metricsFixture";

const NAMES: Record<string, string> = { clara: "Clara", eco: "Eco", beto: "Beto" };
const agentName = (id: string) => NAMES[id] ?? id;
const typeName = (type: string) => ({ comentario: "Comentário", convite: "Convite", post: "Post", resposta: "Resposta" })[type] ?? type;

let counter = 0;
function item(extra: Partial<ForYouItem> = {}): ForYouItem {
  counter += 1;
  return { id: `A-${String(counter).padStart(4, "0")}`, agentId: "clara", roomId: "r", type: "comentario", status: "pendente", meta: {}, text: `Texto ${counter}`, originalText: `Texto ${counter}`, editedByUser: false, createdAt: "2026-11-13T12:00:00.000Z", ...extra };
}

describe("seletor de agentes (Reatribuir)", () => {
  const report = makeReport({
    load: { running: 2, maxRunning: 3, perAgentLimit: 1, queued: 2, agents: [{ id: "clara", name: "Clara", doing: 1, queued: 2, waiting: 0, workedMs7d: 0 }, { id: "eco", name: "Eco", doing: 0, queued: 0, waiting: 0, workedMs7d: 0 }, { id: "beto", name: "Beto", doing: 0, queued: 1, waiting: 1, workedMs7d: 0 }] },
    quota: { windows: [], blocked: [{ agentId: "beto", name: "Beto", label: "sem cota, volta às 15h" }] },
  });
  const agents = [{ id: "clara", name: "Clara" }, { id: "eco", name: "Eco" }, { id: "beto", name: "Beto" }];

  it("mostra a carga de cada um em palavras", () => {
    const choices = agentChoices(report, agents, "clara");
    expect(Object.fromEntries(choices.map((choice) => [choice.id, choice.load]))).toEqual({ eco: "livre", beto: "fila 1 · esperando 1", clara: "fazendo 1 · fila 2" });
  });

  it("a ordem: livre primeiro, motor sem cota depois, o de hoje por último; marca o limite por agente", () => {
    const choices = agentChoices(report, agents, "clara");
    expect(choices.map((choice) => choice.id)).toEqual(["eco", "beto", "clara"]);
    expect(choices[1]).toMatchObject({ blocked: "sem cota, volta às 15h", busy: true });
    expect(choices[2]).toMatchObject({ current: true, atLimit: true });
    expect(choices[0]).toMatchObject({ busy: false, atLimit: false, load: "livre" });
  });

  it("só tarefa que pode ser reatribuída: esperando você não", () => {
    expect(["falha", "cota", "acesso", "espera", "agente"].every(canReassign)).toBe(true);
    expect(canReassign("voce")).toBe(false);
  });
});

describe("diálogo de aprovar em lote", () => {
  const report = makeReport({ rejectionRate: { ...makeReport().rejectionRate, byAgent: [{ key: "clara", label: "Clara", ...rate(3, 25) }, { key: "eco", label: "Eco", ...rate(1, 3) }] } });
  const make = (items: ForYouItem[], pick?: string) => batchView({ items, report, typeName, agentName, ...(pick ? { pick } : {}) });

  it("lista o texto de cada item com a taxa de recusa do agente, do tipo com mais itens liberados", () => {
    const items = [item({ agentId: "clara", where: "Post da Ana" }), item({ agentId: "clara" }), item({ agentId: "eco" }), item({ type: "resposta", agentId: "clara" })];
    const view = make(items);
    expect(view.type).toBe("comentario");
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0]).toMatchObject({ title: "Post da Ana", text: items[0]!.text, agentName: "Clara", rejection: "12% recusado (25 decisões)" });
    expect(view.rows[2]!.rejection).toBe("1 de 3 recusados (poucos dados)");
    expect(view.types.map((choice) => [choice.type, choice.eligible])).toEqual([["comentario", 3], ["resposta", 1]]);
    expect(view.action).toBe("Aprovar 3 itens de comentário");
    expect(view.confirm).toContain("3 textos de comentário");
  });

  it("troca de tipo pelo `pick`; tipo que não existe volta ao padrão", () => {
    const items = [item(), item(), item({ type: "resposta" })];
    expect(make(items, "resposta").rows).toHaveLength(1);
    expect(make(items, "resposta").action).toBe("Aprovar 1 item de resposta");
    expect(make(items, "nada").type).toBe("comentario");
  });

  it("diz quem ficou de fora e por quê: edição, convite sem histórico; e conta o que nem é aprovação de texto", () => {
    const edited = item({ text: "Editado", editedByUser: true });
    const ok = item();
    const invite = item({ type: "convite", agentId: "eco" });
    const plan = item({ kind: "plano" });
    const view = make([edited, ok, invite, plan]);
    expect(view.rows.map((row) => row.id)).toEqual([ok.id]);
    expect(view.leftOut).toEqual([{ id: edited.id, title: "Comentário", agentName: "Clara", reason: expect.stringContaining("edição sua") }]);
    expect(view.notApproval).toBe(1);
    const inviteView = make([invite, plan], "convite");
    expect(inviteView.rows).toHaveLength(0);
    expect(inviteView.leftOut[0]!.reason).toContain("aprovação individual");
    expect(inviteView.action).toBe("");
  });

  it("convite com aprovação individual no histórico do agente entra", () => {
    const history = item({ type: "convite", agentId: "eco", status: "aprovado", decidedBy: "usuario" });
    const invite = item({ type: "convite", agentId: "eco" });
    expect(make([history, invite], "convite").rows.map((row) => row.id)).toEqual([invite.id]);
  });

  it("passando de 20, os que sobram ficam para um segundo lote", () => {
    const items = Array.from({ length: 23 }, () => item());
    const view = make(items);
    expect(view.rows).toHaveLength(20);
    expect(view.over).toBe(3);
  });

  it("sem nada pendente, o diálogo diz o vazio (sem tipo, sem ação)", () => {
    const view = make([item({ status: "aprovado" })]);
    expect(view).toMatchObject({ type: null, rows: [], action: "", types: [] });
  });

  it("taxa de recusa em palavras", () => {
    expect(rejectionText(undefined)).toBe("sem decisões suas ainda");
    expect(rejectionText(group("a", "A", { n: 0 }))).toBe("sem decisões suas ainda");
    expect(rejectionText(group("a", "A", { ...rate(1, 4) }))).toBe("1 de 4 recusados (poucos dados)");
    expect(rejectionText(group("a", "A", { ...rate(3, 10) }))).toBe("30% recusado (10 decisões)");
  });
});

describe("estimativa de economia no diálogo de trocar o modelo", () => {
  const saving = (over: Partial<ModelSaving> = {}): ModelSaving => ({
    agentId: "clara",
    agentName: "Clara",
    currentModel: "claude-sonnet-5-5",
    model: "claude-haiku-5-5",
    days: 14,
    state: "estimado",
    records: 12,
    skipped: 0,
    weeklyNowUsd: 6,
    weeklyNewUsd: 1.9,
    savingPerWeekUsd: 4.1,
    quotaShare: 0.12,
    rejectionRate: 0.12,
    rejectionN: 25,
    text: "cerca de US$ 4,10 a menos por semana (equivalente)",
    note: null,
    quotaText: "cerca de 12% menos do consumo da assinatura do Claude (pelo custo equivalente, não é a leitura da cota)",
    warning: "Taxa de recusa de Clara nas últimas semanas: 12% (25 decisões); trocar o modelo pode piorar.",
    ...over,
  });

  it("economia: frase principal, base da conta, fatia da assinatura e o aviso", () => {
    const view = savingView(saving());
    expect(view.tone).toBe("ok");
    expect(view.headline).toBe("Cerca de US$ 4,10 a menos por semana (equivalente)");
    expect(view.lines[0]).toContain("12 turnos dos últimos 14 dias");
    expect(view.lines[1]).toMatch(/^Cerca de 12% menos do consumo da assinatura/);
    expect(view.warning).toContain("trocar o modelo pode piorar");
  });

  it("custo maior vira aviso; sem dados diz \"sem dados para estimar\" e não inventa número", () => {
    expect(savingView(saving({ savingPerWeekUsd: -2, text: "cerca de US$ 2,00 a mais por semana (equivalente)", quotaText: null })).tone).toBe("warn");
    const none = savingView(saving({ state: "sem_dados", text: "sem dados para estimar", savingPerWeekUsd: null, records: 0, note: "Clara não tem turnos medidos nos últimos 14 dias (sem a contagem de tokens não há o que reprecificar).", quotaText: null }));
    expect(none).toMatchObject({ tone: "neutral", headline: "Sem dados para estimar" });
    expect(none.lines).toHaveLength(1);
    expect(JSON.stringify(none)).not.toMatch(/US\$ \d/);
  });
});

describe("trabalho em paralelo", () => {
  it("a frase: agora 2 de 3 rodando; fila de 4", () => {
    const report = makeReport({ load: { running: 2, maxRunning: 3, perAgentLimit: 1, queued: 4, agents: [] } });
    expect(dispatchSentence(report)).toBe("agora 2 de 3 rodando; fila de 4");
    expect(dispatchSentence(makeReport({ load: { running: 0, maxRunning: 3, perAgentLimit: 1, queued: 0, agents: [] } }))).toBe("agora 0 de 3 rodando; fila vazia");
  });

  it("as opções vêm de DISPATCH_LIMITS e um valor antigo fora do intervalo ainda aparece", () => {
    expect(dispatchOptions("maxRunning")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(dispatchOptions("perAgent")).toEqual([1, 2, 3]);
    expect(dispatchChoices("perAgent", 2)).toEqual([1, 2, 3]);
    expect(dispatchChoices("perAgent", 5)).toEqual([1, 2, 3, 5]);
  });
});

describe("−1 / +1 na meta", () => {
  it("usa o clampTarget: sobe e desce de um em um, e desliga no mínimo e no teto do tipo", () => {
    expect(targetStep({ kind: "invite", target: 10, period: "week" }, 1)).toMatchObject({ next: 11, disabled: false, label: "+1" });
    expect(targetStep({ kind: "invite", target: 10, period: "week" }, -1)).toMatchObject({ next: 9, disabled: false, label: "−1" });
    expect(targetStep({ kind: "invite", target: 1, period: "week" }, -1)).toMatchObject({ next: 1, disabled: true, hint: "A meta mínima é 1" });
    // Convite: teto semanal 60.
    expect(targetStep({ kind: "invite", target: 60, period: "week" }, 1)).toMatchObject({ next: 60, disabled: true });
    expect(targetStep({ kind: "invite", target: 60, period: "week" }, 1).hint).toContain("teto");
    // Post: diário 1, semanal 7.
    expect(targetStep({ kind: "post", target: 7, period: "week" }, 1).disabled).toBe(true);
    expect(targetStep({ kind: "post", target: 7, period: "month" }, 1)).toMatchObject({ next: 8, disabled: false });
  });

  it("a confirmação curta cita o período", () => {
    expect(targetNote(4, "week")).toBe("Salvo: meta da semana em 4");
    expect(targetNote(8, "month")).toBe("Salvo: meta do mês em 8");
  });
});
