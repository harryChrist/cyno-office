import type { ForYouItem, Project, ProjectTask } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeTask } from "../../test-fixtures";
import { ActivityTab } from "./ProjectTabs";
import { SprintsTab } from "./SprintsTab";
import {
  assemblingRequests,
  awaitingUser,
  buildRows,
  buildWorkBoard,
  compareWork,
  currentOwner,
  deadlineOf,
  looseTaskProjects,
  newWorkMessage,
  paceToday,
  planCardCopy,
  projectApprovalBadge,
  projectBlock,
  projectOfItem,
  projectState,
  projectTimeline,
  stepMark,
  STEP_MARK_LABEL,
  handoffText,
  taskState,
  unitProgressText,
  urgencyTier,
  workColumn,
  workRank,
} from "./workView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-10T15:00:00.000Z");
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "fazer", status: "pendente", taskId: `w-${ref}` }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  ...extra,
});

const project = (id: string, tasks: ProjectTask[] = [task("T1")], extra: Partial<Project> = {}): Project => ({
  id,
  kind: "projeto",
  title: `Projeto ${id}`,
  origin: "maestro",
  status: "ativo",
  version: 1,
  priority: "normal",
  mode: { kind: "pede-ok" },
  worked: {},
  tasks,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const item = (id: string, extra: Partial<ForYouItem> = {}): ForYouItem => ({
  id,
  agentId: "ana",
  roomId: "sala",
  type: "post",
  status: "pendente",
  meta: {},
  text: "t",
  originalText: "t",
  editedByUser: false,
  createdAt: AT,
  ...extra,
});

describe("workRank (urgência)", () => {
  const base = (id: string, extra: Partial<Project> = {}) => project(id, [], { createdAt: "2026-11-01T00:00:00.000Z", ...extra });

  it("atrasado, depois prazo em menos de 24 h, depois prioridade, prazo mais próximo e mais recente", () => {
    const list = [
      base("recente", { createdAt: "2026-11-09T00:00:00.000Z" }),
      base("antigo"),
      base("alta", { priority: "alta" }),
      base("baixa", { priority: "baixa" }),
      base("prazo-longe", { dueAt: hoursFromNow(72) }),
      base("prazo-perto", { dueAt: hoursFromNow(30) }),
      base("em-12h", { dueAt: hoursFromNow(12) }),
      base("atrasado-baixa", { dueAt: hoursFromNow(-2), priority: "baixa" }),
    ];
    expect(workRank(list, NOW).map((p) => p.id)).toEqual(["atrasado-baixa", "em-12h", "alta", "prazo-perto", "prazo-longe", "recente", "antigo", "baixa"]);
  });

  it("entre atrasados vale a prioridade e, empatando, o prazo mais antigo", () => {
    const list = [base("a", { dueAt: hoursFromNow(-1) }), base("b", { dueAt: hoursFromNow(-5) }), base("c", { dueAt: hoursFromNow(-1), priority: "alta" })];
    expect(workRank(list, NOW).map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("não muda a lista original e a faixa respeita o relógio", () => {
    const list = [base("x", { dueAt: hoursFromNow(5) }), base("y")];
    const copy = [...list];
    workRank(list, NOW);
    expect(list).toEqual(copy);
    expect(urgencyTier({ dueAt: hoursFromNow(23.9) }, NOW)).toBe(1);
    expect(urgencyTier({ dueAt: hoursFromNow(24.1) }, NOW)).toBe(2);
    expect(urgencyTier({ dueAt: hoursFromNow(-0.1) }, NOW)).toBe(0);
    expect(urgencyTier({}, NOW)).toBe(2);
    expect(compareWork(base("a"), base("a"), NOW)).toBe(0);
  });
});

describe("item de pedido simples (aponta para a folha do Avulsas)", () => {
  it("projectOfItem acha o projeto de uma tarefa pelo ref (ou pela Task), e awaitingUser conta nele", () => {
    const projects = [project("r-x", [task("A5", { status: "esperando_voce" })], { kind: "tarefa" }), project("r-y", [task("A6")], { kind: "tarefa" }), project("plano")];
    expect(projectOfItem({ projectId: "avulsas", taskRef: "A5" }, projects)?.id).toBe("r-x");
    expect(projectOfItem({ projectId: "avulsas", taskRef: "A6", taskId: "outra" }, projects)?.id).toBe("r-y");
    expect(projectOfItem({ projectId: "avulsas", taskRef: "A9", taskId: "w-A6" }, projects)?.id).toBe("r-y");
    expect(projectOfItem({ projectId: "avulsas", taskRef: "A9" }, projects)).toBeUndefined();
    // o ref de um plano com o mesmo nome não confunde (só projeto kind tarefa vale)
    expect(projectOfItem({ projectId: "avulsas", taskRef: "T1" }, projects)).toBeUndefined();
    const result = awaitingUser(projects, [item("A-1", { projectId: "avulsas", taskRef: "A5" })]);
    expect(result.byProject.get("r-x")).toBe(1);
  });
});

describe("awaitingUser (um só cálculo de Esperando você)", () => {
  it("conta itens pendentes, plano sem item e tarefa parada em você sem item, uma vez cada", () => {
    const projects = [
      project("a", [task("T1", { status: "esperando_voce" }), task("T2", { status: "esperando_voce" }), task("T3")]),
      project("b", [task("T1")], { status: "proposto" }),
      project("c", [task("T1")], { status: "proposto", forYouId: "A-9" }),
      project("d", [task("T1")], { status: "concluido" }),
    ];
    const forYou = [
      item("A-1", { projectId: "a", taskRef: "T1" }),
      item("A-2", { projectId: "a", taskRef: "T1" }),
      item("A-3", { projectId: "c", kind: "plano" }),
      item("A-4", { status: "aprovado", projectId: "a" }),
      item("A-5"),
      item("A-6", { projectId: "d" }),
    ];
    const result = awaitingUser(projects, forYou);
    // a: 2 itens + T2 sem item = 3; b: o plano sem item = 1; c: o item do plano = 1; d: concluído, mas o item pendente dele ainda espera você = 1; A-5 solto = 1
    expect(result.byProject.get("a")).toBe(3);
    expect(result.byProject.get("b")).toBe(1);
    expect(result.byProject.get("c")).toBe(1);
    expect(result.byProject.get("d")).toBe(1);
    expect(result.count).toBe(3 + 1 + 1 + 1 + 1);
    expect(result.items.get("a")!.map((i) => i.id)).toEqual(["A-1", "A-2"]);
  });

  it("acha o projeto do item pela tarefa que o pediu (itens antigos, sem projectId)", () => {
    const projects = [project("a", [task("T1", { status: "esperando_voce" })])];
    const result = awaitingUser(projects, [item("A-1", { taskId: "w-T1" })]);
    expect(result.byProject.get("a")).toBe(1);
    expect(result.count).toBe(1);
  });

  it("sem lista do Para você ainda (null): só o que vem dos projetos", () => {
    expect(awaitingUser([project("a", [task("T1", { status: "esperando_voce" })])], null).count).toBe(1);
    expect(awaitingUser([], null).count).toBe(0);
  });
});

describe("bloqueio, estado, prazo e ritmo", () => {
  it("o bloqueio da tarefa (cota, acesso, outro agente) vem antes de 'Esperando você'", () => {
    const blocked = project("a", [task("T1", { status: "a_fazer", blocked: { type: "cota", note: "Beto sem cota", since: "2026-11-10T13:00:00.000Z" } })]);
    expect(projectBlock(blocked, 0, [])).toMatchObject({ type: "cota", label: "Sem cota", since: "2026-11-10T13:00:00.000Z" });
    const waiting = project("b", [task("T1", { status: "esperando_voce" })]);
    expect(projectBlock(waiting, 1, [item("A-1", { createdAt: "2026-11-10T13:30:00.000Z" })])).toMatchObject({ type: "voce", label: "Esperando você", since: "2026-11-10T13:30:00.000Z" });
    expect(projectBlock(project("c"), 0, [])).toBeUndefined();
    expect(projectBlock(project("d", [task("T1", { blocked: { type: "agente", note: "x", since: AT } })], { status: "concluido" }), 0, [])).toBeUndefined();
  });

  it("estado: Projeto usa as palavras do projeto; a tarefa avulsa usa as da tarefa", () => {
    expect(projectState(project("a")).label).toBe("Em andamento");
    expect(projectState(project("a", [], { status: "proposto" })).label).toBe("Plano esperando OK");
    expect(projectState(project("a", [], { status: "ajustando" })).label).toBe("Maestro ajustando");
    expect(projectState(project("a", [], { status: "concluido" })).label).toBe("Concluído");
    expect(projectState(project("a", [task("T1", { status: "em_andamento" })], { kind: "tarefa" })).label).toBe("Fazendo");
    expect(projectState(project("a", [task("T1", { status: "esperando_voce" })], { kind: "tarefa" })).label).toBe("Esperando você");
    expect(projectState(project("a", [task("T1", { status: "concluida" })], { kind: "tarefa", status: "concluido" })).label).toBe("Feita");
    expect(projectState(project("a", [task("T1")], { kind: "tarefa", status: "pausado" })).label).toBe("Pausado");
  });

  it("prazo: atrasado e em menos de 24 h estão em risco; fechado não mostra prazo", () => {
    expect(deadlineOf(project("a", [], { dueAt: hoursFromNow(-3) }), NOW)).toMatchObject({ state: "late", risk: true, label: "atrasado 3 h" });
    expect(deadlineOf(project("a", [], { dueAt: hoursFromNow(5) }), NOW)).toMatchObject({ state: "soon", risk: true, label: "em 5 h" });
    expect(deadlineOf(project("a", [], { dueAt: hoursFromNow(80) }), NOW)).toMatchObject({ state: "ok", risk: false });
    expect(deadlineOf(project("a", [], { dueAt: hoursFromNow(-3), status: "concluido" }), NOW)).toBeNull();
    expect(deadlineOf(project("a"), NOW)).toBeNull();
  });

  it("ritmo de hoje: '0,5/1 h hoje' só com horas por dia", () => {
    const today = new Date(2026, 10, 10, 15, 0, 0);
    const worked = { "2026-11-10": 1_800_000, "2026-11-09": 7_200_000 };
    expect(paceToday({ pace: { hoursPerDay: 1 }, worked }, today)?.label).toBe("0,5/1 h hoje");
    expect(paceToday({ pace: { hoursPerDay: 2.5 }, worked: {} }, today)?.label).toBe("0/2,5 h hoje");
    expect(paceToday({ pace: { maxParallel: 2 }, worked }, today)).toBeNull();
    expect(paceToday({ worked }, today)).toBeNull();
  });

  it("dono atual: a etapa que roda; senão a próxima a fazer", () => {
    const two = task("T2", { status: "em_andamento", current: 1, steps: [{ agentId: "ana", what: "a", status: "feita" }, { agentId: "beto", what: "b", status: "em_andamento" }] });
    expect(currentOwner(project("a", [task("T1"), two]))).toBe("beto");
    expect(currentOwner(project("a", [task("T1", { steps: [{ agentId: "caio", what: "x", status: "pendente" }] })]))).toBe("caio");
    expect(currentOwner(project("a", []))).toBeUndefined();
  });
});

describe("buildRows e filtros", () => {
  const projects = [
    project("andando", [task("T1", { status: "em_andamento" }), task("T2"), task("T3", { status: "concluida" })], { title: "Campanha de lançamento", priority: "alta", dueAt: hoursFromNow(10) }),
    project("espera", [task("T1", { status: "esperando_voce" })], { title: "Posts da semana" }),
    project("parado", [task("T1", { blocked: { type: "cota", note: "sem cota", since: "2026-11-10T13:00:00.000Z" } })], { title: "Relatório" }),
    project("pausado", [task("T1")], { title: "Newsletter", status: "pausado" }),
    project("falhou", [task("T1", { status: "falhou" })], { title: "Migração" }),
    project("pronto", [task("T1", { status: "concluida" })], { title: "Tarefa velha", kind: "tarefa", status: "concluido", finishedAt: "2026-11-09T10:00:00.000Z" }),
    project("proposto", [task("T1")], { title: "Plano novo", status: "proposto", forYouId: "A-10" }),
  ];
  const forYou = [item("A-1", { projectId: "espera", taskRef: "T1" }), item("A-2", { projectId: "espera", kind: "pergunta" as never }), item("A-10", { projectId: "proposto", kind: "plano" })];
  const rows = buildRows(projects, forYou, new Date(NOW));
  const ids = (list: typeof rows) => list.map((row) => row.project.id);

  it("ordena por urgência, com os fechados no fim", () => {
    expect(ids(rows)[0]).toBe("andando");
    expect(ids(rows).at(-1)).toBe("pronto");
  });

  it("cada linha traz progresso, dono, aprovações e bloqueio", () => {
    const andando = rows.find((row) => row.project.id === "andando")!;
    expect(andando.progress).toEqual({ done: 1, total: 3, skipped: 0, unit: "tarefas" });
    expect(andando.deadline?.risk).toBe(true);
    const espera = rows.find((row) => row.project.id === "espera")!;
    expect(espera).toMatchObject({ awaiting: 2, approvals: 1 });
    expect(espera.block?.label).toBe("Esperando você");
    expect(rows.find((row) => row.project.id === "parado")!.block?.label).toBe("Sem cota");
  });
});

describe("quadro", () => {
  it("coluna de cada tarefa: Parada junta pausa, bloqueio e falha; cancelada e plano não aprovado ficam fora", () => {
    const active = { status: "ativo" } as const;
    expect(workColumn(task("T1", { status: "backlog" }), active)).toBe("todo");
    expect(workColumn(task("T1", { status: "a_fazer" }), active)).toBe("todo");
    expect(workColumn(task("T1", { status: "em_andamento" }), active)).toBe("doing");
    expect(workColumn(task("T1", { status: "esperando_voce" }), active)).toBe("waiting");
    expect(workColumn(task("T1", { status: "concluida" }), active)).toBe("done");
    expect(workColumn(task("T1", { status: "falhou" }), active)).toBe("blocked");
    expect(workColumn(task("T1", { blocked: { type: "acesso", note: "x", since: AT } }), active)).toBe("blocked");
    expect(workColumn(task("T1", { status: "em_andamento" }), { status: "pausado" })).toBe("blocked");
    expect(workColumn(task("T1", { status: "concluida" }), { status: "pausado" })).toBe("done");
    expect(workColumn(task("T1", { status: "cancelada" }), active)).toBeNull();
    expect(workColumn(task("T1"), { status: "proposto" })).toBeNull();
    expect(workColumn(task("T1"), { status: "cancelado" })).toBeNull();
  });

  it("distribui as tarefas (de projetos e avulsas), na ordem de urgência, e limita as feitas", () => {
    const projects = [
      project("p1", [task("T1", { status: "em_andamento" }), task("T2"), task("T10"), task("T3", { status: "esperando_voce" })], { priority: "baixa" }),
      project("p2", [task("T1", { status: "em_andamento" })], { kind: "tarefa", priority: "alta" }),
      project("p3", Array.from({ length: 40 }, (_, i) => task(`T${i + 1}`, { status: "concluida", finishedAt: new Date(NOW - i * 60_000).toISOString() })), { status: "concluido" }),
    ];
    const columns = buildWorkBoard(buildRows(projects, [], new Date(NOW)));
    const col = (id: string) => columns.find((column) => column.id === id)!;
    expect(columns.map((column) => column.id)).toEqual(["todo", "doing", "waiting", "blocked", "done"]);
    expect(col("doing").cards.map((card) => card.key)).toEqual(["p2:T1", "p1:T1"]);
    expect(col("todo").cards.map((card) => card.key)).toEqual(["p1:T2", "p1:T10"]);
    expect(col("waiting").cards.map((card) => card.key)).toEqual(["p1:T3"]);
    expect(col("done").count).toBe(40);
    expect(col("done").cards).toHaveLength(30);
    expect(col("done").cards[0]!.key).toBe("p3:T1");
  });
});

describe("trilha (marca da etapa)", () => {
  const steps = [
    { agentId: "ana", what: "a", status: "feita" as const },
    { agentId: "beto", what: "b", status: "em_andamento" as const },
    { agentId: "caio", what: "c", status: "pendente" as const },
  ];
  it("feita ✓, fazendo ●, próxima ○", () => {
    const t = task("T1", { status: "em_andamento", current: 1, steps });
    expect([0, 1, 2].map((i) => stepMark(t, i))).toEqual(["feita", "fazendo", "proxima"]);
  });
  it("esperando ⏸ na etapa atual quando a tarefa espera você ou está bloqueada", () => {
    expect(stepMark(task("T1", { status: "esperando_voce", current: 1, steps }), 1)).toBe("esperando");
    expect(stepMark(task("T1", { status: "em_andamento", current: 1, steps, blocked: { type: "cota", note: "x", since: AT } }), 1)).toBe("esperando");
  });
  it("tarefa que espera dependência não mostra 'fazendo'; falha aparece na etapa", () => {
    expect(stepMark(task("T1", { status: "backlog" }), 0)).toBe("proxima");
    expect(stepMark(task("T1", { status: "falhou", steps: [{ agentId: "ana", what: "a", status: "falhou" }] }), 0)).toBe("falhou");
    expect(stepMark(task("T1"), 9)).toBe("proxima");
  });
});

describe("trilha: cancelada e pulada não são falha; repasse entre agentes", () => {
  const failedStep = [{ agentId: "ana", what: "a", status: "falhou" as const }];
  it("a etapa de uma tarefa cancelada aparece como cancelada (neutra), não como falhou", () => {
    expect(stepMark(task("T1", { status: "cancelada", steps: failedStep }), 0)).toBe("cancelada");
    expect(STEP_MARK_LABEL.cancelada).toBe("cancelada");
  });
  it("a etapa que falhou numa tarefa pulada pelo Maestro aparece como pulada, nunca vermelha", () => {
    expect(stepMark(task("T1", { status: "concluida", skipped: true, steps: failedStep }), 0)).toBe("pulada");
    expect(stepMark(task("T1", { status: "falhou", steps: failedStep }), 0)).toBe("falhou");
  });
  it("o texto do repasse vem do origin: passou para, perguntou a, avisou, respondeu a", () => {
    const names = (id: string) => ({ crivo: "Crivo", eco: "Eco" })[id] ?? id;
    const of = (origin: ProjectTask["origin"]) => handoffText(task("H1", { ownerId: "eco", ...(origin ? { origin } : {}) }), names);
    expect(of({ fromAddress: "ws/crivo", fromRef: "T1", intent: "pass_on", hops: 1 })).toBe("Crivo passou para Eco");
    expect(of({ fromAddress: "ws/crivo", fromRef: "T1", intent: "ask", hops: 1 })).toBe("Crivo perguntou a Eco");
    expect(of({ fromAddress: "ws/crivo", fromRef: "T1", intent: "fyi", hops: 1 })).toBe("Crivo avisou Eco");
    expect(of({ fromAddress: "ws/crivo", fromRef: "T1", intent: "fyi", hops: 2, reply: true })).toBe("Crivo respondeu a Eco");
    expect(of(undefined)).toBeUndefined();
  });
  it("a linha do tempo registra o repasse no horário em que nasceu", () => {
    const handoff = task("H1", { ownerId: "eco", origin: { fromAddress: "ws/crivo", fromRef: "T1", intent: "pass_on", hops: 1, at: "2026-11-10T17:00:00.000Z" } });
    const days = projectTimeline(project("a", [task("T1"), handoff], { createdAt: "2026-11-10T15:00:00.000Z" }), (id) => (id === "crivo" ? "Crivo" : "Eco"));
    const entry = days.flatMap((day) => day.entries).find((candidate) => candidate.kind === "repasse");
    expect(entry).toMatchObject({ text: "Crivo passou para Eco · H1", at: "2026-11-10T17:00:00.000Z" });
  });
});

describe("linha do tempo por dia", () => {
  it("começo, aprovação, entregas, prazo, fim e horas trabalhadas, do dia mais antigo ao mais novo", () => {
    const p = project(
      "a",
      [task("T1", { status: "concluida", finishedAt: "2026-11-11T15:00:00.000Z" }), task("T2")],
      {
        createdAt: "2026-11-09T15:00:00.000Z",
        approvedAt: "2026-11-09T16:00:00.000Z",
        startAt: "2026-11-10T15:00:00.000Z",
        dueAt: "2026-11-12T15:00:00.000Z",
        worked: { "2026-11-10": 5_400_000, "2026-11-11": 3_600_000, "2026-11-08": 0 },
      },
    );
    const days = projectTimeline(p);
    expect(days.map((day) => day.day)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(days[0]!.entries.map((entry) => entry.kind)).toEqual(["criado", "aprovado"]);
    expect(days[1]).toMatchObject({ workedMs: 5_400_000 });
    expect(days[1]!.entries.map((entry) => entry.kind)).toEqual(["comeca"]);
    expect(days[2]!.entries.map((entry) => [entry.kind, entry.text])).toEqual([["entrega", "T1 · Tarefa T1"]]);
    expect(days[3]!.entries.map((entry) => entry.kind)).toEqual(["prazo"]);
  });

  it("horas trabalhadas num dia sem evento também aparecem", () => {
    const days = projectTimeline(project("a", [], { createdAt: "2026-11-09T15:00:00.000Z", worked: { "2026-11-10": 600_000 } }));
    expect(days.map((day) => [day.day, day.workedMs])).toEqual([["2026-11-09", 0], ["2026-11-10", 600_000]]);
  });
});

describe("tarefas avulsas sem projeto", () => {
  it("viram linhas só da tela; registro do pedido, etapas e tarefas de projeto existente ficam de fora", () => {
    const tasks = [
      makeTask("solta", { status: "in_progress", prompt: "Escrever o post\nmais detalhes" }),
      makeTask("feita", { status: "done", result: "pronto" }),
      makeTask("pedido", { role: "request" }),
      makeTask("etapa", { work: { projectId: "p", ref: "T1", step: 0 } }),
      makeTask("filha", { projectId: "p" }),
      makeTask("espelhada"),
    ];
    const loose = looseTaskProjects(tasks, [project("p", [task("T1")]), project("espelhada")]);
    expect(loose.map((p) => p.id)).toEqual(["solta", "feita"]);
    expect(loose[0]).toMatchObject({ kind: "tarefa", title: "Escrever o post", status: "ativo" });
    expect(loose[0]!.tasks[0]).toMatchObject({ status: "em_andamento", steps: [{ agentId: "ana", taskId: "solta" }] });
    expect(loose[1]).toMatchObject({ status: "concluido" });
    expect(loose[1]!.tasks[0]).toMatchObject({ status: "concluida", result: "pronto" });
  });

  it("a tarefa esperando aprovação conta em Esperando você", () => {
    const loose = looseTaskProjects([makeTask("t", { status: "waiting_approval" })], []);
    expect(awaitingUser(loose, []).count).toBe(1);
  });
});

describe("pedido do botão Novo", () => {
  it("texto estruturado em pt-BR para o Maestro", () => {
    const message = newWorkMessage({ text: "  Fazer 5 posts  ", kind: "projeto", priority: "alta", dueAt: "2026-11-15T12:00:00.000Z" });
    expect(message).toContain("Tipo: Projeto");
    expect(message).toContain("Prioridade: alta");
    expect(message).toContain("Prazo: 2026-11-15T12:00:00.000Z");
    expect(message.endsWith("O que fazer:\nFazer 5 posts")).toBe(true);
    expect(newWorkMessage({ text: "x", kind: "tarefa", priority: "normal" })).toContain("Tipo: Tarefa avulsa");
    expect(newWorkMessage({ text: "x", kind: "tarefa", priority: "normal" })).not.toContain("Prazo:");
  });
});

describe("Maestro montando o projeto", () => {
  it("pedido aberto e trabalhando, sem projeto, conta como montando; com projeto, esperando resposta ou fechado, não", () => {
    const tasks = [
      makeTask("a", { role: "request", status: "in_progress" }),
      makeTask("b", { role: "request", status: "queued" }),
      makeTask("c", { role: "request", status: "waiting_approval" }),
      makeTask("d", { role: "request", status: "done" }),
      makeTask("e", { role: "request", status: "in_progress" }),
      makeTask("f", { status: "in_progress" }),
    ];
    expect(assemblingRequests(tasks, [project("e")]).map((task) => task.id)).toEqual(["a", "b"]);
  });
});

describe("cancelada não é falha, pulada não é feita", () => {
  it("tarefa avulsa cancelada vira projeto cancelado, sem 'falhou'; a falha de verdade continua falhando", () => {
    const [cancelled, failed] = looseTaskProjects([makeTask("x", { status: "failed", outcome: "cancelled", result: "Cancelada: o pedido foi fechado pelo usuário" }), makeTask("y", { status: "failed", result: "API fora" })], []);
    expect(cancelled!).toMatchObject({ status: "cancelado" });
    expect(cancelled!.tasks[0]!.status).toBe("cancelada");
    expect(cancelled!.tasks[0]!.failure).toBeUndefined();
    expect(failed!.tasks[0]).toMatchObject({ status: "falhou", failure: "API fora" });
  });

  it("a tarefa pulada ganha o selo Pulada", () => {
    expect(taskState({ status: "concluida", skipped: true })).toEqual({ label: "Pulada", tone: "neutral" });
    expect(taskState({ status: "concluida" }).label).toBe("Feita");
  });
});

describe("unitProgressText: o progresso do projeto na unidade dele", () => {
  it("módulos e tarefas, com singular só quando o total é 1", () => {
    expect(unitProgressText({ done: 3, total: 8, unit: "modulos" })).toBe("3 de 8 módulos");
    expect(unitProgressText({ done: 0, total: 1, unit: "modulos" })).toBe("0 de 1 módulo");
    expect(unitProgressText({ done: 12, total: 40, unit: "tarefas" })).toBe("12 de 40 tarefas");
    expect(unitProgressText({ done: 1, total: 1, unit: "tarefas" })).toBe("1 de 1 tarefa");
    expect(unitProgressText({ done: 0, total: 0, unit: "tarefas" })).toBe("Sem tarefas");
    expect(unitProgressText({ done: 0, total: 0, unit: "modulos" })).toBe("Sem módulos");
  });
});

describe("selo de aprovação, cartão do plano e SprintsTab sem sprints", () => {
  it("selo discreto só quando by !== 'dono', com a frase no título", () => {
    expect(projectApprovalBadge(undefined)).toBeNull();
    expect(projectApprovalBadge({ by: "dono", at: AT })).toBeNull();
    expect(projectApprovalBadge({ by: "regra", at: AT, quote: "pode começar direto" })).toEqual({
      label: "Começou sem aprovação (regra do workspace)",
      title: "pode começar direto",
    });
    expect(projectApprovalBadge({ by: "maestro", at: AT, quote: "pedido já detalhado" })).toEqual({
      label: "Começou sem aprovação (escolha do Maestro)",
      title: "pedido já detalhado",
    });
    expect(projectApprovalBadge({ by: "maestro", at: AT, quote: "   " })).toEqual({
      label: "Começou sem aprovação (escolha do Maestro)",
    });
  });

  it("ActivityTab mostra o selo discreto (com tooltip) para regra/maestro e omite para dono/ausente", () => {
    const emptyAgents = new Map();
    const byRegra = renderToStaticMarkup(
      createElement(ActivityTab, {
        project: project("p1", [], { approval: { by: "regra", at: AT, quote: "sempre começar" } }),
        agents: emptyAgents,
      }),
    );
    expect(byRegra).toContain('data-testid="activity-approval-badge"');
    expect(byRegra).toContain("Começou sem aprovação (regra do workspace)");
    expect(byRegra).toContain('title="sempre começar"');

    const byDono = renderToStaticMarkup(
      createElement(ActivityTab, {
        project: project("p2", [], { approval: { by: "dono", at: AT } }),
        agents: emptyAgents,
      }),
    );
    expect(byDono).not.toContain('data-testid="activity-approval-badge"');
    expect(byDono).not.toContain("Começou sem aprovação");

    const none = renderToStaticMarkup(createElement(ActivityTab, { project: project("p3", []), agents: emptyAgents }));
    expect(none).not.toContain('data-testid="activity-approval-badge"');
  });

  it("linha do tempo usa o texto do selo quando começou sem aprovação", () => {
    const p = project("p1", [], { createdAt: "2026-11-09T15:00:00.000Z", approval: { by: "maestro", at: "2026-11-09T15:05:00.000Z", quote: "escopo fechado" } });
    const entries = projectTimeline(p).flatMap((day) => day.entries);
    expect(entries.find((entry) => entry.kind === "aprovado")).toEqual({
      kind: "aprovado",
      text: "Começou sem aprovação (escolha do Maestro)",
      at: "2026-11-09T15:05:00.000Z",
      title: "escopo fechado",
    });
  });

  it("cartão do plano reflete aprovação opcional e só cita sprints quando o projeto tem sprints", () => {
    const plain = planCardCopy({ version: 1 });
    expect(plain.title).toBe("Aprovação pedida pelo Maestro");
    expect(plain.text).not.toContain("Nada começa antes da sua aprovação");
    expect(plain.text).not.toContain("sprints");
    const withSprints = planCardCopy({ version: 2, sprints: [{ id: "S1", name: "S1", startAt: AT, endAt: AT, order: 1, status: "planejada" }] });
    expect(withSprints.title).toBe("Aprovação pedida pelo Maestro · versão 2");
    expect(withSprints.text).toContain("sprints");
  });

  it("SprintsTab em projeto sem sprints não mostra botão de criar sprint", () => {
    const html = renderToStaticMarkup(
      createElement(SprintsTab, { project: project("p1", []), agents: new Map(), editable: true, fixed: false, now: NOW, onOpenTask: () => undefined }),
    );
    expect(html).not.toContain("sprint-create-first");
    expect(html).not.toContain("Criar a primeira sprint");
  });
});
