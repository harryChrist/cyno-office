import type { Project } from "@cyno/shared";
import { effectiveDeps } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { soloTeam } from "../../dev/test-api";

const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

type Reply = { project: Project; ref?: string };
const post = (ctx: TestApp, url: string, payload: object = {}) => ctx.app.inject({ method: "POST", url: `${API}${url}`, payload });
const patch = (ctx: TestApp, url: string, payload: object) => ctx.app.inject({ method: "PATCH", url: `${API}${url}`, payload });
const find = (project: Project, ref: string) => project.tasks.find((task) => task.ref === ref)!;
const errorOf = (response: { json: () => unknown }) => (response.json() as { error: string }).error;

async function newProject(ctx: TestApp): Promise<Project> {
  return ((await post(ctx, "/projects", { title: "Campanha" })).json() as Reply).project;
}
async function add(ctx: TestApp, projectId: string, body: object): Promise<string> {
  const response = await post(ctx, `/projects/${projectId}/tasks`, body);
  expect(response.statusCode, response.body).toBe(201);
  const ref = (response.json() as Reply).ref!;
  // Criar não executa: estes testes querem a tarefa rodando, então liberam logo (a regra nova tem os testes dela em release.test.ts).
  expect((await post(ctx, `/projects/${projectId}/release`, { refs: [ref] })).statusCode).toBe(200);
  return ref;
}

describe("dependências à mão (\"depois de\")", () => {
  it("subtarefa criada com \"depois de\" espera a irmã; com a irmã pronta, roda e a mãe conclui", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const mother = await add(ctx, project.id, { title: "Criar a postagem" });
    const first = await add(ctx, project.id, { title: "Pesquisar", parent: mother });
    const second = await add(ctx, project.id, { title: "Escrever", parent: mother, assignee: agent.id, dependsOn: [first] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const waiting = runtimeOf(ctx).plans.get(project.id);
    // A segunda tem responsável, mas espera a primeira (que ainda não tem dono): fica parada.
    expect(find(waiting, second)).toMatchObject({ status: "backlog", dependsOn: [first] });
    expect(ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === project.id)).toHaveLength(0);

    expect((await patch(ctx, `/projects/${project.id}/tasks/${first}`, { assignee: agent.id })).statusCode).toBe(200);
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === project.id && event.project.status === "concluido");
    const done = runtimeOf(ctx).plans.get(project.id);
    expect([first, second, mother].map((ref) => find(done, ref).status)).toEqual(["concluida", "concluida", "backlog"]);
    expect(find(done, second).startedAt! >= find(done, first).finishedAt!).toBe(true);
  });

  it("acrescenta e tira dependências pelo PATCH; tirar solta a tarefa", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const mother = await add(ctx, project.id, { title: "Mãe" });
    const a = await add(ctx, project.id, { title: "A", parent: mother });
    const b = await add(ctx, project.id, { title: "B", parent: mother });
    const c = await add(ctx, project.id, { title: "C", parent: mother });
    let response = await patch(ctx, `/projects/${project.id}/tasks/${c}`, { dependsOn: [a, b] });
    expect(response.statusCode, response.body).toBe(200);
    expect(find(runtimeOf(ctx).plans.get(project.id), c).dependsOn).toEqual([a, b]);
    await patch(ctx, `/projects/${project.id}/tasks/${c}`, { dependsOn: [b] });
    expect(find(runtimeOf(ctx).plans.get(project.id), c).dependsOn).toEqual([b]);
    // Com responsável e sem dependência, a C entra na fila.
    await patch(ctx, `/projects/${project.id}/tasks/${c}`, { assignee: agent.id });
    expect(find(runtimeOf(ctx).plans.get(project.id), c).status).toBe("backlog");
    response = await patch(ctx, `/projects/${project.id}/tasks/${c}`, { dependsOn: [] });
    expect(response.statusCode).toBe(200);
    expect(find(runtimeOf(ctx).plans.get(project.id), c).dependsOn).toEqual([]);
    expect(["a_fazer", "em_andamento", "concluida"]).toContain(find(runtimeOf(ctx).plans.get(project.id), c).status);
  });

  it("recusa, em português claro: ela mesma, a mãe, uma de dentro, ciclo e tarefa que não existe", async () => {
    const ctx = await setupApp();
    const project = await newProject(ctx);
    const group = await add(ctx, project.id, { title: "Divulgação", group: true });
    const mother = await add(ctx, project.id, { title: "Postagem", parent: group });
    const a = await add(ctx, project.id, { title: "Pesquisar", parent: mother });
    const b = await add(ctx, project.id, { title: "Escrever", parent: mother, dependsOn: [a] });
    const url = (ref: string) => `/projects/${project.id}/tasks/${ref}`;
    const refused = async (ref: string, dependsOn: string[], status: number) => {
      const response = await patch(ctx, url(ref), { dependsOn });
      expect(response.statusCode, response.body).toBe(status);
      return errorOf(response);
    };
    expect(await refused(a, [a], 400)).toBe("Uma tarefa não pode esperar por ela mesma");
    expect(await refused(a, [mother], 400)).toMatch(/“Postagem” é a tarefa de que esta faz parte/);
    expect(await refused(mother, [a], 400)).toMatch(/“Pesquisar” está dentro desta tarefa/);
    expect(await refused(a, [b], 400)).toMatch(/Isso criaria um ciclo \(.*“Pesquisar”.*“Escrever”.*\)/);
    expect(await refused(a, ["T99"], 404)).toMatch(/não existe/);
    // Um módulo é uma dependência válida (a tarefa espera o módulo inteiro), mas não o módulo de que faz parte.
    expect(await refused(a, [group], 400)).toMatch(/“Divulgação” é a tarefa de que esta faz parte/);
    // Nada mudou depois das recusas.
    const saved = runtimeOf(ctx).plans.get(project.id);
    expect([find(saved, a).dependsOn, find(saved, b).dependsOn]).toEqual([[], [a]]);
  });

  it("depender de uma mãe cujas subtarefas esperam esta tarefa (ciclo por tarefa-mãe) é recusado", async () => {
    const ctx = await setupApp();
    const project = await newProject(ctx);
    const x = await add(ctx, project.id, { title: "X" });
    const mother = await add(ctx, project.id, { title: "Mãe" });
    const kid = await add(ctx, project.id, { title: "Filha", parent: mother, dependsOn: [x] });
    void kid;
    const response = await patch(ctx, `/projects/${project.id}/tasks/${x}`, { dependsOn: [mother] });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toMatch(/ciclo/);
  });

  it("a dependência da mãe vale para as subtarefas de entrada (effectiveDeps)", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const before = await add(ctx, project.id, { title: "Antes" });
    const mother = await add(ctx, project.id, { title: "Mãe" });
    const first = await add(ctx, project.id, { title: "Primeira", parent: mother });
    const second = await add(ctx, project.id, { title: "Segunda", parent: mother, dependsOn: [first] });
    expect((await patch(ctx, `/projects/${project.id}/tasks/${mother}`, { dependsOn: [before] })).statusCode).toBe(200);
    expect((await patch(ctx, `/projects/${project.id}/tasks/${first}`, { assignee: agent.id })).statusCode).toBe(200);
    const saved = runtimeOf(ctx).plans.get(project.id);
    expect(effectiveDeps(saved, find(saved, first))).toEqual([before]);
    expect(effectiveDeps(saved, find(saved, second))).toEqual([first]);
    // A primeira tem dono, mas espera "Antes" (herdado da mãe): não vai para a fila.
    expect(find(saved, first).status).toBe("backlog");
  });

  it("tarefa que já começou não muda de quem espera (409)", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const a = await add(ctx, project.id, { title: "A", assignee: agent.id });
    const b = await add(ctx, project.id, { title: "B" });
    for (let tries = 0; tries < 100 && find(runtimeOf(ctx).plans.get(project.id), a).status !== "concluida"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await patch(ctx, `/projects/${project.id}/tasks/${a}`, { dependsOn: [b] });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toMatch(/já começou/);
  });

  it("módulo depende de módulo: a tarefa do módulo B só roda quando a última tarefa do módulo A termina (e ciclo entre módulos é recusado)", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const project = await newProject(ctx);
    const moduleA = await add(ctx, project.id, { title: "Módulo A", group: true });
    const a1 = await add(ctx, project.id, { title: "A1", parent: moduleA });
    const a2 = await add(ctx, project.id, { title: "A2", parent: moduleA, dependsOn: [a1] });
    const moduleB = await add(ctx, project.id, { title: "Módulo B", group: true, dependsOn: [moduleA] });
    const b1 = await add(ctx, project.id, { title: "B1", parent: moduleB, assignee: agent.id });
    // Ciclo: o módulo A passaria a esperar o B.
    const cycle = await patch(ctx, `/projects/${project.id}/tasks/${moduleA}`, { dependsOn: [moduleB] });
    expect(cycle.statusCode).toBe(400);
    expect(errorOf(cycle)).toMatch(/ciclo/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const waiting = runtimeOf(ctx).plans.get(project.id);
    expect(find(waiting, b1).status).toBe("backlog");
    expect(effectiveDeps(waiting, find(waiting, b1))).toEqual([moduleA]);
    expect(ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === project.id)).toHaveLength(0);

    // A1 e A2 recebem dono: A2 espera A1; B1 só destrava quando o módulo A inteiro terminou.
    expect((await patch(ctx, `/projects/${project.id}/tasks/${a2}`, { assignee: agent.id })).statusCode).toBe(200);
    expect((await patch(ctx, `/projects/${project.id}/tasks/${a1}`, { assignee: agent.id })).statusCode).toBe(200);
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === project.id && event.project.status === "concluido");
    const done = runtimeOf(ctx).plans.get(project.id);
    expect([a1, a2, b1].map((ref) => find(done, ref).status)).toEqual(["concluida", "concluida", "concluida"]);
    expect(find(done, b1).startedAt! >= find(done, a2).finishedAt!).toBe(true);
  });
});
