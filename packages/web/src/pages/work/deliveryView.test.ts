import { projectDefaults, type MediaItem, type Project, type ProjectTask, type Sprint, type SprintSummary } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { canDiscard, filterKey, KIND_FILTERS } from "../foryou/forYouView";
import { carriedWhere, decisionText, deliveryGroups, deliveryHeadline, deliveryView, mediaOfEntry, shortLink } from "./deliveryView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-11T15:00:00.000Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW + n * DAY).toISOString();

const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "fazer", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  ...extra,
});
const summary = (extra: Partial<SprintSummary> = {}): SprintSummary => ({
  builtAt: day(-1),
  done: [{ ref: "T1", title: "Tarefa T1", assignees: ["ana"], finishedAt: day(-2), links: ["https://exemplo.com/arte.png"], taskIds: ["run-1"] }],
  carried: [{ ref: "T2", title: "Tarefa T2", to: "S2" }, { ref: "T3", title: "Tarefa T3", to: null }],
  failed: [],
  skipped: [],
  byAgent: { ana: { done: 1, total: 3 } },
  workedMs: 5_400_000,
  ...extra,
});
const sprint = (id: string, order: number, status: Sprint["status"], extra: Partial<Sprint> = {}): Sprint => ({ id, name: `Sprint ${order} · Tema ${order}`, startAt: day(order * 7 - 14), endAt: day(order * 7 - 7), order, status, ...extra });
const project = (tasks: ProjectTask[], sprints: Sprint[]): Project => ({ ...projectDefaults(), id: "p", title: "Projeto", status: "ativo", version: 1, tasks, labels: [], sprints, createdAt: AT, updatedAt: AT });

describe("deliveryHeadline e carriedWhere", () => {
  it("conta no singular e no plural e inclui as falhas", () => {
    expect(deliveryHeadline({ name: "Sprint 2" }, { done: summary().done, carried: [], failed: [] })).toBe("Sprint 2 fechou: 1 entregue, 0 sobraram");
    expect(deliveryHeadline({ name: "Sprint 2" }, { done: [], carried: [{ ref: "T1", title: "a", to: null }], failed: [{ ref: "T1", title: "a" }] })).toBe("Sprint 2 fechou: 0 entregues, 1 sobrou (1 falhou)");
    const p = project([], [sprint("S2", 2, "planejada")]);
    expect(carriedWhere(p, "S2")).toBe("foi para Sprint 2");
    expect(carriedWhere(p, null)).toBe("ficou sem sprint");
    expect(carriedWhere(p, "S9")).toBe("foi para outra sprint");
  });
});

describe("decisionText", () => {
  it("espera o OK, aprovada por você, aprovada sozinha e devolvida com o motivo", () => {
    expect(decisionText(summary())).toBeNull();
    expect(decisionText(summary({ decidedBy: "usuario", decidedAt: day(0) }))).toMatchObject({ tone: "ok" });
    expect(decisionText(summary({ decidedBy: "usuario", decidedAt: day(0) }))!.text).toMatch(/^aprovada por você em /);
    expect(decisionText(summary({ decidedBy: "automatico", decidedAt: day(0) }))).toMatchObject({ tone: "auto" });
    expect(decisionText(summary({ decidedBy: "automatico", decidedAt: day(0) }))!.text).toMatch(/^aprovada sozinha em /);
    const returned = decisionText(summary({ decidedBy: "usuario", decidedAt: day(0), returned: { reason: "cor errada", refs: ["T8"] } }))!;
    expect(returned.tone).toBe("returned");
    expect(returned.text).toMatch(/devolvida por você em .*: cor errada$/);
  });
});

describe("deliveryView", () => {
  it("sem resumo (sprint ainda aberta) devolve null", () => {
    expect(deliveryView(project([], [sprint("S1", 1, "ativa")]), sprint("S1", 1, "ativa"))).toBeNull();
  });

  it("monta o resumo: entregues, sobra com destino, falhas, canceladas, retrabalho e o que ainda termina", () => {
    const s1 = sprint("S1", 1, "fechando", {
      closedAt: day(-1),
      summary: summary({ failed: [{ ref: "T2", title: "Tarefa T2", reason: "sem cota" }], cancelled: [{ ref: "T9", title: "Velha" }], reworked: [{ ref: "T1", title: "Tarefa T1", count: 2, reason: "tom" }], skipped: ["T7"] }),
    });
    const p = project([task("T1", { sprintId: "S1", status: "concluida" }), task("T4", { sprintId: "S1", status: "em_andamento", title: "Ainda indo" })], [s1, sprint("S2", 2, "planejada")]);
    const view = deliveryView(p, s1)!;
    expect(view.headline).toBe("Sprint 1 · Tema 1 fechou: 1 entregue, 2 sobraram (1 falhou)");
    expect(view.carried).toEqual([
      { ref: "T2", title: "Tarefa T2", where: "foi para Sprint 2" },
      { ref: "T3", title: "Tarefa T3", where: "ficou sem sprint" },
    ]);
    expect(view.finishing).toEqual([{ ref: "T4", title: "Ainda indo" }]);
    expect(view.worked).toBe("1 h 30 trabalhadas");
    expect(view.skipped).toBe(1);
    expect(view.cancelled).toHaveLength(1);
    expect(view.reworked[0]).toMatchObject({ count: 2 });
    expect(view.closedLabel).toMatch(/^fechou em /);
    expect(view.decision).toBeNull();
  });

  it("sprint sem nenhuma tarefa e sem horas", () => {
    const s = sprint("S1", 1, "fechada", { summary: summary({ done: [], carried: [], workedMs: 0, decidedBy: "automatico", decidedAt: day(0) }) });
    const view = deliveryView(project([], [s]), s)!;
    expect(view).toMatchObject({ done: [], carried: [], worked: null, decision: { tone: "auto" } });
    expect(view.headline).toBe("Sprint 1 · Tema 1 fechou: 0 entregues, 0 sobraram");
  });
});

describe("mediaOfEntry e shortLink", () => {
  const media = [
    { id: "M-1", taskId: "run-1" },
    { id: "M-2", rootTaskId: "run-1" },
    { id: "M-3", taskId: "outra" },
  ] as unknown as MediaItem[];
  it("acha a mídia pelas tarefas do runner da entrega", () => {
    expect(mediaOfEntry(media, { taskIds: ["run-1"] }).map((item) => item.id)).toEqual(["M-1", "M-2"]);
    expect(mediaOfEntry(media, {})).toEqual([]);
    expect(mediaOfEntry(null, { taskIds: ["run-1"] })).toEqual([]);
  });
  it("encurta o link para mostrar", () => {
    expect(shortLink("https://www.exemplo.com/arte.png")).toBe("exemplo.com/arte.png");
    expect(shortLink("https://exemplo.com/")).toBe("exemplo.com");
    expect(shortLink("https://exemplo.com/" + "a".repeat(80))).toHaveLength(42);
    expect(shortLink("não é link")).toBe("não é link");
  });
});

describe("deliveryGroups (aba Entregas por sprint)", () => {
  const done = (ref: string, sprintId: string | undefined, finishedAt: string) => task(ref, { status: "concluida", result: `Feito ${ref}`, finishedAt, ...(sprintId ? { sprintId } : {}) });

  it("projeto sem sprints: um grupo só, como antes; sem entrega, nenhum", () => {
    const p = project([done("T1", undefined, day(-3)), done("T2", undefined, day(-1)), task("T3")], []);
    const groups = deliveryGroups(p);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ sprint: null, view: null });
    expect(groups[0]!.tasks.map((t) => t.ref)).toEqual(["T2", "T1"]);
    expect(deliveryGroups(project([task("T3")], []))).toEqual([]);
  });

  it("com sprints: a mais recente primeiro, a fechando/fechada com o resumo, a sem entrega e sem resumo não aparece, soltas no fim", () => {
    const s1 = sprint("S1", 1, "fechada", { summary: summary({ decidedBy: "usuario", decidedAt: day(-6) }) });
    const s2 = sprint("S2", 2, "fechando", { summary: summary() });
    const s3 = sprint("S3", 3, "ativa");
    const s4 = sprint("S4", 4, "planejada");
    const p = project([done("T1", "S1", day(-9)), done("T2", "S2", day(-2)), done("T3", "S3", day(-1)), done("T4", undefined, day(-1)), task("T5", { sprintId: "S4" })], [s1, s2, s3, s4]);
    const groups = deliveryGroups(p);
    expect(groups.map((group) => group.key)).toEqual(["S3", "S2", "S1", "none"]);
    expect(groups[0]!.view).toBeNull();
    expect(groups[1]!.view?.headline).toMatch(/^Sprint 2/);
    expect(groups[2]!.view?.decision?.tone).toBe("ok");
    expect(groups[3]).toMatchObject({ sprint: null });
  });

  it("sprint fechada sem nenhuma entrega aparece (o resumo é a entrega)", () => {
    const s1 = sprint("S1", 1, "fechando", { summary: summary({ done: [] }) });
    expect(deliveryGroups(project([], [s1])).map((group) => group.key)).toEqual(["S1"]);
  });
});

describe("cartão da sprint na lista de Aprovações", () => {
  it("tem filtro próprio e não pode ser descartado", () => {
    expect(filterKey({ type: "outro", kind: "sprint" })).toBe(KIND_FILTERS.sprint.id);
    expect(canDiscard({ status: "pendente", kind: "sprint" })).toBe(false);
    expect(canDiscard({ status: "pendente", kind: "aprovacao" })).toBe(true);
  });
});
