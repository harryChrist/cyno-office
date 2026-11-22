import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry, ForYouItem, Project, ProjectTask, Task } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import { OfficeStore } from "../../store/office-store";
import { ActivityLog, setActivityLog } from "../activity/log";
import { ProjectService, type ProjectHost } from "./project-service";

/**
 * LOTE 3 (Servidor + MCP): poderes do Maestro sobre projetos, módulos e tarefas.
 * - `release` item a item + herança de módulo + aprovação mantendo o do Maestro vs override do dono
 * - `addTasks`/`decideTask` por `project_id` (inclusive projeto manual) e reabertura automática de `concluido`
 * - `update_task`, `delete_task` (subárvore, dependsOn, logs, recusa com folha rodando, snapshot na Atividade)
 * - `set_project_status` + rotas `reopen`/`complete`/DELETE de item
 * - `propose` sobre concluído/cancelado recusado; vários projetos no mesmo pedido (`new_project: true`, reload do disco)
 * - `get_project` resumido para árvores grandes (> 40 itens) + expansão por `ref`
 */

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");
const AT = "2026-11-21T15:00:00.000Z";
afterEach(() => setActivityLog(undefined));

const find = (project: Project, ref: string): ProjectTask => project.tasks.find((task) => task.ref === ref)!;

async function setup(options: { gated?: boolean } = {}) {
  const clock = { now: Date.parse(AT) };
  const gate = gatedSleep();
  const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
  const entries: ActivityEntry[] = [];
  activity.onAppend((entry) => entries.push(entry));
  const ctx = await setupApp({ activity, now: () => new Date(clock.now), runner: testRunner(options.gated ? { sleep: gate.sleep } : {}) });
  const { agent } = await soloTeam(ctx.app);
  const runtime = runtimeOf(ctx);
  /** Cria um pedido aberto do Maestro no estado (sem disparar o coordenador simulado). */
  const openRequest = async (id: string, title = "Pedido do teste"): Promise<Task> => {
    const state = runtime.state.read();
    const maestro = state.agents.find((candidate) => candidate.id === "maestro")!;
    const team = state.teams.find((candidate) => candidate.id === maestro.teamId)!;
    const req: Task = { id, roomId: team.roomId, teamId: team.id, agentId: maestro.id, role: "request", prompt: title, status: "in_progress", createdAt: new Date(clock.now).toISOString(), updatedAt: new Date(clock.now).toISOString() };
    state.tasks.push(req);
    await runtime.state.commit({ tasks: state.tasks, events: [] });
    return req;
  };
  return { ctx, clock, gate, entries, agent, runtime, openRequest };
}

describe("release na proposta e aprovação mantendo o que o Maestro definiu", () => {
  it("create_project grava released por item com herança de módulo; approve sem release mantém; all/none do dono vence", async () => {
    const t = await setup({ gated: true });
    await t.openRequest("req-rel-1", "Livro");
    const proposed = await t.runtime.plans.propose("req-rel-1", {
      release: "later",
      tasks: [
        { ref: "M1", title: "Base", briefing: "m", kind: "module", release: "now" },
        { ref: "T1", title: "Cap 1", briefing: "t", owner: t.agent.id, parent: "M1" },
        { ref: "T2", title: "Cap 2", briefing: "t", owner: t.agent.id, parent: "M1", release: "later" },
        { ref: "M2", title: "Futuro", briefing: "m", kind: "module" },
        { ref: "T3", title: "Cap 3", briefing: "t", owner: t.agent.id, parent: "M2" },
        { ref: "T4", title: "Cap 4", briefing: "t", owner: t.agent.id, parent: "M2", release: "now" },
      ],
    });
    expect(find(proposed, "M1").released).toBe(true);
    expect(find(proposed, "T1").released).toBe(true);
    expect(find(proposed, "T2").released).toBe(false);
    expect(find(proposed, "M2").released).toBe(false);
    expect(find(proposed, "T3").released).toBe(false);
    expect(find(proposed, "T4").released).toBe(true);

    // Aprovar pelo cartão do Para você SEM `release` mantém exatamente o que o Maestro definiu.
    const card = t.runtime.forYou.list().find((item) => item.projectId === proposed.id)!;
    const decided = await t.ctx.app.inject({ method: "POST", url: `${API}/for-you/${card.id}/decision`, payload: { status: "aprovado" } });
    expect(decided.statusCode, decided.body).toBe(200);
    const approved = t.runtime.plans.get(proposed.id);
    expect([find(approved, "T1").released, find(approved, "T2").released, find(approved, "T3").released, find(approved, "T4").released]).toEqual([true, false, false, true]);
    expect(t.entries.find((entry) => entry.action === "plano-aprovado")).toMatchObject({ data: { release: "mixed" } });

    // Override do dono com "all" vence sobre "later" do Maestro.
    await t.openRequest("req-rel-2", "Outro");
    await t.runtime.plans.propose("req-rel-2", { release: "later", tasks: [{ ref: "T1", title: "A", briefing: "a", owner: t.agent.id }] });
    const allRes = await t.ctx.app.inject({ method: "POST", url: `${API}/plans/req-rel-2/approve`, payload: { release: "all" } });
    expect(allRes.statusCode).toBe(200);
    expect(find(allRes.json<Project>(), "T1").released).toBe(true);

    // Override do dono com "none" vence sobre "now" do Maestro.
    await t.openRequest("req-rel-3", "Mais um");
    await t.runtime.plans.propose("req-rel-3", { release: "now", tasks: [{ ref: "T1", title: "A", briefing: "a", owner: t.agent.id }] });
    const noneRes = await t.ctx.app.inject({ method: "POST", url: `${API}/plans/req-rel-3/approve`, payload: { release: "none" } });
    expect(noneRes.statusCode).toBe(200);
    expect(find(noneRes.json<Project>(), "T1").released).toBe(false);
    t.gate.open();
  });

  it("add_project_tasks com project_id funciona em projeto manual; pai planejado + filho now explícito vale o filho", async () => {
    const t = await setup();
    const created = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title: "Manual" } })).json<{ project: Project }>().project;
    const modRef = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${created.id}/tasks`, payload: { title: "Módulo Planejado", group: true } })).json<{ ref: string }>().ref;
    expect(find(t.runtime.plans.get(created.id), modRef).released).toBe(false);

    const updated = t.runtime.plans.addTasks(
      { projectId: created.id },
      [
        { ref: "X1", title: "Herda pai planejado", briefing: "b", owner: t.agent.id, parent: modRef },
        { ref: "X2", title: "Explícito now", briefing: "b", owner: t.agent.id, parent: modRef, release: "now" },
        { ref: "X3", title: "Solta later", briefing: "b", owner: t.agent.id },
      ],
      { release: "later" },
    );
    expect(find(updated, "X1").released).toBe(false);
    expect(find(updated, "X2").released).toBe(true);
    expect(find(updated, "X3").released).toBe(false);
  });
});

describe("update_task e delete_task (e DELETE /projects/:id/tasks/:ref)", () => {
  it("update_task edita tarefa e módulo (recusa owner em módulo e ciclo em dependsOn)", async () => {
    const t = await setup();
    const project = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title: "Edição" } })).json<{ project: Project }>().project;
    t.runtime.plans.addTasks(
      { projectId: project.id },
      [
        { ref: "M1", title: "Mod 1", briefing: "m", kind: "module" },
        { ref: "T1", title: "A", briefing: "a", owner: t.agent.id, parent: "M1" },
        { ref: "M2", title: "Mod 2", briefing: "m", kind: "module" },
        { ref: "T2", title: "B", briefing: "b", owner: t.agent.id, parent: "M2" },
      ],
      { release: "later" },
    );
    const edited = await t.runtime.plans.updateTask(project.id, "M2", { title: "Módulo 2", dependsOn: ["M1"], priority: "alta" }, "maestro");
    expect(find(edited, "M2")).toMatchObject({ title: "Módulo 2", dependsOn: ["M1"], priority: "alta" });
    expect(find(edited, "T2").status).toBe("backlog");
    // Ciclo M1 -> M2 recusado
    await expect(t.runtime.plans.updateTask(project.id, "M1", { dependsOn: ["M2"] }, "maestro")).rejects.toThrow(/ciclo/);
    // Owner em módulo recusado com mensagem clara
    await expect(t.runtime.plans.updateTask(project.id, "M1", { assignee: t.agent.id }, "maestro")).rejects.toThrow(/module.*no owner/i);
    // Atividade registrada como Maestro
    expect(t.entries.find((entry) => entry.action === "tarefa-editada")).toMatchObject({ actor: "maestro" });
  });

  it("delete_task apaga subárvore inteira, limpa dependsOn, logs, Tasks e ForYou, recalcula ocioso e grava snapshot; recusa folha rodando", async () => {
    const t = await setup({ gated: true });
    const project = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title: "Limpeza" } })).json<{ project: Project }>().project;
    t.runtime.plans.addTasks(
      { projectId: project.id },
      [
        { ref: "M1", title: "Módulo apagável", briefing: "desc módulo", kind: "module" },
        { ref: "T1", title: "Filha 1", briefing: "f1", owner: t.agent.id, parent: "M1" },
        { ref: "T2", title: "Filha 2", briefing: "f2", owner: t.agent.id, parent: "M1", depends_on: ["T1"] },
        { ref: "T3", title: "Dependente", briefing: "dep", owner: t.agent.id, depends_on: ["M1"] },
        { ref: "T4", title: "Rodando", briefing: "run", owner: t.agent.id },
      ],
      { release: "later" },
    );
    expect(find(t.runtime.plans.get(project.id), "T3").status).toBe("backlog");

    // Simula Task finalizada + log + item no Para você ligados a T1
    const state = t.runtime.state.read();
    const fakeTaskId = "11111111-1111-1111-1111-111111111111";
    state.tasks.push({ id: fakeTaskId, roomId: state.rooms[1]!.id, teamId: t.agent.teamId, agentId: t.agent.id, prompt: "f1", status: "done", work: { projectId: project.id, ref: "T1", step: 0 }, createdAt: AT, updatedAt: AT });
    const fakeForYou: ForYouItem = { id: "A-8881", taskId: fakeTaskId, projectId: project.id, taskRef: "T1", agentId: t.agent.id, roomId: state.rooms[1]!.id, type: "texto", status: "pendente", meta: {}, text: "x", editedByUser: false, createdAt: AT } as ForYouItem;
    await t.runtime.state.commit({ tasks: state.tasks, forYou: [fakeForYou], events: [] });
    const logPath = path.join(t.ctx.dir, "logs", `${fakeTaskId}.jsonl`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, '{"at":"x"}\n');

    // Libera T4 para colocá-la em andamento: delete_task em T4 deve ser recusado com 409.
    await t.runtime.plans.releaseWork(project.id, { refs: ["T4"] }, "maestro");
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === project.id && event.project.tasks.find((task) => task.ref === "T4")?.status === "em_andamento");
    await expect(t.runtime.plans.deleteTask(project.id, "T4", { by: "maestro" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await t.ctx.app.inject({ method: "DELETE", url: `${API}/projects/${project.id}/tasks/T4` })).statusCode).toBe(409);

    // Apagar M1 apaga M1, T1, T2, remove M1 de T3.dependsOn (T3 vira a_fazer!), remove Task, ForYou e log, e grava snapshot.
    const res = await t.runtime.plans.deleteTask(project.id, "M1", { by: "maestro", reason: "mudou o escopo" });
    expect(res.deleted).toEqual(["M1", "T1", "T2"]);
    expect(res.cleanedDependsOn).toEqual([{ ref: "T3", removed: ["M1"] }]);
    expect(res.project.tasks.map((task) => task.ref)).toEqual(["T3", "T4"]);
    expect(find(res.project, "T3")).toMatchObject({ dependsOn: [], status: "a_fazer" });
    expect(t.runtime.state.read().tasks.some((task) => task.id === fakeTaskId)).toBe(false);
    expect(t.runtime.forYou.list().some((item) => item.id === "A-8881")).toBe(false);
    expect(existsSync(logPath)).toBe(false);
    const act = t.entries.find((entry) => entry.action === "tarefa-apagada");
    expect(act).toMatchObject({
      actor: "maestro",
      summary: "O Maestro apagou “Módulo apagável” (3 itens) em “Limpeza”",
      data: { ref: "M1", title: "Módulo apagável", briefing: "desc módulo", deletedRefs: ["M1", "T1", "T2"], reason: "mudou o escopo" },
    });

    // Rota DELETE /projects/:id/tasks/:ref do dono apaga T3 com actor usuario.
    const delRoute = await t.ctx.app.inject({ method: "DELETE", url: `${API}/projects/${project.id}/tasks/T3` });
    expect(delRoute.statusCode, delRoute.body).toBe(200);
    expect(delRoute.json<{ project: Project }>().project.tasks.map((task) => task.ref)).toEqual(["T4"]);
    expect(t.entries.filter((entry) => entry.action === "tarefa-apagada").at(-1)).toMatchObject({ actor: "usuario" });
    t.gate.open();
  });
});

describe("set_project_status, reabertura automática e rotas reopen/complete", () => {
  it("concluir (recusa com folha rodando), reabrir concluído e cancelado (canceladas ficam canceladas), pausar/retomar e Avulsas intocável", async () => {
    const t = await setup({ gated: true });
    const project = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title: "Ciclo" } })).json<{ project: Project }>().project;
    t.runtime.plans.addTasks(
      { projectId: project.id },
      [
        { ref: "T1", title: "Uma", briefing: "a", owner: t.agent.id },
        { ref: "T2", title: "Duas", briefing: "b", owner: t.agent.id },
      ],
      { release: "later" },
    );
    // Avulsas nunca muda de status
    await expect(t.runtime.plans.setProjectStatus("avulsas", "pausado", "maestro")).rejects.toMatchObject({ statusCode: 409 });
    expect((await t.ctx.app.inject({ method: "POST", url: `${API}/projects/avulsas/complete` })).statusCode).toBe(409);
    expect((await t.ctx.app.inject({ method: "POST", url: `${API}/projects/avulsas/reopen` })).statusCode).toBe(409);

    // Folha rodando impede concluir (409)
    await t.runtime.plans.releaseWork(project.id, { refs: ["T1"] }, "maestro");
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === project.id && event.project.tasks.find((task) => task.ref === "T1")?.status === "em_andamento");
    await expect(t.runtime.plans.setProjectStatus(project.id, "concluido", "maestro")).rejects.toMatchObject({ statusCode: 409 });
    expect((await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${project.id}/complete` })).statusCode).toBe(409);

    // Cancela T1 -> agora dá para concluir; T2 aberta fica como está, finishedAt e doneNotified: true gravados
    await t.runtime.plans.updateTask(project.id, "T1", { status: "cancelada" });
    const completed = await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${project.id}/complete` });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json<{ project: Project }>().project).toMatchObject({ status: "concluido", doneNotified: true });
    expect(completed.json<{ project: Project }>().project.finishedAt).toBeDefined();
    expect(find(completed.json<{ project: Project }>().project, "T2").status).toBe("a_fazer");

    // Reabrir concluído pela rota /reopen
    const reopened = await t.ctx.app.inject({ method: "POST", url: `${API}/projects/${project.id}/reopen` });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const afterReopen = reopened.json<{ project: Project }>().project;
    expect(afterReopen.status).toBe("ativo");
    expect(afterReopen.finishedAt).toBeUndefined();
    expect(afterReopen.doneNotified).toBeUndefined();

    // Pausar e cancelar como Maestro, depois reabrir cancelado (tarefas canceladas seguem canceladas!)
    const paused = await t.runtime.plans.setProjectStatus(project.id, "pausado", "maestro");
    expect(paused.status).toBe("pausado");
    expect(paused.pausedAt).toBeDefined();
    const canceled = await t.runtime.plans.setProjectStatus(project.id, "cancelado", "maestro");
    expect(canceled.status).toBe("cancelado");
    expect(find(canceled, "T2").status).toBe("cancelada");
    const reopenedCanceled = await t.runtime.plans.setProjectStatus(project.id, "ativo", "maestro");
    expect(reopenedCanceled.status).toBe("ativo");
    expect(reopenedCanceled.finishedAt).toBeUndefined();
    expect(find(reopenedCanceled, "T2").status).toBe("cancelada");
    expect(t.entries.filter((entry) => entry.actor === "maestro").map((entry) => entry.summary)).toEqual(
      expect.arrayContaining(["O Maestro pausou o projeto “Ciclo”", "O Maestro cancelou o projeto “Ciclo”", "O Maestro reabriu o projeto “Ciclo”"]),
    );
    t.gate.open();
  });

  it("adicionar item a projeto concluído (qualquer origem) reabre sozinho; propose sem new_project sobre concluído/cancelado recusa", async () => {
    const t = await setup();
    await t.openRequest("req-reopen", "Campanha");
    await t.runtime.plans.propose("req-reopen", { release: "later", tasks: [{ ref: "T1", title: "A", briefing: "a", owner: t.agent.id }] });
    await t.runtime.plans.approve("req-reopen");
    await t.runtime.plans.setProjectStatus("req-reopen", "concluido", "maestro");
    expect(t.runtime.plans.get("req-reopen").status).toBe("concluido");

    // propose sem new_project sobre concluído -> erro em inglês, sem apagar o conteúdo!
    await expect(t.runtime.plans.propose("req-reopen", { release: "later", tasks: [{ ref: "Z1", title: "Novo", briefing: "n", owner: t.agent.id }] })).rejects.toThrow(/completed project[\s\S]*new_project: true/);
    expect(t.runtime.plans.get("req-reopen").tasks.map((task) => task.ref)).toEqual(["T1"]);

    // add_project_tasks reabre sozinho e registra na Atividade
    const reopened = t.runtime.plans.addTasks({ projectId: "req-reopen" }, [{ ref: "T2", title: "Mais uma", briefing: "b", owner: t.agent.id }], { release: "later" });
    expect(reopened.status).toBe("ativo");
    expect(reopened.finishedAt).toBeUndefined();
    expect(t.entries.some((entry) => entry.action === "projeto-reaberto" && entry.actor === "maestro")).toBe(true);

    // Cancelado exige reabrir explicitamente (addTasks recusa, propose sem new_project recusa)
    await t.runtime.plans.setProjectStatus("req-reopen", "cancelado", "maestro");
    expect(() => t.runtime.plans.addTasks({ projectId: "req-reopen" }, [{ ref: "T3", title: "X", briefing: "x", owner: t.agent.id }], { release: "later" })).toThrow(/canceled/i);
    await expect(t.runtime.plans.propose("req-reopen", { release: "later", tasks: [{ ref: "Z1", title: "Novo", briefing: "n", owner: t.agent.id }] })).rejects.toThrow(/canceled project[\s\S]*new_project: true/);
  });
});

describe("vários projetos no mesmo pedido (new_project: true)", () => {
  it("dois projetos no mesmo pedido: aprovação independente, falha acorda com request_id certo, concluir/cancelar um não mexe no outro, fim do pedido cancela os abertos, reload do disco mantém vínculo", async () => {
    const t = await setup({ gated: true });
    await t.openRequest("req-multi", "Dois projetos");

    const p1 = await t.runtime.plans.propose("req-multi", { title: "Projeto A", release: "later", tasks: [{ ref: "T1", title: "A1", briefing: "a", owner: t.agent.id }] });
    const p2 = await t.runtime.plans.propose("req-multi", { title: "Projeto B", release: "now", new_project: true, tasks: [{ ref: "T1", title: "B1", briefing: "b", owner: t.agent.id }] });
    expect(p1.id).toBe("req-multi");
    expect(p1.requestId).toBeUndefined();
    expect(p2.id).not.toBe("req-multi");
    expect(p2.requestId).toBe("req-multi");

    // Dois cartões separados no Para você, ambos com taskId === req-multi mas projectId próprio
    const cards = t.runtime.forYou.list().filter((item) => item.kind === "plano" && item.taskId === "req-multi");
    expect(cards.map((item) => item.projectId).sort()).toEqual([p1.id, p2.id].sort());

    // get_project por request_id lista todos e pede project_id; addTasks/decideTask por request_id exigem project_id
    const listText = t.runtime.plans.describe({ requestId: "req-multi" });
    expect(listText).toContain(p1.id);
    expect(listText).toContain(p2.id);
    expect(listText).toContain("project_id");
    expect(() => t.runtime.plans.addTasks({ requestId: "req-multi" }, [{ title: "X", briefing: "x", owner: t.agent.id }], { release: "later" })).toThrow(/project_id/);
    expect(() => t.runtime.plans.decideTask({ requestId: "req-multi" }, "T1", "skip")).toThrow(/project_id/);

    // Aprovar cada um separadamente
    await t.runtime.plans.approve(p1.id);
    await t.runtime.plans.approve(p2.id);
    expect(t.runtime.plans.holds("req-multi")).toBe(true);
    expect(t.runtime.plans.blocksConclusion("req-multi")).toBeDefined();

    // Espia wake no host do pedido: falha de T1 em p2 acorda o Maestro com requestId "req-multi"!
    const wakes: { reqId: string; kind: string; text: string }[] = [];
    const origHost = (t.runtime.plans as unknown as { deps: { host: (id: string) => ProjectHost | undefined } }).deps.host;
    (t.runtime.plans as unknown as { deps: { host: (id: string) => ProjectHost | undefined } }).deps.host = (id: string) => ({
      ...(origHost(id) ?? { awaitUser: vi.fn(), working: vi.fn(), close: vi.fn(), wake: vi.fn() }),
      wake: (reqId, kind, build) => void wakes.push({ reqId, kind, text: build() }),
    });

    await t.ctx.log.waitFor((event) => event.type === "task:upserted" && event.task.work?.projectId === p2.id && event.task.work.ref === "T1");
    const p2Sub = t.runtime.state.read().tasks.find((task) => task.work?.projectId === p2.id && task.work.ref === "T1")!;
    expect(p2Sub.projectId).toBe("req-multi");
    t.runtime.plans.handleEvent({ type: "task:upserted", task: { ...p2Sub, status: "failed", result: "Erro em B1" } });
    await vi.waitFor(() => expect(wakes.some((w) => w.kind === "failed")).toBe(true));
    expect(wakes[0]).toMatchObject({ reqId: "req-multi", kind: "failed" });
    expect(wakes[0]!.text).toContain(p2.id);

    // Concluir p1 não mexe em p2 e mantém holds("req-multi") true!
    await t.runtime.plans.setProjectStatus(p1.id, "concluido", "maestro");
    expect(t.runtime.plans.get(p1.id).status).toBe("concluido");
    expect(t.runtime.plans.get(p2.id).status).toBe("ativo");
    expect(t.runtime.plans.holds("req-multi")).toBe(true);

    // Reinício: recarregar do disco mantém requestId e o vínculo!
    await t.ctx.store.flush();
    const reloadedStore = await OfficeStore.open(t.ctx.dir);
    const reloadedPlans = reloadedStore.projectsSnapshot();
    expect(reloadedPlans.find((plan) => plan.id === p2.id)?.requestId).toBe("req-multi");
    const freshService = new ProjectService(reloadedPlans, (t.runtime.plans as unknown as { deps: ConstructorParameters<typeof ProjectService>[1] }).deps);
    expect(freshService.holds("req-multi")).toBe(true);
    expect(freshService.describe({ requestId: "req-multi" })).toContain(p2.id);
    freshService.stop();

    // Reabre p1 e fecha o pedido: TODOS os projetos abertos do pedido são cancelados!
    await t.runtime.plans.setProjectStatus(p1.id, "ativo", "maestro");
    const req = t.runtime.state.read().tasks.find((task) => task.id === "req-multi")!;
    t.runtime.plans.handleEvent({ type: "task:upserted", task: { ...req, status: "failed", outcome: "cancelled", result: "Cancelado" } });
    await vi.waitFor(() => expect(t.runtime.plans.get(p1.id).status).toBe("cancelado"));
    await vi.waitFor(() => expect(t.runtime.plans.get(p2.id).status).toBe("cancelado"));
    expect(t.runtime.plans.holds("req-multi")).toBe(false);
    t.gate.open();
  });
});

describe("get_project resumido para árvore grande + ref para expandir", () => {
  it("árvore de 150+ itens resume por módulo com teto de 40/módulo e 300 total; ref expande o módulo inteiro", async () => {
    const t = await setup();
    const project = (await t.ctx.app.inject({ method: "POST", url: `${API}/projects`, payload: { title: "Livro 150" } })).json<{ project: Project }>().project;
    // 3 módulos x 50 tarefas = 153 itens; no M1, 10 tarefas já concluídas e 40 abertas (não passa do teto de abertas mas esconde as 10 concluídas); no M2, 50 abertas (teto de 40 -> 10 escondidas); no M3, 50 abertas com dependência de M2.
    const tasks = [
      { ref: "M1", title: "Parte 1", briefing: "m", kind: "module" as const },
      ...Array.from({ length: 50 }, (_, i) => ({ ref: `A${i + 1}`, title: `Cap A${i + 1}`, briefing: "t", owner: t.agent.id, parent: "M1" })),
      { ref: "M2", title: "Parte 2", briefing: "m", kind: "module" as const, depends_on: ["M1"] },
      ...Array.from({ length: 50 }, (_, i) => ({ ref: `B${i + 1}`, title: `Cap B${i + 1}`, briefing: "t", owner: t.agent.id, parent: "M2" })),
      { ref: "M3", title: "Parte 3", briefing: "m", kind: "module" as const, depends_on: ["M2"] },
      ...Array.from({ length: 50 }, (_, i) => ({ ref: `C${i + 1}`, title: `Cap C${i + 1}`, briefing: "t", owner: t.agent.id, parent: "M3" })),
    ];
    t.runtime.plans.addTasks({ projectId: project.id }, tasks, { release: "later" });
    // Marca 10 tarefas de M1 como concluídas
    const live = (t.runtime.plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === project.id)!;
    for (let i = 1; i <= 10; i += 1) find(live, `A${i}`).status = "concluida";

    const summary = t.runtime.plans.describe({ projectId: project.id });
    expect(summary).toContain("0 de 3 módulos concluídos");
    expect(summary).toContain("- M1 «Parte 1»");
    expect(summary).toContain("10/50");
    expect(summary).toContain("- M2 «Parte 2»");
    expect(summary).toContain("depends on M1");
    expect(summary).toContain("- M3 «Parte 3»");
    // As 10 concluídas de M1 não aparecem no resumo; B41..B50 ficam escondidas pelo teto de 40/módulo
    expect(summary).not.toContain("- A1 «Cap A1»");
    expect(summary).toContain("- A11 «Cap A11»");
    expect(summary).toContain("- B40 «Cap B40»");
    expect(summary).not.toContain("- B41 «Cap B41»");
    expect(summary).toMatch(/\d+ more items hidden: call get_project with ref=M\d to expand/);

    // Expandir M1 com ref traz A1 (concluída) e todas as 50 filhas!
    const expandedM1 = t.runtime.plans.describe({ projectId: project.id }, { ref: "M1" });
    expect(expandedM1).toContain("- M1 «Parte 1»");
    expect(expandedM1).toContain("- A1 «Cap A1»");
    expect(expandedM1).toContain("- A50 «Cap A50»");
    expect(expandedM1).not.toContain("- M2 «Parte 2»");

    // Expandir M2 traz B41..B50
    const expandedM2 = t.runtime.plans.describe({ projectId: project.id }, { ref: "M2" });
    expect(expandedM2).toContain("- B41 «Cap B41»");
    expect(expandedM2).toContain("- B50 «Cap B50»");
    expect(expandedM2).not.toContain("more items hidden");

    // Ref inexistente -> erro claro
    expect(() => t.runtime.plans.describe({ projectId: project.id }, { ref: "Z99" })).toThrow(/does not exist/);
  });
});
