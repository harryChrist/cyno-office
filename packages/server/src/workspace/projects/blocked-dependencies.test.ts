import type { Project, TodayView } from "@cyno/shared";
import { blockedLeaves, flowStatusOf, pendencySummary } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { soloTeam } from "../../dev/test-api";

/** Revisão 2, M5: quem depende de uma subtarefa cancelada ou que falhou fica travada (não roda), com aviso ao dono e ações. */
const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");
type Reply = { project: Project; ref?: string };
const post = (ctx: TestApp, url: string, payload: object = {}) => ctx.app.inject({ method: "POST", url: `${API}${url}`, payload });
const patch = (ctx: TestApp, url: string, payload: object) => ctx.app.inject({ method: "PATCH", url: `${API}${url}`, payload });
const find = (project: Project, ref: string) => project.tasks.find((task) => task.ref === ref)!;

async function add(ctx: TestApp, projectId: string, body: object): Promise<string> {
  const response = await post(ctx, `/projects/${projectId}/tasks`, body);
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as Reply).ref!;
}

/** Mãe com a cadeia A > B (a primeira ainda sem dono: nada roda sozinho durante o teste). */
async function chain(ctx: TestApp) {
  const { agent } = await soloTeam(ctx.app);
  const project = ((await post(ctx, "/projects", { title: "Campanha" })).json() as Reply).project;
  const mother = await add(ctx, project.id, { title: "Criar a postagem" });
  const a = await add(ctx, project.id, { title: "Pesquisar", parent: mother });
  const b = await add(ctx, project.id, { title: "Escrever", parent: mother, dependsOn: [a] });
  const c = await add(ctx, project.id, { title: "Revisar", parent: mother, dependsOn: [b] });
  return { agent, project, mother, a, b, c };
}

describe("subtarefa que depende de uma cancelada", () => {
  it("fica travada (não roda), o texto e o estado dizem isso, e o alerta que espera o dono aparece e sai ao destravar", async () => {
    const ctx = await setupApp();
    const { agent, project, mother, a, b, c } = await chain(ctx);
    await patch(ctx, `/projects/${project.id}/tasks/${b}`, { assignee: agent.id });
    await patch(ctx, `/projects/${project.id}/tasks/${c}`, { assignee: agent.id });
    expect((await patch(ctx, `/projects/${project.id}/tasks/${a}`, { status: "cancelada" })).statusCode).toBe(200);
    const plan = runtimeOf(ctx).plans.get(project.id);
    // Não roda sozinha: segue no backlog (o estado gravado não muda), mas é "travada" para a tela e para o Maestro.
    expect(find(plan, b).status).toBe("backlog");
    expect(blockedLeaves(plan).map((leaf) => leaf.ref)).toEqual([b]);
    expect(flowStatusOf(plan, find(plan, b))).toBe("esperando_voce");
    expect(flowStatusOf(plan, find(plan, mother))).toBe("esperando_voce");
    expect(pendencySummary(plan, find(plan, mother))?.text).toMatch(/0 de 3 prontas · 1 cancelada · 1 travada/);
    expect(ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === project.id)).toHaveLength(0);

    // Alerta que espera o dono (cadeia de atenção).
    const alerts = (await ctx.app.inject({ method: "GET", url: "/api/attention" })).json() as { open: { kind: string; needsOwner: boolean; text: string }[] };
    const blocked = alerts.open.filter((alert) => alert.kind === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ needsOwner: true });
    expect(blocked[0]!.text).toMatch(/Escrever.*travada.*Pesquisar.*cancelada/);

    // Entra na contagem de "Esperando você" do dia.
    const today = (await ctx.app.inject({ method: "GET", url: `${API}/today` })).json() as TodayView;
    expect(today.waiting.count).toBeGreaterThanOrEqual(1);
    expect(today.waiting.oldest.some((item) => item.type === "travada" && item.id === `${project.id}/${b}`)).toBe(true);

    // Tirar a dependência destrava (e ela entra na fila).
    expect((await patch(ctx, `/projects/${project.id}/tasks/${b}`, { dependsOn: [] })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(blockedLeaves(runtimeOf(ctx).plans.get(project.id))).toEqual([]);
    const after = (await ctx.app.inject({ method: "GET", url: "/api/attention" })).json() as { open: { kind: string }[] };
    expect(after.open.filter((alert) => alert.kind === "blocked")).toHaveLength(0);
  });

  it("refazer a cancelada volta para a fila e destrava quem esperava; só serve para tarefa que falhou ou foi cancelada", async () => {
    const ctx = await setupApp();
    const { agent, project, a, b } = await chain(ctx);
    await patch(ctx, `/projects/${project.id}/tasks/${b}`, { assignee: agent.id });
    expect((await patch(ctx, `/projects/${project.id}/tasks/${a}`, { status: "refazer" })).statusCode).toBe(409);
    await patch(ctx, `/projects/${project.id}/tasks/${a}`, { status: "cancelada" });
    expect(blockedLeaves(runtimeOf(ctx).plans.get(project.id)).map((leaf) => leaf.ref)).toEqual([b]);
    const redo = await patch(ctx, `/projects/${project.id}/tasks/${a}`, { status: "refazer" });
    expect(redo.statusCode, redo.body).toBe(200);
    const plan = runtimeOf(ctx).plans.get(project.id);
    expect(find(plan, a).status).toBe("backlog");
    expect(find(plan, a).finishedAt).toBeUndefined();
    expect(blockedLeaves(plan)).toEqual([]);
  });

  it("a mãe com uma subtarefa cancelada não conclui sozinha e mostra o resumo", async () => {
    const ctx = await setupApp();
    const { agent, project, mother, a, b, c } = await chain(ctx);
    // A última sai antes de começar (sem dono, nada roda): depois as duas primeiras rodam e acabam.
    const cancelled = await patch(ctx, `/projects/${project.id}/tasks/${c}`, { status: "cancelada" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    for (const ref of [a, b]) await patch(ctx, `/projects/${project.id}/tasks/${ref}`, { assignee: agent.id });
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === project.id && event.project.tasks.find((task) => task.ref === b)?.status === "concluida");
    const plan = runtimeOf(ctx).plans.get(project.id);
    expect(plan.tasks.map((task) => task.status)).toEqual(["backlog", "concluida", "concluida", "cancelada"]);
    expect(flowStatusOf(plan, find(plan, mother))).toBe("esperando_voce");
    expect(pendencySummary(plan, find(plan, mother))?.text).toBe("2 de 3 prontas · 1 cancelada");
  });
});
