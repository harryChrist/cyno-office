import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry, AvulsasCleanupPreview, AvulsasCleanupResult, ForYouItem, Plan, Project, ProjectDeleteResult, ProjectTask, ServerEvent, Task } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import type { Sleep } from "../../engines/runner/sleep";
import { ActivityLog, setActivityLog } from "../activity/log";
import type { ProjectServiceDeps } from "./project-service";

/**
 * Apagar de vez: tarefas avulsas terminadas (em lote por idade e uma a uma) e projetos inteiros. Sem IA de verdade:
 * o agente é o simulado, e o relógio do app é do teste (as folhas "terminam" em datas combinadas).
 */
const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");
afterEach(() => setActivityLog(undefined));

const at = (iso: string) => new Date(iso);
type Reply = { project: Project; ref?: string; error?: string };

/** Relógio e portão do teste: com `hold`, as etapas ficam em andamento até o fim do teste. */
function world() {
  const clock = { now: at("2026-08-01T12:00:00.000Z") };
  const gate = gatedSleep();
  const state = { hold: false };
  const sleep: Sleep = (ms, signal) => (state.hold ? gate.sleep(ms, signal) : Promise.resolve());
  return { clock, state, runner: testRunner({ sleep }) };
}

async function setup() {
  const w = world();
  const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
  const entries: ActivityEntry[] = [];
  activity.onAppend((entry) => entries.push(entry));
  const ctx = await setupApp({ runner: w.runner, now: () => w.clock.now, activity });
  const { agent } = await soloTeam(ctx.app);
  const runtime = runtimeOf(ctx);
  const raw = () => (runtime.plans as unknown as { plans: Project[] }).plans;
  const avulsas = () => runtime.plans.list().find((project) => project.id === "avulsas")!;
  const logsDir = path.join(ctx.dir, "logs");
  const archiveDir = path.join(ctx.dir, "projects", "avulsas.archive");
  const logOf = (taskId: string) => path.join(logsDir, `${taskId}.jsonl`);
  /** O log da Task existe no disco (o agente simulado não escreve o log de CLI). */
  const withLog = async (taskId: string) => {
    await mkdir(logsDir, { recursive: true });
    await writeFile(logOf(taskId), `${JSON.stringify({ at: "x" })}\n`);
  };
  let slot = 0;
  /** Uma tarefa avulsa que termina em `finishedAt` (o relógio do app é ajustado para lá). Devolve a folha e o id da Task. */
  async function finishedLeaf(finishedAt: string, hold = false): Promise<{ ref: string; taskId: string }> {
    w.clock.now = at(finishedAt);
    w.state.hold = hold;
    slot += 1;
    const { task, project } = await runtime.plans.startRoutineTask({ routineId: "R-0001", routineTitle: "Rotina", mode: { kind: "pede-ok" }, scheduleId: "S1", slotKey: `${finishedAt}#${slot}`, period: "2026-W40", agentId: agent.id, title: `Tarefa ${slot}`, prompt: "Faça" });
    const leaf = project.tasks.find((candidate) => candidate.meta?.requestId === task.id)!;
    if (!hold) await vi.waitFor(() => expect(raw().find((plan) => plan.id === "avulsas")!.tasks.find((candidate) => candidate.ref === leaf.ref)!.status).toBe("concluida"), { timeout: 3000 });
    await withLog(task.id);
    return { ref: leaf.ref, taskId: task.id };
  }
  const preview = async (days: number) => (await ctx.app.inject({ method: "GET", url: `${API}/projects/avulsas/cleanup?olderThanDays=${days}` })).json<AvulsasCleanupPreview>();
  const cleanup = (body: object) => ctx.app.inject({ method: "POST", url: `${API}/projects/avulsas/cleanup`, payload: body });
  const del = (url: string) => ctx.app.inject({ method: "DELETE", url: `${API}${url}` });
  const taskIds = () => ctx.store.snapshot().tasks.map((task) => task.id);
  const archiveFiles = async () => (await readdir(archiveDir).catch(() => [] as string[])).sort();
  return { ctx, w, agent, runtime, raw, avulsas, logOf, withLog, finishedLeaf, preview, cleanup, del, taskIds, archiveDir, archiveFiles, entries };
}

describe("limpeza em lote das tarefas avulsas (GET/POST /projects/avulsas/cleanup)", () => {
  it("a pré-visualização é igual ao que o POST apaga; só o terminado e velho sai; Task rodando protege; arquivo mensal reescrito sem perder o resto", async () => {
    const t = await setup();
    // Quatro folhas terminadas em datas diferentes e uma que segue rodando.
    const aug = await t.finishedLeaf("2026-08-01T12:00:00.000Z");
    const sep1 = await t.finishedLeaf("2026-09-01T12:00:00.000Z");
    const sep2 = await t.finishedLeaf("2026-09-02T12:00:00.000Z");
    const sep20 = await t.finishedLeaf("2026-09-20T12:00:00.000Z");
    const running = await t.finishedLeaf("2026-09-25T12:00:00.000Z", true);
    // 1º de outubro: as três mais velhas (mais de 14 dias) vão para o arquivo mensal; a de 20/09 e a que roda ficam no vivo.
    t.w.clock.now = at("2026-10-01T12:00:00.000Z");
    expect(await t.runtime.plans.archiveDone()).toBe(3);
    expect(await t.archiveFiles()).toEqual(["2026-08.json", "2026-09.json"]);
    t.w.clock.now = at("2026-10-10T12:00:00.000Z");

    // Idades em 10/10: ago 70 d, set1 39 d, set2 38 d, set20 20 d, a que roda não conta.
    expect(await t.preview(15)).toEqual({ count: 1, archivedCount: 3, oldestAt: "2026-08-01T12:00:00.000Z" });
    expect(await t.preview(30)).toMatchObject({ count: 0, archivedCount: 3 });
    expect(await t.preview(45)).toEqual({ count: 0, archivedCount: 1, oldestAt: "2026-08-01T12:00:00.000Z" });
    expect(await t.preview(0)).toMatchObject({ count: 1, archivedCount: 3 });
    expect(await t.preview(365)).toEqual({ count: 0, archivedCount: 0 });
    expect((await t.ctx.app.inject({ method: "GET", url: `${API}/projects/avulsas/cleanup?olderThanDays=366` })).statusCode).toBe(400);
    expect((await t.ctx.app.inject({ method: "GET", url: `${API}/projects/avulsas/cleanup?olderThanDays=x` })).statusCode).toBe(400);
    expect((await t.ctx.app.inject({ method: "GET", url: `${API}/projects/avulsas/cleanup` })).statusCode).toBe(400);
    // Pré-visualizar não apaga nada.
    expect(t.avulsas().tasks.map((leaf) => leaf.ref)).toEqual([sep20.ref, running.ref]);
    expect(t.taskIds()).toEqual(expect.arrayContaining([aug.taskId, sep1.taskId, sep2.taskId, sep20.taskId, running.taskId]));

    // Só o arquivo, e só a mais velha (45 dias): o mês de agosto some do disco e o de setembro fica intacto com as duas.
    const before = (await t.cleanup({ olderThanDays: 45, includeArchive: true })).json<AvulsasCleanupResult>();
    expect(before).toEqual({ deleted: 0, archivedDeleted: 1 });
    expect(await t.archiveFiles()).toEqual(["2026-09.json"]);
    expect(((JSON.parse(await readFile(path.join(t.archiveDir, "2026-09.json"), "utf8")) as ProjectTask[]).map((leaf) => leaf.ref))).toEqual([sep1.ref, sep2.ref]);
    expect(t.taskIds()).not.toContain(aug.taskId);
    expect(existsSync(t.logOf(aug.taskId))).toBe(false);
    expect(existsSync(t.logOf(sep1.taskId))).toBe(true);

    // Sem includeArchive o arquivo não é tocado; a preview anunciou 1 no vivo e o POST apaga exatamente esse 1.
    const forecast = await t.preview(15);
    const live = (await t.cleanup({ olderThanDays: 15 })).json<AvulsasCleanupResult>();
    expect(live).toEqual({ deleted: forecast.count, archivedDeleted: 0 });
    expect(t.avulsas().tasks.map((leaf) => leaf.ref)).toEqual([running.ref]);
    expect(t.taskIds()).not.toContain(sep20.taskId);
    expect(existsSync(t.logOf(sep20.taskId))).toBe(false);
    expect(await t.archiveFiles()).toEqual(["2026-09.json"]);
    // O evento do projeto atualizado (sem a folha) e o retrato sem a Task saíram para as telas.
    const upserts = t.ctx.log.events.filter((event): event is Extract<ServerEvent, { type: "project:upserted" }> => event.type === "project:upserted" && event.project.id === "avulsas");
    expect(upserts.at(-1)!.project.tasks.map((leaf) => leaf.ref)).toEqual([running.ref]);
    const snapshot = t.ctx.log.events.filter((event) => event.type === "office:snapshot").at(-1) as Extract<ServerEvent, { type: "office:snapshot" }>;
    expect(snapshot.office.tasks.map((task) => task.id)).not.toContain(sep20.taskId);

    // Tudo com 0 dias e o arquivo: a que roda é protegida (nunca se apaga o que está em andamento).
    const all = (await t.cleanup({ olderThanDays: 0, includeArchive: true })).json<AvulsasCleanupResult>();
    expect(all).toEqual({ deleted: 0, archivedDeleted: 2 });
    expect(await t.archiveFiles()).toEqual([]);
    expect(t.avulsas().tasks.map((leaf) => leaf.ref)).toEqual([running.ref]);
    expect(t.taskIds()).toContain(running.taskId);
    expect(t.ctx.store.snapshot().tasks.find((task) => task.id === running.taskId)!.status).toBe("in_progress");
    expect(existsSync(t.logOf(running.taskId))).toBe(true);
    expect(existsSync(t.logOf(sep1.taskId))).toBe(false);

    // Idempotente: de novo não há nada, e a pré-visualização agora diz zero.
    expect((await t.cleanup({ olderThanDays: 0, includeArchive: true })).json<AvulsasCleanupResult>()).toEqual({ deleted: 0, archivedDeleted: 0 });
    expect(await t.preview(0)).toEqual({ count: 0, archivedCount: 0 });
    // A Atividade registra o que o dono apagou (e o histórico antigo não é mexido).
    expect(t.entries.filter((entry) => entry.action === "avulsas-apagadas").map((entry) => entry.summary)).toEqual(["Você apagou 1 tarefa avulsa", "Você apagou 1 tarefa avulsa", "Você apagou 2 tarefas avulsas"]);
  });

  it("valida o corpo; folha aberta, cancelada e falhada: só a cancelada sai; Task ativa de folha já terminada protege", async () => {
    const t = await setup();
    expect((await t.cleanup({})).statusCode).toBe(400);
    expect((await t.cleanup({ olderThanDays: -1 })).statusCode).toBe(400);
    expect((await t.cleanup({ olderThanDays: 400 })).statusCode).toBe(400);
    expect((await t.cleanup({ olderThanDays: 1.5 })).statusCode).toBe(400);
    expect((await t.cleanup({ olderThanDays: 7, includeArchive: "sim" })).statusCode).toBe(400);

    const done = await t.finishedLeaf("2026-09-01T12:00:00.000Z");
    const cancelled = await t.finishedLeaf("2026-09-01T13:00:00.000Z");
    const failed = await t.finishedLeaf("2026-09-01T14:00:00.000Z");
    const guarded = await t.finishedLeaf("2026-09-01T15:00:00.000Z", true);
    const leaf = (ref: string) => t.raw().find((plan) => plan.id === "avulsas")!.tasks.find((candidate) => candidate.ref === ref)!;
    Object.assign(leaf(cancelled.ref), { status: "cancelada" });
    Object.assign(leaf(failed.ref), { status: "falhou" });
    // Terminada no papel, mas a Task dela ainda roda (fabricado): protegida.
    Object.assign(leaf(guarded.ref), { status: "concluida", finishedAt: "2026-09-01T15:00:00.000Z" });
    t.w.clock.now = at("2026-11-01T12:00:00.000Z");
    expect(await t.preview(7)).toMatchObject({ count: 2 });
    expect((await t.cleanup({ olderThanDays: 7 })).json<AvulsasCleanupResult>()).toEqual({ deleted: 2, archivedDeleted: 0 });
    expect(t.avulsas().tasks.map((candidate) => candidate.ref).sort()).toEqual([failed.ref, guarded.ref].sort());
    expect(t.taskIds()).toEqual(expect.arrayContaining([failed.taskId, guarded.taskId]));
    expect(t.taskIds()).not.toEqual(expect.arrayContaining([done.taskId]));
    expect(t.taskIds()).not.toEqual(expect.arrayContaining([cancelled.taskId]));
  });

  it("itens do Para você ligados às Tasks apagadas saem da lista e o evento sai; o de outra folha fica", async () => {
    const t = await setup();
    const gone = await t.finishedLeaf("2026-09-01T12:00:00.000Z");
    const kept = await t.finishedLeaf("2026-10-30T12:00:00.000Z");
    const room = t.ctx.store.snapshot().tasks.find((task) => task.id === gone.taskId)!;
    const mk = (id: string, taskId: string): ForYouItem => ({ id, taskId, agentId: room.agentId!, roomId: room.roomId, type: "texto", status: "pendente", meta: {}, text: "x", editedByUser: false }) as ForYouItem;
    const items = (t.runtime as unknown as { state: { commit: (change: object) => Promise<void> } }).state;
    await items.commit({ forYou: [mk("A-9001", gone.taskId), mk("A-9002", kept.taskId)], events: [] });
    t.w.clock.now = at("2026-11-01T12:00:00.000Z");
    await t.cleanup({ olderThanDays: 14 });
    expect(t.runtime.forYou.list().map((item) => item.id)).toEqual(["A-9002"]);
    expect(t.ctx.log.events.some((event) => event.type === "foryou:deleted" && event.id === "A-9001")).toBe(true);
  });
});

describe("retenção diária das tarefas avulsas (ajuste avulsasDays)", () => {
  it("0 não muda nada; acima de 0 a limpeza apaga só o terminado e velho (vivo e arquivo) e protege o que roda", async () => {
    const t = await setup();
    const inArchive = await t.finishedLeaf("2026-07-01T12:00:00.000Z");
    const old = await t.finishedLeaf("2026-09-01T12:00:00.000Z");
    const recent = await t.finishedLeaf("2026-10-25T12:00:00.000Z");
    const running = await t.finishedLeaf("2026-08-01T12:00:00.000Z", true);
    t.w.clock.now = at("2026-08-20T12:00:00.000Z");
    expect(await t.runtime.plans.archiveDone()).toBe(1);
    t.w.clock.now = at("2026-11-01T12:00:00.000Z");
    const retention = (body: object) => t.ctx.app.inject({ method: "PATCH", url: "/api/settings/retention", payload: body });
    const clean = () => t.ctx.app.inject({ method: "POST", url: "/api/settings/retention/cleanup" });

    // Padrão: 0 (nunca). A limpeza do dia roda e nada some.
    expect((await clean()).statusCode).toBe(200);
    expect(t.avulsas().tasks.map((leaf) => leaf.ref).sort()).toEqual([old.ref, recent.ref, running.ref].sort());
    expect(await t.runtime.plans.findTask("avulsas", inArchive.ref)).toBeDefined();

    // 30 dias: some a do arquivo (mais de 30) e a de setembro (61 dias); a de 7 dias e a que roda ficam.
    expect((await retention({ avulsasDays: 30 })).statusCode).toBe(200);
    expect((await clean()).statusCode).toBe(200);
    expect(t.avulsas().tasks.map((leaf) => leaf.ref).sort()).toEqual([recent.ref, running.ref].sort());
    expect(await t.runtime.plans.findTask("avulsas", inArchive.ref)).toBeUndefined();
    expect(t.taskIds()).toEqual(expect.arrayContaining([recent.taskId, running.taskId]));
    expect(t.taskIds()).not.toEqual(expect.arrayContaining([old.taskId]));
    expect(t.taskIds()).not.toEqual(expect.arrayContaining([inArchive.taskId]));
    expect(existsSync(t.logOf(old.taskId))).toBe(false);
    expect(existsSync(t.logOf(inArchive.taskId))).toBe(false);
    expect(existsSync(t.logOf(recent.taskId))).toBe(true);
    expect(existsSync(t.logOf(running.taskId))).toBe(true);
    expect(t.entries.some((entry) => entry.actor === "sistema" && entry.action === "avulsas-apagadas")).toBe(true);

    // De volta a 0: nada mais é apagado, nem com o tempo passando.
    expect((await retention({ avulsasDays: 0 })).statusCode).toBe(200);
    t.w.clock.now = at("2027-06-01T12:00:00.000Z");
    expect((await clean()).statusCode).toBe(200);
    expect(t.avulsas().tasks.map((leaf) => leaf.ref).sort()).toEqual([recent.ref, running.ref].sort());
  });
});

describe("DELETE /projects/:id/tasks/:ref (uma tarefa avulsa terminada)", () => {
  it("apaga a folha, a Task e o log; 404 se não existe; 409 se não terminou, se tem Task rodando ou se não é o Avulsas", async () => {
    const t = await setup();
    const done = await t.finishedLeaf("2026-10-30T12:00:00.000Z");
    const running = await t.finishedLeaf("2026-10-31T12:00:00.000Z", true);
    const ok = await t.del(`/projects/avulsas/tasks/${done.ref}`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ project: Project }>().project.tasks.map((leaf) => leaf.ref)).toEqual([running.ref]);
    expect(t.avulsas().tasks.map((leaf) => leaf.ref)).toEqual([running.ref]);
    expect(t.taskIds()).not.toContain(done.taskId);
    expect(existsSync(t.logOf(done.taskId))).toBe(false);
    expect(t.entries.map((entry) => entry.summary)).toContain("Você apagou a tarefa avulsa “Rotina: Tarefa 1”");
    // Já apagada: 404 (não existe mais, nem no arquivo).
    expect((await t.del(`/projects/avulsas/tasks/${done.ref}`)).statusCode).toBe(404);
    expect((await t.del("/projects/avulsas/tasks/A999")).statusCode).toBe(404);

    // Aberta (rodando): 409 com mensagem em português.
    const open = await t.del(`/projects/avulsas/tasks/${running.ref}`);
    expect(open.statusCode).toBe(409);
    expect(open.json<Reply>().error).toMatch(/ainda não terminou/);
    // Terminada no papel, mas com Task rodando (fabricado): 409 também.
    Object.assign(t.raw().find((plan) => plan.id === "avulsas")!.tasks.find((leaf) => leaf.ref === running.ref)!, { status: "concluida", finishedAt: "2026-10-31T12:00:00.000Z" });
    const busy = await t.del(`/projects/avulsas/tasks/${running.ref}`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json<Reply>().error).toMatch(/execução em andamento/);
    expect(t.taskIds()).toContain(running.taskId);

    // Projeto comum: 409 (apagar no meio quebraria os "Depois de"); projeto que não existe: 404.
    const project = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title: "Campanha" } })).json<Reply>().project;
    const task = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${project.id}/tasks`, payload: { title: "Post" } })).json<Reply>().ref!;
    const common = await t.del(`/projects/${project.id}/tasks/${task}`);
    expect(common.statusCode).toBe(409);
    expect(common.json<Reply>().error).toMatch(/Avulsas/);
    expect(t.runtime.plans.get(project.id).tasks.map((candidate) => candidate.ref)).toEqual([task]);
    expect((await t.del(`/projects/nao-existe/tasks/${task}`)).statusCode).toBe(404);
  });

  it("apaga uma tarefa cancelada e uma que já estava no arquivo mensal", async () => {
    const t = await setup();
    const old = await t.finishedLeaf("2026-08-01T12:00:00.000Z");
    const other = await t.finishedLeaf("2026-08-02T12:00:00.000Z");
    const cancelled = await t.finishedLeaf("2026-10-30T12:00:00.000Z");
    Object.assign(t.raw().find((plan) => plan.id === "avulsas")!.tasks.find((leaf) => leaf.ref === cancelled.ref)!, { status: "cancelada" });
    t.w.clock.now = at("2026-11-01T12:00:00.000Z");
    expect(await t.runtime.plans.archiveDone()).toBe(2);
    expect(await t.runtime.plans.findTask("avulsas", old.ref)).toMatchObject({ ref: old.ref });

    expect((await t.del(`/projects/avulsas/tasks/${old.ref}`)).statusCode).toBe(200);
    expect(await t.runtime.plans.findTask("avulsas", old.ref)).toBeUndefined();
    expect(await t.runtime.plans.findTask("avulsas", other.ref)).toMatchObject({ ref: other.ref });
    expect(t.taskIds()).not.toContain(old.taskId);
    expect(t.taskIds()).toContain(other.taskId);
    expect(existsSync(t.logOf(old.taskId))).toBe(false);
    expect((await t.del(`/projects/avulsas/tasks/${cancelled.ref}`)).statusCode).toBe(200);
    expect(t.avulsas().tasks).toEqual([]);
  });
});

describe("DELETE /projects/:id (um projeto inteiro)", () => {
  const newProject = async (t: Awaited<ReturnType<typeof setup>>, title: string): Promise<Project> => (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title } })).json<Reply>().project;
  const addTask = async (t: Awaited<ReturnType<typeof setup>>, id: string, title: string, extra: object = {}): Promise<string> => {
    const response = await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${id}/tasks`, payload: { title, ...extra } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Reply>().ref!;
  };
  const stepTasks = (t: Awaited<ReturnType<typeof setup>>, id: string) => t.ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === id);

  it("apaga o projeto terminado com as Tasks, os logs e o arquivo; some do retrato; o Avulsas nunca; 404 se não existe", async () => {
    const t = await setup();
    const project = await newProject(t, "Campanha de verão");
    await addTask(t, project.id, "Post 1", { assignee: t.agent.id });
    await addTask(t, project.id, "Post 2", { assignee: t.agent.id });
    const keep = await newProject(t, "Outro projeto");
    await vi.waitFor(() => expect(stepTasks(t, project.id).filter((task) => task.status === "done")).toHaveLength(2), { timeout: 3000 });
    const ids = stepTasks(t, project.id).map((task) => task.id);
    for (const id of ids) await t.withLog(id);
    const projectFile = path.join(t.ctx.dir, "projects", `${project.id}.json`);
    await vi.waitFor(() => expect(existsSync(projectFile)).toBe(true));

    const response = await t.del(`/projects/${project.id}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ProjectDeleteResult>()).toEqual({ deleted: { tasks: 2, logs: 2 } });
    expect(existsSync(projectFile)).toBe(false);
    expect(t.runtime.plans.list().map((plan) => plan.id)).not.toContain(project.id);
    expect(t.runtime.plans.list().map((plan) => plan.id)).toContain(keep.id);
    expect((await t.ctx.app.inject({ method: "GET", url: `${API}/plans/${project.id}` })).statusCode).toBe(404);
    expect(stepTasks(t, project.id)).toEqual([]);
    for (const id of ids) expect(existsSync(t.logOf(id))).toBe(false);
    expect(t.ctx.log.events.filter((event) => event.type === "project:deleted" || event.type === "project:removed").map((event) => event.type)).toEqual(["project:deleted", "project:removed"]);
    expect(t.entries.map((entry) => entry.summary)).toContain("Você apagou o projeto “Campanha de verão”");
    // O estado gravado no disco acompanha: reabrir não traz o projeto de volta.
    expect(await readdir(path.join(t.ctx.dir, "projects"))).not.toContain(`${project.id}.json`);

    // Apagar de novo: 404.
    expect((await t.del(`/projects/${project.id}`)).statusCode).toBe(404);
    expect((await t.del("/projects/nao-existe")).statusCode).toBe(404);
    // O Avulsas nunca se apaga (existindo ou não ainda).
    const avulsas = await t.del("/projects/avulsas");
    expect(avulsas.statusCode).toBe(409);
    expect(avulsas.json<Reply>().error).toMatch(/nunca/);
    await t.finishedLeaf("2026-10-30T12:00:00.000Z");
    expect((await t.del("/projects/avulsas")).statusCode).toBe(409);
    expect(t.runtime.plans.list().some((plan) => plan.id === "avulsas")).toBe(true);
    // Pedido que virou folha do Avulsas (vista de projeto): 409 explicando, nunca apaga nada.
    const requestId = t.avulsas().tasks[0]!.meta!.requestId!;
    expect((await t.del(`/projects/${requestId}`)).statusCode).toBe(409);
    expect(t.avulsas().tasks).toHaveLength(1);
  });

  it("com tarefa rodando: 409 e nada muda; parada a tarefa, apaga", async () => {
    const t = await setup();
    t.w.state.hold = true;
    const project = await newProject(t, "Em andamento");
    const ref = await addTask(t, project.id, "Post", { assignee: t.agent.id });
    await vi.waitFor(() => expect(stepTasks(t, project.id).some((task) => task.status === "in_progress")).toBe(true), { timeout: 3000 });
    const running = stepTasks(t, project.id)[0]!;
    const refused = await t.del(`/projects/${project.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<Reply>().error).toBe("Pare as tarefas em andamento antes de apagar o projeto");
    expect(t.runtime.plans.list().map((plan) => plan.id)).toContain(project.id);
    expect(t.taskIds()).toContain(running.id);
    expect(t.ctx.log.events.some((event) => event.type === "project:deleted")).toBe(false);

    // Cancelada a tarefa, o projeto sai.
    expect((await t.ctx.app.inject({ method: "PATCH", url: `${API}/projects/${project.id}/tasks/${ref}`, payload: { status: "cancelada" } })).statusCode).toBe(200);
    await vi.waitFor(() => expect(t.ctx.store.snapshot().tasks.find((task) => task.id === running.id)!.status).toBe("failed"), { timeout: 3000 });
    expect((await t.del(`/projects/${project.id}`)).statusCode).toBe(200);
    expect(t.runtime.plans.list().map((plan) => plan.id)).not.toContain(project.id);
  });

  it("tarefas que ainda não começaram saem junto e nada dispara depois (agendador e estado de tasks)", async () => {
    const t = await setup();
    const project = await newProject(t, "Pausado");
    expect((await t.ctx.app.inject({ method: "PATCH", url: `${API}/projects/${project.id}`, payload: { status: "pausado" } })).statusCode).toBe(200);
    await addTask(t, project.id, "Ainda não começou", { assignee: t.agent.id });
    await addTask(t, project.id, "Depois", { assignee: t.agent.id });
    expect(stepTasks(t, project.id)).toEqual([]);
    const response = await t.del(`/projects/${project.id}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ProjectDeleteResult>()).toEqual({ deleted: { tasks: 2, logs: 0 } });
    const before = t.ctx.log.events.length;
    t.runtime.plans.pump();
    t.runtime.plans.resume();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stepTasks(t, project.id)).toEqual([]);
    expect(t.runtime.plans.list().map((plan) => plan.id)).not.toContain(project.id);
    expect(t.ctx.log.events.slice(before).some((event) => event.type === "task:upserted" && event.task.work?.projectId === project.id)).toBe(false);
    expect(t.ctx.log.events.slice(before).some((event) => event.type === "project:upserted" && event.project.id === project.id)).toBe(false);
  });

  it("plano esperando aprovação: o item aberto do Para você sai da lista e o pedido do Maestro fecha", async () => {
    const t = await setup();
    const created = await t.ctx.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[plano] Campanha de lançamento" } });
    expect(created.statusCode).toBe(201);
    const request = created.json<Task>();
    const planEvent = (await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === request.id)) as Extract<ServerEvent, { type: "project:upserted" }>;
    const plan: Plan = planEvent.project;
    await t.ctx.log.waitForTask(request.id, "waiting_approval");
    const open = t.runtime.forYou.list().filter((item) => item.projectId === plan.id && item.status === "pendente");
    expect(open.length).toBeGreaterThan(0);

    const response = await t.del(`/projects/${plan.id}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(t.runtime.forYou.list().filter((item) => item.projectId === plan.id)).toEqual([]);
    for (const item of open) expect(t.ctx.log.events.some((event) => event.type === "foryou:deleted" && event.id === item.id)).toBe(true);
    expect(t.runtime.plans.list().map((project) => project.id)).not.toContain(plan.id);
    // O pedido do Maestro não fica esperando um plano que não existe mais (e o histórico da Atividade segue).
    await vi.waitFor(() => expect(t.ctx.store.snapshot().tasks.find((task) => task.id === request.id)!.status).not.toBe("waiting_approval"), { timeout: 3000 });
    expect(t.entries.map((entry) => entry.summary)).toContain(`Você apagou o projeto “${plan.title}”`);
  });

  it("falha ao gravar no disco: 500 e o projeto continua (nada some pela metade); depois apaga", async () => {
    const t = await setup();
    const project = await newProject(t, "Resiste");
    const deps = (t.runtime.plans as unknown as { deps: ProjectServiceDeps }).deps;
    deps.persistDelaysMs = [0, 0];
    const commit = vi.spyOn(deps.state, "commit");
    commit.mockRejectedValueOnce(new Error("disco cheio")).mockRejectedValueOnce(new Error("disco cheio")).mockRejectedValueOnce(new Error("disco cheio"));
    const failed = await t.del(`/projects/${project.id}`);
    expect(failed.statusCode).toBe(500);
    expect(t.runtime.plans.list().map((plan) => plan.id)).toContain(project.id);
    commit.mockRestore();
    expect((await t.del(`/projects/${project.id}`)).statusCode).toBe(200);
    expect(t.runtime.plans.list().map((plan) => plan.id)).not.toContain(project.id);
  });
});
