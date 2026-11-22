import { PLANNED_NOTE, type ActivityEntry, type ForYouItem, type Plan, type Project, type ProjectTask, type ServerEvent, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { API, gatedSleep, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import { cardMetrics } from "../../platform/cards/card";
import { ActivityLog, setActivityLog } from "../activity/log";
import { computeMetrics } from "../metrics/compute";
import { forecastAll, forecastProject, type ForecastStats } from "../metrics/forecast";
import type { WorkScheduler } from "./work-scheduler";

/**
 * LIBERAÇÃO ("criar não executa"): a tarefa criada à mão nasce Planejada e o agendador não a despacha; liberar (à mão, módulo, tudo ou com
 * pré-requisitos), segurar, o plano do Maestro aprovado com "all" ou "none" e a liberação diária por código (tarefas ou módulos).
 */
const setupApp = useTestApp();
const runtimeOf = (ctx: TestApp) => ctx.workspaces.get("principal");

afterEach(() => setActivityLog(undefined));

/** 2026-11-11 12:00 em São Paulo (o dia local vira às 03:00Z). */
const NOON = Date.parse("2026-11-11T15:00:00.000Z");
const DAY = 86_400_000;

type Reply = { project: Project; ref?: string; error?: string };
const send = (ctx: TestApp, method: "POST" | "PATCH", url: string, payload: object = {}) => ctx.app.inject({ method, url: `${API}${url}`, payload });
const find = (project: Project, ref: string): ProjectTask => project.tasks.find((task) => task.ref === ref)!;
/** O projeto vivo em memória (a rota devolve uma cópia). */
const live = (ctx: TestApp, id: string): Project => (runtimeOf(ctx).plans as unknown as { plans: Project[] }).plans.find((plan) => plan.id === id)!;
const stepTasks = (ctx: TestApp, id: string) => ctx.store.snapshot().tasks.filter((task) => task.work?.projectId === id);
const waitDone = (ctx: TestApp, id: string, ref: string) => ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === id && event.project.tasks.find((task) => task.ref === ref)?.status === "concluida");
const errorOf = (response: { json: () => unknown }) => (response.json() as { error: string }).error;

async function setup(options: { gated?: boolean } = {}) {
  const clock = { now: NOON };
  const gate = gatedSleep();
  const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
  const entries: ActivityEntry[] = [];
  activity.onAppend((entry) => entries.push(entry));
  const ctx = await setupApp({ activity, now: () => new Date(clock.now), runner: testRunner(options.gated ? { sleep: gate.sleep } : {}) });
  const { agent } = await soloTeam(ctx.app);
  const created = await send(ctx, "POST", "/projects", { title: "Marrow" });
  expect(created.statusCode).toBe(201);
  const id = (created.json() as Reply).project.id;
  const add = async (title: string, extra: object = {}): Promise<string> => {
    const response = await send(ctx, "POST", `/projects/${id}/tasks`, { title, ...extra });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as Reply).ref!;
  };
  const release = (body: object) => send(ctx, "POST", `/projects/${id}/release`, body);
  const hold = (body: object) => send(ctx, "POST", `/projects/${id}/hold`, body);
  const project = () => live(ctx, id);
  const tick = () => runtimeOf(ctx).plans.tick();
  const flags = (...refs: string[]) => refs.map((ref) => find(project(), ref).released);
  return { ctx, clock, gate, entries, agent, id, add, release, hold, project, tick, flags };
}

describe("criar não executa (agendador)", () => {
  it("a tarefa criada à mão nasce Planejada e não é despachada, mesmo com agente livre e dependência pronta; liberar despacha", async () => {
    const t = await setup();
    const a = await t.add("Pesquisar", { assignee: t.agent.id });
    const b = await t.add("Escrever", { assignee: t.agent.id, dependsOn: [a] });
    runtimeOf(t.ctx).plans.pump();
    expect(find(t.project(), a)).toMatchObject({ released: false, status: "a_fazer", note: PLANNED_NOTE });
    expect(find(t.project(), a).queuedAt).toBeUndefined();
    expect(find(t.project(), b)).toMatchObject({ released: false, status: "backlog" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stepTasks(t.ctx, t.id)).toHaveLength(0);

    const released = await t.release({ refs: [a] });
    expect(released.statusCode, released.body).toBe(200);
    expect((released.json() as Reply).project.tasks.find((task) => task.ref === a)).toMatchObject({ released: true });
    await waitDone(t.ctx, t.id, a);
    // B tem a dependência pronta e o agente livre, mas segue Planejada: não entra na fila sozinha.
    runtimeOf(t.ctx).plans.pump();
    expect(find(t.project(), b)).toMatchObject({ released: false, status: "a_fazer", note: PLANNED_NOTE });
    expect(stepTasks(t.ctx, t.id).filter((task) => task.work!.ref === b)).toHaveLength(0);

    expect((await t.release({ refs: [b] })).statusCode).toBe(200);
    await waitDone(t.ctx, t.id, b);
    expect(t.entries.filter((entry) => entry.action === "tarefas-liberadas").map((entry) => entry.summary)).toEqual(["Você liberou 1 tarefa em “Marrow”", "Você liberou 1 tarefa em “Marrow”"]);
  });

  it("segurar tira da fila; a que roda não é interrompida (409); liberar de novo devolve à fila", async () => {
    const t = await setup({ gated: true });
    const a = await t.add("Rodando", { assignee: t.agent.id });
    const b = await t.add("Na fila", { assignee: t.agent.id });
    expect((await t.release({ all: true })).statusCode).toBe(200);
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === t.id && event.project.tasks.find((task) => task.ref === a)?.status === "em_andamento");
    // B espera o agente ficar livre (esse é o motivo de fila de verdade).
    expect(find(t.project(), b)).toMatchObject({ status: "a_fazer", released: true });
    expect(find(t.project(), b).note).toMatch(/ficar livre/);
    expect(find(t.project(), b).queuedAt).toBeDefined();

    const held = await t.hold({ refs: [b] });
    expect(held.statusCode, held.body).toBe(200);
    expect(find(t.project(), b)).toMatchObject({ released: false, status: "a_fazer", note: PLANNED_NOTE });
    expect(find(t.project(), b).queuedAt).toBeUndefined();
    // A que já roda não volta a Planejada: nada a segurar, e o motivo vem no erro.
    const running = await t.hold({ refs: [a] });
    expect(running.statusCode).toBe(409);
    expect(errorOf(running)).toMatch(/em andamento/);
    expect(find(t.project(), a)).toMatchObject({ released: true, status: "em_andamento" });
    // Um módulo com a rodando e a planejada: segura o que dá e conta o que ficou.
    expect((await t.release({ refs: [b] })).statusCode).toBe(200);
    expect(find(t.project(), b).note).not.toBe(PLANNED_NOTE);
    expect(find(t.project(), b).queuedAt).toBeDefined();
    t.gate.open();
  });

  it("liberar módulo leva as folhas e a herança: tarefa nova em módulo liberado entra liberada; na raiz e em módulo Planejado, Planejada", async () => {
    const t = await setup();
    const mod = await t.add("Capítulos", { group: true });
    const loose = await t.add("Solta");
    expect(t.flags(mod, loose)).toEqual([false, false]);
    const early = await t.add("Cedo", { parent: mod });
    expect(t.flags(early)).toEqual([false]);
    const rootAgain = await t.add("Outra solta");
    expect(t.flags(rootAgain)).toEqual([false]);

    const released = await t.release({ refs: [mod] });
    expect(released.statusCode).toBe(200);
    expect(t.flags(mod, early, loose)).toEqual([true, true, false]);
    const late = await t.add("Tarde", { parent: mod });
    expect(t.flags(late)).toEqual([true]);
    const nested = await t.add("Sub", { parent: late });
    expect(t.flags(nested)).toEqual([true]);
    expect(t.entries.find((entry) => entry.action === "tarefas-liberadas")?.summary).toBe("Você liberou o módulo “Capítulos” (1 tarefa) em “Marrow”");
    // Segurar o módulo de volta: as folhas voltam e a herança também.
    expect((await t.hold({ refs: [mod] })).statusCode).toBe(200);
    expect(t.flags(mod, early, late, nested)).toEqual([false, false, false, false]);
    const again = await t.add("Depois", { parent: mod });
    expect(t.flags(again)).toEqual([false]);
  });

  it("a última folha liberada de um módulo o deixa liberado (a tarefa nova nele entra liberada)", async () => {
    const t = await setup();
    const mod = await t.add("M", { group: true });
    const a = await t.add("A", { parent: mod });
    const b = await t.add("B", { parent: mod });
    await t.release({ refs: [a] });
    expect(find(t.project(), mod).released).toBe(false);
    await t.release({ refs: [b] });
    expect(find(t.project(), mod).released).toBe(true);
  });

  it("liberar com o que precisa leva os pré-requisitos Planejados; sem a opção, só a tarefa", async () => {
    const t = await setup();
    const a = await t.add("A");
    const b = await t.add("B", { dependsOn: [a] });
    const c = await t.add("C", { dependsOn: [b] });
    const d = await t.add("D");
    await t.release({ refs: [c] });
    expect(t.flags(a, b, c, d)).toEqual([false, false, true, false]);
    await t.hold({ refs: [c] });
    const full = await t.release({ refs: [c], withPrerequisites: true });
    expect(full.statusCode).toBe(200);
    expect(t.flags(a, b, c, d)).toEqual([true, true, true, false]);
    expect(t.entries.filter((entry) => entry.action === "tarefas-liberadas").at(-1)?.summary).toBe("Você liberou 3 tarefas (2 como pré-requisito) em “Marrow”");
  });

  it("liberar o projeto inteiro; sem nada para liberar devolve o projeto sem mexer e sem Atividade", async () => {
    const t = await setup();
    const a = await t.add("A");
    const mod = await t.add("M", { group: true });
    const b = await t.add("B", { parent: mod });
    expect((await t.release({ all: true })).statusCode).toBe(200);
    expect(t.flags(a, mod, b)).toEqual([true, true, true]);
    expect(t.entries.find((entry) => entry.action === "tarefas-liberadas")?.summary).toBe("Você liberou todo o projeto (2 tarefas) em “Marrow”");
    const count = t.entries.length;
    expect((await t.release({ all: true })).statusCode).toBe(200);
    expect(t.entries).toHaveLength(count);
  });

  it("duplicar nasce Planejada (cada filha segue a mãe da cópia), e só entra liberada em módulo liberado", async () => {
    const t = await setup();
    const mod = await t.add("M", { group: true });
    const a = await t.add("A", { parent: mod });
    await t.release({ all: true });
    const copy = (await send(t.ctx, "POST", `/projects/${t.id}/tasks/${a}/duplicate`)).json() as Reply;
    expect(find(t.project(), copy.ref!).released).toBe(true);
    const whole = (await send(t.ctx, "POST", `/projects/${t.id}/tasks/${mod}/duplicate`)).json() as Reply;
    expect(find(t.project(), whole.ref!).released).toBe(false);
    const inside = t.project().tasks.filter((task) => task.parent === whole.ref);
    // O módulo tem a tarefa original e a cópia dela: as duas filhas da cópia nascem Planejadas.
    expect(inside.map((task) => task.released)).toEqual([false, false]);
  });

  it("a tarefa avulsa e o repasse entre agentes nunca ficam Planejados (não há freio fora do projeto à mão)", async () => {
    const t = await setup();
    const a = await t.add("A", { assignee: t.agent.id });
    await t.release({ refs: [a] });
    await waitDone(t.ctx, t.id, a);
    const avulsas = runtimeOf(t.ctx).plans.get("avulsas");
    expect(avulsas.tasks.every((task) => task.released !== false)).toBe(true);
    expect(errorOf(await t.release({ all: true }))).toBeDefined();
  });
});

describe("rotas da liberação: erros", () => {
  it("404 para projeto e ref que não existem; 400 para o corpo; 409 no Avulsas e em projeto que terminou", async () => {
    const t = await setup();
    const a = await t.add("A");
    expect((await send(t.ctx, "POST", "/projects/nao-existe/release", { all: true })).statusCode).toBe(404);
    expect((await send(t.ctx, "POST", "/projects/nao-existe/hold", { refs: ["T1"] })).statusCode).toBe(404);
    const missing = await t.release({ refs: ["T99"] });
    expect(missing.statusCode).toBe(404);
    expect(find(t.project(), a).released).toBe(false);
    expect((await t.hold({ refs: ["T99"] })).statusCode).toBe(404);
    expect((await t.release({})).statusCode).toBe(400);
    expect((await t.release({ refs: [] })).statusCode).toBe(400);
    expect((await t.release({ refs: [a], all: true })).statusCode).toBe(400);
    expect((await t.release({ outro: 1 })).statusCode).toBe(400);
    expect((await t.hold({})).statusCode).toBe(400);
    expect((await t.hold({ refs: [] })).statusCode).toBe(400);
    expect((await send(t.ctx, "POST", "/projects/avulsas/release", { all: true })).statusCode).toBe(409);
    expect((await send(t.ctx, "POST", "/projects/avulsas/hold", { refs: ["A1"] })).statusCode).toBe(409);
    // Terminada: não libera nem segura.
    live(t.ctx, t.id).status = "concluido";
    expect((await t.release({ refs: [a] })).statusCode).toBe(409);
    expect((await t.hold({ refs: [a] })).statusCode).toBe(409);
    live(t.ctx, t.id).status = "cancelado";
    expect((await t.release({ all: true })).statusCode).toBe(409);
  });

  it("segurar uma tarefa que já terminou é 409 com o motivo; já Planejada é 200 sem mudança", async () => {
    const t = await setup();
    const a = await t.add("A", { assignee: t.agent.id });
    const b = await t.add("B");
    await t.release({ refs: [a] });
    await waitDone(t.ctx, t.id, a);
    const done = await t.hold({ refs: [a] });
    expect(done.statusCode).toBe(409);
    expect(errorOf(done)).toMatch(/já terminou/);
    const again = await t.hold({ refs: [b] });
    expect(again.statusCode).toBe(200);
    expect(t.entries.filter((entry) => entry.action === "tarefas-seguradas")).toHaveLength(0);
  });

  it("o Maestro (by) registra a Atividade como ele", async () => {
    const t = await setup();
    const a = await t.add("A");
    await runtimeOf(t.ctx).plans.releaseWork(t.id, { refs: [a] }, "maestro");
    expect(t.entries.find((entry) => entry.action === "tarefas-liberadas")).toMatchObject({ actor: "maestro", summary: "O Maestro liberou 1 tarefa em “Marrow”" });
    await runtimeOf(t.ctx).plans.holdWork(t.id, { refs: [a] }, "maestro");
    expect(t.entries.find((entry) => entry.action === "tarefas-seguradas")?.summary).toBe("O Maestro segurou 1 tarefa em “Marrow” (voltaram a Planejada)");
  });
});

describe("liberação diária (PATCH releasePace)", () => {
  const scheduler = (t: Awaited<ReturnType<typeof setup>>) => (runtimeOf(t.ctx).plans as unknown as { scheduler: WorkScheduler }).scheduler;
  const pace = (t: Awaited<ReturnType<typeof setup>>, body: object | null) => send(t.ctx, "PATCH", `/projects/${t.id}`, { releasePace: body });

  it("valida: perDay inteiro de 1 a 500, unidade, dia; null desliga", async () => {
    const t = await setup();
    for (const bad of [{ perDay: 0, unit: "tarefas" }, { perDay: 501, unit: "tarefas" }, { perDay: 1.5, unit: "tarefas" }, { perDay: 2, unit: "semanas" }, { perDay: 2, unit: "tarefas", startsOn: "amanhã" }, { perDay: 2, unit: "tarefas", given: { day: "x", count: 1 } }]) {
      expect((await pace(t, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await pace(t, { perDay: 2, unit: "tarefas", startsOn: "2026-02-31" })).statusCode).toBe(400);
    const on = await pace(t, { perDay: 500, unit: "modulos", startsOn: "2026-11-20" });
    expect(on.statusCode, on.body).toBe(200);
    expect((on.json() as Reply).project.releasePace).toEqual({ perDay: 500, unit: "modulos", startsOn: "2026-11-20" });
    const off = await pace(t, null);
    expect((off.json() as Reply).project.releasePace).toBeUndefined();
    expect(t.entries.filter((entry) => entry.action.startsWith("liberacao-diaria")).map((entry) => entry.summary)).toEqual(["Você ligou a liberação diária (500 módulos por dia, a partir de 20/11) em “Marrow”", "Você desligou a liberação diária em “Marrow”"]);
    // Desligar o que já está desligado não registra nada.
    await pace(t, null);
    expect(t.entries.filter((entry) => entry.action === "liberacao-diaria-desligada")).toHaveLength(1);
  });

  it("tarefas: libera perDay por dia, vira o dia, e reiniciar no mesmo dia não libera além do perDay", async () => {
    const t = await setup();
    const refs = [await t.add("A"), await t.add("B"), await t.add("C"), await t.add("D"), await t.add("E")];
    const on = await pace(t, { perDay: 2, unit: "tarefas" });
    expect((on.json() as Reply).project.releasePace).toMatchObject({ perDay: 2, unit: "tarefas", given: { day: "2026-11-11", count: 2 } });
    expect(t.flags(...refs)).toEqual([true, true, false, false, false]);
    expect(t.entries.find((entry) => entry.action === "liberacao-diaria")).toMatchObject({ actor: "sistema", summary: "A liberação diária liberou 2 tarefas em “Marrow”" });
    t.tick();
    runtimeOf(t.ctx).plans.resume();
    expect(t.flags(...refs)).toEqual([true, true, false, false, false]);
    // O agendador acorda na virada do dia local (03:00Z).
    expect(scheduler(t).nextWakeAt()).toBe(Date.parse("2026-11-12T03:00:00.000Z"));
    t.clock.now = NOON + DAY;
    t.tick();
    expect(t.flags(...refs)).toEqual([true, true, true, true, false]);
    expect(live(t.ctx, t.id).releasePace?.given).toEqual({ day: "2026-11-12", count: 2 });
    t.clock.now = NOON + 2 * DAY;
    t.tick();
    expect(t.flags(...refs)).toEqual([true, true, true, true, true]);
    // Sem nada Planejado: nada a fazer e nenhum despertar sobrando.
    t.clock.now = NOON + 3 * DAY;
    t.tick();
    expect(t.entries.filter((entry) => entry.action === "liberacao-diaria")).toHaveLength(3);
  });

  it("a prioridade vence a ordem da árvore; os pré-requisitos contam no total do dia; o primeiro sai inteiro mesmo passando do dia", async () => {
    const t = await setup();
    const a = await t.add("A");
    const b = await t.add("B");
    const c = await t.add("C", { priority: "alta", dependsOn: [a] });
    const d = await t.add("D");
    await pace(t, { perDay: 1, unit: "tarefas" });
    // C vence (alta) e leva A de que depende: 2 de 1 por dia, mas o primeiro item sai inteiro; B e D esperam.
    expect(t.flags(a, b, c, d)).toEqual([true, false, true, false]);
    expect(live(t.ctx, t.id).releasePace?.given).toEqual({ day: "2026-11-11", count: 2 });
    t.clock.now = NOON + DAY;
    t.tick();
    expect(t.flags(a, b, c, d)).toEqual([true, true, true, false]);
    t.clock.now = NOON + 2 * DAY;
    t.tick();
    expect(t.flags(d)).toEqual([true]);
  });

  it("módulos: um módulo inteiro por dia, o de prioridade mais alta primeiro, com o módulo de que depende junto (conta como módulo)", async () => {
    const t = await setup();
    const m1 = await t.add("Primeiro", { group: true });
    const a = await t.add("A", { parent: m1 });
    const b = await t.add("B", { parent: m1 });
    const m2 = await t.add("Segundo", { group: true, priority: "alta" });
    const c = await t.add("C", { parent: m2 });
    const m3 = await t.add("Terceiro", { group: true });
    const d = await t.add("D", { parent: m3 });
    const solta = await t.add("Solta");
    await pace(t, { perDay: 1, unit: "modulos" });
    expect(t.flags(a, b, c, d, solta)).toEqual([false, false, true, false, false]);
    expect(t.flags(m2)).toEqual([true]);
    t.clock.now = NOON + DAY;
    t.tick();
    expect(t.flags(a, b, c, d, solta)).toEqual([true, true, true, false, false]);
    expect(t.flags(m1)).toEqual([true]);
    // Dois por dia: o terceiro módulo e a tarefa solta (uma unidade cada), na ordem da árvore.
    await pace(t, { perDay: 2, unit: "modulos" });
    t.clock.now = NOON + 2 * DAY;
    t.tick();
    expect(t.flags(d, solta)).toEqual([true, true]);
  });

  it("módulos: o pré-requisito de outro módulo entra junto e conta no dia; só saem as folhas de que ele depende", async () => {
    const t = await setup();
    const m1 = await t.add("Base", { group: true });
    const a = await t.add("A", { parent: m1 });
    const b = await t.add("B", { parent: m1 });
    const m2 = await t.add("Uso", { group: true, priority: "alta" });
    const c = await t.add("C", { parent: m2, dependsOn: [a] });
    await pace(t, { perDay: 1, unit: "modulos" });
    expect(t.flags(a, b, c)).toEqual([true, false, true]);
    expect(live(t.ctx, t.id).releasePace?.given).toEqual({ day: "2026-11-11", count: 2 });
    expect(t.flags(m1, m2)).toEqual([false, true]);
  });

  it("projeto pausado não libera; ao retomar, libera", async () => {
    const t = await setup();
    const a = await t.add("A");
    expect((await send(t.ctx, "PATCH", `/projects/${t.id}`, { status: "pausado" })).statusCode).toBe(200);
    await pace(t, { perDay: 1, unit: "tarefas" });
    t.tick();
    expect(t.flags(a)).toEqual([false]);
    expect(live(t.ctx, t.id).releasePace?.given).toBeUndefined();
    expect((await send(t.ctx, "PATCH", `/projects/${t.id}`, { status: "ativo" })).statusCode).toBe(200);
    expect(t.flags(a)).toEqual([true]);
  });

  it("startsOn no futuro não libera; no dia, libera; o agendador acorda na virada do dia até lá", async () => {
    const t = await setup();
    const a = await t.add("A");
    await pace(t, { perDay: 1, unit: "tarefas", startsOn: "2026-11-13" });
    t.tick();
    expect(t.flags(a)).toEqual([false]);
    expect(scheduler(t).nextWakeAt()).toBe(Date.parse("2026-11-12T03:00:00.000Z"));
    t.clock.now = NOON + DAY;
    t.tick();
    expect(t.flags(a)).toEqual([false]);
    t.clock.now = NOON + 2 * DAY;
    t.tick();
    expect(t.flags(a)).toEqual([true]);
  });

  it("respeita a janela de horário do projeto: fechada não libera, e o agendador acorda quando abre", async () => {
    const t = await setup();
    const a = await t.add("A");
    expect((await send(t.ctx, "PATCH", `/projects/${t.id}`, { pace: { window: { from: "13:00", to: "18:00" } } })).statusCode).toBe(200);
    await pace(t, { perDay: 1, unit: "tarefas" });
    expect(t.flags(a)).toEqual([false]);
    expect(scheduler(t).nextWakeAt()).toBe(Date.parse("2026-11-11T16:00:00.000Z"));
    t.clock.now = Date.parse("2026-11-11T16:30:00.000Z");
    t.tick();
    expect(t.flags(a)).toEqual([true]);
  });

  it("mudar o perDay no meio do dia mantém a conta do dia", async () => {
    const t = await setup();
    const refs = [await t.add("A"), await t.add("B"), await t.add("C")];
    await pace(t, { perDay: 1, unit: "tarefas" });
    expect(t.flags(...refs)).toEqual([true, false, false]);
    await pace(t, { perDay: 2, unit: "tarefas" });
    expect(t.flags(...refs)).toEqual([true, true, false]);
    await pace(t, { perDay: 2, unit: "tarefas" });
    expect(t.flags(...refs)).toEqual([true, true, false]);
  });

  it("a folha liberada pelo ritmo já é despachada no mesmo pump", async () => {
    const t = await setup();
    const a = await t.add("A", { assignee: t.agent.id });
    await pace(t, { perDay: 1, unit: "tarefas" });
    await waitDone(t.ctx, t.id, a);
  });
});

describe("plano do Maestro: aprovar com \"all\" (padrão) ou \"none\"", () => {
  async function planRequest(ctx: TestApp, prompt: string): Promise<{ request: Task; plan: Plan }> {
    const response = await ctx.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt } });
    expect(response.statusCode).toBe(201);
    const request = response.json() as Task;
    const event = await ctx.log.waitFor((candidate) => candidate.type === "project:upserted" && candidate.project.id === request.id);
    return { request, plan: (event as Extract<ServerEvent, { type: "project:upserted" }>).project };
  }
  const withActivity = async () => {
    const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
    const entries: ActivityEntry[] = [];
    activity.onAppend((entry) => entries.push(entry));
    return { ctx: await setupApp({ activity }), entries };
  };

  it("sem corpo: libera tudo (o comportamento de sempre) e registra na Atividade", async () => {
    const { ctx, entries } = await withActivity();
    const { request, plan } = await planRequest(ctx, "[plano] Campanha de lançamento");
    expect((await ctx.app.inject({ method: "POST", url: `${API}/plans/${plan.id}/approve` })).statusCode).toBe(200);
    await ctx.log.waitForTask(request.id, "done");
    expect(runtimeOf(ctx).plans.get(plan.id).tasks.every((task) => task.released === true)).toBe(true);
    expect(entries.find((entry) => entry.action === "plano-aprovado")).toMatchObject({ data: { release: "all" } });
    expect(entries.find((entry) => entry.action === "plano-aprovado")?.summary).toMatch(/^Você aprovou o plano .* e liberou as 4 tarefas$/);
  });

  it("none: aprova e deixa todas Planejadas; nada roda até liberar; depois liberar tudo termina o plano", async () => {
    const { ctx, entries } = await withActivity();
    const { request, plan } = await planRequest(ctx, "[plano] Campanha de lançamento");
    const approved = await ctx.app.inject({ method: "POST", url: `${API}/plans/${plan.id}/approve`, payload: { release: "none" } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((approved.json() as Plan).tasks.every((task) => task.released === false)).toBe(true);
    expect((approved.json() as Plan).status).toBe("ativo");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stepTasks(ctx, plan.id)).toHaveLength(0);
    expect(entries.find((entry) => entry.action === "plano-aprovado")).toMatchObject({ data: { release: "none" } });
    expect(entries.find((entry) => entry.action === "plano-aprovado")?.summary).toMatch(/Planejadas, para liberar depois$/);

    expect((await ctx.app.inject({ method: "POST", url: `${API}/projects/${plan.id}/release`, payload: { all: true } })).statusCode).toBe(200);
    await ctx.log.waitForTask(request.id, "done");
    expect(runtimeOf(ctx).plans.get(plan.id).tasks.every((task) => task.status === "concluida")).toBe(true);
  });

  it("o cartão do Para você aceita release na decisão (none deixa Planejadas); corpo inválido é 400", async () => {
    const { ctx } = await withActivity();
    const { plan } = await planRequest(ctx, "[plano] Campanha de lançamento");
    expect((await ctx.app.inject({ method: "POST", url: `${API}/plans/${plan.id}/approve`, payload: { release: "talvez" } })).statusCode).toBe(400);
    const item = ((await ctx.app.inject({ method: "GET", url: `${API}/for-you` })).json() as ForYouItem[]).find((candidate) => candidate.projectId === plan.id)!;
    const decided = await ctx.app.inject({ method: "POST", url: `${API}/for-you/${item.id}/decision`, payload: { status: "aprovado", release: "none" } });
    expect(decided.statusCode, decided.body).toBe(200);
    const after = runtimeOf(ctx).plans.get(plan.id);
    expect(after.status).toBe("ativo");
    expect(after.tasks.every((task) => task.released === false)).toBe(true);
  });
});

describe("compatibilidade: sem nenhum released tudo corre como antes", () => {
  it("tarefa de projeto antigo (sem o campo) é despachada e termina", async () => {
    const t = await setup();
    const a = await t.add("A", { assignee: t.agent.id });
    delete find(t.project(), a).released;
    runtimeOf(t.ctx).plans.pump();
    await waitDone(t.ctx, t.id, a);
  });
});

describe("describe, addTasks, setReleasePace, assignTask, convertProjectToTask e contagens/previsão", () => {
  it("describe mostra 'X planned, Y released', o ritmo diário e o estado por item (e omite sem Planejada nem ritmo)", async () => {
    const t = await setup({ gated: true });
    const m = await t.add("Módulo", { group: true });
    const a = await t.add("A", { parent: m, assignee: t.agent.id });
    const b = await t.add("B", { parent: m, assignee: t.agent.id });
    await t.release({ refs: [a] });
    await t.ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === t.id && event.project.tasks.find((task) => task.ref === a)?.status === "em_andamento");
    await runtimeOf(t.ctx).plans.setReleasePace(t.id, { perDay: 2, unit: "tarefas", startsOn: "2026-11-20" });
    const text = runtimeOf(t.ctx).plans.describe(t.id);
    expect(text).toContain("Release: 1 planned, 1 released; daily release: 2 tasks/day from 2026-11-20 (0 of 2 released today).");
    expect(text).toMatch(new RegExp(`- ${m} «Módulo» \\[.*, mixed\\]`));
    expect(text).toMatch(new RegExp(`- ${a} «A» \\[.*, released\\]`));
    expect(text).toMatch(new RegExp(`- ${b} «B» \\[.*, planned\\]`));
    // Sem Planejadas nem ritmo diário: linha de liberação some.
    await t.release({ all: true });
    await runtimeOf(t.ctx).plans.setReleasePace(t.id, null);
    const clean = runtimeOf(t.ctx).plans.describe(t.id);
    expect(clean).not.toContain("Release:");
    expect(clean).not.toContain(", planned]");
    t.gate.open();
  });

  it("addTasks (Maestro) nasce liberada por padrão, mas herda false dentro de um pai Planejado", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const created = await ctx.app.inject({ method: "POST", url: `${API}/tasks`, payload: { prompt: "[plano] Campanha com módulos" } });
    expect(created.statusCode).toBe(201);
    const request = created.json() as Task;
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === request.id);
    expect((await send(ctx, "POST", `/plans/${request.id}/approve`, { release: "none" })).statusCode).toBe(200);
    const plannedMod = ((await send(ctx, "POST", `/projects/${request.id}/tasks`, { title: "Futuro", group: true })).json() as Reply).ref!;
    const releasedMod = ((await send(ctx, "POST", `/projects/${request.id}/tasks`, { title: "Agora", group: true })).json() as Reply).ref!;
    expect((await send(ctx, "POST", `/projects/${request.id}/release`, { refs: [releasedMod] })).statusCode).toBe(200);

    const updated = runtimeOf(ctx).plans.addTasks(request.id, [
      { ref: "R1", title: "Solta do Maestro", briefing: "faz", owner: agent.id },
      { ref: "R2", title: "Em módulo Planejado", briefing: "faz", owner: agent.id, parent: plannedMod },
      { ref: "R3", title: "Em módulo liberado", briefing: "faz", owner: agent.id, parent: releasedMod },
    ]);
    expect(find(updated, "R1").released).toBe(true);
    expect(find(updated, "R2").released).toBe(false);
    expect(find(updated, "R3").released).toBe(true);
  });

  it("convertProjectToTask limpa released e põe a tarefa liberada no Avulsas", async () => {
    const t = await setup();
    const a = await t.add("Única", { assignee: t.agent.id });
    expect(find(t.project(), a).released).toBe(false);
    const converted = await send(t.ctx, "POST", `/projects/${t.id}/convert`);
    expect(converted.statusCode, converted.body).toBe(200);
    const avulsas = (converted.json() as Reply).project;
    expect(avulsas.id).toBe("avulsas");
    expect(avulsas.tasks.at(-1)?.released).toBeUndefined();
  });

  it("admit, rankOf, atRiskCount, forecast e blockedNow NÃO tratam folha Planejada como esperando vaga", async () => {
    const t = await setup();
    // Projeto com prazo em 4 horas, só com tarefa Planejada (sem nada liberado).
    const soon = new Date(NOON + 4 * 3_600_000).toISOString();
    expect((await send(t.ctx, "PATCH", `/projects/${t.id}`, { dueAt: soon })).statusCode).toBe(200);
    const a = await t.add("Planejada", { assignee: t.agent.id });
    runtimeOf(t.ctx).plans.pump();

    const fakeTask = { id: "sub-1", roomId: "", teamId: "", agentId: t.agent.id, prompt: "x", status: "queued", work: { projectId: t.id, ref: a, step: 0 }, createdAt: new Date(NOON).toISOString(), updatedAt: new Date(NOON).toISOString() } as Task;
    expect(runtimeOf(t.ctx).plans.admit(fakeTask)).toBe(false);
    expect(runtimeOf(t.ctx).plans.rankOf(fakeTask)).toBeUndefined();
    expect(runtimeOf(t.ctx).plans.atRiskCount()).toBe(0);

    // Previsão (forecastProject e forecastAll) e bloqueados (blockedNow) ignoram folhas Planejadas.
    const proj = live(t.ctx, t.id);
    const stats: ForecastStats = { stepMs: new Map([[t.agent.id, [600_000, 600_000, 600_000]]]), workspaceMs: [600_000, 600_000, 600_000], approvalWaits: new Map(), dispatch: { maxRunning: 3, perAgent: 1 }, quotaResumeAt: new Map() };
    expect(forecastProject(proj, stats, NOON).remaining).toBe(0);
    const snap = { agents: [{ id: t.agent.id, name: t.agent.name }], tasks: [], projects: [proj], forYou: [], routines: [], entries: [], usage: [], dispatch: { maxRunning: 3, perAgent: 1 }, quota: [] };
    expect(forecastAll(snap, NOON).projects).toHaveLength(0);
    // Mesmo 48 h depois, a folha Planejada não aparece em blockedNow nem em cardMetrics.atRisk.
    const later = NOON + 48 * 3_600_000;
    expect(computeMetrics(snap, { now: later }).blockedNow.count).toBe(0);
    expect(cardMetrics(snap, NOON).atRisk).toBe(0);

    // Ao liberar, o projeto passa a contar como em risco e entra na previsão.
    await t.release({ refs: [a] });
    expect(runtimeOf(t.ctx).plans.atRiskCount()).toBe(1);
    expect(forecastProject(live(t.ctx, t.id), stats, NOON).remaining).toBe(1);
  });
});
