import type { ForYouItem, Routine } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActivityLog, type ActivityLog } from "../workspace/activity/log";
import { call, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();

/** POST de modo (200, não 201): devolve o corpo. */
async function setMode(app: Parameters<typeof soloTeam>[0], url: string, payload: object) {
  const response = await app.inject({ method: "POST", url, payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { routine: Routine };
}

const schedule = { label: "Comentar", days: { kind: "uteis" }, times: ["09:00"], action: "Prepare comentários" };

async function makeRoutine(app: Parameters<typeof soloTeam>[0], body: object = {}) {
  const { agent } = await soloTeam(app);
  const routine = await call<Routine>(app, "POST", `${wsApi()}/routines`, { type: "meta", title: "Comentários", kind: "comment", site: "linkedin.com", unit: "comentário", target: 5, agentId: agent.id, schedules: [schedule], ...body });
  return { agent, routine };
}

describe("POST /routines/:id/mode (modo Automático da rotina)", () => {
  it("só a rota do usuário liga: grava approvedAt no servidor, espelha needsApproval e recusa campos de fora", async () => {
    const { app, workspaces } = await setupApp();
    const { routine } = await makeRoutine(app);
    expect(routine).toMatchObject({ mode: { kind: "pede-ok" }, needsApproval: true });
    const url = `${wsApi()}/routines/${routine.id}/mode`;
    // O corpo é estrito: ninguém manda approvedAt.
    expect((await app.inject({ method: "POST", url, payload: { kind: "automatico", actions: ["comentario"], dailyCap: 2, approvedAt: "2020-01-01T00:00:00.000Z" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { kind: "automatico", actions: [], dailyCap: 2 } })).statusCode).toBe(400);
    const on = await setMode(app, url, { kind: "automatico", actions: ["comentario"], dailyCap: 2, sites: ["linkedin.com"] });
    expect(on.routine.needsApproval).toBe(false);
    expect(on.routine.mode).toMatchObject({ kind: "automatico", grant: { actions: ["comentario"], dailyCap: 2, sites: ["linkedin.com"] } });
    const approvedAt = Date.parse((on.routine.mode as { grant: { approvedAt: string } }).grant.approvedAt);
    expect(Math.abs(approvedAt - Date.now())).toBeLessThan(60_000);
    expect(workspaces.get("principal").routines.get(routine.id).mode.kind).toBe("automatico");
    const off = await setMode(app, url, { kind: "pede-ok" });
    expect(off.routine).toMatchObject({ mode: { kind: "pede-ok" }, needsApproval: true });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/R-0099/mode`, payload: { kind: "pede-ok" } })).statusCode).toBe(404);
  });

  it("sugestão do Maestro: só vale ao aceitar; recusar apaga a sugestão", async () => {
    const { app, workspaces } = await setupApp();
    const { routine } = await makeRoutine(app);
    const runtime = workspaces.get("principal");
    const url = `${wsApi()}/routines/${routine.id}/mode`;
    expect((await app.inject({ method: "POST", url, payload: { kind: "proposta", accept: true } })).statusCode).toBe(409);
    // Uma proposta do Maestro com Automático sugerido, aprovada no cartão em Pede OK.
    const { routine: proposed } = runtime.routines.propose({ title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 2, instruction: "x", agentId: routine.agentId!, suggestedMode: { actions: ["post"], dailyCap: 1 } });
    const card = { id: "A-X", routine: { routineId: proposed.id, mode: "criar" } } as ForYouItem;
    runtime.routines.decide(card, { status: "aprovado" });
    const created = runtime.routines.get(proposed.id);
    expect(created).toMatchObject({ status: "ativa", mode: { kind: "pede-ok" }, modeProposal: { by: "maestro", grant: { actions: ["post"], dailyCap: 1 } } });
    const accepted = await setMode(app, `${wsApi()}/routines/${proposed.id}/mode`, { kind: "proposta", accept: true });
    expect(accepted.routine.mode).toMatchObject({ kind: "automatico", grant: { actions: ["post"], dailyCap: 1 } });
    expect(accepted.routine.modeProposal).toBeUndefined();
  });

  it("proposta ainda não decidida ou rotina encerrada: 409", async () => {
    const { app, workspaces } = await setupApp();
    const { routine } = await makeRoutine(app);
    const runtime = workspaces.get("principal");
    const { routine: proposed } = runtime.routines.propose({ title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 2, instruction: "x", agentId: routine.agentId! });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/${proposed.id}/mode`, payload: { kind: "automatico", actions: ["post"], dailyCap: 1 } })).statusCode).toBe(409);
    await call(app, "PATCH", `${wsApi()}/routines/${routine.id}`, { status: "encerrada" });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/routines/${routine.id}/mode`, payload: { kind: "pede-ok" } })).statusCode).toBe(409);
  });
});

describe("Automático da rotina nas tarefas de rotina", () => {
  it("as tarefas herdam o modo da rotina e o teto do dia é DA rotina (soma das execuções)", async () => {
    const { app, workspaces } = await setupApp();
    const { routine, agent } = await makeRoutine(app);
    const runtime = workspaces.get("principal");
    await setMode(app, `${wsApi()}/routines/${routine.id}/mode`, { kind: "automatico", actions: ["comentario"], dailyCap: 2 });
    const live = runtime.routines.get(routine.id);
    const start = (title: string) => runtime.plans.startRoutineTask({ routineId: routine.id, routineTitle: routine.title, mode: live.mode, scheduleId: "S1", period: "2026-W46", agentId: agent.id, title, prompt: `Rotina: ${title}` });
    const first = await start("09:00");
    const second = await start("13:00");
    const third = await start("18:00");
    // Herança: o projeto de rotina nasce com o mesmo modo/grant.
    expect(first.project.mode).toMatchObject({ kind: "automatico", grant: { actions: ["comentario"], dailyCap: 2 } });
    // O teto (2) é da rotina: o contador é um só para todas as execuções do dia.
    expect(runtime.routines.autoReserve(routine.id, { type: "comentario" })).toEqual({ ok: true, label: "1 de 2 hoje" });
    expect(runtime.routines.autoReserve(routine.id, { type: "comentario" })).toEqual({ ok: true, label: "2 de 2 hoje" });
    expect(runtime.routines.autoReserve(routine.id, { type: "comentario" })).toEqual({ ok: false, note: "Teto de 2 por dia atingido" });
    expect(runtime.routines.get(routine.id).autoUsage?.count).toBe(2);
    expect(runtime.routines.autoReserve(routine.id, { type: "convite" })).toMatchObject({ ok: false, note: expect.stringContaining("não está liberado") });
    expect([second.task.id, third.task.id]).toHaveLength(2);
  });

  it("voltar para Pede OK, ou pausar a rotina, para as decisões sozinhas (ao vivo, mesmo com a tarefa já criada)", async () => {
    const { app, workspaces } = await setupApp();
    const { routine, agent } = await makeRoutine(app);
    const runtime = workspaces.get("principal");
    await setMode(app, `${wsApi()}/routines/${routine.id}/mode`, { kind: "automatico", actions: ["comentario"], dailyCap: 5 });
    const { task } = await runtime.plans.startRoutineTask({ routineId: routine.id, routineTitle: routine.title, mode: runtime.routines.get(routine.id).mode, scheduleId: "S1", period: "2026-W46", agentId: agent.id, title: "x", prompt: "Rotina: x" });
    await call(app, "PATCH", `${wsApi()}/routines/${routine.id}`, { status: "pausada" });
    expect(runtime.plans.autoReserve(task, { type: "comentario" })).toMatchObject({ ok: false, note: expect.stringContaining("pausada") });
    await call(app, "PATCH", `${wsApi()}/routines/${routine.id}`, { status: "ativa" });
    await setMode(app, `${wsApi()}/routines/${routine.id}/mode`, { kind: "pede-ok" });
    expect(runtime.plans.autoReserve(task, { type: "comentario" })).toEqual({ ok: false });
  });

  it("compatibilidade: o antigo 'sem OK' (needsApproval:false) continua liberando o clique pelo rótulo; o Automático novo não", async () => {
    const { app, workspaces } = await setupApp();
    const { routine } = await makeRoutine(app);
    const runtime = workspaces.get("principal");
    const url = `${wsApi()}/routines/${routine.id}`;
    // Antigo: needsApproval false -> grant com os rótulos do tipo e o site.
    const legacy = await call<Routine>(app, "PATCH", url, { needsApproval: false });
    expect(legacy.mode).toMatchObject({ kind: "automatico", grant: { sites: ["linkedin.com"] } });
    expect(runtime.routines.grant(routine.id, "www.linkedin.com", "Comentar", "click")).toEqual({ allowed: true, routineId: routine.id });
    // Pela lista de tipos (Automático novo) o navegador NÃO usa a lista de rótulos: vai pelo autoReserve.
    await setMode(app, `${url}/mode`, { kind: "automatico", actions: ["comentario"], dailyCap: 3 });
    expect(runtime.routines.grant(routine.id, "www.linkedin.com", "Comentar", "click")).toBeNull();
    // Voltar a pedir OK pelo campo antigo também desliga.
    expect((await call<Routine>(app, "PATCH", url, { needsApproval: true })).mode).toEqual({ kind: "pede-ok" });
    expect(runtime.routines.grant(routine.id, "www.linkedin.com", "Comentar", "click")).toBeNull();
  });
});

describe("cartão da rotina: modo escolhido ao criar", () => {
  it("padrão é Pede OK; 'automatico' no cartão liga com o escopo que o Maestro sugeriu (e só se ele sugeriu)", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await makeRoutine(app);
    const runtime = workspaces.get("principal");
    const input = { title: "Posts", unit: "post", kind: "post" as const, site: "linkedin.com", target: 2, instruction: "x", agentId: agent.id };
    const a = runtime.routines.propose({ ...input, suggestedMode: { actions: ["post"], dailyCap: 1 } }).routine;
    runtime.routines.decide({ id: "A-1", routine: { routineId: a.id, mode: "criar" } } as ForYouItem, { status: "aprovado", routine: { mode: "automatico" } });
    expect(runtime.routines.get(a.id)).toMatchObject({ status: "ativa", needsApproval: false, mode: { kind: "automatico", grant: { actions: ["post"], dailyCap: 1 } } });
    expect(runtime.routines.get(a.id).modeProposal).toBeUndefined();
    // Sem sugestão do Maestro, "automatico" no cartão não liga nada.
    const b = runtime.routines.propose(input).routine;
    runtime.routines.decide({ id: "A-2", routine: { routineId: b.id, mode: "criar" } } as ForYouItem, { status: "aprovado", routine: { mode: "automatico" } });
    expect(runtime.routines.get(b.id)).toMatchObject({ status: "ativa", mode: { kind: "pede-ok" }, needsApproval: true });
    // Sugerido e deixado em Pede OK: a sugestão fica para o detalhe da rotina.
    const c = runtime.routines.propose({ ...input, suggestedMode: { actions: ["post"] } }).routine;
    runtime.routines.decide({ id: "A-3", routine: { routineId: c.id, mode: "criar" } } as ForYouItem, { status: "aprovado", routine: { mode: "pede-ok" } });
    expect(runtime.routines.get(c.id)).toMatchObject({ mode: { kind: "pede-ok" }, modeProposal: { grant: { actions: ["post"] } } });
  });
});

describe("Atividade das rotinas (proposta e modo)", () => {
  afterEach(() => setActivityLog(undefined));

  it("registra proposta, aprovação com Automático, ajuste, recusa e o liga/desliga do modo", async () => {
    const { app, workspaces } = await setupApp();
    const { agent } = await makeRoutine(app);
    const record = vi.fn();
    setActivityLog({ record } as unknown as ActivityLog);
    const runtime = workspaces.get("principal");
    const input = { title: "Posts", unit: "post", kind: "post" as const, site: "linkedin.com", target: 2, instruction: "x", agentId: agent.id, suggestedMode: { actions: ["post"], dailyCap: 1 } };
    const actions = () => record.mock.calls.map(([entry]) => `${entry.category}.${entry.action}`);
    const a = runtime.routines.propose(input).routine;
    expect(actions()).toEqual(["rotina.proposta"]);
    runtime.routines.decide({ id: "A-1", routine: { routineId: a.id, mode: "criar" } } as ForYouItem, { status: "aprovado", routine: { mode: "automatico" } });
    expect(actions()).toContain("rotina.automatico-ligado");
    await setMode(app, `${wsApi()}/routines/${a.id}/mode`, { kind: "pede-ok" });
    expect(actions().at(-1)).toBe("rotina.automatico-desligado");
    const b = runtime.routines.propose(input).routine;
    runtime.routines.decide({ id: "A-2", routine: { routineId: b.id, mode: "criar" } } as ForYouItem, { status: "respondido", response: "mude o horário" });
    expect(actions().at(-1)).toBe("rotina.ajustada");
    const c = runtime.routines.propose(input).routine;
    runtime.routines.decide({ id: "A-3", routine: { routineId: c.id, mode: "criar" } } as ForYouItem, { status: "rejeitado" });
    expect(actions().at(-1)).toBe("rotina.recusada");
    const entries = record.mock.calls.map(([entry]) => entry);
    expect(entries.find((entry) => entry.action === "automatico-ligado")).toMatchObject({ actor: "usuario", refs: { routineId: a.id } });
    expect(entries.find((entry) => entry.action === "proposta")).toMatchObject({ actor: "maestro" });
  });
});
