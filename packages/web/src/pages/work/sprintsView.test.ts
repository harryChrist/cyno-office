import { projectDefaults, type Project, type ProjectTask, type Sprint } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildProjectGroups } from "./projectsView";
import { buildSprintLanes, buildTimeline, carriedLabel, closedEarly, currentSprintLabel, loadByAgent, loadText, looseOpenCount, openSprints, shortSprintName, sprintDates, sprintPlanned, startsInLabel } from "./sprintsView";
import { buildTreeRows, type TreeNodeRow } from "./taskTreeView";

const AT = "2026-11-10T12:00:00.000Z";
/** 2026-11-11 12:00 em São Paulo. */
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
const sprint = (id: string, order: number, status: Sprint["status"], from: number, to: number, extra: Partial<Sprint> = {}): Sprint => ({ id, name: `Sprint ${order} · Tema ${order}`, startAt: day(from), endAt: day(to), order, status, ...extra });
const project = (tasks: ProjectTask[], sprints: Sprint[]): Project => ({ ...projectDefaults(), id: "p", title: "Projeto", status: "ativo", version: 1, tasks, labels: [], sprints, createdAt: AT, updatedAt: AT });

const sample = () =>
  project(
    [
      task("T1", { sprintId: "S1", status: "concluida", finishedAt: day(-2) }),
      task("T2", { sprintId: "S2", carriedFrom: "S1", carryCount: 1 }),
      task("T3", { sprintId: "S2", status: "em_andamento" }),
      task("T4", { sprintId: "S3" }),
      task("T5"),
      task("G", { group: true, steps: [], ownerId: "", status: "backlog" }),
      task("T6", { parent: "G", sprintId: "S3" }),
    ],
    [sprint("S3", 3, "planejada", 7, 14), sprint("S1", 1, "fechada", -8, -1), sprint("S2", 2, "ativa", -1, 6)],
  );

describe("buildSprintLanes", () => {
  it("as faixas seguem a ordem das sprints, com o progresso, o dia da ativa e a sobra que saiu", () => {
    const { lanes, loose } = buildSprintLanes(sample(), NOW);
    expect(lanes.map((lane) => lane.sprint.id)).toEqual(["S1", "S2", "S3"]);
    expect(lanes[0]!.progress).toMatchObject({ done: 1, total: 1 });
    expect(lanes[0]!.carriedOut).toBe(1);
    expect(lanes[1]!.day).toEqual({ day: 2, days: 7 });
    expect(lanes[1]!.progress).toMatchObject({ done: 0, total: 2 });
    expect(lanes[2]!.tasks.map((item) => item.task.ref)).toEqual(["T4", "T6"]);
    expect(lanes[0]!.day).toBeNull();
    expect(loose.tasks.map((item) => item.task.ref)).toEqual(["T5"]);
  });

  it("a linha da tarefa traz o caminho acima, o responsável e o selo de quem veio da anterior", () => {
    const { lanes } = buildSprintLanes(sample(), NOW);
    const carried = lanes[1]!.tasks.find((item) => item.task.ref === "T2")!;
    expect(carried.carried).toBe("Sprint 1");
    expect(carried.assignees).toEqual(["ana"]);
    expect(lanes[2]!.tasks.find((item) => item.task.ref === "T6")!.path).toBe("Tarefa G");
    expect(lanes[1]!.tasks.find((item) => item.task.ref === "T3")!.status).toBe("em_andamento");
  });

  it("tarefa arquivada não aparece nem conta; sprint que não existe cai em 'sem sprint'", () => {
    const p = sample();
    p.tasks.push(task("T7", { sprintId: "S9" }), task("T8", { sprintId: "S1", archived: true, status: "concluida" }));
    const { lanes, loose } = buildSprintLanes(p, NOW);
    expect(lanes[0]!.progress.total).toBe(1);
    expect(loose.tasks.map((item) => item.task.ref)).toEqual(["T5", "T7"]);
  });
});

describe("buildTimeline", () => {
  it("blocos proporcionais às datas e o marcador de hoje", () => {
    const timeline = buildTimeline(sample(), NOW)!;
    expect(timeline.blocks.map((block) => block.id)).toEqual(["S1", "S2", "S3"]);
    const [s1, s2, s3] = timeline.blocks as [typeof timeline.blocks[number], typeof timeline.blocks[number], typeof timeline.blocks[number]];
    expect(s1.left).toBe(0);
    expect(s1.width).toBeCloseTo((7 / 22) * 100, 5);
    expect(s2.left).toBeCloseTo((7 / 22) * 100, 5);
    expect(s3.left + s3.width).toBeCloseTo(100, 5);
    expect(timeline.today).toBeCloseTo((8 / 22) * 100, 5);
    expect(timeline.from).toBe("03/11");
    expect(timeline.to).toBe("25/11");
  });

  it("sem sprints não há linha; hoje fora do intervalo não tem marcador", () => {
    expect(buildTimeline({ sprints: [] }, NOW)).toBeNull();
    expect(buildTimeline(project([], [sprint("S1", 1, "fechada", -20, -10)]), NOW)!.today).toBeNull();
  });

  it("a sprint curta ganha largura mínima", () => {
    const timeline = buildTimeline(project([], [sprint("S1", 1, "ativa", 0, 0.1), sprint("S2", 2, "planejada", 1, 30)]), NOW)!;
    expect(timeline.blocks[0]!.width).toBeGreaterThanOrEqual(4);
  });
});

describe("rótulos de sprint", () => {
  it("nome curto, sprint em andamento, 'começa em' e 'veio da'", () => {
    const p = sample();
    expect(shortSprintName("Sprint 2 · Busca")).toBe("Sprint 2");
    expect(shortSprintName("Entrega")).toBe("Entrega");
    expect(currentSprintLabel(p)).toBe("Sprint 2 · até 17/11");
    expect(currentSprintLabel(project([], [sprint("S1", 1, "planejada", 1, 8)]))).toBeUndefined();
    expect(startsInLabel(p, p.tasks.find((item) => item.ref === "T4")!)).toBe("Começa em 18/11");
    expect(startsInLabel(p, p.tasks.find((item) => item.ref === "T2")!)).toBeUndefined();
    expect(startsInLabel(p, { sprintId: "S3", status: "em_andamento" })).toBeUndefined();
    expect(carriedLabel(p, p.tasks.find((item) => item.ref === "T2")!)).toBe("veio da Sprint 1");
    expect(carriedLabel(p, { carriedFrom: "S1", status: "concluida" })).toBeUndefined();
    expect(carriedLabel(p, { carriedFrom: "S9", status: "a_fazer" })).toBe("veio da sprint anterior");
  });

  it("as sprints que aceitam tarefa e as tarefas abertas soltas", () => {
    const p = sample();
    expect(openSprints(p).map((item) => item.id)).toEqual(["S2", "S3"]);
    expect(looseOpenCount(p)).toBe(1);
    p.tasks.find((item) => item.ref === "T5")!.status = "concluida";
    expect(looseOpenCount(p)).toBe(0);
  });
});

describe("a árvore e a entrada leem a sprint", () => {
  it("a linha da folha traz 'Começa em' e o selo da sobra; pai e módulo não", () => {
    const rows = buildTreeRows(sample(), new Set(), { now: NOW }).filter((row): row is TreeNodeRow => row.kind === "node");
    const by = (ref: string) => rows.find((row) => row.ref === ref)!;
    expect(by("T4").startsIn).toBe("Começa em 18/11");
    expect(by("T2").carried).toBe("veio da Sprint 1");
    expect(by("T2").startsIn).toBeUndefined();
    expect(by("G").startsIn).toBeUndefined();
    expect(by("G").sprints).toEqual(["S3"]);
  });

  it("a linha do projeto na entrada mostra a sprint em andamento", () => {
    const groups = buildProjectGroups([sample()], null, NOW);
    expect(groups.progresso[0]!.sprint).toBe("Sprint 2 · até 17/11");
    const none = buildProjectGroups([project([task("T1")], [])], null, NOW);
    expect(none.progresso[0]!.sprint).toBeUndefined();
  });
});

describe("datas da sprint fechada cedo", () => {
  // Fim previsto 17/11, fechou 11/11: o fim planejado continua visível e o dia do fechamento aparece à parte.
  const early = sprint("S1", 1, "fechada", -1, 6, { closedAt: day(0) });
  it("mostra 'planejada até … · fechada em …' em vez de reescrever o fim", () => {
    expect(closedEarly(early)).toBe(true);
    expect(sprintDates(early)).toBe("planejada até 17/11 · fechada em 11/11");
    expect(sprintPlanned(early)).toBe("planejada até 17/11");
  });
  it("no prazo (ou ainda aberta) mostra só o intervalo", () => {
    const onTime = sprint("S1", 1, "fechada", -7, 0, { closedAt: day(0) });
    expect(closedEarly(onTime)).toBe(false);
    expect(sprintDates(onTime)).toBe(`${sprintDates({ ...onTime, status: "ativa" })}`);
    expect(sprintDates(sprint("S2", 2, "ativa", -1, 6))).toBe("10/11–17/11");
    expect(sprintPlanned(sprint("S2", 2, "ativa", -1, 6))).toBe("10/11–17/11");
  });
  it("na linha do tempo o bloco leva as datas e o progresso", () => {
    const p = project([task("T1", { sprintId: "S1", status: "concluida" }), task("T2", { sprintId: "S1" })], [early]);
    const block = buildTimeline(p, NOW)!.blocks[0]!;
    expect(block.range).toBe("planejada até 17/11 · fechada em 11/11");
    expect(block.progress).toMatchObject({ done: 1, total: 2 });
  });
});

describe("carga por agente da sprint", () => {
  const owned = (ref: string, owner: string, extra: Partial<ProjectTask> = {}) => task(ref, { ownerId: owner, steps: owner ? [{ agentId: owner, what: "x", status: "pendente" }] : [], sprintId: "S1", ...extra });
  const p = project(
    [owned("T1", "sol"), owned("T2", "sol"), owned("T3", "sol"), owned("T4", "crivo"), owned("T5", "crivo"), owned("T6", "eco"), owned("T7", "eco", { status: "concluida" }), owned("T8", "", { status: "backlog" })],
    [sprint("S1", 1, "ativa", -1, 6)],
  );
  const names: Record<string, string> = { sol: "Sol", crivo: "Crivo", eco: "Eco" };
  it("conta só as abertas, a maior carga primeiro, e as sem responsável por último", () => {
    const [lane] = buildSprintLanes(p, NOW).lanes;
    expect(lane!.load).toEqual([
      { agentId: "sol", count: 3 },
      { agentId: "crivo", count: 2 },
      { agentId: "eco", count: 1 },
      { agentId: "", count: 1 },
    ]);
  });
  it("vira o texto 'Sol 3 · Crivo 2 · Eco 1'", () => {
    const load = loadByAgent(p, p.tasks.slice(0, 6));
    expect(loadText(load, (id) => names[id] ?? id)).toBe("Sol 3 · Crivo 2 · Eco 1");
    expect(loadText([], (id) => id)).toBe("");
    expect(loadText([{ agentId: "", count: 2 }], (id) => id)).toBe("Sem responsável 2");
  });
});
