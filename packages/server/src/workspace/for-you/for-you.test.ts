import { mkdir, rm, writeFile } from "node:fs/promises";
import { readDiskForYou } from "../../dev/test-utils";
import path from "node:path";
import { APPROVAL_REFUSED_RESULT, type ApiErrorBody, type ForYouItem, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { SIMULATED_DRAFT_MARK } from "../../sim/mock-script";
import { call, createTask, createWorkspace, getOffice, soloTeam, wsApi } from "../../dev/test-api";
import { EventLog, testRunner, useTestApp, type TestApp } from "../../dev/test-app";
import { BACKFILL_WHY } from "./service";

const setupApp = useTestApp();

type App = TestApp["app"];
type Decision = { status: ForYouItem["status"]; text?: string; response?: string };

const listItems = (app: App, ws?: string) => call<ForYouItem[]>(app, "GET", `${wsApi(ws)}/for-you`);
const decideItem = (app: App, id: string, body: Decision, status = 200, ws?: string) =>
  call<ForYouItem>(app, "POST", `${wsApi(ws)}/for-you/${id}/decision`, body, status);

/** Espera o item do "Para você" da tarefa aparecer (evento foryou:upserted). */
async function itemFor(log: EventLog, taskId: string): Promise<ForYouItem> {
  const event = await log.waitFor((e) => e.type === "foryou:upserted" && e.item.taskId === taskId);
  return (event as Extract<ServerEvent, { type: "foryou:upserted" }>).item;
}

async function taskOf(app: App, id: string, ws?: string): Promise<Task> {
  return (await getOffice(app, ws)).tasks.find((task) => task.id === id)!;
}

/** Quarto com um agente e uma tarefa parada na aprovação, com o item já criado. */
async function waitingTask(setup: TestApp, prompt: string, ws?: string) {
  const { room, team } = await soloTeam(setup.app, "Solo", ws);
  const task = await createTask(setup.app, room.id, team.id, prompt, ws);
  await setup.log.waitForTask(task.id, "waiting_approval");
  return { task, item: await itemFor(setup.log, task.id) };
}

describe("Para você: itens nascem dos pedidos de aprovação", () => {
  it("o pedido de aprovação cria o item ligado à tarefa, com rascunho, tipo, por quê e id sequencial", async () => {
    const setup = await setupApp();
    expect(await listItems(setup.app)).toEqual([]);
    const { task, item } = await waitingTask(setup, "Escrever convite para Ana Souza [aprovar]");
    expect(item).toMatchObject({ id: "A-0001", taskId: task.id, agentId: task.agentId, roomId: task.roomId, type: "convite", status: "pendente", to: "Ana Souza", editedByUser: false });
    // Compacto: o rascunho igual ao texto não é guardado (ausente = igual).
    expect(item.originalText).toBeUndefined();
    expect(item.text.length).toBeLessThanOrEqual(200);
    expect(item.text).toContain(SIMULATED_DRAFT_MARK);
    expect(item.why).toContain("precisa do seu ok");

    const second = await createTask(setup.app, task.roomId, task.teamId, "Qual o melhor horário? [aprovar]");
    // O agente só roda uma tarefa por vez: decide a primeira para a segunda chegar à aprovação.
    await decideItem(setup.app, item.id, { status: "aprovado" });
    const next = await itemFor(setup.log, second.id);
    expect(next).toMatchObject({ id: "A-0002", type: "pergunta" });

    await setup.store.flush();
    const saved = await readDiskForYou<ForYouItem>(setup.dir);
    expect(saved.map((current) => current.id)).toEqual(["A-0001", "A-0002"]);
  });

  it("aprovar com o texto editado: a tarefa conclui usando o texto final; o item guarda a edição", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Mensagem para a Bia [aprovar]");
    const decided = await decideItem(setup.app, item.id, { status: "aprovado", text: "  Oi, Bia! Texto meu.  ", response: "manda hoje" });
    expect(decided).toMatchObject({ status: "aprovado", text: "Oi, Bia! Texto meu.", editedByUser: true, response: "manda hoje" });
    expect(decided.decidedAt).toBeDefined();
    await setup.log.waitForTask(task.id, "done");
    const done = await taskOf(setup.app, task.id);
    expect(done.result).toContain("### Texto aprovado\n\nOi, Bia! Texto meu.");
    expect(done.result).toContain("manda hoje");
    expect(setup.log.events.some((event) => event.type === "foryou:upserted" && event.item.status === "aprovado")).toBe(true);
  });

  it("aprovar sem mexer no texto não marca como editado", async () => {
    const setup = await setupApp();
    const { item } = await waitingTask(setup, "Post sobre testes [aprovar]");
    expect(await decideItem(setup.app, item.id, { status: "aprovado", text: item.text })).toMatchObject({ editedByUser: false });
  });

  it("rejeitar: a tarefa falha com a nota do usuário como motivo", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Comentário no post do Caio [aprovar]");
    expect(await decideItem(setup.app, item.id, { status: "rejeitado", response: "tom formal demais" })).toMatchObject({ status: "rejeitado" });
    await setup.log.waitForTask(task.id, "failed");
    expect((await taskOf(setup.app, task.id)).result).toBe(`${APPROVAL_REFUSED_RESULT}: tom formal demais`);
  });

  it("responder uma pergunta exige a resposta; respondida, a tarefa segue com ela no resultado", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Devo publicar na segunda ou na terça? [aprovar]");
    expect(item).toMatchObject({ type: "pergunta", title: "Devo publicar na segunda ou na terça?" });
    const invalid = await decideItem(setup.app, item.id, { status: "respondido", response: "   " }, 400);
    expect((invalid as unknown as ApiErrorBody).details?.[0]?.path).toBe("response");
    expect((await taskOf(setup.app, task.id)).status).toBe("waiting_approval");

    expect(await decideItem(setup.app, item.id, { status: "respondido", response: "Terça, 9h" })).toMatchObject({ status: "respondido", response: "Terça, 9h" });
    await setup.log.waitForTask(task.id, "done");
    expect((await taskOf(setup.app, task.id)).result).toContain("### Sua resposta\n\nTerça, 9h");
  });

  it("decidido só aceita reabrir; reabrir não reabre a tarefa e decidir de novo só muda o item", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Convite para o Leo [aprovar]");
    await decideItem(setup.app, item.id, { status: "aprovado" });
    await setup.log.waitForTask(task.id, "done");
    const conflict = await decideItem(setup.app, item.id, { status: "rejeitado" }, 409);
    expect((conflict as unknown as ApiErrorBody).error).toContain("reabra");

    const reopened = await decideItem(setup.app, item.id, { status: "pendente" });
    expect(reopened.status).toBe("pendente");
    expect(reopened.decidedAt).toBeUndefined();
    expect((await taskOf(setup.app, task.id)).status).toBe("done");

    expect(await decideItem(setup.app, item.id, { status: "rejeitado", response: "mudei de ideia" })).toMatchObject({ status: "rejeitado" });
    expect((await taskOf(setup.app, task.id)).status).toBe("done");
  });

  it("validação: id fora do formato dá 400, item inexistente 404 e campos extras 400", async () => {
    const { app } = await setupApp();
    await call(app, "POST", `${wsApi()}/for-you/nada/decision`, { status: "aprovado" }, 400);
    await decideItem(app, "A-9999", { status: "aprovado" }, 404);
    await call(app, "POST", `${wsApi()}/for-you/A-0001/decision`, { status: "aprovado", extra: 1 }, 400);
    await call(app, "POST", `${wsApi()}/for-you/A-0001/decision`, { status: "talvez" }, 400);
    await call(app, "POST", `${wsApi()}/for-you/A-0001/decision`, { status: "aprovado", text: " " }, 400);
  });
});

describe("Para você: atalho /tasks/:id/approval", () => {
  it("aprovar pela tarefa aprova o item ligado (texto do rascunho)", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Convite para a Rita [aprovar]");
    const approved = await call<Task>(setup.app, "POST", `${wsApi()}/tasks/${task.id}/approval`, { approved: true }, 200);
    expect(approved.status).toBe("in_progress");
    await setup.log.waitForTask(task.id, "done");
    const [saved] = await listItems(setup.app);
    expect(saved).toMatchObject({ id: item.id, status: "aprovado", text: item.text, editedByUser: false });
    expect((await taskOf(setup.app, task.id)).result).toContain(item.text);
  });

  it("recusar pela tarefa rejeita o item", async () => {
    const setup = await setupApp();
    const { task, item } = await waitingTask(setup, "Post do lançamento [aprovar]");
    const refused = await call<Task>(setup.app, "POST", `${wsApi()}/tasks/${task.id}/approval`, { approved: false }, 200);
    expect(refused).toMatchObject({ status: "failed", result: APPROVAL_REFUSED_RESULT });
    expect((await listItems(setup.app)).find((current) => current.id === item.id)!.status).toBe("rejeitado");
  });

  it("com o Maestro: o item é da subtarefa, e decidir o item faz a tarefa original concluir", async () => {
    const setup = await setupApp({ maestro: { reviewMs: 20 } });
    const parent = await call<Task>(setup.app, "POST", `${wsApi()}/tasks`, { prompt: "Pesquisar e escrever post sobre agentes [aprovar]" });
    await setup.log.waitForTask(parent.id, "waiting_approval");
    const sub = (await getOffice(setup.app)).tasks.find((task) => task.projectId === parent.id)!;
    const item = await itemFor(setup.log, sub.id);
    expect(item).toMatchObject({ taskId: sub.id, roomId: sub.roomId, agentId: sub.agentId, type: "post" });
    expect((await listItems(setup.app)).some((current) => current.taskId === parent.id)).toBe(false);

    await decideItem(setup.app, item.id, { status: "aprovado", text: "Post final" });
    await setup.log.waitForTask(parent.id, "done");
    expect((await taskOf(setup.app, parent.id)).result).toContain("Post final");
  });

  it("com o Maestro: aprovar pela tarefa original decide o item da subtarefa", async () => {
    const setup = await setupApp({ maestro: { reviewMs: 20 } });
    const parent = await call<Task>(setup.app, "POST", `${wsApi()}/tasks`, { prompt: "Pesquisar concorrentes [aprovar]" });
    await setup.log.waitForTask(parent.id, "waiting_approval");
    await call(setup.app, "POST", `${wsApi()}/tasks/${parent.id}/approval`, { approved: false }, 200);
    await setup.log.waitForTask(parent.id, "failed");
    const [item] = await listItems(setup.app);
    expect(item!.status).toBe("rejeitado");
  });
});

describe("Para você: isolamento e boot", () => {
  it("cada workspace tem os seus itens e a sua sequência", async () => {
    const setup = await setupApp();
    const other = await createWorkspace(setup.app, "Instagram");
    const otherLog = new EventLog(setup.workspaces.get(other.id).hub);
    const here = await waitingTask(setup, "Convite para a Ana [aprovar]");
    const there = await waitingTask({ ...setup, log: otherLog }, "Convite para o Bruno [aprovar]", other.id);
    expect(here.item.id).toBe("A-0001");
    expect(there.item.id).toBe("A-0001");
    expect(there.item.to).toBe("Bruno");

    expect((await listItems(setup.app)).map((item) => item.to)).toEqual(["Ana"]);
    expect((await listItems(setup.app, other.id)).map((item) => item.to)).toEqual(["Bruno"]);
    // Os eventos de um workspace não chegam ao outro.
    expect(setup.log.events.some((event) => event.type === "foryou:upserted" && event.item.to === "Bruno")).toBe(false);

    await decideItem(setup.app, there.item.id, { status: "rejeitado" }, 200, other.id);
    expect((await listItems(setup.app))[0]!.status).toBe("pendente");
    expect((await taskOf(setup.app, here.task.id)).status).toBe("waiting_approval");
    await call(setup.app, "GET", "/api/w/nao-existe/for-you", undefined, 404);
  });

  it("depois de reiniciar, os itens voltam e aprovar ainda conclui a tarefa com o texto editado", async () => {
    const first = await setupApp({ runner: testRunner() });
    const { task, item } = await waitingTask(first, "Mensagem para o Davi [aprovar]");
    await first.app.close();

    const rebooted = await setupApp({ dataDir: first.dataDir });
    expect(await listItems(rebooted.app)).toEqual([item]);
    await decideItem(rebooted.app, item.id, { status: "aprovado", text: "Versão do reboot" });
    await rebooted.log.waitForTask(task.id, "done");
    expect((await taskOf(rebooted.app, task.id)).result).toContain("Versão do reboot");
    // Já aprovada: o runner não pede aprovação de novo (nenhum item novo).
    expect(await listItems(rebooted.app)).toHaveLength(1);
  });

  it("aprovação pendente de antes do Para você (sem a pasta for-you) ganha um item no boot", async () => {
    const first = await setupApp();
    const { task } = await waitingTask(first, "Publicar o anúncio [aprovar]");
    await first.app.close();
    await rm(path.join(first.dir, "for-you"), { recursive: true, force: true });

    const rebooted = await setupApp({ dataDir: first.dataDir });
    const [item] = await listItems(rebooted.app);
    expect(item).toMatchObject({ id: "A-0001", taskId: task.id, status: "pendente", text: task.prompt, why: BACKFILL_WHY });
    await call(rebooted.app, "POST", `${wsApi()}/tasks/${task.id}/approval`, { approved: true }, 200);
    await rebooted.log.waitForTask(task.id, "done");
  });

  it("arquivo do Para você inválido impede o boot com uma mensagem clara", async () => {
    const first = await setupApp();
    await first.app.close();
    await mkdir(path.join(first.dir, "for-you"), { recursive: true });
    await writeFile(path.join(first.dir, "for-you", "2026-11.json"), JSON.stringify([{ id: "x" }]));
    await expect(setupApp({ dataDir: first.dataDir })).rejects.toThrow(/2026-11\.json/);
  });
});
