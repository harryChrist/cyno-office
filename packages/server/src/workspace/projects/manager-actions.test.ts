import { taskRankInput, type ActivityEntry, type Project, type ProjectTask } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, soloTeam } from "../../dev/test-api";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import { ActivityLog, setActivityLog } from "../activity/log";

/** Ações do gestor sobre projetos (Gestão): "Isso primeiro" (`pinned`) e reatribuir uma tarefa travada. */
const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

afterEach(() => setActivityLog(undefined));

type Reply = { project: Project; ref?: string; error?: string };
const send = (ctx: TestApp, method: "POST" | "PATCH", url: string, payload: object = {}) => ctx.app.inject({ method, url: `${API}${url}`, payload });
/** O projeto de verdade em memória (para fabricar o estado travado: sem IA nenhuma tarefa roda de verdade). */
const raw = (ctx: TestApp, id: string) => (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === id)!;
const rawTask = (ctx: TestApp, id: string, ref: string): ProjectTask => raw(ctx, id).tasks.find((task) => task.ref === ref)!;

async function setup() {
  const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
  const entries: ActivityEntry[] = [];
  activity.onAppend((entry) => entries.push(entry));
  const ctx = await setupApp({ activity });
  const { team, agent: first } = await soloTeam(ctx.app, "Solo");
  const second = await createAgent(ctx.app, team.id, "Segundo");
  const created = (await send(ctx, "POST", "/projects", { title: "Campanha" })).json() as Reply;
  const id = created.project.id;
  // Pausado: a fila não anda sozinha, então a tarefa fica onde o teste a deixa.
  expect((await send(ctx, "PATCH", `/projects/${id}`, { status: "pausado" })).statusCode).toBe(200);
  const add = async (title: string, extra: object = {}): Promise<string> => {
    const response = await send(ctx, "POST", `/projects/${id}/tasks`, { title, ...extra });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as Reply).ref!;
  };
  const reassign = (ref: string, body: object) => send(ctx, "POST", `/projects/${id}/tasks/${ref}/reassign`, body);
  return { ctx, id, first, second, add, reassign, entries };
}

describe('"Isso primeiro" (PATCH /projects/:id { pinned })', () => {
  it("fixa, mantém o instante se pedir de novo, solta, e registra na Atividade", async () => {
    const { ctx, id, entries } = await setup();
    const pinned = ((await send(ctx, "PATCH", `/projects/${id}`, { pinned: true })).json() as Reply).project;
    expect(pinned.pinnedAt).toBeDefined();
    const again = ((await send(ctx, "PATCH", `/projects/${id}`, { pinned: true })).json() as Reply).project;
    expect(again.pinnedAt).toBe(pinned.pinnedAt);
    const loose = ((await send(ctx, "PATCH", `/projects/${id}`, { pinned: false })).json() as Reply).project;
    expect(loose.pinnedAt).toBeUndefined();
    expect(entries.filter((entry) => entry.category === "plano" && ["fixado", "solto"].includes(entry.action)).map((entry) => [entry.action, entry.actor, entry.refs?.planId])).toEqual([
      ["fixado", "usuario", id],
      ["solto", "usuario", id],
    ]);
    expect(entries.find((entry) => entry.action === "fixado")!.summary).toContain("Isso primeiro");
  });

  it("recusa valor que não é booleano e projeto que já terminou", async () => {
    const { ctx, id } = await setup();
    expect((await send(ctx, "PATCH", `/projects/${id}`, { pinned: "sim" })).statusCode).toBe(400);
    raw(ctx, id).status = "concluido";
    const finished = await send(ctx, "PATCH", `/projects/${id}`, { pinned: true });
    expect(finished.statusCode).toBe(409);
  });

  it("o fixado entra na ordem de urgência da fila (taskRankInput) antes de uma tarefa atrasada", async () => {
    const { ctx, id, add } = await setup();
    const ref = await add("Qualquer");
    await send(ctx, "PATCH", `/projects/${id}`, { pinned: true });
    const project = raw(ctx, id);
    expect(taskRankInput(project, project.tasks.find((task) => task.ref === ref)!, 0).pinnedAt).toBe(project.pinnedAt);
  });
});

describe("POST /projects/:id/tasks/:ref/reassign", () => {
  it("tarefa no backlog sem dono: o agente vira o responsável e a tarefa entra na fila", async () => {
    const { id, second, add, reassign, entries } = await setup();
    const ref = await add("Escrever", { briefing: "Escreva o texto" });
    const response = await reassign(ref, { agentId: second.id });
    expect(response.statusCode, response.body).toBe(200);
    const task = (response.json() as Reply).project.tasks.find((candidate) => candidate.ref === ref)!;
    expect(task).toMatchObject({ ownerId: second.id, status: "a_fazer" });
    expect(task.steps[0]).toMatchObject({ agentId: second.id, status: "pendente" });
    const event = entries.find((entry) => entry.action === "reatribuida")!;
    expect(event).toMatchObject({ category: "plano", actor: "usuario", refs: { planId: id }, data: { ref, agentId: second.id, step: 0 } });
    expect(event.summary).toMatch(/Você passou “Escrever” de ninguém para Segundo/);
  });

  it("tarefa que falhou: troca o agente, volta a pendente, limpa a falha e vai para a fila (o mesmo caminho do retry)", async () => {
    const { ctx, id, first, second, add, reassign } = await setup();
    const ref = await add("Resumo", { assignee: first.id });
    const task = rawTask(ctx, id, ref);
    Object.assign(task, { status: "falhou", failure: "motor caiu", finishedAt: "2026-11-12T10:00:00.000Z" });
    Object.assign(task.steps[0]!, { status: "falhou", taskId: "t-velha", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T10:00:00.000Z", result: "erro" });
    const response = await reassign(ref, { agentId: second.id });
    expect(response.statusCode, response.body).toBe(200);
    const after = (response.json() as Reply).project.tasks.find((candidate) => candidate.ref === ref)!;
    expect(after).toMatchObject({ status: "a_fazer", ownerId: second.id });
    expect(after.failure).toBeUndefined();
    expect(after.queuedAt).toBeDefined();
    expect(after.steps[0]).toMatchObject({ agentId: second.id, status: "pendente" });
    expect(after.steps[0]!.taskId).toBeUndefined();
    expect(after.steps[0]!.result).toBeUndefined();
  });

  it("tarefa travada por cota, sem etapa rodando: limpa o bloqueio (que vira histórico) e muda o agente", async () => {
    const { ctx, id, first, second, add, reassign } = await setup();
    const ref = await add("Post", { assignee: first.id });
    Object.assign(rawTask(ctx, id, ref), { status: "a_fazer", blocked: { type: "cota", note: "sem cota", since: "2026-11-12T10:00:00.000Z" }, note: "Agente sem cota" });
    const response = await reassign(ref, { agentId: second.id });
    expect(response.statusCode, response.body).toBe(200);
    const after = (response.json() as Reply).project.tasks.find((candidate) => candidate.ref === ref)!;
    expect(after.blocked).toBeUndefined();
    expect(after.note).toBeUndefined();
    expect(after.blockedSpans).toEqual([expect.objectContaining({ type: "cota", since: "2026-11-12T10:00:00.000Z" })]);
    expect(after.steps[0]!.agentId).toBe(second.id);
  });

  it("409 pedindo para cancelar a etapa antes quando ela está rodando; 409 também com a tarefa esperando você ou já terminada", async () => {
    const { ctx, id, first, second, add, reassign } = await setup();
    const ref = await add("Rodando", { assignee: first.id });
    const task = rawTask(ctx, id, ref);
    Object.assign(task, { status: "em_andamento" });
    Object.assign(task.steps[0]!, { status: "em_andamento", taskId: "t-1", startedAt: "2026-11-12T10:00:00.000Z" });
    const running = await reassign(ref, { agentId: second.id });
    expect(running.statusCode).toBe(409);
    expect((running.json() as Reply).error).toMatch(/cancele a etapa antes/);
    expect(rawTask(ctx, id, ref).steps[0]!.agentId).toBe(first.id);

    const waiting = await add("Esperando", { assignee: first.id });
    Object.assign(rawTask(ctx, id, waiting), { status: "esperando_voce" });
    const hold = await reassign(waiting, { agentId: second.id });
    expect(hold.statusCode).toBe(409);
    expect((hold.json() as Reply).error).toMatch(/espera você/);

    const finished = await add("Pronta", { assignee: first.id });
    Object.assign(rawTask(ctx, id, finished), { status: "concluida" });
    expect((await reassign(finished, { agentId: second.id })).statusCode).toBe(409);
  });

  it("recusa agente que não existe, o mesmo agente numa tarefa só parada, etapa já feita e corpo mal formado", async () => {
    const { ctx, id, first, second, add, reassign } = await setup();
    const ref = await add("Tarefa", { assignee: first.id });
    expect((await reassign(ref, { agentId: "ninguem" })).statusCode).toBe(400);
    const same = await reassign(ref, { agentId: first.id });
    expect(same.statusCode).toBe(409);
    expect((same.json() as Reply).error).toMatch(/nada a trocar/);
    expect((await reassign(ref, { agentId: second.id, step: 3 })).statusCode).toBe(400);
    expect((await reassign(ref, {})).statusCode).toBe(400);
    expect((await reassign(ref, { agentId: second.id, extra: 1 })).statusCode).toBe(400);
    expect((await reassign("T99", { agentId: second.id })).statusCode).toBe(404);
    const done = rawTask(ctx, id, ref);
    Object.assign(done, { status: "falhou" });
    done.steps[0]!.status = "feita";
    const doneStep = await reassign(ref, { agentId: second.id });
    expect(doneStep.statusCode).toBe(409);
    expect((doneStep.json() as Reply).error).toMatch(/já foi feita/);
  });

  it("numa tarefa de várias etapas, `step` escolhe qual passa adiante e as feitas ficam como estão", async () => {
    const { ctx, id, first, second, add, reassign } = await setup();
    const ref = await add("Em duas etapas", { assignee: first.id });
    const task = rawTask(ctx, id, ref);
    task.steps = [
      { agentId: first.id, what: "Rascunho", status: "feita", result: "ok", startedAt: "2026-11-12T08:00:00.000Z", finishedAt: "2026-11-12T09:00:00.000Z" },
      { agentId: first.id, what: "Revisão", status: "pendente" },
    ];
    Object.assign(task, { status: "em_andamento", current: 1, blocked: { type: "acesso", note: "sem acesso", since: "2026-11-12T09:30:00.000Z" } });
    const response = await reassign(ref, { agentId: second.id });
    expect(response.statusCode, response.body).toBe(200);
    const after = (response.json() as Reply).project.tasks.find((candidate) => candidate.ref === ref)!;
    expect(after.steps.map((step) => [step.agentId, step.status])).toEqual([[first.id, "feita"], [second.id, "pendente"]]);
    expect(after.ownerId).toBe(first.id);
    expect(after.blocked).toBeUndefined();
  });
});

describe("projeto de demonstração (seed): nada de fixar nem reatribuir (revisão L2)", () => {
  it("fixar e reatribuir num projeto seed-* dá 409 com mensagem clara, e nada muda", async () => {
    const { ctx, id, second, add } = await setup();
    const ref = await add("Tarefa de mentira");
    rawTask(ctx, id, ref).status = "a_fazer";
    raw(ctx, id).id = "seed-p9";
    const pin = await send(ctx, "PATCH", "/projects/seed-p9", { pinned: true });
    expect(pin.statusCode).toBe(409);
    expect((pin.json() as Reply).error).toMatch(/demonstração/);
    const reassign = await send(ctx, "POST", `/projects/seed-p9/tasks/${ref}/reassign`, { agentId: second.id });
    expect(reassign.statusCode).toBe(409);
    expect((reassign.json() as Reply).error).toMatch(/demonstração/);
    expect(raw(ctx, "seed-p9").pinnedAt).toBeUndefined();
    // Outros ajustes (prioridade) continuam valendo no projeto semente.
    expect((await send(ctx, "PATCH", "/projects/seed-p9", { priority: "alta" })).statusCode).toBe(200);
  });
});
