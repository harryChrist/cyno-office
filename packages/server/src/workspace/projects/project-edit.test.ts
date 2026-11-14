import { randomUUID } from "node:crypto";
import { findMaestroAgent, type Project, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import { call, soloTeam } from "../../dev/test-api";

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

type Reply = { project: Project; ref?: string };
const post = (ctx: TestApp, url: string, payload: object = {}) => ctx.app.inject({ method: "POST", url: `${API}${url}`, payload });
const patch = (ctx: TestApp, url: string, payload: object) => ctx.app.inject({ method: "PATCH", url: `${API}${url}`, payload });
const refOf = (response: { json: () => unknown }) => (response.json() as Reply).ref!;
const find = (project: Project, ref: string) => project.tasks.find((task) => task.ref === ref)!;

async function newProject(ctx: TestApp, title = "Campanha"): Promise<Project> {
  const response = await post(ctx, "/projects", { title });
  expect(response.statusCode).toBe(201);
  return (response.json() as Reply).project;
}

/** Cria nó (entregável/tarefa/subtarefa) e devolve o `ref`. */
async function add(ctx: TestApp, projectId: string, body: object): Promise<string> {
  const response = await post(ctx, `/projects/${projectId}/tasks`, body);
  expect(response.statusCode, response.body).toBe(201);
  return refOf(response);
}

describe("POST /projects e criar nós da árvore", () => {
  it("cria o projeto à mão (origem usuario, ativo, sem plano) e cada nível, com o limite de profundidade", async () => {
    const ctx = await setupApp();
    const project = await newProject(ctx);
    expect(project).toMatchObject({ origin: "usuario", kind: "projeto", status: "ativo", tasks: [] });
    expect(project.approvedAt).toBeDefined();
    expect(project.forYouId).toBeUndefined();
    expect((await post(ctx, "/projects", { title: "   " })).statusCode).toBe(400);

    const group = await add(ctx, project.id, { title: "Front-End", group: true });
    const task = await add(ctx, project.id, { title: "Tela de login", parent: group });
    const sub = await add(ctx, project.id, { title: "Layout", parent: task });
    const deep = await post(ctx, `/projects/${project.id}/tasks`, { title: "Cor do botão", parent: sub });
    expect(deep.statusCode).toBe(400);
    expect((deep.json() as { error: string }).error).toMatch(/3 níveis/);
    // Entregável só direto no projeto, e sem responsável.
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "Sub", parent: group, group: true })).statusCode).toBe(400);
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "G", group: true, assignee: "x" })).statusCode).toBe(400);

    const saved = runtimeOf(ctx).plans.get(project.id);
    expect(saved.tasks.map((item) => [item.ref, item.parent ?? null, item.group ?? false])).toEqual([
      ["T1", null, true],
      ["T2", "T1", false],
      ["T3", "T2", false],
    ]);
    // O pai (T2) deixou de executar: sem passos e sem responsável; a folha T3 ainda não tem responsável (backlog).
    expect(find(saved, "T2")).toMatchObject({ steps: [], ownerId: "" });
    expect(find(saved, "T3")).toMatchObject({ status: "backlog" });
    expect(find(saved, "T3").steps).toHaveLength(1);
  });

  it("tarefa sem responsável não executa; ao ganhar um entra na fila, roda e o projeto conclui (e reabre com tarefa nova)", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const ref = await add(ctx, project.id, { title: "Escrever o post" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(find(runtimeOf(ctx).plans.get(project.id), ref)).toMatchObject({ status: "backlog" });
    expect(ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === project.id)).toHaveLength(0);

    const assigned = await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { assignee: agent.id });
    expect(assigned.statusCode, assigned.body).toBe(200);
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === project.id && event.project.status === "concluido");
    const done = runtimeOf(ctx).plans.get(project.id);
    expect(find(done, ref)).toMatchObject({ status: "concluida", ownerId: agent.id });
    // Trocar o responsável de quem já começou: 409.
    expect((await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { assignee: null })).statusCode).toBe(409);

    // Tarefa nova num projeto concluído do dono reabre o projeto.
    const second = await add(ctx, project.id, { title: "Outro post" });
    const reopened = runtimeOf(ctx).plans.get(project.id);
    expect(reopened.status).toBe("ativo");
    expect(find(reopened, second).status).toBe("backlog");
  });

  it("criar com responsável já põe a tarefa na fila do agendador; Maestro e agente inexistente são recusados", async () => {
    const ctx = await setupApp({ runner: testRunner({ sleep: gatedSleep().sleep }) });
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const maestro = findMaestroAgent(ctx.store.snapshot())!;
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "A", assignee: maestro.id })).statusCode).toBe(400);
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "A", assignee: "ninguem" })).statusCode).toBe(400);
    const ref = await add(ctx, project.id, { title: "Post", assignee: agent.name });
    const task = find(runtimeOf(ctx).plans.get(project.id), ref);
    expect(["a_fazer", "em_andamento"]).toContain(task.status);
    await ctx.log.waitFor((event) => event.type === "task:upserted" && event.task.work?.projectId === project.id && event.task.work.ref === ref);
  });

  it("o boot (resume) não cancela o projeto do dono, que não tem pedido do Maestro", async () => {
    const ctx = await setupApp({ runner: testRunner({ sleep: gatedSleep().sleep }) });
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    await add(ctx, project.id, { title: "Post", assignee: agent.id });
    runtimeOf(ctx).plans.resume();
    expect(runtimeOf(ctx).plans.get(project.id).status).toBe("ativo");
  });

  it("o projeto que o Maestro está ajustando, o cancelado e o concluído do Maestro não aceitam edição", async () => {
    const ctx = await setupApp();
    const plans = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans;
    const project = await newProject(ctx);
    const live = plans.find((candidate) => candidate.id === project.id)!;
    live.status = "ajustando";
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "A" })).statusCode).toBe(409);
    live.status = "cancelado";
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "A" })).statusCode).toBe(409);
    live.status = "concluido";
    live.origin = "maestro";
    expect((await post(ctx, `/projects/${project.id}/tasks`, { title: "A" })).statusCode).toBe(409);
    expect((await post(ctx, "/projects/nao-existe/tasks", { title: "A" })).statusCode).toBe(404);
  });
});

describe("editar, mover, duplicar, etiquetar, cancelar e arquivar", () => {
  it("edita na linha (nome, datas, prioridade, briefing, pronto quando) e valida", async () => {
    const ctx = await setupApp();
    const project = await newProject(ctx);
    const ref = await add(ctx, project.id, { title: "Post" });
    const response = await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { title: "Post  da   semana", priority: "alta", dueAt: "2026-12-01T12:00:00.000Z", briefing: "Falar do lançamento", doneWhen: ["Menos de 600 caracteres"] });
    expect(response.statusCode, response.body).toBe(200);
    expect(find((response.json() as Reply).project, ref)).toMatchObject({ title: "Post da semana", priority: "alta", dueAt: "2026-12-01T12:00:00.000Z", briefing: "Falar do lançamento", doneWhen: [{ id: "d1", text: "Menos de 600 caracteres" }] });
    expect((await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { startAt: "2026-12-05T12:00:00.000Z" })).statusCode).toBe(400);
    const cleared = await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { dueAt: null });
    expect(find((cleared.json() as Reply).project, ref).dueAt).toBeUndefined();
    expect((await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { nome: "x" })).statusCode).toBe(400);
    expect((await patch(ctx, `/projects/${project.id}/tasks/T99`, { title: "x" })).statusCode).toBe(404);
    // Objetivo e "pronto quando" do projeto.
    const head = await patch(ctx, `/projects/${project.id}`, { summary: "Lançar a campanha", doneWhen: ["Posts no ar"] });
    expect(head.statusCode).toBe(200);
    expect((head.json() as { project: Project }).project).toMatchObject({ summary: "Lançar a campanha", doneWhen: [{ id: "d1", text: "Posts no ar" }] });
  });

  it("mover: de pai, para o fim, antes de uma irmã, passo para cima e baixo; ciclo e limites são recusados", async () => {
    const ctx = await setupApp();
    const project = await newProject(ctx);
    const front = await add(ctx, project.id, { title: "Front", group: true });
    const back = await add(ctx, project.id, { title: "Back", group: true });
    const a = await add(ctx, project.id, { title: "A", parent: front });
    const b = await add(ctx, project.id, { title: "B", parent: front });
    const c = await add(ctx, project.id, { title: "C", parent: front });
    const order = (p: Project, parent?: string) => p.tasks.filter((task) => task.parent === parent).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((task) => task.ref);

    const up = await post(ctx, `/projects/${project.id}/tasks/${c}/move`, { step: "up" });
    expect(order((up.json() as Reply).project, front)).toEqual([a, c, b]);
    const before = await post(ctx, `/projects/${project.id}/tasks/${b}/move`, { before: a });
    expect(order((before.json() as Reply).project, front)).toEqual([b, a, c]);
    const down = await post(ctx, `/projects/${project.id}/tasks/${b}/move`, { step: "down" });
    expect(order((down.json() as Reply).project, front)).toEqual([a, b, c]);

    const toBack = await post(ctx, `/projects/${project.id}/tasks/${a}/move`, { parent: back });
    expect(find((toBack.json() as Reply).project, a).parent).toBe(back);
    expect(order((toBack.json() as Reply).project, front)).toEqual([b, c]);
    // Dentro de uma tarefa (vira mãe).
    const into = await post(ctx, `/projects/${project.id}/tasks/${c}/move`, { parent: b });
    expect(into.statusCode, into.body).toBe(200);
    expect(find((into.json() as Reply).project, b).steps).toEqual([]);
    // Ciclo: o pai para dentro de um descendente.
    const cycle = await post(ctx, `/projects/${project.id}/tasks/${b}/move`, { parent: c });
    expect(cycle.statusCode).toBe(400);
    expect((cycle.json() as { error: string }).error).toMatch(/dentro dela mesma/);
    // Entregável não vira filho; direto no projeto (`parent: null`) volta.
    expect((await post(ctx, `/projects/${project.id}/tasks/${front}/move`, { parent: b })).statusCode).toBe(400);
    const top = await post(ctx, `/projects/${project.id}/tasks/${c}/move`, { parent: null });
    expect(find((top.json() as Reply).project, c).parent).toBeUndefined();
    // Limite de profundidade: B (nível 2, com filhas) dentro de um nível 2 passaria de 3.
    const t1 = await add(ctx, project.id, { title: "T1x", parent: back });
    const t2 = await add(ctx, project.id, { title: "T2x", parent: t1 });
    const deep = await post(ctx, `/projects/${project.id}/tasks/${t1}/move`, { parent: t2 });
    expect(deep.statusCode).toBe(400);
  });

  it("duplica a tarefa com as filhas, sem estado, logo depois da original", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const group = await add(ctx, project.id, { title: "Front", group: true });
    const task = await add(ctx, project.id, { title: "Tela", parent: group });
    const child = await add(ctx, project.id, { title: "Layout", parent: task });
    const other = await add(ctx, project.id, { title: "Outra", parent: group });
    await patch(ctx, `/projects/${project.id}/tasks/${child}`, { priority: "alta", labels: [] });
    const labelled = await post(ctx, `/projects/${project.id}/tasks/${child}/label`, { name: "front" });
    expect((labelled.json() as Reply).project.labels).toEqual([expect.objectContaining({ name: "front" })]);
    // Tarefa já concluída serve de origem: a cópia volta sem resultado.
    const plans = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans;
    const live = plans.find((candidate) => candidate.id === project.id)!;
    Object.assign(find(live, child), { status: "concluida", result: "feito", finishedAt: new Date().toISOString(), ownerId: agent.id });
    const response = await post(ctx, `/projects/${project.id}/tasks/${task}/duplicate`);
    expect(response.statusCode, response.body).toBe(201);
    const { project: after, ref: copyRef } = response.json() as Reply;
    const copy = find(after, copyRef!);
    expect(copy).toMatchObject({ title: "Tela (cópia)", parent: group });
    const copyChild = after.tasks.find((candidate) => candidate.parent === copyRef)!;
    expect(copyChild).toMatchObject({ title: "Layout", priority: "alta", status: "a_fazer", labels: [expect.any(String)] });
    expect(copyChild.result).toBeUndefined();
    expect(copyChild.steps.every((step) => step.status === "pendente" && step.taskId === undefined)).toBe(true);
    const siblings = after.tasks.filter((candidate) => candidate.parent === group).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((candidate) => candidate.ref);
    expect(siblings).toEqual([task, copyRef, other]);
  });

  it("cancela uma tarefa (e as filhas de um pai) e arquiva só o que já terminou", async () => {
    const ctx = await setupApp({ runner: testRunner({ sleep: gatedSleep().sleep }) });
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const group = await add(ctx, project.id, { title: "Entrega", group: true });
    const a = await add(ctx, project.id, { title: "A", parent: group, assignee: agent.id });
    const b = await add(ctx, project.id, { title: "B", parent: group });
    expect((await post(ctx, `/projects/${project.id}/tasks/${a}/archive`)).statusCode).toBe(409);
    const cancelled = await patch(ctx, `/projects/${project.id}/tasks/${group}`, { status: "cancelada" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const after = runtimeOf(ctx).plans.get(project.id);
    expect(find(after, a).status).toBe("cancelada");
    expect(find(after, b).status).toBe("cancelada");
    const archived = await post(ctx, `/projects/${project.id}/tasks/${group}/archive`);
    expect(archived.statusCode, archived.body).toBe(200);
    const done = (archived.json() as Reply).project;
    expect(done.tasks.every((task) => task.archived === true)).toBe(true);
  });
});

/** Como o Maestro delega uma tarefa avulsa: um pedido (role request) e a Task do agente, ligadas ao Avulsas. */
async function delegate(ctx: TestApp, agentId: string, prompt: string): Promise<{ request: Task; sub: Task }> {
  const runtime = runtimeOf(ctx);
  const state = runtime.state.read();
  const agent = state.agents.find((candidate) => candidate.id === agentId)!;
  const team = state.teams.find((candidate) => candidate.id === agent.teamId)!;
  const maestro = findMaestroAgent(state)!;
  const at = new Date().toISOString();
  const request: Task = { id: randomUUID(), roomId: team.roomId, teamId: team.id, agentId: maestro.id, role: "request", prompt, status: "in_progress", createdAt: at, updatedAt: at };
  const sub: Task = { id: randomUUID(), roomId: team.roomId, teamId: team.id, agentId, projectId: request.id, routeReason: "teste", prompt, status: "queued", createdAt: at, updatedAt: at };
  runtime.plans.adopt(request, sub);
  state.tasks.push(request, sub);
  await runtime.state.commit({
    tasks: state.tasks,
    events: [
      { type: "task:upserted", task: request },
      { type: "task:upserted", task: sub },
    ],
  });
  return { request, sub };
}

describe("converter: tarefa avulsa <-> projeto", () => {
  it("a tarefa do Avulsas vira projeto próprio: remapeia a Task, o item do Para você e a rotina, e a folha sai do Avulsas", async () => {
    const gate = gatedSleep();
    const ctx = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const { agent } = await soloTeam(ctx.app);
    const { sub } = await delegate(ctx, agent.id, "Comentar 5 posts");
    const runtime = runtimeOf(ctx);
    const leaf = runtime.plans.list().find((project) => project.id === "avulsas")!.tasks.find((task) => task.steps[0]?.taskId === sub.id)!;
    expect(leaf.ref).toMatch(/^A\d+$/);
    // Um item do Para você e uma execução de rotina ligados a ela.
    const items = runtime.state.readForYou();
    items.push({ id: "A-9001", status: "pendente", taskId: sub.id, projectId: "avulsas", taskRef: leaf.ref, agentId: agent.id, roomId: sub.roomId, title: "x", text: "x", why: "", createdAt: new Date().toISOString() } as never);
    await runtime.state.commit({ forYou: items, events: [] });
    let remapped: { ids: ReadonlySet<string>; projectId: string } | undefined;
    ((runtime.plans as unknown as { deps: { remapRoutineRuns: unknown } }).deps).remapRoutineRuns = (ids: ReadonlySet<string>, projectId: string) => void (remapped = { ids, projectId });

    expect((await post(ctx, "/projects/outro/tasks/A1/convert")).statusCode).toBe(409);
    expect((await post(ctx, "/projects/avulsas/tasks/A999/convert")).statusCode).toBe(404);
    const response = await post(ctx, `/projects/avulsas/tasks/${leaf.ref}/convert`);
    expect(response.statusCode, response.body).toBe(200);
    const project = (response.json() as { project: Project }).project;
    expect(project).toMatchObject({ kind: "projeto", origin: "usuario", status: "ativo", title: "Comentar 5 posts" });
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]).toMatchObject({ ref: "T1" });
    expect(project.tasks[0]!.meta).toBeUndefined();
    expect(runtime.plans.list().find((candidate) => candidate.id === "avulsas")!.tasks.some((task) => task.ref === leaf.ref)).toBe(false);
    const moved = runtime.state.read().tasks.find((task) => task.id === sub.id)!;
    expect(moved.work).toEqual({ projectId: project.id, ref: "T1", step: 0 });
    expect(runtime.state.readForYou().find((item) => item.id === "A-9001")).toMatchObject({ projectId: project.id, taskRef: "T1" });
    expect(remapped).toMatchObject({ projectId: project.id });
    expect(remapped!.ids.has(sub.id)).toBe(true);
    // Agora o projeto pausa (o que a tarefa avulsa não fazia).
    const paused = await patch(ctx, `/projects/${project.id}`, { status: "pausado" });
    expect(paused.statusCode, paused.body).toBe(200);
    gate.open();
  });

  it("o projeto de uma tarefa só vira tarefa avulsa (uma Task nasce na fila); recusa o que tem ritmo, vários itens ou pausa", async () => {
    const ctx = await setupApp({ runner: testRunner({ sleep: gatedSleep().sleep }) });
    const { agent } = await soloTeam(ctx.app);
    const runtime = runtimeOf(ctx);
    const project = await newProject(ctx, "Um post só");
    expect((await post(ctx, `/projects/${project.id}/convert`)).statusCode).toBe(409);
    const ref = await add(ctx, project.id, { title: "Escrever o post", assignee: agent.id });
    await patch(ctx, `/projects/${project.id}`, { pace: { hoursPerDay: 2 } });
    const withPace = await post(ctx, `/projects/${project.id}/convert`);
    expect(withPace.statusCode).toBe(409);
    expect((withPace.json() as { error: string }).error).toMatch(/ritmo/);
    await patch(ctx, `/projects/${project.id}`, { pace: null });
    const two = await add(ctx, project.id, { title: "Outra" });
    expect((await post(ctx, `/projects/${project.id}/convert`)).statusCode).toBe(409);
    await post(ctx, `/projects/${project.id}/tasks/${two}/archive`).catch(() => undefined);
    await patch(ctx, `/projects/${project.id}/tasks/${two}`, { status: "cancelada" });
    await post(ctx, `/projects/${project.id}/tasks/${two}/archive`);

    const response = await post(ctx, `/projects/${project.id}/convert`);
    expect(response.statusCode, response.body).toBe(200);
    const avulsas = (response.json() as { project: Project }).project;
    expect(avulsas.id).toBe("avulsas");
    const leaf = avulsas.tasks.find((task) => task.meta?.requestId === project.id)!;
    expect(leaf).toMatchObject({ title: "Escrever o post", ownerId: agent.id });
    expect(leaf.ref).toMatch(/^A\d+$/);
    expect(runtime.plans.list().some((candidate) => candidate.id === project.id)).toBe(false);
    const task = runtime.state.read().tasks.find((candidate) => candidate.id === leaf.steps[0]!.taskId)!;
    expect(task.work).toMatchObject({ projectId: "avulsas", ref: leaf.ref });
    // O projeto Avulsas não se converte nem se apaga.
    expect((await post(ctx, "/projects/avulsas/convert")).statusCode).toBe(409);
    void ref;
  });

  it("o Avulsas não aceita criar à mão, mover, duplicar nem mudar de título", async () => {
    const ctx = await setupApp();
    expect((await post(ctx, "/projects/avulsas/tasks", { title: "A" })).statusCode).toBe(409);
    expect((await patch(ctx, "/projects/avulsas", { title: "Outro" })).statusCode).toBe(409);
    expect((await post(ctx, "/projects/avulsas/tasks/A1/move", { step: "up" })).statusCode).toBe(409);
    expect((await post(ctx, "/projects/avulsas/tasks/A1/duplicate")).statusCode).toBe(409);
    expect((await call(ctx.app, "GET", `/api/w/principal/plans`)) as Project[]).toBeInstanceOf(Array);
  });
});
