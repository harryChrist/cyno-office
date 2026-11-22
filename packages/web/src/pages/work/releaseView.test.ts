import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkStore } from "../../store/workStore";
import {
  containerState,
  impliedSelection,
  isHoldable,
  isUnreleasedProject,
  leafState,
  normalizeSelection,
  PACE_MAX_PER_DAY,
  paceBodyOf,
  paceFormOf,
  paceNextText,
  paceText,
  PLAN_APPROVALS,
  plannedWaitButton,
  plannedWaits,
  plannedWaitText,
  RELEASE_FILTER_LABELS,
  RELEASE_FILTERS,
  releaseCounts,
  releaseFilterRefs,
  releaseMenu,
  releaseSummaryText,
  selectionCan,
  selectionSummary,
  todayKey,
} from "./releaseView";
import { syncProjectResponse } from "./useTaskActions";

const AT = "2026-11-21T12:00:00.000Z";

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
const group = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { group: true, steps: [], ownerId: "", status: "backlog", ...extra });
const mother = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { steps: [], ownerId: "", status: "backlog", ...extra });
const project = (tasks: ProjectTask[], extra: Partial<Project> = {}): Project => ({
  ...projectDefaults(),
  id: "p1",
  title: "Livro",
  status: "ativo",
  version: 1,
  tasks,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

describe("estado da linha (folha e contêiner)", () => {
  it("Planejada tem prioridade na folha; demais estados reaproveitam o da tarefa", () => {
    expect(leafState({ status: "a_fazer", hold: true, blocked: true })).toEqual({ label: "Planejada", tone: "planned", planned: true });
    expect(leafState({ status: "a_fazer", hold: false, blocked: false })).toEqual({ label: "Na fila", tone: "queued", planned: false });
    expect(leafState({ status: "em_andamento", hold: false, blocked: false })).toEqual({ label: "Em andamento", tone: "running", planned: false });
    expect(leafState({ status: "esperando_voce", hold: false, blocked: false })).toEqual({ label: "Esperando você", tone: "waiting", planned: false });
    expect(leafState({ status: "a_fazer", hold: false, blocked: true })).toEqual({ label: "Parada", tone: "blocked", planned: false });
    expect(leafState({ status: "concluida", hold: false, blocked: false })).toEqual({ label: "Concluída", tone: "done", planned: false });
    expect(leafState({ status: "cancelada", hold: false, blocked: false })).toEqual({ label: "Cancelada", tone: "off", planned: false });
    expect(leafState({ status: "falhou", hold: false, blocked: false })).toEqual({ label: "Falhou", tone: "failed", planned: false });
    expect(leafState({ status: "backlog", hold: false, blocked: false })).toEqual({ label: "Backlog", tone: "neutral", planned: false });
  });

  it("contêiner mostra Planejado, Misto ou o estado das filhas (Em execução, Concluído…)", () => {
    expect(containerState({ status: "backlog", release: "planejada" })).toEqual({ label: "Planejado", tone: "planned", planned: true });
    expect(containerState({ status: "em_andamento", release: "mista" })).toEqual({ label: "Misto", tone: "neutral", planned: false });
    expect(containerState({ status: "em_andamento", release: "liberada" })).toEqual({ label: "Em execução", tone: "running", planned: false });
    expect(containerState({ status: "a_fazer", release: "liberada" })).toEqual({ label: "Na fila", tone: "queued", planned: false });
    expect(containerState({ status: "concluida", release: undefined })).toEqual({ label: "Concluído", tone: "done", planned: false });
    expect(containerState({ status: "cancelada", release: undefined })).toEqual({ label: "Cancelado", tone: "off", planned: false });
    expect(containerState({ status: "backlog", release: "liberada" })).toEqual({ label: "Liberado", tone: "neutral", planned: false });
  });

  it("isHoldable: só folha liberada ainda na fila (backlog ou a_fazer)", () => {
    expect(isHoldable(task("T1", { released: true, status: "a_fazer" }))).toBe(true);
    expect(isHoldable(task("T2", { status: "backlog" }))).toBe(true);
    expect(isHoldable(task("T3", { released: false, status: "a_fazer" }))).toBe(false);
    expect(isHoldable(task("T4", { released: true, status: "em_andamento" }))).toBe(false);
    expect(isHoldable(task("T5", { released: true, status: "a_fazer", archived: true }))).toBe(false);
  });
});

describe("aviso de dependência Planejada", () => {
  it("detecta dependência direta, de módulo e indireta via prerequisiteClosure", () => {
    const p = project([
      task("T7", { title: "Pesquisa", released: false }),
      task("T8", { title: "Rascunho", released: true, dependsOn: ["T7"], status: "backlog" }),
      task("T9", { title: "Revisão", released: true, dependsOn: ["T8"], status: "backlog" }),
      group("M1", { title: "Base" }),
      task("A1", { parent: "M1", released: false }),
      group("M2", { title: "Depois", dependsOn: ["M1"] }),
      task("B1", { parent: "M2", released: true, status: "backlog" }),
    ]);
    const waits8 = plannedWaits(p, p.tasks[1]!);
    expect(waits8.map((item) => item.ref)).toEqual(["T7"]);
    expect(plannedWaitText(waits8)).toBe("espera T7, que está Planejada");
    expect(plannedWaitButton(waits8)).toBe("Liberar T7");

    // Indireta: T9 -> T8 (liberada) -> T7 (Planejada)
    const waits9 = plannedWaits(p, p.tasks[2]!);
    expect(waits9.map((item) => item.ref)).toEqual(["T7"]);

    // Módulo M2 espera módulo M1 (não duplica as folhas de M1)
    const waitsM2 = plannedWaits(p, p.tasks[5]!);
    expect(waitsM2).toMatchObject([{ ref: "M1", container: true, state: "planejada" }]);
    expect(plannedWaitText(waitsM2)).toBe("espera M1, que está Planejado");
    expect(plannedWaitButton(waitsM2)).toBe("Liberar M1");

    // Tarefa Planejada não mostra o aviso (ela mesma ainda não foi liberada)
    expect(plannedWaits(p, p.tasks[0]!)).toEqual([]);
  });

  it("plural e mais de 2 itens nos textos do aviso", () => {
    const two = [
      { ref: "T1", title: "A", container: false, state: "planejada" as const },
      { ref: "T2", title: "B", container: false, state: "planejada" as const },
    ];
    expect(plannedWaitText(two)).toBe("espera T1 e T2, que estão Planejadas");
    expect(plannedWaitButton(two)).toBe("Liberar 2 itens");
    const three = [...two, { ref: "T3", title: "C", container: false, state: "planejada" as const }];
    expect(plannedWaitText(three)).toBe("espera T1 e mais 2, que estão Planejadas");
    expect(plannedWaitButton(three)).toBe("Liberar 3 itens");
  });
});

describe("seleção em lote com módulos", () => {
  const base = () =>
    project([
      group("M1", { title: "Capítulo 1" }),
      task("T1", { parent: "M1", released: false }),
      task("T2", { parent: "M1", released: false, dependsOn: ["T0"] }),
      task("T0", { title: "Pré-requisito", released: false }),
      task("T3", { title: "Liberada na fila", released: true, status: "a_fazer" }),
    ]);

  it("selecionar módulo equivale a ele inteiro (remove filhas redundantes e marca implícitas)", () => {
    const p = base();
    expect(normalizeSelection(p, ["T1", "M1", "T3"])).toEqual(["M1", "T3"]);
    expect([...impliedSelection(p, new Set(["M1"])).values()].sort()).toEqual(["T1", "T2"]);
    expect(selectionSummary(p, ["M1"])).toBe("1 selecionada (2 tarefas)");
    expect(selectionSummary(p, ["T0", "T3"])).toBe("2 selecionadas");
  });

  it("selectionCan indica quais botões têm efeito", () => {
    const p = base();
    expect(selectionCan(p, ["M1"])).toEqual({ release: true, releaseWith: true, hold: false });
    expect(selectionCan(p, ["M1", "T0"])).toEqual({ release: true, releaseWith: false, hold: false });
    expect(selectionCan(p, ["T3"])).toEqual({ release: false, releaseWith: false, hold: true });
    expect(selectionCan(p, ["M1", "T3"])).toEqual({ release: true, releaseWith: true, hold: true });
    expect(selectionCan(p, [])).toEqual({ release: false, releaseWith: false, hold: false });
  });
});

describe("filtro Mostrar", () => {
  it("filtra folhas e mantém ancestrais visíveis", () => {
    expect(RELEASE_FILTERS).toEqual(["tudo", "liberadas", "planejadas"]);
    expect(RELEASE_FILTER_LABELS).toEqual({ tudo: "Tudo", liberadas: "Liberadas", planejadas: "Planejadas" });
    const p = project([
      group("M1"),
      group("M1A", { parent: "M1" }),
      task("T1", { parent: "M1A", released: false }),
      task("T2", { parent: "M1", released: true }),
      group("M2"),
      task("T3", { parent: "M2", released: true, status: "concluida" }),
    ]);
    expect(releaseFilterRefs(p, "tudo")).toBeNull();
    expect([...releaseFilterRefs(p, "planejadas")!].sort()).toEqual(["M1", "M1A", "T1"]);
    expect([...releaseFilterRefs(p, "liberadas")!].sort()).toEqual(["M1", "M2", "T2", "T3"]);
  });
});

describe("cabeçalho: contagem e ritmo de liberação", () => {
  it("conta liberadas e planejadas e esconde quando não há planejadas", () => {
    const p = project([
      task("T1", { released: true, status: "a_fazer" }),
      task("T2", { released: true, status: "concluida" }),
      task("T3", { released: false }),
      task("T4", { released: false }),
    ]);
    expect(releaseCounts(p)).toEqual({ released: 1, planned: 2 });
    expect(releaseSummaryText(p)).toBe("1 liberada · 2 planejadas");
    expect(releaseSummaryText(project([task("T1", { released: true })]))).toBeNull();
  });

  it("calcula texto de ritmo e próxima liberação usando releasePace.given e o dia de hoje", () => {
    const today = todayKey(Date.parse("2026-11-21T15:00:00.000Z"));
    expect(today).toBe("2026-11-21");
    const plannedTasks = [task("T1", { released: false }), task("T2", { released: false })];
    expect(paceText(project(plannedTasks), today)).toBe("Ritmo desligado");
    expect(paceNextText({ perDay: 3, unit: "tarefas" }, 2, today)).toBe("próxima liberação hoje");
    expect(paceNextText({ perDay: 3, unit: "tarefas", given: { day: today, count: 3 } }, 2, today)).toBe("próxima liberação amanhã");
    expect(paceNextText({ perDay: 3, unit: "tarefas", given: { day: today, count: 1 } }, 2, today)).toBe("próxima liberação hoje");
    expect(paceNextText({ perDay: 3, unit: "tarefas", given: { day: "2026-11-20", count: 3 } }, 2, today)).toBe("próxima liberação hoje");
    expect(paceNextText({ perDay: 3, unit: "tarefas", startsOn: "2026-11-22" }, 2, today)).toBe("próxima liberação amanhã");
    expect(paceNextText({ perDay: 3, unit: "tarefas", startsOn: "2026-11-25" }, 2, today)).toBe("próxima liberação em 25/11");
    expect(paceNextText({ perDay: 3, unit: "tarefas" }, 0, today)).toBe("nada Planejado para liberar");
    expect(paceText(project(plannedTasks, { releasePace: { perDay: 3, unit: "tarefas", given: { day: today, count: 3 } } }), today)).toBe(
      "Ritmo: liberar 3 tarefas por dia (próxima liberação amanhã)",
    );
    expect(paceText(project(plannedTasks, { releasePace: { perDay: 1, unit: "modulos" } }), today)).toBe(
      "Ritmo: liberar 1 módulo por dia (próxima liberação hoje)",
    );
  });

  it("formulário de ritmo lê e valida corretamente", () => {
    const today = "2026-11-21";
    expect(paceFormOf(undefined, today)).toEqual({ enabled: false, perDay: "3", unit: "tarefas", start: "hoje", date: "2026-11-23" });
    expect(paceFormOf({ perDay: 5, unit: "modulos", startsOn: "2026-11-22" }, today)).toEqual({ enabled: true, perDay: "5", unit: "modulos", start: "amanha", date: "2026-11-22" });
    expect(paceBodyOf({ enabled: false, perDay: "3", unit: "tarefas", start: "hoje", date: "2026-11-23" }, today)).toEqual({ ok: true, releasePace: null });
    expect(paceBodyOf({ enabled: true, perDay: "0", unit: "tarefas", start: "hoje", date: "2026-11-23" }, today)).toEqual({
      ok: false,
      error: `Quantidade por dia: um número inteiro de 1 a ${PACE_MAX_PER_DAY}.`,
    });
    expect(paceBodyOf({ enabled: true, perDay: "2", unit: "tarefas", start: "data", date: "2026-11-20" }, today)).toEqual({
      ok: false,
      error: "Escolha uma data de hoje em diante.",
    });
    expect(paceBodyOf({ enabled: true, perDay: "2", unit: "modulos", start: "amanha", date: "2026-11-23" }, today)).toEqual({
      ok: true,
      releasePace: { perDay: 2, unit: "modulos", startsOn: "2026-11-22" },
    });
  });
});

describe("menu da linha, projeto planejado, aprovação do plano e sincronização com o store", () => {
  beforeEach(() => useWorkStore.getState().reset());

  it("menu da linha oferece ações certas para módulo, mãe, folha Planejada e folha na fila", () => {
    const p = project([
      group("M1"),
      task("T1", { parent: "M1", released: false }),
      task("T2", { parent: "M1", released: true, status: "a_fazer" }),
      mother("P1"),
      task("T3", { parent: "P1", released: false, dependsOn: ["T1"] }),
      task("T4", { released: true, status: "em_andamento" }),
    ]);
    expect(releaseMenu(p, p.tasks[0]!)).toEqual([
      { id: "release", label: "Liberar módulo inteiro" },
      { id: "hold", label: "Segurar módulo" },
    ]);
    expect(releaseMenu(p, p.tasks[3]!)).toEqual([{ id: "release", label: "Liberar módulo inteiro" }]);
    expect(releaseMenu(p, p.tasks[1]!)).toEqual([{ id: "release", label: "Liberar" }]);
    expect(releaseMenu(p, p.tasks[4]!)).toEqual([
      { id: "release", label: "Liberar" },
      { id: "release_with", label: "Liberar com o que precisa" },
    ]);
    expect(releaseMenu(p, p.tasks[2]!)).toEqual([{ id: "hold", label: "Segurar" }]);
    expect(releaseMenu(p, p.tasks[5]!)).toEqual([]);
  });

  it("isUnreleasedProject e rótulos dos botões de aprovação do plano", () => {
    expect(isUnreleasedProject(project([task("T1", { released: false })]))).toBe(true);
    expect(isUnreleasedProject(project([task("T1", { released: false }), task("T2", { released: true })]))).toBe(false);
    expect(isUnreleasedProject(project([]))).toBe(false);
    expect(PLAN_APPROVALS).toEqual([
      { release: "all", label: "Aprovar e começar", testId: "plan-approve" },
      { release: "none", label: "Aprovar e deixar planejado", testId: "plan-approve-planned" },
    ]);
  });

  it("syncProjectResponse aplica no workStore tanto resposta { project } quanto Project direto", () => {
    const p1 = project([task("T1", { released: true })]);
    expect(syncProjectResponse({ project: p1 })?.id).toBe("p1");
    expect(useWorkStore.getState().projects[0]?.tasks[0]?.released).toBe(true);
    const p2 = project([task("T1", { released: false })]);
    expect(syncProjectResponse(p2)?.id).toBe("p1");
    expect(useWorkStore.getState().projects[0]?.tasks[0]?.released).toBe(false);
  });
});
