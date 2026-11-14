import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { APPROVAL_REFUSED_RESULT, MAESTRO_TEXTS, type ApiErrorBody, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createAgent, createRoom, createTeam, createWorkspace, getOffice, wsApi } from "../dev/test-api";
import { EventLog, gatedSleep, testRunner, useTestApp, type TestApp } from "../dev/test-app";

const setupApp = useTestApp();

const ask = (app: TestApp["app"], prompt: string, ws?: string) => call<Task>(app, "POST", `${wsApi(ws)}/tasks`, { prompt });
const decide = (app: TestApp["app"], taskId: string, approved: boolean, ws?: string) =>
  call<Task>(app, "POST", `${wsApi(ws)}/tasks/${taskId}/approval`, { approved }, 200);

/** Status da tarefa sem repetições seguidas (a tarefa do Maestro é regravada ao delegar). */
const statuses = (log: EventLog, taskId: string) => log.taskStatuses(taskId).filter((status, i, all) => status !== all[i - 1]);

const progressMessages = (log: EventLog, taskId: string) =>
  log.events.flatMap((event) => (event.type === "task:progress" && event.taskId === taskId ? [event.message] : []));

/** A subtarefa que o Maestro criou para `projectId` (espera ela aparecer). */
async function subtaskOf(log: EventLog, projectId: string): Promise<Task> {
  const event = await log.waitFor((e) => e.type === "task:upserted" && e.task.projectId === projectId);
  return (event as Extract<ServerEvent, { type: "task:upserted" }>).task;
}

/** Notas do histórico de um Cérebro (os resultados de tarefa ficam em `historico/`). */
async function brainNotes(dir: string, brainId: string): Promise<{ file: string; content: string }[]> {
  const brainDir = path.join(dir, "brains", brainId, "historico");
  const files = await readdir(brainDir);
  return Promise.all(files.map(async (file) => ({ file, content: await readFile(path.join(brainDir, file), "utf8") })));
}

describe("Maestro: triagem, delegação e retorno", () => {
  it("pedido só com o texto: triagem, subtarefa para o time certo, revisão e nota no Cérebro do lobby", async () => {
    const { app, log, dir } = await setupApp();
    const task = await ask(app, "Pesquisar referências sobre agentes");
    expect(task).toMatchObject({ status: "queued", roomId: "sala-do-maestro", agentId: "maestro" });
    expect(task.projectId).toBeUndefined();

    const sub = await subtaskOf(log, task.id);
    expect(sub).toMatchObject({ projectId: task.id, roomId: "projetoy", teamId: "projetoy-pesquisa", prompt: task.prompt });
    expect(sub.routeReason).toBe("pedido fala de 'pesquisar', 'referências' → time Pesquisa do quarto ProjetoY");

    await log.waitForTask(task.id, "done");
    expect(statuses(log, task.id)).toEqual(["queued", "in_progress", "done"]);
    expect(statuses(log, sub.id)).toEqual(["queued", "in_progress", "done"]);
    expect(progressMessages(log, task.id)).toEqual([MAESTRO_TEXTS.triage, MAESTRO_TEXTS.delegated("Pesquisa"), MAESTRO_TEXTS.review("Pesquisa")]);
    // O Maestro "trabalha" na triagem e na revisão, e fica livre enquanto o time faz.
    await log.waitFor(() => log.agentStatuses("maestro").slice(-2).join() === "done,idle");
    expect(log.agentStatuses("maestro")).toEqual(["working", "idle", "working", "done", "idle"]);

    const office = await getOffice(app);
    const parent = office.tasks.find((candidate) => candidate.id === task.id)!;
    const child = office.tasks.find((candidate) => candidate.id === sub.id)!;
    expect(parent.routeReason).toBe(sub.routeReason);
    expect(parent.result).toContain(child.result!);
    expect(parent.result).toMatch(/^Entregue por .+, time Pesquisa\./);

    const teamNote = (await brainNotes(dir, "projetoy")).find((note) => note.content.includes(`task: "${sub.id}"`))!;
    const lobbyNotes = (await brainNotes(dir, "global")).filter((note) => note.content.includes(`task: "${task.id}"`));
    expect(lobbyNotes).toHaveLength(1);
    expect(lobbyNotes[0]!.content).toContain(`subtask: "${sub.id}"`);
    expect(lobbyNotes[0]!.content).toContain(`[[projetoy/${teamNote.file.replace(/\.md$/, "")}]]`);
    expect(lobbyNotes[0]!.content).toContain(sub.routeReason!);
  });

  it("subtarefa falhou: a tarefa original falha com o motivo", async () => {
    const { app, log } = await setupApp();
    const task = await ask(app, "Pesquisar o mercado [falhar]");
    const sub = await subtaskOf(log, task.id);
    await log.waitForTask(task.id, "failed");
    expect(statuses(log, sub.id)).toEqual(["queued", "in_progress", "failed"]);
    const parent = (await getOffice(app)).tasks.find((candidate) => candidate.id === task.id)!;
    expect(parent.result).toMatch(/^O time Pesquisa não concluiu: Falha simulada/);
  });

  it("subtarefa pede aprovação: a original fica esperando você; aprovar pela original decide a subtarefa", async () => {
    const { app, log } = await setupApp({ maestro: { reviewMs: 50 } });
    const task = await ask(app, "Pesquisar concorrentes [aprovar]");
    const sub = await subtaskOf(log, task.id);
    await log.waitForTask(sub.id, "waiting_approval");
    await log.waitForTask(task.id, "waiting_approval");
    expect(progressMessages(log, task.id).at(-1)).toBe(MAESTRO_TEXTS.waitingTeam("Pesquisa"));
    // Quem pede aprovação é o agente do time; o Maestro não fica com o "!".
    expect((await getOffice(app)).agents.find((agent) => agent.id === "maestro")!.status).toBe("idle");

    // Não se confere o estado que a resposta da aprovação devolve: com a máquina carregada a resposta (que espera a gravação em disco) chega depois de o
    // Maestro já ter fechado a tarefa ("done"). O que vale é a sequência de estados nos eventos, esperada pelo evento e não por tempo.
    await decide(app, task.id, true);
    await log.waitForTask(task.id, "done");
    expect(statuses(log, sub.id)).toEqual(["queued", "in_progress", "waiting_approval", "in_progress", "done"]);
    expect(statuses(log, task.id)).toEqual(["queued", "in_progress", "waiting_approval", "in_progress", "done"]);
  });

  it("recusar a aprovação da subtarefa (direto nela) faz a original falhar", async () => {
    const { app, log } = await setupApp();
    const task = await ask(app, "Pesquisar e publicar [aprovar]");
    const sub = await subtaskOf(log, task.id);
    await log.waitForTask(task.id, "waiting_approval");
    await decide(app, sub.id, false);
    await log.waitForTask(task.id, "failed");
    const parent = (await getOffice(app)).tasks.find((candidate) => candidate.id === task.id)!;
    expect(parent.result).toBe(`O time Pesquisa não concluiu: ${APPROVAL_REFUSED_RESULT}`);
    await call<ApiErrorBody>(app, "POST", `${wsApi()}/tasks/${task.id}/approval`, { approved: true }, 409);
  });

  it("workspace sem time: esperando você com a pergunta; depois de criar um time, aprovar refaz a triagem", async () => {
    // O time só trabalha depois de `open()`: sem isso, com tudo em 0 ms, a tarefa podia chegar a
    // "done" antes de a resposta da aprovação sair (ela espera a gravação em disco).
    const gate = gatedSleep();
    const { app, workspaces } = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const ws = (await createWorkspace(app, "Instagram")).id;
    const log = new EventLog(workspaces.get(ws).hub);
    const task = await ask(app, "Fazer um vídeo", ws);
    await log.waitForTask(task.id, "waiting_approval");
    let office = await getOffice(app, ws);
    expect(office.tasks.find((candidate) => candidate.id === task.id)!.routeReason).toBe(MAESTRO_TEXTS.noTeam);
    expect(progressMessages(log, task.id).at(-1)).toBe(MAESTRO_TEXTS.noTeam);
    expect(office.agents.find((agent) => agent.role === "maestro")!.status).toBe("waiting_approval");

    const room = await createRoom(app, "Estúdio", {}, ws);
    const team = await createTeam(app, room.id, "Vídeo", ws);
    await createAgent(app, team.id, "Bia", ws);
    const retried = await decide(app, task.id, true, ws);
    expect(retried.status).toBe("in_progress");
    const sub = await subtaskOf(log, task.id);
    expect(sub.routeReason).toBe("pedido fala de 'vídeo' → time Vídeo do quarto Estúdio");
    gate.open();
    await log.waitForTask(task.id, "done");
    office = await getOffice(app, ws);
    expect(office.agents.find((agent) => agent.role === "maestro")!.status).not.toBe("waiting_approval");
  });

  it("workspace sem time: recusar encerra a tarefa", async () => {
    const { app, workspaces } = await setupApp();
    const ws = (await createWorkspace(app, "LinkedIn")).id;
    const log = new EventLog(workspaces.get(ws).hub);
    const task = await ask(app, "Qualquer coisa", ws);
    await log.waitForTask(task.id, "waiting_approval");
    expect(await decide(app, task.id, false, ws)).toMatchObject({ status: "failed", result: APPROVAL_REFUSED_RESULT });
  });

  it("quarto do time removido no meio: a subtarefa é cancelada e a original falha", async () => {
    const gate = gatedSleep();
    const { app, log } = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const task = await ask(app, "Pesquisar tendências");
    const sub = await subtaskOf(log, task.id);
    await log.waitForTask(sub.id, "in_progress");
    await call(app, "DELETE", `${wsApi()}/rooms/projetoy`);
    await log.waitForTask(task.id, "failed");
    const parent = (await getOffice(app)).tasks.find((candidate) => candidate.id === task.id)!;
    expect(parent.result).toBe("O time Pesquisa não concluiu: Cancelada: a sala foi removida");
  });

  it("atalho: com teamId vai direto ao time (sem Maestro); para a Gerência, vai ao Maestro; roomId sem teamId = 400", async () => {
    const { app, log } = await setupApp();
    const direct = await call<Task>(app, "POST", `${wsApi()}/tasks`, { teamId: "projetox-backend", prompt: "Pesquisar índices" });
    expect(direct).toMatchObject({ roomId: "projetox", teamId: "projetox-backend" });
    expect(direct.projectId).toBeUndefined();
    expect(["caio", "bruna"]).toContain(direct.agentId);
    await log.waitForTask(direct.id, "done");

    const office = await getOffice(app);
    const gerencia = office.teams.find((team) => team.roomId === "sala-do-maestro")!;
    const viaGerencia = await call<Task>(app, "POST", `${wsApi()}/tasks`, { roomId: "sala-do-maestro", teamId: gerencia.id, prompt: "Pesquisar" });
    expect(viaGerencia.agentId).toBe("maestro");
    await log.waitForTask(viaGerencia.id, "done");

    const bad = await call<ApiErrorBody>(app, "POST", `${wsApi()}/tasks`, { roomId: "projetox", prompt: "x" }, 400);
    expect(bad.details?.[0]?.path).toBe("teamId");
    await call(app, "POST", `${wsApi()}/tasks`, { teamId: "fantasma", prompt: "x" }, 404);
  });

  it("restart: a triagem interrompida recomeça e a delegação em andamento termina", async () => {
    const first = await setupApp({ maestro: { triageMinMs: 60_000, triageMaxMs: 60_000 } });
    const triaging = await ask(first.app, "Pesquisar tendências");
    await first.log.waitForTask(triaging.id, "in_progress");
    await first.app.close();

    const rebooted = await setupApp({ dataDir: first.dataDir });
    const sub = await subtaskOf(rebooted.log, triaging.id);
    await rebooted.log.waitForTask(triaging.id, "done");
    expect(statuses(rebooted.log, sub.id)).toEqual(["queued", "in_progress", "done"]);
  });

  it("restart com a subtarefa em andamento: ela volta para a fila e a original fecha quando ela termina", async () => {
    const gate = gatedSleep();
    const first = await setupApp({ runner: testRunner({ sleep: gate.sleep }) });
    const task = await ask(first.app, "Pesquisar tendências");
    const sub = await subtaskOf(first.log, task.id);
    await first.log.waitForTask(sub.id, "in_progress");
    await first.app.close();

    const rebooted = await setupApp({ dataDir: first.dataDir });
    await rebooted.log.waitForTask(task.id, "done");
    expect(statuses(rebooted.log, sub.id)).toEqual(["queued", "in_progress", "done"]);
    // O Maestro nunca roda no runner: a tarefa dele não ganha uma "segunda" execução.
    expect(rebooted.log.events.some((e) => e.type === "task:progress" && e.taskId === task.id && e.message.startsWith("Lendo"))).toBe(false);
  });
});
