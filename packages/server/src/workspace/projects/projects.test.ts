import type { ForYouItem, Plan, ServerEvent, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { OfficeStore } from "../../store/office-store";
import type { ProjectServiceDeps } from "./project-service";

const setupApp = useTestApp();

type Ctx = TestApp & { post: (url: string, payload?: unknown) => Promise<{ statusCode: number; json: () => unknown }> };

async function setup(): Promise<Ctx> {
  const testApp = await setupApp();
  const post = (url: string, payload?: unknown) => testApp.app.inject({ method: "POST", url: `${API}${url}`, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
  return { ...testApp, post };
}

const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

/** Pedido "[plano] …" do Maestro simulado: espera o plano chegar (esperando aprovação). */
async function planRequest(ctx: Ctx, prompt: string): Promise<{ request: Task; plan: Plan }> {
  const response = await ctx.post("/tasks", { prompt });
  expect(response.statusCode).toBe(201);
  const request = response.json() as Task;
  const event = await ctx.log.waitFor((candidate) => candidate.type === "project:upserted" && candidate.project.id === request.id);
  return { request, plan: (event as Extract<ServerEvent, { type: "project:upserted" }>).project };
}

const planEvents = (ctx: TestApp, planId: string): Plan[] =>
  ctx.log.events.flatMap((event) => (event.type === "project:upserted" && event.project.id === planId ? [event.project] : []));

const stepTasks = (ctx: TestApp, requestId: string) => ctx.store.snapshot().tasks.filter((task) => task.projectId === requestId && task.work);

/** Nenhum momento passou dos limites (tarefas em andamento no workspace; etapas rodando por agente). */
function maxConcurrency(plans: Plan[]): { running: number; perAgent: number } {
  let running = 0;
  let perAgent = 0;
  for (const plan of plans) {
    running = Math.max(running, plan.tasks.filter((task) => task.status === "em_andamento").length);
    const counts = new Map<string, number>();
    for (const task of plan.tasks) {
      const step = task.steps[task.current];
      if (step?.status === "em_andamento") counts.set(step.agentId, (counts.get(step.agentId) ?? 0) + 1);
    }
    perAgent = Math.max(perAgent, ...counts.values(), 0);
  }
  return { running, perAgent };
}

describe("planos (Maestro simulado)", () => {
  it("nada roda antes da aprovação; aprovado, distribui pelas dependências, passa as etapas adiante e acorda o Maestro só no fim", async () => {
    const ctx = await setup();
    const wake = vi.spyOn(runtimeOf(ctx).maestro, "wake");
    const { request, plan } = await planRequest(ctx, "[plano] Campanha de lançamento");
    expect(plan).toMatchObject({ status: "proposto", version: 1 });
    expect(plan.tasks.map((task) => [task.ref, task.status])).toEqual([
      ["T1", "a_fazer"],
      ["T2", "backlog"],
      ["T3", "backlog"],
      ["T4", "backlog"],
    ]);
    await ctx.log.waitForTask(request.id, "waiting_approval");
    const item = ((await ctx.app.inject({ method: "GET", url: `${API}/for-you` })).json() as ForYouItem[]).find((candidate) => candidate.projectId === plan.id)!;
    expect(item).toMatchObject({ kind: "plano", status: "pendente", taskId: request.id, projectId: request.id });
    expect(item.text).toContain("**T2 · Escrever o rascunho** — dono: Davi; etapas: Lia → Davi (depois de T1)");
    // Sem aprovação, nenhuma etapa existe.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stepTasks(ctx, request.id)).toHaveLength(0);

    expect((await ctx.post(`/plans/${plan.id}/approve`)).statusCode).toBe(200);
    await ctx.log.waitForTask(request.id, "done");
    const final = runtimeOf(ctx).plans.get(plan.id);
    expect(final.status).toBe("concluido");
    expect(final.tasks.every((task) => task.status === "concluida")).toBe(true);
    expect(runtimeOf(ctx).forYou.list().find((candidate) => candidate.id === item.id)?.status).toBe("aprovado");

    // Uma subtarefa por etapa (T1: 1, T2: 2, T3: 1, T4: 1), na ordem que as dependências permitem.
    const steps = stepTasks(ctx, request.id);
    expect(steps.map((task) => `${task.work!.ref}.${task.work!.step}:${task.agentId}`)).toEqual(["T1.0:lia", "T2.0:lia", "T2.1:davi", "T4.0:lia", "T3.0:nina"]);
    // A etapa 2 de T2 recebe o que a etapa 1 entregou; T3 recebe o resultado de T2 (dependência).
    const t2a = steps.find((task) => task.work!.ref === "T2" && task.work!.step === 0)!;
    const t2b = steps.find((task) => task.work!.ref === "T2" && task.work!.step === 1)!;
    const t3 = steps.find((task) => task.work!.ref === "T3")!;
    expect(t2b.prompt).toContain("## O que as etapas anteriores entregaram\n- Etapa 1 (Lia):");
    expect(t2b.prompt).toContain(t2a.result!.replace(/\s+/g, " ").trim().slice(0, 40));
    expect(t3.prompt).toContain("## O que as subtarefas de que esta depende entregaram\n- T2 «Escrever o rascunho» (Davi):");
    // A última etapa de T2 passa o resultado a T3 (que depende dela); T3, sem ninguém depois, é a última de verdade.
    expect(t2b.prompt).toMatch(/Depois de você: .*\(T3 «Revisar»\)/);
    expect(t3.prompt).toContain("Você é a última etapa");
    expect(t2a.prompt).toContain("Depois de você: Davi recebe o seu resultado");

    // Limites padrão (3 no workspace, 1 por agente) nunca passaram; T2 (prioridade alta) começou antes de T4.
    expect(maxConcurrency(planEvents(ctx, plan.id))).toEqual({ running: 2, perAgent: 1 });
    // O Maestro só foi acordado uma vez: no fim, com o resumo.
    expect(wake.mock.calls.map((call) => call[1])).toEqual(["done"]);
    expect((wake.mock.calls[0]![2] as () => string)()).toContain("o projeto terminou — 4 de 4 tarefas concluídas");
    const done = ctx.store.snapshot().tasks.find((task) => task.id === request.id)!;
    expect(done.result).toContain("Plano concluído (4 tarefas).");
  });

  it("limite do workspace configurável: com 1 tarefa por vez, nada roda em paralelo", async () => {
    const ctx = await setup();
    const patched = await ctx.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { dispatch: { maxRunning: 1 } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ dispatch: { maxRunning: 1 } });
    expect((await ctx.app.inject({ method: "PATCH", url: "/api/workspaces/principal", payload: { dispatch: { maxRunning: 99 } } })).statusCode).toBe(400);
    const { request, plan } = await planRequest(ctx, "[plano] Campanha");
    await ctx.post(`/plans/${plan.id}/approve`);
    await ctx.log.waitForTask(request.id, "done");
    expect(maxConcurrency(planEvents(ctx, plan.id))).toEqual({ running: 1, perAgent: 1 });
  });

  it("sem cota: a etapa espera com o motivo (sem trocar de motor) e anda quando o motor volta; parada demais avisa o Maestro uma vez", async () => {
    const ctx = await setup();
    const runtime = runtimeOf(ctx);
    const deps = (runtime.plans as unknown as { deps: ProjectServiceDeps }).deps;
    let blocked = true;
    deps.availability = (agent) => (blocked && agent.id === "lia" ? { reason: "quota" } : undefined);
    const wake = vi.spyOn(runtime.maestro, "wake").mockImplementation(() => undefined);
    const { plan } = await planRequest(ctx, "[plano] Campanha");
    await ctx.post(`/plans/${plan.id}/approve`);
    let current = runtime.plans.get(plan.id);
    expect(current.tasks[0]).toMatchObject({ status: "a_fazer", note: "Lia indisponível (sem cota): espera voltar" });
    expect(stepTasks(ctx, plan.id)).toHaveLength(0);
    // Parada além do limite: o Maestro recebe UM aviso (não repete na conferência seguinte).
    (runtime.plans as unknown as { stallMs: number }).stallMs = -1;
    runtime.plans.checkStalls();
    runtime.plans.checkStalls();
    expect(wake.mock.calls.map((call) => call[1])).toEqual(["stalled"]);
    expect((wake.mock.calls[0]![2] as () => string)()).toContain("T1 «Levantar referências»: parada há");
    blocked = false;
    runtime.plans.pump();
    current = runtime.plans.get(plan.id);
    expect(current.tasks[0]!.status).not.toBe("a_fazer");
    expect(stepTasks(ctx, plan.id).map((task) => task.agentId)).toEqual(["lia"]);
  });

  it("uma etapa falha: o Maestro é acordado (uma vez) e as dependentes não começam", async () => {
    const ctx = await setup();
    const wake = vi.spyOn(runtimeOf(ctx).maestro, "wake");
    const { request, plan } = await planRequest(ctx, "[plano] [falhar] Campanha");
    await ctx.post(`/plans/${plan.id}/approve`);
    await ctx.log.waitForTask(request.id, "failed");
    expect(wake.mock.calls.map((call) => call[1])).toEqual(["failed"]);
    expect((wake.mock.calls[0]![2] as () => string)()).toContain("a tarefa T2 («Escrever o rascunho») falhou na etapa 2/2 (Davi)");
    const final = runtimeOf(ctx).plans.get(plan.id);
    expect(final.status).toBe("cancelado");
    expect(final.tasks.find((task) => task.ref === "T3")!.status).toBe("cancelada");
    expect(stepTasks(ctx, request.id).some((task) => task.work!.ref === "T3")).toBe(false);
  });

  it("ajustar volta para o Maestro (versão nova para aprovar); cancelar fecha o pedido; o card do Para você decide o plano", async () => {
    const ctx = await setup();
    const { request, plan } = await planRequest(ctx, "[plano] Campanha");
    const adjusted = await ctx.post(`/plans/${plan.id}/adjust`, { feedback: "Inclua o Instagram" });
    expect(adjusted.statusCode).toBe(200);
    const v2 = (await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === plan.id && event.project.version === 2)) as Extract<ServerEvent, { type: "project:upserted" }>;
    expect(v2.project.status).toBe("proposto");
    expect(v2.project.tasks[0]!.briefing).toContain("Ajuste pedido pelo usuário: Inclua o Instagram");
    const items = runtimeOf(ctx).forYou.list().filter((item) => item.projectId === plan.id);
    expect(items.map((item) => item.status)).toEqual(["respondido", "pendente"]);
    expect(items[0]!.response).toBe("Inclua o Instagram");

    expect((await ctx.post(`/for-you/${items[1]!.id}/decision`, { status: "rejeitado", response: "Não precisa mais" })).statusCode).toBe(200);
    const closed = await ctx.log.waitForTask(request.id, "failed");
    expect((closed as Extract<ServerEvent, { type: "task:upserted" }>).task.result).toBe("Plano cancelado pelo usuário: Não precisa mais");
    expect(runtimeOf(ctx).plans.get(plan.id).status).toBe("cancelado");
    expect((await ctx.post(`/plans/${plan.id}/approve`)).statusCode).toBe(409);

    // Aprovar pelo card do "Para você".
    const second = await planRequest(ctx, "[plano] Outra campanha");
    const card = runtimeOf(ctx).forYou.list().find((item) => item.projectId === second.plan.id)!;
    expect((await ctx.post(`/for-you/${card.id}/decision`, { status: "aprovado" })).statusCode).toBe(200);
    await ctx.log.waitForTask(second.request.id, "done");
  });

  it("fechar um pedido parado: cancelar para o plano e as etapas; concluir fecha como está", async () => {
    const ctx = await setup();
    const { request, plan } = await planRequest(ctx, "[plano] Campanha");
    const response = await ctx.post(`/tasks/${request.id}/close`, { mode: "cancelar", note: "esqueci" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "failed", result: "Cancelado pelo usuário: esqueci" });
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === plan.id && event.project.status === "cancelado");
    expect((await ctx.post(`/tasks/${request.id}/close`, { mode: "concluir" })).statusCode).toBe(409);

    const other = await ctx.post("/tasks", { prompt: "Escreva um post" });
    const otherTask = other.json() as Task;
    const concluded = await ctx.post(`/tasks/${otherTask.id}/close`, { mode: "concluir", note: "Já resolvi" });
    expect(concluded.statusCode).toBe(200);
    expect(ctx.store.snapshot().tasks.find((task) => task.id === otherTask.id)).toMatchObject({ status: "done", result: "Já resolvi" });
    expect(ctx.store.snapshot().tasks.filter((task) => task.projectId === otherTask.id).every((task) => task.status !== "queued" && task.status !== "in_progress")).toBe(true);
  });

  it("os planos voltam no office:snapshot e no GET /plans", async () => {
    const ctx = await setup();
    const { plan } = await planRequest(ctx, "[plano] Campanha");
    const list = (await ctx.app.inject({ method: "GET", url: `${API}/plans` })).json() as Plan[];
    // o projeto fixo "Avulsas" sempre vem junto
    expect(list.map((candidate) => candidate.id).sort()).toEqual([plan.id, "avulsas"].sort());
    expect((await ctx.app.inject({ method: "GET", url: `${API}/plans/${plan.id}` })).json()).toMatchObject({ id: plan.id, status: "proposto" });
  });

  it("tarefa avulsa (sem plano) nasce como folha do Avulsas, acompanha a Task e fecha com o pedido; o pedido fica role request", async () => {
    const ctx = await setup();
    const response = await ctx.post("/tasks", { prompt: "Escrever um post curto sobre café" });
    const request = response.json() as Task;
    expect(request.role).toBe("request");
    await ctx.log.waitForTask(request.id, "done");
    const leaf = await vi.waitFor(() => {
      const found = runtimeOf(ctx).plans.list().find((candidate) => candidate.id === "avulsas")?.tasks.find((task) => task.meta?.requestId === request.id);
      expect(found?.status).toBe("concluida");
      return found!;
    });
    expect(leaf).toMatchObject({ ref: "A1", meta: { requestId: request.id, origin: "usuario" } });
    expect(leaf.steps[0]!.address).toMatch(/^principal\//);
    const sub = ctx.store.snapshot().tasks.find((task) => task.projectId === request.id)!;
    expect(sub.work).toEqual({ projectId: "avulsas", ref: "A1", step: 0 });
    // a vista de projeto do pedido (o que o Maestro, o Cyno e a tela atual leem): um projeto kind tarefa com o id do pedido
    expect(runtimeOf(ctx).plans.get(request.id)).toMatchObject({ id: request.id, kind: "tarefa", origin: "usuario", priority: "normal", status: "concluido", tasks: [{ ref: "A1", status: "concluida" }] });
    // não é plano: não tem ciclo de plano (nenhum projeto próprio do pedido)
    expect(runtimeOf(ctx).plans.list().some((candidate) => candidate.id === request.id)).toBe(false);
    // e a gravação foi para projects/avulsas.json
    await ctx.store.flush();
    const saved = (await OfficeStore.open(ctx.dir)).projectsSnapshot().find((candidate) => candidate.id === "avulsas")!;
    expect(saved.tasks.find((task) => task.meta?.requestId === request.id)?.status).toBe("concluida");
  });
});
