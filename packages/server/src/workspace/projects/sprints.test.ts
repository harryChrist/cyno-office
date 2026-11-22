import type { Project } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { soloTeam } from "../../dev/test-api";
import type { ProjectServiceDeps } from "./project-service";

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

const NOON = Date.parse("2026-11-11T15:00:00.000Z");
const DAY = 86_400_000;

type Reply = { project: Project; ref?: string; sprintId?: string; error?: string };
const send = (ctx: TestApp, method: "POST" | "PATCH" | "DELETE", url: string, payload?: object) => ctx.app.inject({ method, url: `${API}${url}`, ...(payload ? { payload } : {}) });
const find = (project: Project, ref: string) => project.tasks.find((task) => task.ref === ref)!;
const live = (ctx: TestApp, id: string) => runtimeOf(ctx).plans.get(id);
const iso = (ms: number) => new Date(ms).toISOString();

/** Relógio do ProjectService (o dos testes). */
function fakeClock(ctx: TestApp, start = NOON) {
  const clock = { now: start };
  const deps = (runtimeOf(ctx).plans as unknown as { deps: ProjectServiceDeps }).deps;
  deps.now = () => new Date(clock.now);
  return clock;
}

async function newProject(ctx: TestApp, title = "Campanha"): Promise<string> {
  const response = await send(ctx, "POST", "/projects", { title });
  expect(response.statusCode).toBe(201);
  return (response.json() as Reply).project.id;
}
async function addTask(ctx: TestApp, projectId: string, body: object): Promise<string> {
  const response = await send(ctx, "POST", `/projects/${projectId}/tasks`, body);
  expect(response.statusCode, response.body).toBe(201);
  const ref = (response.json() as Reply).ref!;
  // Criar não executa: estes testes querem a tarefa rodando, então liberam logo (a regra nova tem os testes dela em release.test.ts).
  expect((await send(ctx, "POST", `/projects/${projectId}/release`, { refs: [ref] })).statusCode).toBe(200);
  return ref;
}
async function addSprint(ctx: TestApp, projectId: string, body: { name?: string; goal?: string; startAt?: string; endAt?: string; adoptOpen?: boolean } = {}): Promise<string> {
  // Projetos novos não permitem criar a primeira sprint (409); estes testes cobrem o ciclo em projetos legados que já tinham sprints.
  const raw = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === projectId)!;
  if (!raw.sprints?.length) {
    const now = (runtimeOf(ctx).plans as unknown as { deps: ProjectServiceDeps }).deps.now().getTime();
    const start = body.startAt ? Date.parse(body.startAt) : now;
    const end = body.endAt ? Date.parse(body.endAt) : start + 7 * DAY;
    const active = raw.status === "ativo" && start <= now && now < end;
    raw.sprints = [{ id: "S1", name: body.name ?? "Sprint 1", ...(body.goal ? { goal: body.goal } : {}), startAt: iso(start), endAt: iso(end), order: 1, status: active ? "ativa" : "planejada", ...(active ? { openedAt: iso(now) } : {}) }];
    if (body.adoptOpen) for (const task of raw.tasks) if (!task.group && !task.sprintId && task.status !== "concluida" && task.status !== "cancelada") task.sprintId = "S1";
    return "S1";
  }
  const response = await send(ctx, "POST", `/projects/${projectId}/sprints`, body);
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as Reply).sprintId!;
}
const waitDone = (ctx: TestApp, id: string, ref: string) => ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === id && event.project.tasks.find((task) => task.ref === ref)?.status === "concluida");

describe("sprints pelas rotas e o agendador por sprint", () => {
  it("projeto novo sem sprints recusa POST /projects/:id/sprints com 409; projeto que já tem sprint aceita criar mais", async () => {
    const ctx = await setupApp();
    fakeClock(ctx);
    const id = await newProject(ctx, "Sem sprints");
    const denied = await send(ctx, "POST", `/projects/${id}/sprints`, { name: "Sprint 1" });
    expect(denied.statusCode).toBe(409);
    expect((denied.json() as Reply).error).toBe("Projetos novos não usam sprints: use módulos e a liberação.");
    expect(live(ctx, id).sprints ?? []).toHaveLength(0);

    // Projeto legado que já tem sprint continua aceitando criar novas sprints pela rota.
    await addSprint(ctx, id, { name: "Sprint 1", startAt: iso(NOON - DAY), endAt: iso(NOON + 7 * DAY) });
    const created = await send(ctx, "POST", `/projects/${id}/sprints`, { name: "Sprint 2" });
    expect(created.statusCode, created.body).toBe(201);
    expect((created.json() as Reply).sprintId).toBe("S2");
  });

  it("só a folha da sprint ativa anda; a da futura espera com a nota e começa quando a sprint abre (tick por data)", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const clock = fakeClock(ctx);
    const id = await newProject(ctx);
    const s1 = await addSprint(ctx, id, { name: "Login", startAt: iso(NOON - DAY), endAt: iso(NOON + 7 * DAY) });
    const s2 = await addSprint(ctx, id, { name: "Busca", startAt: iso(NOON + 7 * DAY), endAt: iso(NOON + 14 * DAY) });
    expect(live(ctx, id).sprints!.map((sprint) => sprint.status)).toEqual(["ativa", "planejada"]);

    // Tarefa nova herda a sprint ativa; a outra vai para a futura.
    const t1 = await addTask(ctx, id, { title: "Tela de login", assignee: agent.id });
    const t2 = await addTask(ctx, id, { title: "Busca por preço" });
    expect(find(live(ctx, id), t1).sprintId).toBe(s1);
    expect((await send(ctx, "POST", `/projects/${id}/tasks/${t2}/move`, { sprintId: s2 })).statusCode).toBe(200);
    expect((await send(ctx, "PATCH", `/projects/${id}/tasks/${t2}`, { assignee: agent.id })).statusCode).toBe(200);

    await waitDone(ctx, id, t1);
    const waiting = find(live(ctx, id), t2);
    expect(waiting).toMatchObject({ status: "a_fazer", sprintId: s2 });
    expect(waiting.note).toMatch(/^Busca começa em 18\/11 às /);
    expect(ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === id && task.work.ref === t2)).toHaveLength(0);

    // A data da S2 chega: o tick fecha a S1, abre a S2 e a tarefa começa.
    clock.now = NOON + 7 * DAY + 60_000;
    runtimeOf(ctx).plans.tick();
    await waitDone(ctx, id, t2);
    expect(live(ctx, id).sprints!.map((sprint) => sprint.status)).toEqual(["fechando", "ativa"]);
  });

  it("projeto pausado não abre sprint; ao retomar as datas andam o tempo parado", async () => {
    const ctx = await setupApp();
    const clock = fakeClock(ctx);
    const id = await newProject(ctx);
    expect((await send(ctx, "PATCH", `/projects/${id}`, { status: "pausado" })).statusCode).toBe(200);
    const s1 = await addSprint(ctx, id, { startAt: iso(NOON), endAt: iso(NOON + 7 * DAY) });
    clock.now = NOON + 3 * DAY;
    runtimeOf(ctx).plans.tick();
    expect(live(ctx, id).sprints![0]).toMatchObject({ id: s1, status: "planejada" });
    expect((await send(ctx, "PATCH", `/projects/${id}`, { status: "ativo" })).statusCode).toBe(200);
    const sprint = live(ctx, id).sprints![0]!;
    expect(sprint.startAt).toBe(iso(NOON + 3 * DAY));
    expect(sprint.status).toBe("ativa");
    expect(live(ctx, id).pausedAt).toBeUndefined();
  });

  it("começar e fechar agora: a sobra passa para a seguinte, com a Atividade e o carryCount", async () => {
    const ctx = await setupApp();
    fakeClock(ctx);
    const id = await newProject(ctx);
    const s1 = await addSprint(ctx, id, { startAt: iso(NOON - DAY), endAt: iso(NOON + 7 * DAY) });
    const s2 = await addSprint(ctx, id);
    const s3 = await addSprint(ctx, id);
    const t1 = await addTask(ctx, id, { title: "Sobra" });
    expect(find(live(ctx, id), t1).sprintId).toBe(s1);

    const closed = await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`);
    expect(closed.statusCode, closed.body).toBe(200);
    let project = live(ctx, id);
    expect(project.sprints!.map((sprint) => sprint.status)).toEqual(["fechando", "planejada", "planejada"]);
    expect(find(project, t1)).toMatchObject({ sprintId: s2, carriedFrom: s1, carryCount: 1 });

    const started = await send(ctx, "POST", `/projects/${id}/sprints/${s3}/start`);
    expect(started.statusCode, started.body).toBe(200);
    project = live(ctx, id);
    expect(project.sprints!.map((sprint) => sprint.status)).toEqual(["fechando", "planejada", "ativa"]);
    // Começar a S3 enquanto a S2 ainda não abriu: nada fechou; a sobra não mexe.
    expect(find(project, t1).sprintId).toBe(s2);
    const again = await send(ctx, "POST", `/projects/${id}/sprints/${s2}/start`);
    expect(again.statusCode).toBe(200);
    project = live(ctx, id);
    expect(project.sprints!.map((sprint) => sprint.status)).toEqual(["fechando", "ativa", "fechando"]);
    expect(find(project, t1).sprintId).toBe(s2);
  });

  it("erros: sprint de outro projeto, mover quem não é folha, apagar a ativa com tarefas, datas, ordem e Avulsas", async () => {
    const ctx = await setupApp();
    fakeClock(ctx);
    const a = await newProject(ctx, "A");
    const b = await newProject(ctx, "B");
    const sa = await addSprint(ctx, a, { startAt: iso(NOON - DAY), endAt: iso(NOON + DAY) });
    await addSprint(ctx, b);
    await addSprint(ctx, b);
    const sb2 = "S2";
    const group = await addTask(ctx, a, { title: "Entregável", group: true });
    const child = await addTask(ctx, a, { title: "Filha", parent: group });
    const loose = await addTask(ctx, a, { title: "Solta" });

    const other = await send(ctx, "POST", `/projects/${a}/tasks/${loose}/move`, { sprintId: sb2 });
    expect(other.statusCode).toBe(404);
    expect((other.json() as Reply).error).toMatch(/não existe/);
    const notLeaf = await send(ctx, "POST", `/projects/${a}/tasks/${group}/move`, { sprintId: sa });
    expect(notLeaf.statusCode).toBe(400);
    expect((notLeaf.json() as Reply).error).toMatch(/Só as tarefas que executam/);
    expect(find(live(ctx, a), child).sprintId).toBe(sa);

    const delActive = await send(ctx, "DELETE", `/projects/${a}/sprints/${sa}`);
    expect(delActive.statusCode).toBe(409);
    expect((delActive.json() as Reply).error).toMatch(/feche-a antes/);
    expect((await send(ctx, "POST", `/projects/${a}/sprints/${sa}/start`)).statusCode).toBe(409);
    expect((await send(ctx, "POST", `/projects/${b}/sprints/S2/close`)).statusCode).toBe(409);
    expect((await send(ctx, "PATCH", `/projects/${a}/sprints/${sa}`, { endAt: iso(NOON - 2 * DAY) })).statusCode).toBe(400);
    expect((await send(ctx, "PATCH", `/projects/${a}/sprints/S9`, { name: "X" })).statusCode).toBe(404);
    expect((await send(ctx, "POST", `/projects/${b}/sprints/reorder`, { ids: ["S1"] })).statusCode).toBe(400);
    expect((await send(ctx, "POST", `/projects/${a}/sprints`, { startAt: "ontem" })).statusCode).toBe(400);
    const avulsas = await send(ctx, "POST", `/projects/avulsas/sprints`, {});
    expect(avulsas.statusCode).toBe(409);
    expect((await send(ctx, "POST", `/projects/nao-existe/sprints`, {})).statusCode).toBe(404);

    // Planejada apaga e solta as tarefas dela; reordenar e editar funcionam.
    expect((await send(ctx, "POST", `/projects/${b}/sprints/reorder`, { ids: ["S2", "S1"] })).statusCode).toBe(200);
    expect(live(ctx, b).sprints!.map((sprint) => [sprint.id, sprint.order])).toEqual([["S1", 2], ["S2", 1]]);
    const patched = await send(ctx, "PATCH", `/projects/${b}/sprints/S1`, { name: "Entrega", goal: "Entrar no app" });
    expect((patched.json() as { project: Project }).project.sprints!.find((sprint) => sprint.id === "S1")).toMatchObject({ name: "Entrega", goal: "Entrar no app" });
    const t = await addTask(ctx, b, { title: "Futura" });
    await send(ctx, "POST", `/projects/${b}/tasks/${t}/move`, { sprintId: "S2" });
    expect((await send(ctx, "DELETE", `/projects/${b}/sprints/S2`)).statusCode).toBe(200);
    expect(find(live(ctx, b), t).sprintId).toBeUndefined();
    expect(live(ctx, b).sprints!.map((sprint) => sprint.id)).toEqual(["S1"]);
  });

  it("adoptOpen põe na sprint nova as tarefas abertas sem sprint; tudo vai para a Atividade", async () => {
    const ctx = await setupApp();
    fakeClock(ctx);
    const id = await newProject(ctx);
    const t1 = await addTask(ctx, id, { title: "Já existia" });
    expect(find(live(ctx, id), t1).sprintId).toBeUndefined();
    const s1 = await addSprint(ctx, id, { adoptOpen: true, startAt: iso(NOON - DAY), endAt: iso(NOON + 3 * DAY) });
    expect(find(live(ctx, id), t1).sprintId).toBe(s1);
    // Fechar sem sprint seguinte: a sobra fica sem sprint, com a marca de que veio da anterior.
    expect((await send(ctx, "POST", `/projects/${id}/sprints/${s1}/close`)).statusCode).toBe(200);
    expect(find(live(ctx, id), t1)).toMatchObject({ carriedFrom: s1, carryCount: 1 });
    expect(find(live(ctx, id), t1).sprintId).toBeUndefined();
  });

  it("dependência em pai: espera todas as folhas dele concluírem", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const id = await newProject(ctx);
    const group = await addTask(ctx, id, { title: "Front", group: true });
    const a = await addTask(ctx, id, { title: "A", parent: group });
    const b = await addTask(ctx, id, { title: "B", parent: group });
    const c = await addTask(ctx, id, { title: "C" });
    const plans = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === id)!;
    find(plans, c).dependsOn = [group];
    expect((await send(ctx, "PATCH", `/projects/${id}/tasks/${c}`, { assignee: agent.id })).statusCode).toBe(200);
    expect(find(live(ctx, id), c).status).toBe("backlog");
    await send(ctx, "PATCH", `/projects/${id}/tasks/${a}`, { assignee: agent.id });
    await waitDone(ctx, id, a);
    expect(find(live(ctx, id), c).status).toBe("backlog");
    await send(ctx, "PATCH", `/projects/${id}/tasks/${b}`, { assignee: agent.id });
    await waitDone(ctx, id, c);
    expect(find(live(ctx, id), c).status).toBe("concluida");
  });
});
