import { randomUUID } from "node:crypto";
import { findMaestroAgent, projectDefaults, type Plan, type Project, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import { call, createTask, getOffice, soloTeam } from "../../dev/test-api";
import type { ProjectServiceDeps } from "./project-service";
import { WorkClock } from "./work-clock";
import { hoursText, paceHold, startText, WorkScheduler } from "./work-scheduler";

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

/** 2026-11-11 12:00 em São Paulo (15:00Z). */
const NOON = Date.parse("2026-11-11T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;

/** Relógio do ProjectService (o dos testes): `clock.now` é o instante atual. */
function fakeClock(ctx: TestApp, start = NOON) {
  const clock = { now: start };
  const deps = (runtimeOf(ctx).plans as unknown as { deps: ProjectServiceDeps }).deps;
  deps.now = () => new Date(clock.now);
  return clock;
}

/**
 * Como o Maestro delega uma tarefa avulsa: um pedido (role request) e a Task do agente, ligadas por
 * um Projeto kind "tarefa" (adopt). A Task entra na fila do agente na hora.
 */
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
  runtime.orchestrator.enqueue(agentId);
  return { request, sub };
}

const patch = (ctx: TestApp, id: string, body: object) => ctx.app.inject({ method: "PATCH", url: `${API}/projects/${id}`, payload: body });
/** O projeto do pedido: o próprio ou, se o pedido simples virou folha do Avulsas, a vista de projeto dele. */
const projectOf = (ctx: TestApp, id: string): Project => runtimeOf(ctx).plans.list().find((candidate) => candidate.id === id) ?? runtimeOf(ctx).plans.get(id);

/**
 * Faz de um pedido simples um projeto `kind: "tarefa"` próprio (como os que a migração deixa de fora do Avulsas:
 * os com ritmo, pausa ou modo próprios): tira as folhas dele do Avulsas e refaz o `work` das Tasks.
 */
async function toLegacyProject(ctx: TestApp, requestId: string): Promise<Project> {
  const runtime = runtimeOf(ctx);
  const plans = (runtime.plans as unknown as { plans: Project[] }).plans;
  const avulsas = plans.find((candidate) => candidate.id === "avulsas")!;
  const leaves = avulsas.tasks.filter((task) => task.meta?.requestId === requestId);
  avulsas.tasks = avulsas.tasks.filter((task) => !leaves.includes(task));
  const at = new Date().toISOString();
  const project: Project = { ...projectDefaults(), id: requestId, kind: "tarefa", title: leaves[0]!.title, status: "ativo", version: 1, tasks: leaves.map((leaf, index) => ({ ...leaf, ref: `T${index + 1}`, meta: undefined })), createdAt: at, updatedAt: at };
  plans.push(project);
  const state = runtime.state.read();
  for (const [index, leaf] of leaves.entries()) {
    const sub = state.tasks.find((task) => task.id === leaf.steps[0]!.taskId)!;
    sub.work = { projectId: requestId, ref: `T${index + 1}`, step: 0 };
  }
  await runtime.state.commit({ tasks: state.tasks, events: [] });
  return project;
}
const taskStatus = (ctx: TestApp, id: string) => ctx.store.snapshot().tasks.find((task) => task.id === id)?.status;
/** Ordem em que as Tasks começaram (in_progress) no hub. */
const startOrder = (ctx: TestApp) => ctx.log.events.flatMap((event) => (event.type === "task:upserted" && event.task.status === "in_progress" ? [event.task.id] : []));

describe("workScheduler: elegibilidade do ritmo (funções puras)", () => {
  const at = NOON;
  it("começa em, janela, limite do dia e em paralelo, com a nota legível e quando acordar", () => {
    const future = new Date(at + 2 * HOUR).toISOString();
    expect(paceHold({ startAt: future }, {}, at, 0, 0)).toEqual({ note: `Começa em ${startText(at + 2 * HOUR)}`, wakeAt: at + 2 * HOUR });
    expect(startText(Date.parse("2026-11-12T15:30:00.000Z"))).toBe("12/11 às 12h30");
    // A tarefa vence o projeto: o "começa em" dela já passou.
    expect(paceHold({ startAt: future }, { startAt: new Date(at - HOUR).toISOString() }, at, 0, 0)).toBeUndefined();
    const closed = paceHold({ pace: { window: { from: "13:00", to: "18:00" } } }, {}, at, 0, 0);
    expect(closed).toEqual({ note: "Fora do horário (volta às 13h)", wakeAt: Date.parse("2026-11-11T16:00:00.000Z") });
    expect(paceHold({ pace: { window: { from: "09:00", to: "13:00" } } }, {}, at, 0, 0)).toBeUndefined();
    const limit = paceHold({ pace: { hoursPerDay: 1 } }, {}, at, HOUR, 0);
    expect(limit).toEqual({ note: "Limite de 1 h de hoje atingido (volta amanhã)", wakeAt: Date.parse("2026-11-12T03:00:00.000Z") });
    expect(paceHold({ pace: { hoursPerDay: 1 } }, {}, at, HOUR - 1, 0)).toBeUndefined();
    expect(paceHold({ pace: { maxParallel: 2 } }, {}, at, 0, 2)?.note).toContain("no máximo 2 por vez");
    expect(paceHold({ pace: { maxParallel: 2 } }, {}, at, 0, 1)).toBeUndefined();
    expect(paceHold({}, {}, at, 10 * HOUR, 9)).toBeUndefined();
    expect([hoursText(1), hoursText(0.5), hoursText(1.5), hoursText(2), hoursText(0.001), hoursText(0.0001)]).toEqual(["1 h", "30 min", "1,5 h", "2 h", "4 s", "1 s"]);
  });
});

describe("workClock (relógio de horas)", () => {
  const AT = "2026-11-11T12:00:00.000Z";
  const project = (): Project => ({ id: "p", kind: "tarefa", title: "P", origin: "usuario", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, worked: {}, tasks: [], createdAt: AT, updatedAt: AT });

  function setup(start = NOON) {
    const time = { now: start };
    const projects = [project()];
    const saved: Project[][] = [];
    const clock = new WorkClock({ projects: () => projects, save: (changed) => saved.push(changed), now: () => time.now });
    return { time, projects, saved, clock };
  }
  const task = (status: Task["status"]) => ({ id: "t1", status, work: { projectId: "p", ref: "T1", step: 0 } });

  it("soma o tempo em andamento por dia local; esperar aprovação não conta", () => {
    const { time, projects, clock } = setup();
    clock.observe(task("in_progress"));
    time.now += 10 * MIN;
    clock.observe(task("waiting_approval"));
    expect(projects[0]!.worked).toEqual({ "2026-11-11": 10 * MIN });
    time.now += 3 * HOUR; // esperando o usuário: nada soma
    clock.tick();
    expect(projects[0]!.worked["2026-11-11"]).toBe(10 * MIN);
    clock.observe(task("in_progress"));
    time.now += 5 * MIN;
    expect(clock.pending("p")).toBe(5 * MIN);
    clock.tick();
    expect(projects[0]!.worked["2026-11-11"]).toBe(15 * MIN);
    expect(clock.pending("p")).toBe(0);
    time.now += 5 * MIN;
    clock.observe(task("done"));
    expect(projects[0]!.worked["2026-11-11"]).toBe(20 * MIN);
    expect(clock.openCount()).toBe(0);
  });

  it("parte à meia-noite (fuso de São Paulo) e grava parciais a cada tick", () => {
    // 23:50 de 11/11 em São Paulo = 02:50Z de 12/11.
    const { time, projects, saved, clock } = setup(Date.parse("2026-11-12T02:50:00.000Z"));
    clock.observe(task("in_progress"));
    time.now += 5 * MIN;
    clock.tick();
    expect(saved).toHaveLength(1);
    time.now += 25 * MIN; // 00:20 do dia 12
    clock.tick();
    expect(projects[0]!.worked).toEqual({ "2026-11-11": 10 * MIN, "2026-11-12": 20 * MIN });
    // Sem fatia aberta, o tick não grava nada.
    clock.observe(task("failed"));
    const before = saved.length;
    clock.tick();
    expect(saved).toHaveLength(before);
  });

  it("ignora Tasks sem etapa de projeto e poda dias com mais de 90", () => {
    const { time, projects, clock } = setup();
    projects[0]!.worked = { "2026-01-01": 5, "2026-11-10": 7 };
    clock.observe({ id: "x", status: "in_progress", work: undefined });
    expect(clock.openCount()).toBe(0);
    clock.observe(task("in_progress"));
    time.now += MIN;
    clock.tick();
    expect(Object.keys(projects[0]!.worked).sort()).toEqual(["2026-11-10", "2026-11-11"]);
  });
});

describe("PATCH /projects/:id", () => {
  async function loose(ctx: TestApp) {
    const solo = await soloTeam(ctx.app);
    const { request } = await delegate(ctx, solo.agent.id, "Tarefa do teste");
    await ctx.log.waitForTask(request.id, "in_progress");
    return { ...solo, id: request.id };
  }

  it("valida o corpo (zod) e devolve { project }; null limpa; pausar e retomar", async () => {
    const gate = gatedSleep();
    const ctx = await setupApp({ runner: testRunner({ sleep: gate.sleep, minMs: 1, maxMs: 1 }) });
    const { id } = await loose(ctx);
    await toLegacyProject(ctx, id);
    const ok = await patch(ctx, id, { priority: "alta", dueAt: "2026-11-20T15:00:00.000Z", startAt: "2026-11-12T12:00:00Z", pace: { hoursPerDay: 1.5, window: { from: "09:00", to: "12:00" }, maxParallel: 2 }, title: "  Novo   título " });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { project: Project }).project).toMatchObject({ id, priority: "alta", dueAt: "2026-11-20T15:00:00.000Z", startAt: "2026-11-12T12:00:00.000Z", title: "Novo título", pace: { hoursPerDay: 1.5, window: { from: "09:00", to: "12:00" }, maxParallel: 2 } });
    // O ritmo informado substitui o anterior.
    const replaced = await patch(ctx, id, { pace: { maxParallel: 1 } });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((replaced.json() as { project: Project }).project.pace).toEqual({ maxParallel: 1 });
    const cleared = (await patch(ctx, id, { pace: null, dueAt: null, startAt: null })).json() as { project: Project };
    expect(cleared.project.pace).toBeUndefined();
    expect(cleared.project.dueAt).toBeUndefined();
    expect(cleared.project.startAt).toBeUndefined();
    const paused = (await patch(ctx, id, { status: "pausado" })).json() as { project: Project };
    expect(paused.project.status).toBe("pausado");
    expect(((await patch(ctx, id, { status: "ativo" })).json() as { project: Project }).project.status).toBe("ativo");
    expect(projectOf(ctx, id).priority).toBe("alta");

    for (const bad of [{ priority: "urgente" }, { pace: { window: { from: "9h", to: "12:00" } } }, { pace: { hoursPerDay: 0 } }, { pace: { hoursPerDay: 30 } }, { pace: { maxParallel: 0 } }, { dueAt: "amanhã" }, { status: "concluido" }, { title: "   " }, { desconhecido: 1 }]) {
      expect((await patch(ctx, id, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(ctx, "nao-existe", { priority: "alta" })).statusCode).toBe(404);
  });

  it("pedido simples (folha do Avulsas): título, prioridade, começo e prazo valem; pausa e ritmo próprio dão 409 com o motivo; terminada não muda", async () => {
    const ctx = await setupApp({ runner: testRunner({ sleep: gatedSleep().sleep, minMs: 1, maxMs: 1 }) });
    const { id } = await loose(ctx);
    const ok = await patch(ctx, id, { priority: "alta", dueAt: "2026-11-20T15:00:00.000Z", startAt: "2026-11-12T12:00:00Z", title: "  Novo   título " });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { project: Project }).project).toMatchObject({ id, kind: "tarefa", priority: "alta", dueAt: "2026-11-20T15:00:00.000Z", startAt: "2026-11-12T12:00:00.000Z", title: "Novo título" });
    const leaf = runtimeOf(ctx).plans.list().find((candidate) => candidate.id === "avulsas")!.tasks.find((task) => task.meta?.requestId === id)!;
    expect(leaf).toMatchObject({ priority: "alta", title: "Novo título", dueAt: "2026-11-20T15:00:00.000Z" });
    const paused = await patch(ctx, id, { status: "pausado" });
    expect(paused.statusCode).toBe(409);
    expect(paused.body).toMatch(/não pausa/);
    expect((await patch(ctx, id, { pace: { hoursPerDay: 2 } })).statusCode).toBe(409);
    expect((await patch(ctx, id, { status: "ativo" })).statusCode).toBe(200);
    expect((await patch(ctx, id, { dueAt: null, startAt: null })).statusCode).toBe(200);
    // o próprio Avulsas é fixo
    expect((await patch(ctx, "avulsas", { title: "Outro" })).statusCode).toBe(409);
    expect((await patch(ctx, "avulsas", { status: "pausado" })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: `${API}/plans/avulsas/cancel` })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: `${API}/projects/avulsas/mode`, payload: { kind: "pede-ok" } })).statusCode).toBe(409);
    // cancelar o pedido simples cancela a folha e fecha o pedido
    const cancelled = await ctx.app.inject({ method: "POST", url: `${API}/plans/${id}/cancel` });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ id, status: "cancelado", tasks: [{ status: "cancelada" }] });
    expect((await patch(ctx, id, { priority: "baixa" })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: `${API}/plans/${id}/cancel` })).statusCode).toBe(409);
  });

  it("projeto que terminou não muda; plano que espera aprovação não pausa mas aceita ritmo e prazo", async () => {
    const ctx = await setupApp();
    const response = await ctx.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[plano] Campanha" } });
    const request = response.json() as Task;
    const event = (await ctx.log.waitFor((candidate) => candidate.type === "project:upserted" && candidate.project.id === request.id)) as Extract<ServerEvent, { type: "project:upserted" }>;
    expect(event.project.status).toBe("proposto");
    expect((await patch(ctx, request.id, { status: "pausado" })).statusCode).toBe(409);
    expect((await patch(ctx, request.id, { priority: "baixa", dueAt: "2026-12-01T12:00:00Z" })).statusCode).toBe(200);
    await ctx.app.inject({ method: "POST", url: `${API}/plans/${request.id}/cancel` });
    expect((await patch(ctx, request.id, { priority: "alta" })).statusCode).toBe(409);
  });
});

describe("agendador: tarefa avulsa passa pelo mesmo ritmo", () => {
  /** Agente ocupado com a primeira tarefa (gate); a segunda fica na fila e recebe o ritmo antes de a vez chegar. */
  async function busyThenQueued() {
    const gate = gatedSleep();
    const ctx = await setupApp({ runner: testRunner({ sleep: gate.sleep, minMs: 1, maxMs: 1 }) });
    const solo = await soloTeam(ctx.app);
    const first = await delegate(ctx, solo.agent.id, "Primeira");
    await ctx.log.waitForTask(first.sub.id, "in_progress");
    const second = await delegate(ctx, solo.agent.id, "Segunda");
    return { ctx, gate, agentId: solo.agent.id, first, second };
  }

  it("sem ritmo, a tarefa simples começa na hora (nada de espera extra)", async () => {
    const ctx = await setupApp();
    const solo = await soloTeam(ctx.app);
    const { sub } = await delegate(ctx, solo.agent.id, "Simples");
    await ctx.log.waitForTask(sub.id, "done");
    expect(taskStatus(ctx, sub.id)).toBe("done");
  });

  it("'começa em' no futuro: fica 'Começa em…' sem erro e roda sozinha na hora certa (acorda pelo nextWakeAt)", async () => {
    const { ctx, gate, second } = await busyThenQueued();
    const clock = fakeClock(ctx);
    const startAt = new Date(NOON + 2 * MIN).toISOString();
    expect((await patch(ctx, second.request.id, { startAt })).statusCode).toBe(200);
    gate.open();
    await ctx.log.waitForTask(second.sub.id, "queued").catch(() => undefined);
    await vi.waitFor(() => expect(projectOf(ctx, second.request.id).tasks[0]!.note).toBe(`Começa em ${startText(NOON + 2 * MIN)}`));
    expect(taskStatus(ctx, second.sub.id)).toBe("queued");
    // Não é bloqueio com tipo: é só a nota.
    expect(projectOf(ctx, second.request.id).tasks[0]!.blocked).toBeUndefined();
    expect(projectOf(ctx, second.request.id).tasks[0]!.status).toBe("a_fazer");
    const scheduler = (runtimeOf(ctx).plans as unknown as { scheduler: { nextWakeAt(): number | undefined } }).scheduler;
    expect(scheduler.nextWakeAt()).toBe(NOON + 2 * MIN);
    clock.now = NOON + 3 * MIN;
    runtimeOf(ctx).plans.tick();
    await ctx.log.waitForTask(second.sub.id, "done");
    const task = projectOf(ctx, second.request.id).tasks[0]!;
    expect(task.note).toBeUndefined();
    expect(scheduler.nextWakeAt()).toBeUndefined();
  });

  it("janela que exclui o horário: não roda; ajustar a janela pelo PATCH faz rodar", async () => {
    const { ctx, gate, second } = await busyThenQueued();
    fakeClock(ctx);
    await toLegacyProject(ctx, second.request.id);
    await patch(ctx, second.request.id, { pace: { window: { from: "13:00", to: "18:00" } } });
    gate.open();
    await vi.waitFor(() => expect(projectOf(ctx, second.request.id).tasks[0]!.note).toBe("Fora do horário (volta às 13h)"));
    expect(taskStatus(ctx, second.sub.id)).toBe("queued");
    await patch(ctx, second.request.id, { pace: { window: { from: "09:00", to: "18:00" } } });
    await ctx.log.waitForTask(second.sub.id, "done");
    expect(projectOf(ctx, second.request.id).tasks[0]!.note).toBeUndefined();
  });

  it("limite de horas do dia estourado: espera até o dia seguinte (virada do dia) e então roda", async () => {
    const { ctx, gate, second } = await busyThenQueued();
    const clock = fakeClock(ctx);
    await toLegacyProject(ctx, second.request.id);
    const project = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((candidate) => candidate.id === second.request.id)!;
    project.worked["2026-11-11"] = HOUR;
    await patch(ctx, second.request.id, { pace: { hoursPerDay: 1 } });
    gate.open();
    await vi.waitFor(() => expect(project.tasks[0]!.note).toBe("Limite de 1 h de hoje atingido (volta amanhã)"));
    expect(taskStatus(ctx, second.sub.id)).toBe("queued");
    const scheduler = (runtimeOf(ctx).plans as unknown as { scheduler: { nextWakeAt(): number | undefined } }).scheduler;
    expect(scheduler.nextWakeAt()).toBe(Date.parse("2026-11-12T03:00:00.000Z"));
    clock.now = Date.parse("2026-11-12T03:00:30.000Z");
    runtimeOf(ctx).plans.tick();
    await ctx.log.waitForTask(second.sub.id, "done");
  });

  it("projeto pausado não começa nada novo e retomar solta a fila; a que já rodava termina", async () => {
    const { ctx, gate, first, second } = await busyThenQueued();
    await toLegacyProject(ctx, second.request.id);
    expect((await patch(ctx, second.request.id, { status: "pausado" })).statusCode).toBe(200);
    gate.open();
    await ctx.log.waitForTask(first.sub.id, "done");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(taskStatus(ctx, second.sub.id)).toBe("queued");
    expect((await patch(ctx, second.request.id, { status: "ativo" })).statusCode).toBe(200);
    await ctx.log.waitForTask(second.sub.id, "done");
  });

  it("a ordem da fila segue o workRank: a de prioridade alta, criada depois, roda primeiro (FIFO no empate)", async () => {
    const { ctx, gate, agentId, first, second } = await busyThenQueued();
    const third = await delegate(ctx, agentId, "Terceira");
    const fourth = await delegate(ctx, agentId, "Quarta");
    await patch(ctx, fourth.request.id, { priority: "alta" });
    gate.open();
    await ctx.log.waitForTask(third.sub.id, "done");
    expect(startOrder(ctx).filter((id) => [first.sub.id, second.sub.id, third.sub.id, fourth.sub.id].includes(id))).toEqual([first.sub.id, fourth.sub.id, second.sub.id, third.sub.id]);
  });

  it("prazo atrasado passa na frente da prioridade alta", async () => {
    const { ctx, gate, agentId, first, second } = await busyThenQueued();
    fakeClock(ctx);
    const high = await delegate(ctx, agentId, "Alta");
    await patch(ctx, high.request.id, { priority: "alta" });
    await patch(ctx, second.request.id, { priority: "baixa", dueAt: new Date(Date.now() - HOUR).toISOString() });
    gate.open();
    await ctx.log.waitForTask(high.sub.id, "done");
    expect(startOrder(ctx).filter((id) => [first.sub.id, second.sub.id, high.sub.id].includes(id))).toEqual([first.sub.id, second.sub.id, high.sub.id]);
  });
});

describe("agendador: projetos com plano", () => {
  const post = (ctx: TestApp, url: string, payload?: object) => ctx.app.inject({ method: "POST", url: `${API}${url}`, ...(payload ? { payload } : {}) });
  async function plan(ctx: TestApp): Promise<{ request: Task; plan: Plan }> {
    const request = (await post(ctx, "/tasks", { prompt: "[plano] Campanha" })).json() as Task;
    const event = (await ctx.log.waitFor((candidate) => candidate.type === "project:upserted" && candidate.project.id === request.id)) as Extract<ServerEvent, { type: "project:upserted" }>;
    return { request, plan: event.project };
  }

  it("limite mole: a etapa em curso termina e a próxima só começa no dia seguinte, com a nota do limite", async () => {
    const gate = gatedSleep();
    const ctx = await setupApp({ runner: testRunner({ sleep: gate.sleep, minMs: 1, maxMs: 1 }) });
    const clock = fakeClock(ctx);
    const { request, plan: proposed } = await plan(ctx);
    await patch(ctx, proposed.id, { pace: { hoursPerDay: 1 } });
    await post(ctx, `/plans/${proposed.id}/approve`);
    await ctx.log.waitFor((event) => event.type === "task:upserted" && event.task.projectId === request.id && event.task.work !== undefined && event.task.status === "in_progress");
    // O dia já estourou o limite com a etapa T1 ainda rodando: ela NÃO é interrompida.
    const live = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((candidate) => candidate.id === proposed.id)!;
    live.worked["2026-11-11"] = 2 * HOUR;
    gate.open();
    await vi.waitFor(() => expect(live.tasks[0]!.status).toBe("concluida"));
    await vi.waitFor(() => expect(live.tasks.find((task) => task.ref === "T2")!.note).toBe("Limite de 1 h de hoje atingido (volta amanhã)"));
    expect(ctx.store.snapshot().tasks.filter((task) => task.projectId === request.id && task.work?.ref === "T2")).toHaveLength(0);
    clock.now = Date.parse("2026-11-12T03:01:00.000Z");
    runtimeOf(ctx).plans.tick();
    await ctx.log.waitForTask(request.id, "done");
    expect(runtimeOf(ctx).plans.get(proposed.id).status).toBe("concluido");
  });

  it("maxParallel 1: nunca duas etapas do projeto ao mesmo tempo", async () => {
    const ctx = await setupApp({ runner: testRunner({ minMs: 1, maxMs: 1, sleep: async () => new Promise((resolve) => setTimeout(resolve, 5)) }) });
    const { request, plan: proposed } = await plan(ctx);
    await patch(ctx, proposed.id, { pace: { maxParallel: 1 } });
    await post(ctx, `/plans/${proposed.id}/approve`);
    await ctx.log.waitForTask(request.id, "done");
    let max = 0;
    for (const event of ctx.log.events) {
      if (event.type !== "project:upserted" || event.project.id !== proposed.id) continue;
      max = Math.max(max, event.project.tasks.filter((task) => task.status === "em_andamento").length);
    }
    expect(max).toBe(1);
  });

  it("pausar não interrompe a etapa em andamento; ela termina, nada novo começa e retomar continua", async () => {
    const gate = gatedSleep();
    const ctx = await setupApp({ runner: testRunner({ sleep: gate.sleep, minMs: 1, maxMs: 1 }) });
    const { request, plan: proposed } = await plan(ctx);
    await post(ctx, `/plans/${proposed.id}/approve`);
    await ctx.log.waitFor((event) => event.type === "task:upserted" && event.task.projectId === request.id && event.task.work !== undefined && event.task.status === "in_progress");
    expect(((await patch(ctx, proposed.id, { status: "pausado" })).json() as { project: Project }).project.status).toBe("pausado");
    gate.open();
    const live = (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((candidate) => candidate.id === proposed.id)!;
    await vi.waitFor(() => expect(live.tasks[0]!.status).toBe("concluida"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(live.status).toBe("pausado");
    expect(ctx.store.snapshot().tasks.filter((task) => task.projectId === request.id && task.work).map((task) => task.work!.ref)).toEqual(["T1"]);
    await patch(ctx, proposed.id, { status: "ativo" });
    await ctx.log.waitForTask(request.id, "done");
  });
});

describe("bloqueio com tipo", () => {
  it("espera de aprovação vira blocked 'voce' e some quando a tarefa volta ao trabalho; sem cota vira 'cota'", async () => {
    const ctx = await setupApp({ runner: testRunner() });
    const solo = await soloTeam(ctx.app);
    const { request, sub } = await delegate(ctx, solo.agent.id, "Publicar [aprovar]");
    await ctx.log.waitForTask(sub.id, "waiting_approval");
    await vi.waitFor(() => expect(projectOf(ctx, request.id).tasks[0]!.blocked).toMatchObject({ type: "voce", by: `principal/${solo.agent.id}` }));
    expect(projectOf(ctx, request.id).tasks[0]!.status).toBe("esperando_voce");
    const item = runtimeOf(ctx).forYou.list().find((candidate) => candidate.taskId === sub.id)!;
    // o item aponta para a folha do Avulsas (projeto + ref), não para um projeto que já não existe
    expect(item).toMatchObject({ projectId: "avulsas", taskRef: expect.stringMatching(/^A\d+$/) });
    expect(await runtimeOf(ctx).plans.findTask(item.projectId!, item.taskRef!)).toMatchObject({ ref: item.taskRef });
    await call(ctx.app, "POST", `${API}/for-you/${item.id}/decision`, { status: "aprovado" }, 200);
    await ctx.log.waitForTask(sub.id, "done");
    await vi.waitFor(() => expect(projectOf(ctx, request.id).tasks[0]).toMatchObject({ status: "concluida" }));
    expect(projectOf(ctx, request.id).tasks[0]!.blocked).toBeUndefined();
    // O bloqueio que acabou fica no histórico (`blockedSpans`), e a tarefa guarda quando entrou na fila (`queuedAt`).
    expect(projectOf(ctx, request.id).tasks[0]!.blockedSpans).toEqual([expect.objectContaining({ type: "voce", by: `principal/${solo.agent.id}`, since: expect.any(String), until: expect.any(String) })]);
    expect(projectOf(ctx, request.id).tasks[0]!.queuedAt).toEqual(expect.any(String));

    // Sem cota do motor: a tarefa avulsa fica na fila com blocked 'cota' (nada de erro) e anda quando o motor volta.
    const deps = (runtimeOf(ctx).plans as unknown as { deps: ProjectServiceDeps }).deps;
    let blocked = true;
    const orchestratorDeps = (runtimeOf(ctx).orchestrator as unknown as { deps: { availability?: ProjectServiceDeps["availability"] } }).deps;
    orchestratorDeps.availability = (agent) => (blocked && agent.id === solo.agent.id ? { reason: "quota" } : undefined);
    deps.availability = orchestratorDeps.availability;
    const other = await delegate(ctx, solo.agent.id, "Sem cota");
    await vi.waitFor(() => expect(projectOf(ctx, other.request.id).tasks[0]!.blocked).toMatchObject({ type: "cota" }));
    expect(taskStatus(ctx, other.sub.id)).toBe("queued");
    blocked = false;
    runtimeOf(ctx).orchestrator.retryWaiting();
    await ctx.log.waitForTask(other.sub.id, "done");
    await vi.waitFor(() => expect(projectOf(ctx, other.request.id).tasks[0]!.blocked).toBeUndefined());
    expect(projectOf(ctx, other.request.id).tasks[0]!.blockedSpans?.map((span) => span.type)).toContain("cota");
  });
});

describe("orquestrador: esperar o usuário não segura o agente", () => {
  it("outra tarefa na fila: a vaga é solta na hora, a nova roda sem esperar e a aprovada recomeça depois", async () => {
    const inputs: { id: string; resumed: boolean }[] = [];
    const inner = testRunner();
    const ctx = await setupApp({ runner: { provider: inner.provider, run: (input, hooks) => (inputs.push({ id: input.task.id, resumed: input.resumedDecision !== undefined }), inner.run(input, hooks)) } });
    const solo = await soloTeam(ctx.app);
    const slow = await createTask(ctx.app, solo.room.id, solo.team.id, "Publicar o post [aprovar]");
    await ctx.log.waitForTask(slow.id, "waiting_approval");
    expect(runtimeOf(ctx).state.read().agents.find((agent) => agent.id === solo.agent.id)!.status).toBe("waiting_approval");
    // Um pedido novo do usuário para o mesmo agente: não fica atrás da aprovação esquecida.
    const quick = await createTask(ctx.app, solo.room.id, solo.team.id, "Responder rápido");
    await ctx.log.waitForTask(quick.id, "done");
    expect(taskStatus(ctx, slow.id)).toBe("waiting_approval");
    const item = runtimeOf(ctx).forYou.list().find((candidate) => candidate.taskId === slow.id && candidate.status === "pendente")!;
    expect(item).toBeDefined();
    // Aprovar: a tarefa original conclui, recomeçando já com a decisão do usuário.
    await call(ctx.app, "POST", `${API}/for-you/${item.id}/decision`, { status: "aprovado" }, 200);
    await ctx.log.waitForTask(slow.id, "done");
    expect(inputs.filter((entry) => entry.id === slow.id).map((entry) => entry.resumed)).toEqual([false, true]);
    expect(ctx.log.taskStatuses(slow.id)).toEqual(["queued", "in_progress", "waiting_approval", "queued", "in_progress", "done"]);
    await vi.waitFor(async () => expect((await getOffice(ctx.app)).agents.find((agent) => agent.id === solo.agent.id)!.status).toBe("idle"));
  });

  it("sem outra tarefa, segura a vaga pelo tempo configurado e depois libera (o agente fica livre)", async () => {
    const ctx = await setupApp({ runner: testRunner(), approvalParkMs: 40 });
    const solo = await soloTeam(ctx.app);
    const slow = await createTask(ctx.app, solo.room.id, solo.team.id, "Publicar [aprovar]");
    await ctx.log.waitForTask(slow.id, "waiting_approval");
    const orchestrator = runtimeOf(ctx).orchestrator as unknown as { slots: Map<string, unknown> };
    expect(orchestrator.slots.has(solo.agent.id)).toBe(true);
    await vi.waitFor(() => expect(orchestrator.slots.has(solo.agent.id)).toBe(false));
    expect((runtimeOf(ctx).orchestrator as unknown as { isParked(id: string): boolean }).isParked(slow.id)).toBe(true);
    // O agente está livre: uma tarefa que chega agora começa de imediato.
    const quick = await createTask(ctx.app, solo.room.id, solo.team.id, "Chegou depois");
    await ctx.log.waitForTask(quick.id, "done");
    expect(taskStatus(ctx, slow.id)).toBe("waiting_approval");
  });

  it("recusar uma tarefa parada a falha sem mexer na tarefa que roda no agente", async () => {
    const gate = gatedSleep();
    let gated = false;
    const ctx = await setupApp({ runner: testRunner({ sleep: (ms, signal) => (gated ? gate.sleep(ms, signal) : Promise.resolve()), minMs: 1, maxMs: 1 }), approvalParkMs: 0 });
    const solo = await soloTeam(ctx.app);
    const slow = await createTask(ctx.app, solo.room.id, solo.team.id, "Publicar [aprovar]");
    await ctx.log.waitForTask(slow.id, "waiting_approval");
    gated = true;
    const busy = await createTask(ctx.app, solo.room.id, solo.team.id, "Ocupada");
    await ctx.log.waitForTask(busy.id, "in_progress");
    const item = runtimeOf(ctx).forYou.list().find((candidate) => candidate.taskId === slow.id && candidate.status === "pendente")!;
    await call(ctx.app, "POST", `${API}/for-you/${item.id}/decision`, { status: "rejeitado" }, 200);
    await ctx.log.waitForTask(slow.id, "failed");
    expect(taskStatus(ctx, busy.id)).toBe("in_progress");
    gate.open();
    await ctx.log.waitForTask(busy.id, "done");
  });
});

describe("Freebuff: o agendador prefere quem já tem a hora aberta", () => {
  type Fake = { plan: object; task: { steps: { agentId: string }[]; current: number }; index: number };
  const candidate = (agentId: string): Fake => ({ plan: {}, task: { steps: [{ agentId }], current: 0 }, index: 0 });
  const agents = [
    { id: "ana", engine: "freebuff" },
    { id: "beto", engine: "freebuff" },
    { id: "caio", engine: "claude" },
    { id: "duda", engine: "freebuff" },
  ];
  const scheduler = (holds: Set<string>) =>
    new WorkScheduler({ deps: { holdsHour: (agent: { id: string }) => holds.has(agent.id), state: { read: () => ({ agents }) } } } as never, {} as never) as unknown as {
      preferOpenHours(list: Fake[]): Fake[];
    };
  const ids = (list: Fake[]) => list.map((entry) => entry.task.steps[0]!.agentId);

  it("dentro dos agentes de Freebuff, quem tem a hora aberta vai primeiro; os outros motores não mudam de lugar", () => {
    const list = [candidate("ana"), candidate("caio"), candidate("beto"), candidate("duda")];
    expect(ids(scheduler(new Set(["beto"])).preferOpenHours(list))).toEqual(["beto", "caio", "ana", "duda"]);
    expect(ids(scheduler(new Set(["duda", "beto"])).preferOpenHours(list))).toEqual(["beto", "caio", "duda", "ana"]);
  });

  it("sem ninguém com hora aberta, ou com um agente só, a ordem de importância fica como está", () => {
    const list = [candidate("ana"), candidate("beto"), candidate("caio")];
    expect(ids(scheduler(new Set()).preferOpenHours(list))).toEqual(["ana", "beto", "caio"]);
    expect(ids(scheduler(new Set(["ana"])).preferOpenHours([candidate("caio"), candidate("ana")]))).toEqual(["caio", "ana"]);
  });
});
