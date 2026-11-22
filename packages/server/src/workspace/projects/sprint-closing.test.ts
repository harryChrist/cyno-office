import type { ForYouItem, Project } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import type { ProjectServiceDeps } from "./project-service";

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

const NOON = Date.parse("2026-11-11T15:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Reply = { project: Project; ref?: string; sprintId?: string; error?: string };
const send = (ctx: TestApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => ctx.app.inject({ method, url: `${API}${url}`, ...(payload ? { payload } : {}) });
const live = (ctx: TestApp, id: string) => runtimeOf(ctx).plans.get(id);
/** O projeto de verdade em memória (para fabricar o histórico: sem IA nenhuma tarefa roda). */
const raw = (ctx: TestApp, id: string) => (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === id)!;
const task = (project: Project, ref: string) => project.tasks.find((candidate) => candidate.ref === ref)!;

function fakeClock(ctx: TestApp, start = NOON) {
  const clock = { now: start };
  (runtimeOf(ctx).plans as unknown as { deps: ProjectServiceDeps }).deps.now = () => new Date(clock.now);
  return clock;
}

async function newProject(ctx: TestApp, title = "Campanha"): Promise<string> {
  const response = await send(ctx, "POST", "/projects", { title });
  expect(response.statusCode).toBe(201);
  return (response.json() as Reply).project.id;
}
async function addTask(ctx: TestApp, projectId: string, title: string): Promise<string> {
  const response = await send(ctx, "POST", `/projects/${projectId}/tasks`, { title });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as Reply).ref!;
}
async function addSprint(ctx: TestApp, projectId: string, body: { name?: string; goal?: string; startAt?: string; endAt?: string } = {}): Promise<string> {
  // Projetos novos não permitem criar a primeira sprint; este arquivo testa o fechamento em projetos legados que já tinham sprints.
  const project = raw(ctx, projectId);
  if (!project.sprints?.length) {
    const now = (runtimeOf(ctx).plans as unknown as { deps: ProjectServiceDeps }).deps.now().getTime();
    const start = body.startAt ? Date.parse(body.startAt) : now;
    const end = body.endAt ? Date.parse(body.endAt) : start + 7 * DAY;
    const active = project.status === "ativo" && start <= now && now < end;
    project.sprints = [{ id: "S1", name: body.name ?? "Sprint 1", ...(body.goal ? { goal: body.goal } : {}), startAt: iso(start), endAt: iso(end), order: 1, status: active ? "ativa" : "planejada", ...(active ? { openedAt: iso(now) } : {}) }];
    return "S1";
  }
  const response = await send(ctx, "POST", `/projects/${projectId}/sprints`, body);
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as Reply).sprintId!;
}
const items = async (ctx: TestApp): Promise<ForYouItem[]> => (await send(ctx, "GET", "/for-you")).json() as ForYouItem[];
const sprintItems = async (ctx: TestApp, projectId: string) => (await items(ctx)).filter((item) => item.kind === "sprint" && item.projectId === projectId);

/** Um projeto com S1 ativa (vence em 1 dia) e S2 logo depois, com histórico variado fabricado na S1. */
async function seeded(ctx: TestApp) {
  const clock = fakeClock(ctx);
  const id = await newProject(ctx);
  const s1 = await addSprint(ctx, id, { name: "Sprint 1", startAt: iso(NOON - 6 * DAY), endAt: iso(NOON + DAY) });
  const s2 = await addSprint(ctx, id, { name: "Sprint 2", startAt: iso(NOON + DAY), endAt: iso(NOON + 8 * DAY) });
  for (const title of ["Arte do post", "Texto do site", "Vídeo curto", "Banner antigo", "Pesquisa extra", "Ajuste de cor", "Roteiro final"]) await addTask(ctx, id, title);
  const project = raw(ctx, id);
  const at = iso(NOON - DAY);
  Object.assign(task(project, "T1"), { status: "concluida", finishedAt: at, result: "Pronto: https://exemplo.com/arte.png e https://exemplo.com/arte.png.", steps: [{ agentId: "eco", what: "faz", status: "concluida", taskId: "task-1" }] });
  Object.assign(task(project, "T2"), { status: "concluida", finishedAt: at, result: "Texto no ar.", rework: { count: 2, last: { reason: "tom formal demais", at } } });
  Object.assign(task(project, "T3"), { status: "falhou", failure: "Sem cota" });
  Object.assign(task(project, "T4"), { status: "cancelada" });
  Object.assign(task(project, "T5"), { status: "concluida", skipped: true, finishedAt: at });
  Object.assign(task(project, "T6"), { status: "a_fazer" });
  project.worked = { "2026-11-09": 3_600_000, "2026-11-10": 1_800_000 };
  return { clock, id, s1, s2 };
}

describe("fechamento da sprint em duas fases", () => {
  it("Fechar agora: resumo gravado, sobra já na seguinte, um cartão em Aprovações", async () => {
    const ctx = await setupApp();
    const { id, s1, s2 } = await seeded(ctx);
    const closed = await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    expect(closed.statusCode, closed.body).toBe(200);
    const project = live(ctx, id);
    const sprint = project.sprints!.find((candidate) => candidate.id === s1)!;
    expect(sprint.status).toBe("fechando");
    expect(sprint.closedAt).toBeDefined();
    const summary = sprint.summary!;
    expect(summary.done.map((entry) => entry.ref)).toEqual(["T1", "T2"]);
    expect(summary.done[0]).toMatchObject({ links: ["https://exemplo.com/arte.png"], taskIds: ["task-1"] });
    expect(summary.failed).toEqual([{ ref: "T3", title: "Vídeo curto", reason: "Sem cota" }]);
    expect(summary.cancelled).toEqual([{ ref: "T4", title: "Banner antigo" }]);
    expect(summary.skipped).toEqual(["T5"]);
    expect(summary.reworked).toEqual([{ ref: "T2", title: "Texto do site", count: 2, reason: "tom formal demais" }]);
    // Falhou e a fazer/backlog andam na hora para a S2 (a rotina não espera o dono).
    expect(summary.carried.map((entry) => [entry.ref, entry.to])).toEqual([["T3", s2], ["T6", s2], ["T7", s2]]);
    expect(task(project, "T6")).toMatchObject({ sprintId: s2, carriedFrom: s1 });
    expect(summary.workedMs).toBe(5_400_000);

    const cards = await sprintItems(ctx, id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "sprint", status: "pendente", sprintId: s1, title: "Sprint 1 fechou: 2 entregues, 3 sobraram (1 falhou)" });
    expect(sprint.forYouId).toBe(cards[0]!.id);
    // O tick e o agendador não duplicam o cartão.
    for (let n = 0; n < 3; n += 1) runtimeOf(ctx).plans.tick();
    expect(await sprintItems(ctx, id)).toHaveLength(1);
  });

  it("aprovar fecha a sprint; decidir de novo, reabrir ou descartar dão 409", async () => {
    const ctx = await setupApp();
    const { id, s1 } = await seeded(ctx);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    const [card] = await sprintItems(ctx, id);
    const approved = await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "aprovado" });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: "aprovado", decidedBy: "usuario" });
    const sprint = live(ctx, id).sprints![0]!;
    expect(sprint.status).toBe("fechada");
    expect(sprint.summary).toMatchObject({ decidedBy: "usuario" });
    expect(sprint.summary!.decidedAt).toBeDefined();
    expect((await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "aprovado" })).statusCode).toBe(409);
    expect((await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "pendente" })).statusCode).toBe(409);
    expect((await send(ctx, "POST", `/for-you/${card!.id}/cancel`, {})).statusCode).toBe(409);
  });

  it("devolver exige o motivo; cria retrabalho na sprint ativa com o motivo e fecha mesmo assim", async () => {
    const ctx = await setupApp();
    const { id, clock, s2 } = await seeded(ctx);
    // A data da S1 chega: o tick fecha a S1 e abre a S2 (a ativa).
    clock.now = NOON + DAY + 60_000;
    runtimeOf(ctx).plans.tick();
    const [card] = await sprintItems(ctx, id);
    expect(live(ctx, id).sprints!.map((sprint) => sprint.status)).toEqual(["fechando", "ativa"]);
    expect(card).toMatchObject({ status: "pendente", sprintId: "S1" });

    const noReason = await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "rejeitado", returnRefs: ["T1"] });
    expect(noReason.statusCode).toBe(400);
    const wrongRef = await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "rejeitado", reason: "refazer", returnRefs: ["T3"] });
    expect(wrongRef.statusCode).toBe(400);
    expect(live(ctx, id).sprints![0]!.status).toBe("fechando");
    const approveWithRefs = await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "aprovado", returnRefs: ["T1"] });
    expect(approveWithRefs.statusCode).toBe(400);

    const returned = await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "rejeitado", reason: "A cor não é a da marca", returnRefs: ["T1", "T2"] });
    expect(returned.statusCode, returned.body).toBe(200);
    expect(returned.json()).toMatchObject({ status: "rejeitado", rejection: { reason: "A cor não é a da marca" } });
    const project = live(ctx, id);
    expect(project.sprints![0]).toMatchObject({ status: "fechada" });
    expect(project.sprints![0]!.summary!.returned).toEqual({ reason: "A cor não é a da marca", refs: ["T8", "T9"] });
    const rework = task(project, "T8");
    expect(rework).toMatchObject({ title: "Retrabalho: Arte do post", sprintId: s2 });
    expect(rework.briefing).toContain("A cor não é a da marca");
    expect(rework.briefing).toContain("Arte do post");
    // As entregues originais continuam entregues.
    expect(task(project, "T1").status).toBe("concluida");
  });

  it("devolver sem marcar tarefa só registra o motivo e fecha", async () => {
    const ctx = await setupApp();
    const { id, s1 } = await seeded(ctx);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    const [card] = await sprintItems(ctx, id);
    const before = live(ctx, id).tasks.length;
    const response = await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "rejeitado", response: "faltou a mídia" });
    expect(response.statusCode, response.body).toBe(200);
    expect(live(ctx, id).tasks).toHaveLength(before);
    expect(live(ctx, id).sprints![0]).toMatchObject({ status: "fechada" });
    expect(live(ctx, id).sprints![0]!.summary!.returned).toEqual({ reason: "faltou a mídia", refs: [] });
  });

  it("sprint sem tarefa nenhuma fecha com resumo vazio e cartão", async () => {
    const ctx = await setupApp();
    fakeClock(ctx);
    const id = await newProject(ctx);
    const s1 = await addSprint(ctx, id, { startAt: iso(NOON - DAY), endAt: iso(NOON + DAY) });
    expect((await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`)).statusCode).toBe(200);
    const [card] = await sprintItems(ctx, id);
    expect(card!.title).toBe("Sprint 1 fechou: 0 entregues, 0 sobraram");
    expect(live(ctx, id).sprints![0]!.summary).toMatchObject({ done: [], carried: [], failed: [] });
  });

  it("última sprint do projeto: a sobra fica sem sprint (to = null) e o cartão mostra isso", async () => {
    const ctx = await setupApp();
    fakeClock(ctx);
    const id = await newProject(ctx);
    const s1 = await addSprint(ctx, id, { startAt: iso(NOON - DAY), endAt: iso(NOON + DAY) });
    const t = await addTask(ctx, id, "Sobra");
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    const project = live(ctx, id);
    expect(task(project, t).sprintId).toBeUndefined();
    expect(project.sprints![0]!.summary!.carried).toEqual([{ ref: t, title: "Sobra", to: null }]);
    expect((await sprintItems(ctx, id))[0]!.text).toContain("ficou sem sprint");
  });

  it("mover tarefa para sprint fechando explica o que fazer; apagar a sprint fechando é barrado", async () => {
    const ctx = await setupApp();
    const { id, s1 } = await seeded(ctx);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    const moved = await send(ctx, "POST", `/projects/${id}/tasks/T7/move`, { sprintId: s1 });
    expect(moved.statusCode).toBe(409);
    expect((moved.json() as Reply).error).toBe("Essa sprint já fechou. Mova para a sprint ativa ou para uma futura.");
    expect((await send(ctx, "DELETE", `/projects/${id}/sprints/${s1}`)).statusCode).toBe(409);
  });
});

describe("fechamento no modo Automático", () => {
  const setAuto = (ctx: TestApp, id: string, actions: string[], dailyCap = 5) => send(ctx, "POST", `/projects/${id}/mode`, { kind: "automatico", actions, dailyCap });
  /** O cartão é fechado em segundo plano: espera o item sair de "pendente". */
  const settled = async (ctx: TestApp, id: string) => {
    for (let n = 0; n < 50; n += 1) {
      const cards = await sprintItems(ctx, id);
      if (cards.every((card) => card.status !== "pendente")) return cards;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return sprintItems(ctx, id);
  };

  it("com o tipo sprint liberado, o resumo é aprovado sozinho (decidido sozinho)", async () => {
    const ctx = await setupApp();
    const { id, s1 } = await seeded(ctx);
    expect((await setAuto(ctx, id, ["sprint"])).statusCode).toBe(200);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    const sprint = live(ctx, id).sprints![0]!;
    expect(sprint.status).toBe("fechada");
    expect(sprint.summary).toMatchObject({ decidedBy: "automatico" });
    const [card] = await settled(ctx, id);
    expect(card).toMatchObject({ status: "aprovado", decidedBy: "automatico" });
    expect(live(ctx, id).autoUsage?.count).toBe(1);
  });

  it("sem o tipo liberado espera o dono (a nota diz por quê)", async () => {
    const ctx = await setupApp();
    const { id, s1 } = await seeded(ctx);
    await setAuto(ctx, id, ["post"]);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    expect(live(ctx, id).sprints![0]!.status).toBe("fechando");
    const [card] = await sprintItems(ctx, id);
    expect(card).toMatchObject({ status: "pendente" });
    expect(card!.why).toMatch(/sprint/);
  });

  it("teto do dia: a segunda sprint do dia espera o dono", async () => {
    const ctx = await setupApp();
    const { id, s1, s2 } = await seeded(ctx);
    await setAuto(ctx, id, ["sprint"], 1);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    expect(live(ctx, id).sprints![0]!.status).toBe("fechada");
    expect((await send(ctx, "POST", `/projects/${id}/sprints/${s2}/start`)).statusCode).toBe(200);
    expect((await send(ctx, "POST", `/projects/${id}/sprints/${s2}/close`)).statusCode).toBe(200);
    expect(live(ctx, id).sprints![1]!.status).toBe("fechando");
    const cards = await settled(ctx, id);
    expect(cards.map((card) => card.status).sort()).toEqual(["aprovado", "pendente"]);
    expect(cards.find((card) => card.status === "pendente")!.why).toMatch(/Teto de 1 por dia/);
  });

  it("projeto pausado: nada é aprovado sozinho, mas o dono aprova", async () => {
    const ctx = await setupApp();
    const { id, s1 } = await seeded(ctx);
    await setAuto(ctx, id, ["sprint"]);
    expect((await send(ctx, "PATCH", `/projects/${id}`, { status: "pausado" })).statusCode).toBe(200);
    await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    expect(live(ctx, id).sprints![0]!.status).toBe("fechando");
    const [card] = await sprintItems(ctx, id);
    expect(card!.why).toMatch(/pausado/);
    expect((await send(ctx, "POST", `/for-you/${card!.id}/decision`, { status: "aprovado" })).statusCode).toBe(200);
  });
});
